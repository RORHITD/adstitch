import fs from "node:fs";
import path from "node:path";
import type { SegmentPlan, Storyboard, Beat } from "../types.js";
import type { Provider } from "../providers/types.js";
import type { Config } from "../config.js";
import type { Project } from "./state.js";
import { loadManifest, saveManifest, isFresh, recordArtifact } from "./state.js";
import { videoPrompt, DEFAULT_NEGATIVE_PROMPT } from "./prompts.js";
import { beatFrames, altStartPath } from "./keyframes.js";
import type { Cast } from "./cast.js";
import { qcSegment } from "./qc.js";
import { hashInputs } from "../util/fs.js";
import { log, pLimit } from "../util/log.js";

export interface VideoRunOptions {
  /** restrict to these beat ids (default: all) */
  beats?: string[];
  /** takes per beat id, e.g. { hook: 3 }. Takes v>1 render scripted alternates
   * when the beat has them (different line + own keyframe); otherwise fall back
   * to seed re-rolls of the base prompt. */
  variants?: Record<string, number>;
  model: string;
  force?: boolean;
  /** override config qc.enabled (--no-qc) */
  qc?: boolean;
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
    seed: plan.seed,
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
    if (beat.alternates?.length && frames[i].reusedBoundary) {
      throw new Error(
        `beat "${beat.id}" starts on a shared boundary frame (previous beat is "match") and cannot have alternate openings`,
      );
    }
    const takes = Math.max(1, opts.variants?.[beat.id] ?? 1);
    for (let v = 1; v <= takes; v++) {
      const alt = v > 1 ? beat.alternates?.[v - 2] : undefined;
      // effective beat: alternate content merged over the base (duration/transition stay base)
      const effBeat: Beat = alt
        ? { ...beat, dialogue: alt.dialogue, action: alt.action, camera: alt.camera, emotion: alt.emotion, startFramePrompt: alt.startFramePrompt }
        : beat;
      plans.push({
        beat: effBeat,
        index: i,
        variant: v,
        firstFramePath: alt ? altStartPath(project, i, beat.id, v) : frames[i].firstPath,
        lastFramePath: frames[i].lastPath,
        prompt: videoPrompt(sb, effBeat, cfg.defaults.aspectRatio),
        negativePrompt: DEFAULT_NEGATIVE_PROMPT,
        outPath: segmentPath(project, sb, beat.id, v),
        // alternates vary by content — a seed re-roll is only for identical prompts
        seed: alt ? undefined : seedFor(v),
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
  const qcEnabled = opts.qc ?? cfg.qc.enabled;
  const qcScratch = path.join(project.segmentsDir, ".qc");

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

  const renderOnce = (plan: SegmentPlan, outPath: string, seed: number | undefined) =>
    provider.generateVideo({
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
      outPath,
      pollIntervalMs: cfg.defaults.pollIntervalMs,
      timeoutMs: cfg.defaults.videoTimeoutMs,
    });

  let generated = 0;
  let cached = 0;
  // one segment's failure must never abort siblings mid-render — in-flight Veo
  // operations are already billed server-side and their downloads would be lost
  const failures: Array<{ artifactId: string; message: string }> = [];
  await Promise.all(
    plans.map((plan) =>
      limit(async () => {
        const failId = segmentArtifactId(plan);
        try {
          await renderPlan(plan);
        } catch (err) {
          log.error(`${failId} failed: ${(err as Error).message}`);
          failures.push({ artifactId: failId, message: (err as Error).message });
        }
      }),
    ),
  );

  async function renderPlan(plan: SegmentPlan): Promise<void> {
    {
        for (const f of [plan.firstFramePath, plan.lastFramePath]) {
          if (f && !fs.existsSync(f)) throw new Error(`missing keyframe ${f} — run: adstitch keyframes ${project.name}`);
        }
        const artifactId = segmentArtifactId(plan);
        // canonical hash — a QC re-roll changes the actual seed but must NOT
        // change this hash, or the segment re-bills on every subsequent run
        const inputHash = segmentInputHash(plan, cfg, opts.model, veoRefs);
        if (!opts.force && isFresh(manifest, artifactId, inputHash)) {
          log.dim(`${artifactId} unchanged — skipping`);
          cached++;
          return;
        }

        const cost = plan.beat.durationSeconds * rate;
        const recModel = isMock ? "mock" : opts.model;
        log.info(`rendering ${artifactId} (${plan.beat.durationSeconds}s, ${opts.model}${plan.lastFramePath ? ", first+last frame" : ", first frame"})${rate ? ` ~$${cost.toFixed(2)}` : ""}`);
        let result = await renderOnce(plan, plan.outPath, plan.seed);
        manifest.ledger.push({ at: new Date().toISOString(), kind: "video", model: recModel, detail: artifactId, costUsd: cost });
        let actualSeed = plan.seed;

        let qc: { pass: boolean; reasons: string[]; attempts: number } | undefined;
        if (qcEnabled) {
          const first = await qcSegment({ videoPath: plan.outPath, plan, sb, provider, cfg, scratchDir: qcScratch });
          if (first.judgeCostUsd) manifest.ledger.push({ at: new Date().toISOString(), kind: "text", model: cfg.models.text, detail: `qc/${artifactId}`, costUsd: first.judgeCostUsd });
          qc = { pass: first.pass, reasons: first.reasons, attempts: 1 };

          if (!first.pass) {
            log.warn(`QC failed ${artifactId}: ${first.reasons.join("; ")} — re-rolling once (~$${cost.toFixed(2)})`);
            const rejectedPath = plan.outPath.replace(/\.mp4$/, ".rejected.mp4");
            fs.rmSync(rejectedPath, { force: true });
            fs.renameSync(plan.outPath, rejectedPath);
            const retakeSeed = (plan.seed ?? 0) + 104729 + plan.variant;
            result = await renderOnce(plan, plan.outPath, retakeSeed);
            actualSeed = retakeSeed;
            manifest.ledger.push({ at: new Date().toISOString(), kind: "video", model: recModel, detail: `${artifactId} (qc re-roll)`, costUsd: cost });

            const second = await qcSegment({ videoPath: plan.outPath, plan, sb, provider, cfg, scratchDir: qcScratch });
            if (second.judgeCostUsd) manifest.ledger.push({ at: new Date().toISOString(), kind: "text", model: cfg.models.text, detail: `qc/${artifactId}@retake`, costUsd: second.judgeCostUsd });
            qc = { pass: second.pass, reasons: second.reasons, attempts: 2 };
            if (!second.pass) {
              log.warn(`QC failed the retake too (${second.reasons.join("; ")}) — keeping it anyway; if unusable: adstitch regen ${project.name} ${plan.beat.id}`);
            } else {
              log.ok(`retake passed QC (rejected take kept at ${path.basename(rejectedPath)})`);
            }
          }
        }

        recordArtifact(manifest, artifactId, {
          inputHash,
          path: plan.outPath,
          model: recModel,
          costUsd: cost * (qc?.attempts ?? 1),
          remoteUri: result.remoteUri,
          ...(qc ? { qc } : {}),
          ...(actualSeed !== undefined ? { actualSeed } : {}),
        });
        saveManifest(project, manifest); // persist as we go — a crash shouldn't lose paid renders
        generated++;
        log.ok(`${artifactId} → ${plan.outPath}`);
    }
  }

  fs.rmSync(qcScratch, { recursive: true, force: true });
  saveManifest(project, manifest);
  if (failures.length) {
    throw new Error(
      `${failures.length} segment(s) failed [${failures.map((f) => f.artifactId).join(", ")}] — completed segments are saved; re-run to retry only the failures. First error: ${failures[0].message}`,
    );
  }
  return { generated, cached };
}
