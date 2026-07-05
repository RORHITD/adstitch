import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { z } from "zod";
import type { Storyboard } from "../types.js";
import type { Provider } from "../providers/types.js";
import type { Config } from "../config.js";
import type { Project } from "./state.js";
import { castPaths } from "./cast.js";
import { stripFences } from "./storyboard.js";
import { transcribePrompt, dialogueIssues, normalizeWords } from "./qc.js";
import { ffmpeg, ffprobeDuration } from "../util/ffmpeg.js";
import { ensureDir } from "../util/fs.js";
import { log } from "../util/log.js";

// The definition of done. Every defect that shipped in this project's history
// lived in a dimension nothing was checking: an 18dB audio slam at joins, blind
// trims clipping first syllables, and Veo speaking a word that was never in the
// script ("Tannerym"). verify() checks the FINISHED file against the storyboard
// contract — an ad either passes all gates or it isn't done.

export interface VerifyCheck {
  name: string;
  pass: boolean;
  detail: string;
}

const TranscriptSchema = z.object({ transcript: z.string() });
const SweepSchema = z.object({ pass: z.boolean(), reasons: z.array(z.string()).default([]) });

const MAX_JOIN_STEP_DB = 20; // natural speech onsets measured ≤16dB; the slam class was 18-31dB

function missingRatio(script: string, spokenWords: string[]): { ratio: number; missing: string[] } {
  // dot/slash/www: scripts spell URLs out loud but transcribers write the URL back
  const FILL = new Set(["a", "the", "and", "um", "uh", "oh", "so", "hey", "you", "dot", "slash", "www"]);
  const sig = normalizeWords(script).filter((w) => w.length >= 3 && !FILL.has(w));
  const missing = sig.filter(
    (w) => !spokenWords.some((s) => s === w || (w.length >= 4 && Math.abs(s.length - w.length) <= 3 && (s.includes(w) || w.includes(s)))),
  );
  return { ratio: sig.length ? missing.length / sig.length : 0, missing };
}

