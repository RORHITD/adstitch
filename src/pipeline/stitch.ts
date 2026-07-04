import fs from "node:fs";
import path from "node:path";
import type { Storyboard } from "../types.js";
import type { Config } from "../config.js";
import { videoDims } from "../config.js";
import type { Provider } from "../providers/types.js";
import type { Project } from "./state.js";
import { loadManifest, saveManifest, recordArtifact } from "./state.js";
import { segmentPath } from "./videos.js";
import { speechSpan, type SpeechSpan } from "./timing.js";
import { brollPaths } from "./broll.js";
import { ffmpeg, ffprobeDuration } from "../util/ffmpeg.js";
import { ensureDir } from "../util/fs.js";
import { log } from "../util/log.js";

export interface StitchOptions {
  /**
   * plain — normalize + join as-is (hard cut or crossfade)
   * flow  — one-take feel: keeps frame-matched boundaries, time-ramps the silent
   *         acted tails (~2×) and rebuilds audio with ducked tails + safe fades
   *         (speech-aware: never cuts or fades inside a word)
   * tight — fast ad rhythm: cuts each clip right around its spoken line;
   *         with cutaways, hides every join under a 0.7s product B-roll insert
   */
  style?: "plain" | "flow" | "tight";
  /** tight style: insert product B-roll at joins (requires `adstitch broll <name>`) */
  cutaways?: boolean;
  /** plain style: "cut" = hard cuts; "smooth" = 0.15s crossfade */
  transition: "cut" | "smooth";
  /** pick a specific variant per beat id, e.g. { hook: 2 } uses hook@2 */
  picks?: Record<string, number>;
  musicPath?: string;
  musicVolume?: number;
  outName?: string;
  /** plain style only: manual trims at match joins (default 0 — blind trims clip words) */
  trimTail?: number;
  trimHead?: number;
}

const FADE = 0.15;
const RAMP_K = 2; // tail speed-up factor in flow style
const INSERT_LEN = 0.7;

const enc = [
  "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
];

