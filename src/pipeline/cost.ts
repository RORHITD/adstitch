import type { Storyboard } from "../types.js";
import type { Config } from "../config.js";
import type { Project } from "./state.js";
import { loadManifest, spentUsd } from "./state.js";
import { keyframeCount } from "./keyframes.js";
import { log } from "../util/log.js";

export interface Estimate {
  rows: Array<{ item: string; detail: string; usd: number }>;
  totalUsd: number;
}

export function estimateRun(
  project: Project,
  sb: Storyboard,
  cfg: Config,
  videoModel: string,
  variants: Record<string, number> = {},
  beats?: string[],
): Estimate {
  const rows: Estimate["rows"] = [];
  const imageModel = cfg.defaults.useHqKeyframes ? cfg.models.imageHq : cfg.models.image;
  const imageRate = cfg.pricing.imagePerImage[imageModel] ?? 0.1;
  const videoRate = cfg.pricing.videoPerSecond[videoModel] ?? 0.4;

  const kfCount = keyframeCount(project, sb) + 2; // + persona & product refs (skipped if user supplies assets)
  rows.push({ item: "keyframes+refs", detail: `≤${kfCount} images × ${imageModel}`, usd: kfCount * imageRate });

  for (const beat of sb.beats) {
    if (beats && !beats.includes(beat.id)) continue;
    const takes = Math.max(1, variants[beat.id] ?? 1);
    rows.push({
      item: `video/${beat.id}`,
      detail: `${beat.durationSeconds}s × ${takes} take${takes > 1 ? "s" : ""} × ${videoModel}`,
      usd: beat.durationSeconds * takes * videoRate,
    });
  }

  return { rows, totalUsd: rows.reduce((s, r) => s + r.usd, 0) };
}

export function printEstimate(est: Estimate): void {
  for (const r of est.rows) log.dim(`${r.item.padEnd(18)} ${r.detail.padEnd(52)} ~$${r.usd.toFixed(2)}`);
  log.money(`estimated spend: ~$${est.totalUsd.toFixed(2)}  (rates from config "pricing" — verify current pricing)`);
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
