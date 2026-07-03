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

/** flat estimate for one flash multimodal judge call */
export const JUDGE_COST_USD = 0.001;

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
      prompt: qcJudgePrompt(sb),
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

  for (const f of [firstFrame, midFrame, lastFrame]) fs.rmSync(f, { force: true });
  return { pass: reasons.length === 0, reasons, ssim, judgeCostUsd };
}
