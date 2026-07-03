import { execa } from "execa";

export async function ffmpeg(args: string[]): Promise<void> {
  try {
    await execa("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  } catch (err: any) {
    throw new Error(`ffmpeg failed: ${err.stderr || err.shortMessage || err.message}\nargs: ffmpeg ${args.join(" ")}`);
  }
}

export async function ffprobeDuration(file: string): Promise<number> {
  const { stdout } = await execa("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "json",
    file,
  ]);
  const dur = Number(JSON.parse(stdout)?.format?.duration);
  if (!Number.isFinite(dur)) throw new Error(`could not probe duration of ${file}`);
  return dur;
}

export async function hasFfmpeg(): Promise<boolean> {
  try {
    await execa("ffmpeg", ["-version"]);
    await execa("ffprobe", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

/** grab the very last frame of a video as a PNG (for extract-chaining mode) */
export async function extractLastFrame(video: string, outPng: string): Promise<void> {
  await ffmpeg(["-sseof", "-0.25", "-i", video, "-frames:v", "1", "-update", "1", outPng]);
}

/** grab one frame at t seconds */
export async function extractFrameAt(video: string, t: number, outPng: string): Promise<void> {
  await ffmpeg(["-ss", t.toFixed(3), "-i", video, "-frames:v", "1", "-update", "1", outPng]);
}

let ssimAvailable: boolean | undefined;

/**
 * Structural similarity between two images (0..1, 1 = identical). Both inputs
 * are normalized to the same size/format first. Returns null when this ffmpeg
 * build lacks the ssim filter or the comparison fails — callers must treat
 * null as "check unavailable", never as a failure.
 */
export async function ssimCompare(aPng: string, bPng: string): Promise<number | null> {
  if (ssimAvailable === undefined) {
    try {
      const { stdout } = await execa("ffmpeg", ["-hide_banner", "-filters"]);
      ssimAvailable = / ssim /.test(stdout);
    } catch {
      ssimAvailable = false;
    }
  }
  if (!ssimAvailable) return null;
  try {
    const { stderr } = await execa("ffmpeg", [
      "-hide_banner",
      "-i", aPng,
      "-i", bPng,
      "-filter_complex",
      "[0:v]scale=540:960,format=yuv420p,setsar=1[a];[1:v]scale=540:960,format=yuv420p,setsar=1[b];[a][b]ssim",
      "-f", "null", "-",
    ]);
    const m = stderr.match(/All:\s*([\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  } catch {
    return null;
  }
}
