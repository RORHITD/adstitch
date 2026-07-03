import fs from "node:fs";
import type { Storyboard } from "../types.js";
import type { Config } from "../config.js";
import type { Project } from "./state.js";
import { loadManifest, spentUsd, isFresh } from "./state.js";
import { keyframeJobs, keyframeInputHash } from "./keyframes.js";
import { buildSegmentPlans, segmentInputHash, segmentArtifactId } from "./videos.js";
import { castPaths, referenceSet } from "./cast.js";
import { castPersonaPrompt, castProductPrompt, keyframePrompt } from "./prompts.js";
import { findAssets, hashInputs } from "../util/fs.js";
import { log } from "../util/log.js";

export interface Estimate {
  rows: Array<{ item: string; detail: string; usd: number }>;
  totalUsd: number;
  cachedCount: number;
}

/**
 * Cache-aware estimate: anything whose inputs are unchanged (per the same
 * hashes the renderers use) is excluded, so resume/regen runs quote only what
 * will actually be billed.
 */
export function estimateRun(
  project: Project,
  sb: Storyboard,
  cfg: Config,
  videoModel: string,
  variants: Record<string, number> = {},
  beats?: string[],
): Estimate {
  const manifest = loadManifest(project);
  const rows: Estimate["rows"] = [];
  let cachedCount = 0;

  const imageModel = cfg.defaults.useHqKeyframes ? cfg.models.imageHq : cfg.models.image;
  const imageRate = cfg.pricing.imagePerImage[imageModel] ?? 0.1;
  const videoRate = cfg.pricing.videoPerSecond[videoModel] ?? 0.4;
  const aspect = cfg.defaults.aspectRatio;
  const cast = castPaths(project);
  const refs = referenceSet(cast);

  // cast references — only when not user-supplied and not already generated from these inputs
  let castPending = 0;
  if (!findAssets(project.assetsDir, "persona").length) {
    const hash = hashInputs({ prompt: castPersonaPrompt(sb, aspect), model: imageModel, aspect });
    isFresh(manifest, "cast/persona", hash) ? cachedCount++ : castPending++;
  }
  if (!findAssets(project.assetsDir, "product").length) {
    const hash = hashInputs({ prompt: castProductPrompt(sb, aspect), model: imageModel, aspect });
    isFresh(manifest, "cast/product", hash) ? cachedCount++ : castPending++;
  }

  // keyframes
  let kfPending = 0;
  for (const job of keyframeJobs(project, sb)) {
    const hash = keyframeInputHash(keyframePrompt(sb, job.framePrompt, aspect), imageModel, aspect, refs);
    isFresh(manifest, job.id, hash) ? cachedCount++ : kfPending++;
  }
  const imagesPending = castPending + kfPending;
  if (imagesPending > 0) {
    rows.push({ item: "keyframes+refs", detail: `${imagesPending} image(s) × ${imageModel}`, usd: imagesPending * imageRate });
  }

  // video segments
  const plans = buildSegmentPlans(project, sb, cfg, { beats, variants, model: videoModel });
  const byBeat = new Map<string, { pending: number; cached: number; seconds: number }>();
  for (const plan of plans) {
    const entry = byBeat.get(plan.beat.id) ?? { pending: 0, cached: 0, seconds: plan.beat.durationSeconds };
    const fresh =
      isFresh(manifest, segmentArtifactId(plan), segmentInputHash(plan, cfg, videoModel)) &&
      fs.existsSync(plan.firstFramePath); // missing keyframes ⇒ hash can't be trusted as final
    fresh ? entry.cached++ : entry.pending++;
    byBeat.set(plan.beat.id, entry);
  }
  for (const [beatId, e] of byBeat) {
    cachedCount += e.cached;
    if (e.pending === 0) continue;
    const cachedNote = e.cached ? ` (${e.cached} cached)` : "";
    rows.push({
      item: `video/${beatId}`,
      detail: `${e.seconds}s × ${e.pending} take${e.pending > 1 ? "s" : ""}${cachedNote} × ${videoModel}`,
      usd: e.seconds * e.pending * videoRate,
    });
  }

  return { rows, totalUsd: rows.reduce((s, r) => s + r.usd, 0), cachedCount };
}

export function printEstimate(est: Estimate, opts: { qcReroll?: boolean } = {}): void {
  for (const r of est.rows) log.dim(`${r.item.padEnd(18)} ${r.detail.padEnd(52)} ~$${r.usd.toFixed(2)}`);
  if (est.cachedCount) log.dim(`${est.cachedCount} artifact(s) already up to date — not billed again`);
  if (est.totalUsd === 0) {
    log.money("estimated spend: $0.00 — everything is cached");
  } else {
    log.money(`estimated spend: ~$${est.totalUsd.toFixed(2)}  (rates from config "pricing" — verify current pricing)`);
    if (opts.qcReroll) log.dim("+ up to 1 auto-QC re-roll per failed segment (same per-segment rate; --no-qc to disable)");
  }
}

export function printLedger(project: Project): void {
  const manifest = loadManifest(project);
  if (!manifest.ledger.length) {
    log.info("no spend recorded yet");
    return;
  }
  for (const e of manifest.ledger) {
    log.dim(`${e.at}  ${e.kind.padEnd(5)} ${e.detail.padEnd(28)} ${e.model.padEnd(32)} $${e.costUsd.toFixed(3)}`);
  }
  log.money(`total recorded spend: $${spentUsd(manifest).toFixed(2)}`);
}