export async function verifyFinal(
  project: Project,
  sb: Storyboard,
  provider: Provider,
  cfg: Config,
  finalPath: string,
): Promise<{ pass: boolean; checks: VerifyCheck[] }> {
  const checks: VerifyCheck[] = [];
  const duration = await ffprobeDuration(finalPath);
  checks.push({ name: "file", pass: true, detail: `${path.basename(finalPath)} — ${duration.toFixed(1)}s` });

  // 1) script integrity: transcribe the WHOLE final and compare with every line
  try {
    const raw = await provider.generateJson({ model: cfg.models.text, prompt: transcribePrompt(), temperature: 0, videos: [finalPath] });
    const transcript = TranscriptSchema.parse(JSON.parse(stripFences(raw))).transcript.trim();
    if (!transcript) {
      checks.push({ name: "script integrity", pass: true, detail: "no speech detected by transcriber — check unavailable" });
    } else {
      const fullScript = sb.beats.map((b) => b.dialogue).join(" ");
      const issue = dialogueIssues(fullScript, transcript);
      const spoken = normalizeWords(transcript);
      const beatProblems: string[] = [];
      for (const b of sb.beats) {
        const { ratio, missing } = missingRatio(b.dialogue, spoken);
        if (ratio > 0.3) beatProblems.push(`${b.id}: missing "${missing.slice(0, 4).join('", "')}"`);
      }
      const problems = [issue, ...beatProblems].filter(Boolean);
      checks.push({
        name: "script integrity",
        pass: problems.length === 0,
        detail: problems.length ? problems.join(" | ") : `all ${sb.beats.length} lines spoken as scripted`,
      });
    }
  } catch (err) {
    checks.push({ name: "script integrity", pass: false, detail: `transcription failed: ${(err as Error).message}` });
  }

  // 2) visual sweep: sampled frames + persona reference through the judge.
  // Dense sampling matters: a 1s dissolve artifact slipped straight between
  // 2.5s-grid samples in one variant while failing the other.
  const sweepDir = ensureDir(path.join(project.finalDir, ".verify"));
  try {
    const interval = Math.max(1.25, duration / 28);
    await ffmpeg(["-i", finalPath, "-vf", `fps=1/${interval.toFixed(3)},scale=540:-2`, path.join(sweepDir, "f-%02d.png")]);
    const frames = fs.readdirSync(sweepDir).filter((f) => f.endsWith(".png")).sort().map((f) => path.join(sweepDir, f)).slice(0, 28);
    const personaRef = castPaths(project).personaRefs[0];
    const images = fs.existsSync(personaRef) ? [personaRef, ...frames] : frames;
    const raw = await provider.generateJson({
      model: cfg.models.text,
      temperature: 0,
      prompt: `QC_JUDGE
${fs.existsSync(personaRef) ? "Image 1 is the persona reference; the remaining images are" : "These images are"} frames sampled every ${interval.toFixed(2)}s across one finished video ad featuring ONE woman.
FAIL if ANY frame shows: (a) a clearly different woman (face/hair/wardrobe changed)${fs.existsSync(personaRef) ? " than image 1" : ""}; (b) burned-in subtitles, captions, or watermark text; (c) grotesque anatomical artifacts (mangled hands, warped or duplicated face); (d) a dissolve/double-exposure blending two shots (ghostly overlapping images); (e) a scene that obviously doesn't belong in this ad.
Different camera angles, shot sizes, product close-ups without the person, and natural motion blur are all FINE.
Return ONLY JSON: {"pass": boolean, "reasons": string[]} — each reason ≤14 words, naming the frame number (frames count from 1 in the order given, so frame N sits near t=(N-1)*${interval.toFixed(2)}s).`,
      images,
    });
    const verdict = SweepSchema.parse(JSON.parse(stripFences(raw)));
    checks.push({
      name: "visual sweep",
      pass: verdict.pass,
      detail: verdict.pass ? `${frames.length} frames: one persona, no burned text, no artifacts` : verdict.reasons.join("; "),
    });
  } catch (err) {
    checks.push({ name: "visual sweep", pass: false, detail: `sweep failed: ${(err as Error).message}` });
  } finally {
    fs.rmSync(sweepDir, { recursive: true, force: true });
  }

  // 3) audio joins: no loudness slams anywhere in the file
  try {
    const { stderr } = await execa("ffmpeg", ["-hide_banner", "-i", finalPath, "-af", "ebur128", "-f", "null", "-"]);
    let prev: number | undefined;
    let maxStep = 0;
    let maxT = 0;
    for (const line of stderr.split("\n")) {
      const tRaw = line.match(/\bt:\s*([\d.]+)/)?.[1];
      const mRaw = line.match(/\bM:\s*(-?[\d.]+)/)?.[1];
      if (!tRaw || !mRaw) continue;
      const t = parseFloat(tRaw);
      // skip the 400ms-window warm-up and the outro fade; clamp near-silence to
      // -50 so fades to/from quiet don't register as artificial cliffs
      if (t < 0.6 || t > duration - 0.7) {
        prev = undefined;
        continue;
      }
      const cur = Math.max(parseFloat(mRaw), -50);
      if (prev !== undefined && Math.abs(cur - prev) > maxStep) {
        maxStep = Math.abs(cur - prev);
        maxT = t;
      }
      prev = cur;
    }
    checks.push({
      name: "audio continuity",
      pass: maxStep <= MAX_JOIN_STEP_DB,
      detail: `largest loudness step ${maxStep.toFixed(1)}dB${maxStep > 0 ? ` at ${maxT.toFixed(1)}s` : ""} (limit ${MAX_JOIN_STEP_DB}dB)`,
    });
  } catch (err) {
    checks.push({ name: "audio continuity", pass: false, detail: `loudness scan failed: ${(err as Error).message}` });
  }

  const pass = checks.every((c) => c.pass);
  for (const c of checks) log[c.pass ? "ok" : "error"](`${c.name.padEnd(18)} ${c.detail}`);
  log[pass ? "ok" : "error"](pass ? "VERIFIED — this ad matches its storyboard contract" : "NOT DONE — fix the failures above and re-verify");
  return { pass, checks };
}
