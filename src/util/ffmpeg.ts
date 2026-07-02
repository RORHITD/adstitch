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
