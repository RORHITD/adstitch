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

/** start frame for a scripted alternate take (variant ≥ 2). `.altN` files are
 *  same-prompt candidate redraws; `@N` files are different scripted content. */
export function altStartPath(project: Project, beatIndex: number, beatId: string, variant: number): string {
  return path.join(project.keyframesDir, `b${beatIndex}-${beatId}-start@${variant}.png`);
}

export interface KeyframeJob {
  id: string;
  outPath: string;
  framePrompt: string;
  beatIndex: number;
  /** boundary frames belong to beatIndex AND beatIndex+1 for filtering */
  boundary: boolean;
}

/**
 * Every unique keyframe image a storyboard needs (boundary frames appear once;
 * alternate takes get their own start frames). Single source of truth for the
 * generator, the cost estimator, and status.
 */
export function keyframeJobs(project: Project, sb: Storyboard): KeyframeJob[] {
  const frames = beatFrames(project, sb);
  const jobs: KeyframeJob[] = [];
  sb.beats.forEach((beat, i) => {
    if (beat.alternates?.length && frames[i].reusedBoundary) {
      throw new Error(
        `beat "${beat.id}" starts on a shared boundary frame (previous beat is "match") and cannot have alternate openings — remove its alternates or change the previous beat's transition`,
      );
    }
    if (!frames[i].reusedBoundary) {
      jobs.push({ id: `keyframe/${beat.id}-start`, outPath: frames[i].firstPath, framePrompt: beat.startFramePrompt, beatIndex: i, boundary: false });
    }
    beat.alternates?.forEach((alt, k) => {
      const v = k + 2;
      jobs.push({ id: `keyframe/${beat.id}-start@${v}`, outPath: altStartPath(project, i, beat.id, v), framePrompt: alt.startFramePrompt, beatIndex: i, boundary: false });
    });
    if (frames[i].lastPath) {
      if (!beat.endFramePrompt) {
        throw new Error(`beat "${beat.id}" has transitionOut=match but no endFramePrompt — re-run: adstitch plan ${project.name} --force`);
      }
      jobs.push({ id: `keyframe/${beat.id}-boundary`, outPath: frames[i].lastPath, framePrompt: beat.endFramePrompt, beatIndex: i, boundary: true });
    }
  });
  return jobs;
}

/** the exact inputs that determine a keyframe — shared by renderer and cost estimator */
export function keyframeInputHash(prompt: string, model: string, aspect: string, refs: string[]): string {
  return hashInputs({ prompt, model, aspect }, refs);
}

export async function generateKeyframes(
  project: Project,
  sb: Storyboard,
  cast: Cast,
  provider: Provider,
  cfg: Config,
  force = false,
  /** restrict to these beat ids — cheap creative preview before generating everything */
  onlyBeats?: string[],
  /** generate N alternates per start frame (same prompt, natural variation) — pick by
   * overwriting the primary file; downstream hashes track file content automatically */
  candidates = 1,
): Promise<void> {
  const manifest = loadManifest(project);
  const refs = referenceSet(cast);
  const model = cfg.defaults.useHqKeyframes ? cfg.models.imageHq : cfg.models.image;
  const isMock = provider.name === "mock";
  const imageCost = isMock ? 0 : (cfg.pricing.imagePerImage[model] ?? 0.1);
  const recModel = isMock ? "mock" : model;
  const aspect = cfg.defaults.aspectRatio;
  const limit = pLimit(cfg.defaults.concurrency);

  const wanted = (i: number) => !onlyBeats || (i < sb.beats.length && onlyBeats.includes(sb.beats[i].id));
  const jobs = keyframeJobs(project, sb).filter((j) => (j.boundary ? wanted(j.beatIndex) || wanted(j.beatIndex + 1) : wanted(j.beatIndex)));

  let generated = 0;
  await Promise.all(
    jobs.map((job) =>
      limit(async () => {
        const prompt = keyframePrompt(sb, job.framePrompt, aspect);
        const inputHash = keyframeInputHash(prompt, model, aspect, refs);
        if (!force && isFresh(manifest, job.id, inputHash)) {
          log.dim(`${job.id} unchanged — skipping`);
          return;
        }
        log.info(`keyframe ${path.basename(job.outPath)} (${model})`);
        await provider.generateImage({ model, prompt, aspectRatio: aspect, referenceImagePaths: refs, outPath: job.outPath });
        recordArtifact(manifest, job.id, { inputHash, path: job.outPath, model: recModel, costUsd: imageCost },
          { kind: "image", model: recModel, detail: job.id, costUsd: imageCost });
        generated++;

        // alternates are throwaway picks — ledger-tracked, never freshness-tracked
        for (let alt = 2; alt <= candidates; alt++) {
          const altPath = job.outPath.replace(/\.png$/, `.alt${alt}.png`);
          log.info(`keyframe ${path.basename(altPath)} (candidate ${alt}/${candidates})`);
          await provider.generateImage({ model, prompt, aspectRatio: aspect, referenceImagePaths: refs, outPath: altPath });
          manifest.ledger.push({ at: new Date().toISOString(), kind: "image", model: recModel, detail: `${job.id}.alt${alt}`, costUsd: imageCost });
        }
        if (candidates > 1) {
          log.info(`pick a winner: cp ${path.basename(job.outPath).replace(/\.png$/, ".altN.png")} over ${path.basename(job.outPath)} — segments re-render from whichever file wins`);
        }
      }),
    ),
  );

  saveManifest(project, manifest);
  log.ok(`keyframes ready (${generated} generated, ${jobs.length - generated} cached) → ${project.keyframesDir}`);
}

/** number of unique keyframe images a storyboard needs (for cost estimates) */
export function keyframeCount(project: Project, sb: Storyboard): number {
  return keyframeJobs(project, sb).length;
}
