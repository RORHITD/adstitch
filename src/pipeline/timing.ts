import path from "node:path";
import { execa } from "execa";
import type { Provider } from "../providers/types.js";
import type { Config } from "../config.js";
import type { Project } from "./state.js";
import { loadManifest, saveManifest, recordArtifact } from "./state.js";
import { ffprobeDuration } from "../util/ffmpeg.js";
import { hashInputs } from "../util/fs.js";
import { log } from "../util/log.js";

// Where does she actually start and stop talking in each clip? Veo places
// speech unpredictably inside the clip; every editing decision that cuts or
// ramps a clip must be speech-aware or it clips words / leaves dead air.
//
// Detection is LOCAL and deterministic: measured Veo clips put speech ~15 dB
// above room ambience (speech ≈ -13..-16 dB momentary, ambience ≈ -30..-35 dB),
// so silencedetect at -24 dB cleanly separates "someone is talking" from
// "ambience only". (An LLM listening to the clip could not — it reported
// ambience tails as speech.)

export interface SpeechSpan {
  speechStart: number;
  speechEnd: number;
  duration: number;
}

const DETECTOR = "ebur128-adaptive v1";

/**
 * Momentary-loudness (EBU R128, 400ms window) curve with a per-clip adaptive
 * threshold. Fixed-threshold silencedetect fails here twice over: raw ambience
 * levels vary per clip, and ambience PEAK transients poke above any fixed
 * floor even when the momentary loudness sits 15+ dB below speech.
 */
async function detectSpan(file: string, duration: number): Promise<{ speechStart: number; speechEnd: number }> {
  const { stderr } = await execa("ffmpeg", ["-hide_banner", "-i", file, "-af", "ebur128", "-f", "null", "-"]);
  const points: Array<{ t: number; m: number }> = [];
  for (const line of stderr.split("\n")) {
    const t = line.match(/\bt:\s*([\d.]+)/)?.[1];
    const m = line.match(/\bM:\s*(-?[\d.]+)/)?.[1];
    if (t && m) points.push({ t: parseFloat(t), m: parseFloat(m) });
  }
  if (points.length < 5) return { speechStart: 0, speechEnd: duration };

  const levels = points.map((p) => p.m);
  const peak = Math.max(...levels);
  const floor = Math.min(...levels);
  if (peak - floor < 8) return { speechStart: 0, speechEnd: duration }; // no speech/ambience separation

  const thr = Math.max(peak - 11, floor + 5);
  const loud = points.filter((p) => p.m >= thr);
  if (!loud.length) return { speechStart: 0, speechEnd: duration };

  // the 400ms window lags reality: first loud M means audio began ~0.4s earlier
  const speechStart = Math.max(0, loud[0].t - 0.45);
  const speechEnd = Math.min(duration, Math.max(loud[loud.length - 1].t - 0.1, speechStart + 0.3));
  return { speechStart, speechEnd };
}

export async function speechSpan(
  project: Project,
  segmentPath: string,
  _provider: Provider | undefined,
  cfg: Config,
): Promise<SpeechSpan> {
  const manifest = loadManifest(project);
  const duration = await ffprobeDuration(segmentPath);
  const id = `timing/${path.basename(segmentPath, ".mp4")}`;
  const inputHash = hashInputs({ kind: "speech-timing", detector: DETECTOR }, [segmentPath]);

  const cached = manifest.artifacts[id];
  if (cached && cached.inputHash === inputHash && cached.timing) {
    return { ...cached.timing, duration };
  }

  let span: { speechStart: number; speechEnd: number };
  try {
    span = await detectSpan(segmentPath, duration);
  } catch (err) {
    log.warn(`speech timing failed for ${path.basename(segmentPath)} (${(err as Error).message}) — assuming speech spans the full clip`);
    span = { speechStart: 0, speechEnd: duration };
  }

  recordArtifact(manifest, id, { inputHash, path: segmentPath, model: "ebur128", costUsd: 0, timing: span },
    { kind: "text", model: "ebur128", detail: id, costUsd: 0 });
  saveManifest(project, manifest);
  return { ...span, duration };
}
