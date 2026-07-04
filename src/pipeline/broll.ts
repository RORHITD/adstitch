import fs from "node:fs";
import path from "node:path";
import type { Storyboard } from "../types.js";
import type { Provider } from "../providers/types.js";
import type { Config } from "../config.js";
import type { Project } from "./state.js";
import { loadManifest, saveManifest, isFresh, recordArtifact } from "./state.js";
import { castPaths } from "./cast.js";
import { hashInputs } from "../util/fs.js";
import { log } from "../util/log.js";

// Person-free product close-ups used as cutaway inserts between talking beats
// (stitch --style tight --cutaways). A 0.7s insert hides any pose jump — the
// editor's universal solvent — while the audio flows underneath.

const BROLL_SECONDS = 4;

function brollPrompts(sb: Storyboard): string[] {
  const s = sb.style;
  const productLine = sb.campaign.product.description;
  return [
    `Slow cinematic push-in, macro product b-roll: ${productLine} Setting: ${s.setting}. Lighting: ${s.lighting}. Locked-off then gentle push toward the product. NO people, NO hands, NO text or logos anywhere. Audio: quiet natural room ambience only, no music, no voices.`,
    `Gentle low-angle orbit, shallow depth of field product b-roll: ${productLine} The colors catch the light: ${s.lighting}. Setting: ${s.setting}. NO people, NO hands, NO text or logos anywhere. Audio: quiet natural room ambience only, no music, no voices.`,
  ];
}

export function brollPaths(project: Project, count = 2): string[] {
  return Array.from({ length: count }, (_, i) => path.join(project.segmentsDir, `broll-${i + 1}.mp4`));
}

export async function generateBroll(
  project: Project,
  sb: Storyboard,
  provider: Provider,
  cfg: Config,
  opts: { count?: number; model: string; force?: boolean },
): Promise<string[]> {
  const manifest = loadManifest(project);
  const count = Math.min(opts.count ?? 2, 2);
  const prompts = brollPrompts(sb).slice(0, count);
  const isMock = provider.name === "mock";
  const rate = isMock ? 0 : (cfg.pricing.videoPerSecond[opts.model] ?? 0.4);
  const productRef = castPaths(project).productRefs[0];
  const firstFrame = fs.existsSync(productRef) ? productRef : undefined;
  const outs: string[] = [];

  for (let i = 0; i < prompts.length; i++) {
    const outPath = brollPaths(project, count)[i];
    const artifactId = `broll/${i + 1}`;
    const inputHash = hashInputs(
      { prompt: prompts[i], model: opts.model, duration: BROLL_SECONDS, aspectRatio: cfg.defaults.aspectRatio, resolution: cfg.defaults.resolution },
      firstFrame ? [firstFrame] : [],
    );
    if (!opts.force && isFresh(manifest, artifactId, inputHash)) {
      log.dim(`${artifactId} unchanged — skipping`);
      outs.push(outPath);
      continue;
    }
    const cost = BROLL_SECONDS * rate;
    log.info(`rendering ${artifactId} (${BROLL_SECONDS}s product cutaway, ${opts.model})${rate ? ` ~$${cost.toFixed(2)}` : ""}`);
    const result = await provider.generateVideo({
      model: opts.model,
      prompt: prompts[i],
      firstFramePath: firstFrame,
      durationSeconds: BROLL_SECONDS,
      aspectRatio: cfg.defaults.aspectRatio,
      resolution: cfg.defaults.resolution,
      personGeneration: cfg.defaults.personGeneration,
      outPath,
      pollIntervalMs: cfg.defaults.pollIntervalMs,
      timeoutMs: cfg.defaults.videoTimeoutMs,
    });
    const recModel = isMock ? "mock" : opts.model;
    recordArtifact(manifest, artifactId, { inputHash, path: outPath, model: recModel, costUsd: cost, remoteUri: result.remoteUri },
      { kind: "video", model: recModel, detail: artifactId, costUsd: cost });
    saveManifest(project, manifest);
    outs.push(outPath);
  }
  return outs;
}