export async function stitchAd(
  project: Project,
  sb: Storyboard,
  cfg: Config,
  opts: StitchOptions,
  provider?: Provider,
): Promise<string> {
  const style = opts.style ?? "plain";
  const inputs = sb.beats.map((b) => {
    const p = segmentPath(project, sb, b.id, opts.picks?.[b.id] ?? 1);
    if (!fs.existsSync(p)) throw new Error(`missing segment ${p} — run: adstitch videos ${project.name}`);
    return p;
  });

  // speech spans (raw-clip timeline == normalized timeline when heads aren't trimmed)
  let spans: SpeechSpan[] = [];
  if (style !== "plain") {
    if (!provider) throw new Error(`stitch style "${style}" needs speech timing — provider missing`);
    log.dim("analyzing speech timing per clip");
    spans = [];
    for (const input of inputs) spans.push(await speechSpan(project, input, provider, cfg));
  }

  const { w, h } = videoDims(cfg.defaults.aspectRatio, cfg.defaults.resolution);
  const normDir = ensureDir(path.join(project.segmentsDir, ".norm"));
  ensureDir(project.finalDir);

  // resolve B-roll for tight+cutaways before any work
  let brolls: string[] = [];
  if (style === "tight" && opts.cutaways) {
    brolls = brollPaths(project).filter((p) => fs.existsSync(p));
    if (!brolls.length) throw new Error(`no B-roll clips found — run: adstitch broll ${project.name}`);
  }

  // 1) normalize: identical codec/fps/geometry + loudness. Tight style trims to
  // the spoken line here (speech-aware, never inside a word); other styles keep
  // full clips so frame-matched boundaries survive.
  const trimTail = opts.trimTail ?? 0;
  const trimHead = opts.trimHead ?? 0;
  const normalize = async (src: string, out: string, head: number, keep: number | undefined) => {
    const args = ["-i", src];
    if (head > 0 || keep !== undefined) {
      args.push("-ss", head.toFixed(3));
      if (keep !== undefined) args.push("-t", keep.toFixed(3));
    }
    args.push(
      "-vf", `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${cfg.defaults.fps}`,
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
      ...enc, out,
    );
    await ffmpeg(args);
  };

  const normed: string[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const out = path.join(normDir, `n${i}.mp4`);
    let head = 0;
    let keep: number | undefined;
    if (style === "tight") {
      const s = spans[i];
      head = Math.max(0, s.speechStart - 0.15);
      keep = Math.min(s.duration, s.speechEnd + 0.35) - head;
    } else if (style === "plain") {
      head = i > 0 && sb.beats[i - 1].transitionOut === "match" ? trimHead : 0;
      const tail = sb.beats[i].transitionOut === "match" ? trimTail : 0;
      if (head > 0 || tail > 0) keep = (await ffprobeDuration(inputs[i])) - head - tail;
    }
    log.dim(`normalizing ${path.basename(inputs[i])}${head || keep !== undefined ? ` (speech-aware cut)` : ""}`);
    await normalize(inputs[i], out, head, keep);
    normed.push(out);
  }
  const normBrolls: string[] = [];
  for (let j = 0; j < brolls.length; j++) {
    const out = path.join(normDir, `b${j}.mp4`);
    await normalize(brolls[j], out, 0, undefined);
    normBrolls.push(out);
  }

  const outName = opts.outName ?? `${project.name}-${style === "plain" ? opts.transition : style}`;
  const programPath = path.join(project.finalDir, `${outName}${opts.musicPath ? ".program" : ""}.mp4`);

  if (style === "flow") {
    await stitchFlow(sb, normed, spans, programPath);
  } else if (style === "tight") {
    await stitchTight(normed, normBrolls, spans, programPath);
  } else if (opts.transition === "cut" || normed.length === 1) {
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
      ...enc, programPath,
    ]);
  }

  // optional music bed added AFTER the join (per-clip generated music would clash at every cut)
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
  log.ok(`stitched ${normed.length} segments${normBrolls.length ? ` + ${Math.max(0, normed.length - 1)} cutaways` : ""} → ${finalPath} (${dur.toFixed(1)}s, style: ${style})`);
  return finalPath;
}

/**
 * One-take flow: video keeps every frame-matched boundary; the silent acted
 * tail after each spoken line plays at 2× (compressing the vamp AND Veo's
 * decelerate-into-frame crawl) and its audio is ducked, so each join is a
 * quiet settle into the next line instead of a freeze then an 18 dB slam.
 */
