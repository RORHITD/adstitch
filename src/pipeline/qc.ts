import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Storyboard, SegmentPlan } from "../types.js";
import type { Provider } from "../providers/types.js";
import type { Config } from "../config.js";
import { qcJudgePrompt } from "./prompts.js";
import { stripFences } from "./storyboard.js";
import { extractFrameAt, ssimCompare } from "../util/ffmpeg.js";
import { ensureDir } from "../util/fs.js";
import { log } from "../util/log.js";

export interface QcVerdict {
  pass: boolean;
  reasons: string[];
  ssim?: number;
  judgeCostUsd: number;
}

const JudgeSchema = z.object({ pass: z.boolean(), reasons: z.array(z.string()).default([]) });
const TranscriptSchema = z.object({ transcript: z.string() });

/** flat estimate for one flash multimodal judge call */
export const JUDGE_COST_USD = 0.001;

// "dot"/"slash"/"www" — scripts spell URLs out loud ("universalrehab dot io slash careers")
// but transcribers write them back as the URL, so those words never appear "spoken"
const FILLERS = new Set(["a", "the", "and", "um", "uh", "oh", "so", "hey", "like", "you", "know", "dot", "slash", "www"]);

export function normalizeWords(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

const matchesAny = (word: string, vocab: string[]) =>
  vocab.some((v) => v === word || (word.length >= 4 && levenshtein(word, v) <= 2) || v.includes(word) || word.includes(v));

/**
 * Compare a spoken transcript against the scripted line. Transcription itself
 * is imperfect ("quotas" → "quotes"), so matching is fuzzy (edit distance ≤2);
 * what CANNOT pass is an invented word ("Tannerym") or a substantially missing
 * line. Returns a human-readable issue string, or null when the speech is ok.
 */
export function dialogueIssues(script: string, transcript: string): string | null {
  const scriptWords = normalizeWords(script);
  const spokenWords = normalizeWords(transcript);
  if (!spokenWords.length) return null; // empty transcript = check unavailable, never a failure

  const hallucinated = spokenWords.filter((w) => w.length >= 4 && !FILLERS.has(w) && !matchesAny(w, scriptWords));
  const significant = scriptWords.filter((w) => w.length >= 3 && !FILLERS.has(w));
  const missing = significant.filter((w) => !matchesAny(w, spokenWords));
  const missingRatio = significant.length ? missing.length / significant.length : 0;

  const issues: string[] = [];
  if (hallucinated.length) issues.push(`invented word(s): "${hallucinated.join('", "')}"`);
  if (missingRatio > 0.25) issues.push(`missing ${missing.length}/${significant.length} scripted words (e.g. "${missing.slice(0, 3).join('", "')}")`);
  return issues.length ? issues.join("; ") : null;
}

export function transcribePrompt(): string {
  return `QC_TRANSCRIBE
Listen to this video clip and transcribe EXACTLY the words the person speaks, word for word, in order.
Do not correct, complete, or paraphrase anything — write only what is actually said.
Return ONLY JSON: {"transcript": string} — an empty string if there is no speech or you cannot hear it clearly.`;
}

/**
 * Two checks per rendered segment:
 *  1. free deterministic: first frame vs conditioning keyframe (SSIM) — catches
 *     "wrong scene entirely", threshold is deliberately lenient;
 *  2. multimodal judge: same person / burned-in text / anatomy / label legibility.
 * QC infrastructure failures (missing ssim filter, unparseable judge output)
 * degrade to pass — QC must never block the pipeline on its own bugs.
 */
export async function qcSegment(opts: {
  videoPath: string;
  plan: SegmentPlan;
  sb: Storyboard;
  provider: Provider;
  cfg: Config;
  scratchDir: string;
}): Promise<QcVerdict> {
  const { videoPath, plan, sb, provider, cfg } = opts;
  const reasons: string[] = [];
  const scratch = ensureDir(opts.scratchDir);
  const tag = path.basename(videoPath, ".mp4");

  const firstFrame = path.join(scratch, `${tag}-first.png`);
  const midFrame = path.join(scratch, `${tag}-mid.png`);
  const lastFrame = path.join(scratch, `${tag}-last.png`);
  const d = plan.beat.durationSeconds;
  await extractFrameAt(videoPath, 0.05, firstFrame);
  await extractFrameAt(videoPath, d / 2, midFrame);
  await extractFrameAt(videoPath, Math.max(0, d - 0.2), lastFrame);

  let ssim: number | undefined;
  const score = await ssimCompare(firstFrame, plan.firstFramePath);
  if (score === null) {
    log.dim("ssim check unavailable on this ffmpeg build — skipping conditioning check");
  } else {
    ssim = score;
    if (score < cfg.qc.ssimThreshold) {
      reasons.push(`first frame does not match the keyframe (SSIM ${score.toFixed(2)} < ${cfg.qc.ssimThreshold})`);
    }
  }

  let judgeCostUsd = 0;
  try {
    const raw = await provider.generateJson({
      model: cfg.models.text,
      prompt: qcJudgePrompt(sb, plan.beat),
      temperature: 0,
      images: [plan.firstFramePath, firstFrame, midFrame, lastFrame],
    });
    judgeCostUsd = provider.name === "mock" ? 0 : JUDGE_COST_USD;
    const verdict = JudgeSchema.safeParse(JSON.parse(stripFences(raw)));
    if (verdict.success) {
      if (!verdict.data.pass) reasons.push(...(verdict.data.reasons.length ? verdict.data.reasons : ["judge failed the segment without reasons"]));
    } else {
      log.dim(`qc judge returned unparseable verdict — treating as pass`);
    }
  } catch (err) {
    log.dim(`qc judge call failed (${(err as Error).message}) — treating as pass`);
  }

  // dialogue check: Veo can hallucinate words the script never contained
  // (an em-dash once became a spoken invented name) — transcribe and compare
  if (plan.beat.dialogue) {
    try {
      const raw = await provider.generateJson({
        model: cfg.models.text,
        prompt: transcribePrompt(),
        temperature: 0,
        videos: [videoPath],
      });
      judgeCostUsd += provider.name === "mock" ? 0 : JUDGE_COST_USD;
      const t = TranscriptSchema.safeParse(JSON.parse(stripFences(raw)));
      if (t.success && t.data.transcript.trim()) {
        const issue = dialogueIssues(plan.beat.dialogue, t.data.transcript);
        if (issue) reasons.push(`spoken line deviates from script — ${issue}`);
      }
    } catch (err) {
      log.dim(`qc transcription failed (${(err as Error).message}) — skipping dialogue check`);
    }
  }

  for (const f of [firstFrame, midFrame, lastFrame]) fs.rmSync(f, { force: true });
  return { pass: reasons.length === 0, reasons, ssim, judgeCostUsd };
}
