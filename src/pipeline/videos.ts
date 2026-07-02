import fs from "node:fs";
import path from "node:path";
import type { SegmentPlan, Storyboard } from "../types.js";
import type { Provider } from "../providers/types.js";
import type { Config } from "../config.js";
import type { Project } from "./state.js";
import { loadManifest, saveManifest, isFresh, recordArtifact } from "./state.js";
import { videoPrompt, DEFAULT_NEGATIVE_PROMPT } from "./prompts.js";
import { beatFrames } from "./keyframes.js";
import type { Cast } from "./cast.js";
import { referenceSet } from "./cast.js";
import { hashInputs } from "../util/fs.js";
import { log, pLimit } from "../util/log.js";

export interface VideoRunOptions {
  /** restrict to these beat ids (default: all) */
  beats?: string[];
  /** extra takes per beat id, e.g. { hook: 3 } renders hook, hook@2, hook@3 */
  variants?: Record<string, number>;
  model: string;
  force?: boolean;
}

export function segmentPath(project: Project, sb: Storyboard, beatId: string, variant = 1): string {
  const i = sb.beats.findIndex((b) => b.id === beatId);
  const suffix = variant > 1 ? `@${variant}` : "";
  return path.join(project.segmentsDir, `${String(i).padStart(2, "0")}-${beatId}${suffix}.mp4`);
}

export function seedFor(variant: number): number | undefined {
  return variant > 1 ? 1000 + variant * 7919 : undefined;
}

/** the exact inputs that determine a segment — shared by renderer and cost estimator */
export function segmentInputHash(plan: SegmentPlan, cfg: Config, model: string, veoRefs: string[] = []): string {
  const params = {
    prompt: plan.prompt,
    negativePrompt: plan.negativePrompt,
    model,
    duration: plan.beat.durationSeconds,
    aspectRatio: cfg.defaults.aspectRatio,
    resolution: cfg.defaults.resolution,
    personGeneration: cfg.defaults.personGeneration,
    seed: seedFor(plan.variant),
    veoRefs,
  };
  return hashInputs(params, [plan.firstFramePath, ...(plan.lastFramePath ? [plan.lastFramePath] : []), ...veoRefs]);
}

export function segmentArtifactId(plan: SegmentPlan): string {
  return `segment/${plan.beat.id}${plan.variant > 1 ? `@${plan.variant}` : ""}`;
}

export function buildSegmentPlans(project: Project, sb: Storyboard, cfg: Config, opts: VideoRunOptions): SegmentPlan[] {
  const frames = beatFrames(project, sb);
  const plans: SegmentPlan[] = [];
  sb.beats.forEach((beat, i) => {
    if (opts.beats && !opts.beats.includes(beat.id)) return;
    const takes = Math.max(1, opts.variants?.[beat.id] ?? 1);
    for (let v = 1; v <= takes; v++) {
      plans.push({
        beat,
        index: i,
        variant: v,
        firstFramePath: frames[i].firstPath,
        lastFramePath: frames[i].lastPath,
        prompt: videoPrompt(sb, beat, cfg.defaults.aspectRatio),
        negativePrompt: DEFAULT_NEGATIVE_PROMPT,
        outPath: segmentPath(project, sb, beat.id, v),
      });
    }
  });
  return plans;
}

export async function generateSegments(
  project: Project,
  sb: Storyboard,
  cast: Cast,
  provider: Provider,
  cfg: Config,
  opts: VideoRunOptions,
): Promise<{ generated: number; cached: number }> {
  const manifest = loadManifest(project);
  const plans = buildSegmentPlans(project, sb, cfg, opts);
  const limit = pLimit(cfg.defaults.concurrency);
  const isMock = provider.name === "mock";
  if (!isMock && cfg.pricing.videoPerSecond[opts.model] === undefined) {
    log.warn(`no pricing entry for "${opts.model}" — estimating at $0.40/s. Add it to adstitch.config.json "pricing.videoPerSecond" (and check the model still exists: adstitch models).`);
  }
  const rate = isMock ? 0 : (cfg.pricing.videoPerSecond[opts.model] ?? 0.4);

  // 1080p renders require 8s clips on the Gemini API — fail before spending, not mid-run
  if (cfg.defaults.resolution === "1080p") {
    const bad = plans.filter((p) => p.beat.durationSeconds !== 8);
    if (bad.length) {
      throw new Error(`1080p requires 8s clips, but beats [${[...new Set(bad.map((p) => p.beat.id))].join(", ")}] are shorter — use resolution "720p" or an all-8s template.`);
    }
  }

  // Veo reference images can't be combined with first-frame conditioning, and
  // every adstitch segment is first-frame conditioned. Identity comes from the
  // keyframes (which DO use the references).
  if (cfg.defaults.videoReferenceImages) {
    log.warn(`videoReferenceImages is enabled but incompatible with first-frame conditioning — ignoring (cast refs still shape every keyframe)`);
  }
  const veoRefs = undefined;

  // frame-matched beats can still generate IN PARALLEL because boundary
  // keyframes exist up front — no waiting on the previous segment to render.
  let generated = 0;
  let cached = 0;
  await Promise.all(
    plans.map((plan) =>
      limit(async () => {
        for (const f of [plan.firstFramePath, plan.lastFramePath]) {
          if (f && !fs.existsSync(f)) throw new Error(`missing keyframe ${f} — run: adstitch keyframes ${project.name}`);
        }
        const artifactId = segmentArtifactId(plan);
        const seed = seedFor(plan.variant);
        const inputHash = segmentInputHash(plan, cfg, opts.model, veoRefs);
        if (!opts.force && isFresh(manifest, artifactId, inputHash)) {
          log.dim(`${artifactId} unchanged — skipping`);
          cached++;
          return;
        }

        const cost = plan.beat.durationSeconds * rate;
        log.info(`rendering ${artifactId} (${plan.beat.durationSeconds}s, ${opts.model}${plan.lastFramePath ? ", first+last frame" : ", first frame"})${rate ? ` ~$${cost.toFixed(2)}` : ""}`);
        const result = await provider.generateVideo({
          model: opts.model,
          prompt: plan.prompt,
          negativePrompt: plan.negativePrompt,
          firstFramePath: plan.firstFramePath,
          lastFramePath: plan.lastFramePath,
          referenceImagePaths: veoRefs,
          durationSeconds: plan.beat.durationSeconds,
          aspectRatio: cfg.defaults.aspectRatio,
          resolution: cfg.defaults.resolution,
          personGeneration: cfg.defaults.personGeneration,
          seed,
          outPath: plan.outPath,
          pollIntervalMs: cfg.defaults.pollIntervalMs,
          timeoutMs: cfg.defaults.videoTimeoutMs,
        });
        const recModel = isMock ? "mock" : opts.model;
        recordArtifact(manifest, artifactId, { inputHash, path: plan.outPath, model: recModel, costUsd: cost, remoteUri: result.remoteUri },
          { kind: "video", model: recModel, detail: artifactId, costUsd: cost });
        saveManifest(project, manifest); // persist as we go — a crash shouldn't lose paid renders
        generated++;
        log.ok(`${artifactId} → ${plan.outPath}`);
      }),
    ),
  );

  saveManifest(project, manifest);
  return { generated, cached };
}