async function stitchFlow(sb: Storyboard, normed: string[], spans: SpeechSpan[], outPath: string): Promise<void> {
  const N = normed.length;
  const durations = await Promise.all(normed.map((f) => ffprobeDuration(f)));
  const parts: string[] = [];
  const pads: string[] = [];

  for (let i = 0; i < N; i++) {
    const d = durations[i];
    const isMatch = i < N - 1 && sb.beats[i]?.transitionOut === "match";
    const rampStart = Math.min(Math.max(spans[i].speechEnd + 0.25, 0.3), d - 0.2);
    const ramp = isMatch && d - rampStart > 0.4 ? rampStart : null;

    let newDur: number;
    if (ramp !== null) {
      newDur = ramp + (d - ramp) / RAMP_K;
      parts.push(
        `[${i}:v]trim=end=${ramp.toFixed(3)},setpts=PTS-STARTPTS[v${i}a]`,
        `[${i}:v]trim=start=${ramp.toFixed(3)},setpts=(PTS-STARTPTS)/${RAMP_K}[v${i}b]`,
        `[v${i}a][v${i}b]concat=n=2:v=1:a=0[v${i}]`,
        `[${i}:a]atrim=end=${ramp.toFixed(3)},asetpts=PTS-STARTPTS[a${i}a]`,
        `[${i}:a]atrim=start=${ramp.toFixed(3)},asetpts=PTS-STARTPTS,atempo=${RAMP_K},volume=0.63[a${i}b]`,
        `[a${i}a][a${i}b]concat=n=2:v=0:a=1[a${i}p]`,
      );
    } else {
      newDur = d;
      parts.push(`[${i}:v]setpts=PTS-STARTPTS[v${i}]`, `[${i}:a]asetpts=PTS-STARTPTS[a${i}p]`);
    }

    // NEVER fade a tail to silence — room tone must survive the cut or the next
    // clip's onset lands as a slam from digital zero. Tails stay at the ducked
    // ambience level; only de-click micro-fades at the edges (and a real
    // fade-out on the final clip).
    const fadeIn = 0.02;
    const fadeOut = i === N - 1 ? 0.5 : 0.03;
    const fadeOutStart = Math.max(0, newDur - fadeOut - 0.02);
    pads.push(`[a${i}p]afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut}[a${i}]`);
  }

  const interleaved = Array.from({ length: N }, (_, i) => `[v${i}][a${i}]`).join("");
  const graph = [...parts, ...pads, `${interleaved}concat=n=${N}:v=1:a=1[v][a]`].join(";");
  await ffmpeg([...normed.flatMap((f) => ["-i", f]), "-filter_complex", graph, "-map", "[v]", "-map", "[a]", ...enc, outPath]);
}

/**
 * Tight cuts + cutaways: clips are already speech-trimmed by normalize; each
 * join is hidden under a 0.7s product insert (its own quiet ambience keeps the
 * room alive), so pose jumps are invisible and the ad runs at spoken-line pace.
 */
async function stitchTight(normed: string[], normBrolls: string[], spans: SpeechSpan[], outPath: string): Promise<void> {
  const N = normed.length;
  const B = normBrolls.length;
  const durations = await Promise.all(normed.map((f) => ffprobeDuration(f)));
  const brollDurs = await Promise.all(normBrolls.map((f) => ffprobeDuration(f)));
  const parts: string[] = [];
  const seq: string[] = [];

  for (let i = 0; i < N; i++) {
    const d = durations[i];
    const fadeIn = 0.03;
    const outStart = Math.max(0, d - 0.09);
    parts.push(
      `[${i}:v]setpts=PTS-STARTPTS[cv${i}]`,
      `[${i}:a]asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${outStart.toFixed(3)}:d=0.06[ca${i}]`,
    );
    seq.push(`[cv${i}][ca${i}]`);

    if (i < N - 1 && B > 0) {
      const j = i % B;
      const round = Math.floor(i / B);
      const maxOff = Math.max(0, brollDurs[j] - INSERT_LEN - 0.1);
      const off = Math.min(0.15 + round * 1.4, maxOff);
      const inIdx = N + j;
      parts.push(
        `[${inIdx}:v]trim=start=${off.toFixed(3)}:end=${(off + INSERT_LEN).toFixed(3)},setpts=PTS-STARTPTS[iv${i}]`,
        `[${inIdx}:a]atrim=start=${off.toFixed(3)}:end=${(off + INSERT_LEN).toFixed(3)},asetpts=PTS-STARTPTS,volume=0.5,afade=t=in:st=0:d=0.04,afade=t=out:st=${(INSERT_LEN - 0.08).toFixed(3)}:d=0.06[ia${i}]`,
      );
      seq.push(`[iv${i}][ia${i}]`);
    }
  }

  const graph = [...parts, `${seq.join("")}concat=n=${seq.length}:v=1:a=1[v][a]`].join(";");
  await ffmpeg([
    ...[...normed, ...normBrolls].flatMap((f) => ["-i", f]),
    "-filter_complex", graph,
    "-map", "[v]", "-map", "[a]",
    ...enc, outPath,
  ]);
}
