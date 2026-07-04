import fs from "node:fs";
import path from "node:path";
import type { Storyboard } from "../types.js";
import type { Config } from "../config.js";
import { videoDims } from "../config.js";
import type { Project } from "./state.js";
import { loadManifest, saveManifest, recordArtifact } from "./state.js";
import { segmentPath } from "./videos.js";
import { ffmpeg, ffprobeDuration } from "../util/ffmpeg.js";
import { ensureDir } from "../util/fs.js";
import { log } from "../util/log.js";

export interface StitchOptions {
  /** "cut" = hard cuts (matched frames make these invisible); "smooth" = 0.15s crossfade */
  transition: "cut" | "smooth";
  /** pick a specific variant per beat id, e.g. { hook: 2 } uses hook@2 */
  picks?: Record<string, number>;
  musicPath?: string;
  musicVolume?: number;
  outName?: string;
  /** seconds trimmed off a clip's END at frame-matched joins (default 0.4).
   * First/last-frame conditioning makes Veo decelerate into the target frame
   * and accelerate out of it — trimming both sides cuts on action and removes
   * the slow-freeze-speed-up hiccup. Set 0 to disable. */
  trimTail?: number;
  /** seconds trimmed off a clip's START at frame-matched joins (default 0.25) */
  trimHead?: number;
}

const FADE = 0.15;
const MATCH_TRIM_TAIL = 0.4;
const MATCH_TRIM_HEAD = 0.25;

export async function stitchAd(project: Project, sb: Storyboard, cfg: Config, opts: StitchOptions): Promise<string> {
  const inputs = sb.beats.map((b) => {
    const p = segmentPath(project, sb, b.id, opts.picks?.[b.id] ?? 1);
    if (!fs.existsSync(p)) throw new Error(`missing segment ${p} — run: adstitch videos ${project.name}`);
    return p;
  });

  const { w, h } = videoDims(cfg.defaults.aspectRatio, cfg.defaults.resolution);
  const normDir = ensureDir(path.join(project.segmentsDir, ".norm"));
  ensureDir(project.finalDir);

  // 1) normalize: identical codec/fps/geometry + loudness so segments join
  // cleanly. At frame-matched joins, trim the deceleration tail / acceleration
  // head so the cut lands on continuous motion, and micro-fade audio edges to
  // kill clicks at the hard cuts.
  const trimTail = opts.trimTail ?? MATCH_TRIM_TAIL;
  const trimHead = opts.trimHead ?? MATCH_TRIM_HEAD;
  const normed: string[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const out = path.join(normDir, `n${i}.mp4`);
    const head = i > 0 && sb.beats[i - 1].transitionOut === "match" ? trimHead : 0;
    const tail = sb.beats[i].transitionOut === "match" ? trimTail : 0;
    const srcDur = await ffprobeDuration(inputs[i]);
    const keep = Math.max(1, srcDur - head - tail);
    log.dim(`normalizing ${path.basename(inputs[i])}${head || tail ? ` (trim -${head.toFixed(2)}s head / -${tail.toFixed(2)}s tail)` : ""}`);
    await ffmpeg([
      "-i", inputs[i],
      "-ss", head.toFixed(3), "-t", keep.toFixed(3),
      "-vf", `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${cfg.defaults.fps}`,
      "-af", `loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.015,afade=t=out:st=${Math.max(0, keep - 0.02).toFixed(3)}:d=0.02`,
      "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      out,
    ]);
    normed.push(out);
  }

  // 2) join
  const outName = opts.outName ?? `${project.name}-${opts.transition}`;
  const programPath = path.join(project.finalDir, `${outName}${opts.musicPath ? ".program" : ""}.mp4`);

  if (opts.transition === "cut" || normed.length === 1) {
    const listFile = path.join(normDir, "concat.txt");
    fs.writeFileSync(listFile, normed.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", programPath]);
  } else {
    const durations = await Promise.all(normed.map((f) => ffprobeDuration(f)));
    const inputArgs = normed.flatMap((f) => ["-i", f]);
    const vChain: string[] = [];
    const aChain: string[] = [];
    let cumulative = 0;
    for (let i = 1; i < normed.length; i++) {
      cumulative += durations[i - 1];
      const offset = (cumulative - i * FADE).toFixed(3);
      const vin = i === 1 ? "[0:v]" : `[v${i - 1}]`;
      const ain = i === 1 ? "[0:a]" : `[a${i - 1}]`;
      vChain.push(`${vin}[${i}:v]xfade=transition=fade:duration=${FADE}:offset=${offset}[v${i}]`);
      aChain.push(`${ain}[${i}:a]acrossfade=d=${FADE}[a${i}]`);
    }
    const last = normed.length - 1;
    await ffmpeg([
      ...inputArgs,
      "-filter_complex", [...vChain, ...aChain].join(";"),
      "-map", `[v${last}]`, "-map", `[a${last}]`,
      "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k",
      programPath,
    ]);
  }

  // 3) optional music bed added AFTER the join (per-clip generated music would clash at every cut)
  let finalPath = programPath;
  if (opts.musicPath) {
    if (!fs.existsSync(opts.musicPath)) throw new Error(`music file not found: ${opts.musicPath}`);
    finalPath = path.join(project.finalDir, `${outName}.mp4`);
    const total = await ffprobeDuration(programPath);
    const vol = opts.musicVolume ?? 0.12;
    const fadeOutStart = Math.max(0, total - 1.5).toFixed(3);
    await ffmpeg([
      "-i", programPath,
      "-stream_loop", "-1", "-i", opts.musicPath,
      "-filter_complex",
      `[1:a]volume=${vol},afade=t=in:st=0:d=1,afade=t=out:st=${fadeOutStart}:d=1.5[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=3:normalize=0[a]`,
      "-map", "0:v", "-map", "[a]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
      "-t", total.toFixed(3),
      finalPath,
    ]);
    fs.rmSync(programPath);
  }

  fs.rmSync(normDir, { recursive: true, force: true });

  const manifest = loadManifest(project);
  recordArtifact(manifest, `final/${outName}`, { inputHash: "n/a", path: finalPath });
  saveManifest(project, manifest);
  const dur = await ffprobeDuration(finalPath);
  log.ok(`stitched ${normed.length} segments → ${finalPath} (${dur.toFixed(1)}s)`);
  return finalPath;
}
