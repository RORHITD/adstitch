import path from "node:path";
import type { Storyboard } from "../types.js";
import type { Provider } from "../providers/types.js";
import type { Config } from "../config.js";
import type { Project } from "./state.js";
import { loadManifest, saveManifest, isFresh, recordArtifact } from "./state.js";
import { keyframePrompt } from "./prompts.js";
import type { Cast } from "./cast.js";
import { referenceSet } from "./cast.js";
import { hashInputs } from "../util/fs.js";
import { log, pLimit } from "../util/log.js";

export interface BeatFrames {
  /** exact first frame for this beat's video call */
  firstPath: string;
  /** exact last frame — only set when this beat frame-matches into the next */
  lastPath?: string;
  /** true when firstPath is a boundary frame shared with the previous beat */
  reusedBoundary: boolean;
}

/**
 * The continuity map. For transitionOut="match", ONE boundary image serves as
 * beat i's lastFrame AND beat i+1's firstFrame — so the cut lands on the exact
 * same pixels and the join is invisible. For "cut", each beat gets its own
 * start frame (new angle, same locked identity/scene).
 */
export function beatFrames(project: Project, sb: Storyboard): BeatFrames[] {
  const kf = (name: string) => path.join(project.keyframesDir, name);
  return sb.beats.map((beat, i) => {
    const prevMatch = i > 0 && sb.beats[i - 1].transitionOut === "match";
    const firstPath = prevMatch
      ? kf(`b${i - 1}-${sb.beats[i - 1].id}-to-${beat.id}.png`)
      : kf(`b${i}-${beat.id}-start.png`);
    const lastPath =
      beat.transitionOut === "match" && i + 1 < sb.beats.length
        ? kf(`b${i}-${beat.id}-to-${sb.beats[i + 1].id}.png`)
        : undefined;
    return { firstPath, lastPath, reusedBoundary: prevMatch };
  });
}

export async function generateKeyframes(
  project: Project,
  sb: Storyboard,
  cast: Cast,
  provider: Provider,
  cfg: Config,
  force = false,
): Promise<void> {
  const manifest = loadManifest(project);
  const frames = beatFrames(project, sb);
  const refs = referenceSet(cast);
  const model = cfg.defaults.useHqKeyframes ? cfg.models.imageHq : cfg.models.image;
  const imageCost = provider.name === "mock" ? 0 : (cfg.pricing.imagePerImage[model] ?? 0.1);
  const aspect = cfg.defaults.aspectRatio;
  const limit = pLimit(cfg.defaults.concurrency);

  // collect the unique images to produce (boundary frames appear once)
  const jobs: Array<{ id: string; outPath: string; framePrompt: string }> = [];
  sb.beats.forEach((beat, i) => {
    if (!frames[i].reusedBoundary) {
      jobs.push({ id: `keyframe/${beat.id}-start`, outPath: frames[i].firstPath, framePrompt: beat.startFramePrompt });
    }
    if (frames[i].lastPath) {
      if (!beat.endFramePrompt) {
        throw new Error(`beat "${beat.id}" has transitionOut=match but no endFramePrompt — re-run: adstitch plan ${project.name} --force`);
      }
      jobs.push({ id: `keyframe/${beat.id}-boundary`, outPath: frames[i].lastPath, framePrompt: beat.endFramePrompt });
    }
  });

  let generated = 0;
  await Promise.all(
    jobs.map((job) =>
      limit(async () => {
        const prompt = keyframePrompt(sb, job.framePrompt, aspect);
        const inputHash = hashInputs({ prompt, model, aspect }, refs);
        if (!force && isFresh(manifest, job.id, inputHash)) {
          log.dim(`${job.id} unchanged — skipping`);
          return;
        }
        log.info(`keyframe ${path.basename(job.outPath)} (${model})`);
        await provider.generateImage({ model, prompt, aspectRatio: aspect, referenceImagePaths: refs, outPath: job.outPath });
        recordArtifact(manifest, job.id, { inputHash, path: job.outPath, model, costUsd: imageCost },
          { kind: "image", model, detail: job.id, costUsd: imageCost });
        generated++;
      }),
    ),
  );

  saveManifest(project, manifest);
  log.ok(`keyframes ready (${generated} generated, ${jobs.length - generated} cached) → ${project.keyframesDir}`);
}

/** number of unique keyframe images a storyboard needs (for cost estimates) */
export function keyframeCount(project: Project, sb: Storyboard): number {
  const frames = beatFrames(project, sb);
  return frames.filter((f) => !f.reusedBoundary).length + frames.filter((f) => f.lastPath).length;
}
