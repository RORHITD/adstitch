import fs from "node:fs";
import path from "node:path";
import type { ImageRequest, Provider, TextRequest, VideoRequest, VideoResult } from "./types.js";
import { ffmpeg } from "../util/ffmpeg.js";
import { ensureDir, sha256 } from "../util/fs.js";

// Free provider: synthesizes storyboards, keyframes and clips locally with ffmpeg
// so the entire pipeline (incl. stitching) can be exercised without an API key.

const PALETTE = ["0x1f6f8b", "0x99582a", "0x432818", "0x6a994e", "0x386641", "0x7b2cbf", "0xbc4749", "0x0f4c5c"];

function colorFor(text: string): string {
  const h = parseInt(sha256(text).slice(0, 6), 16);
  return PALETTE[h % PALETTE.length];
}

function toneFor(text: string): number {
  return 220 + (parseInt(sha256(text).slice(0, 4), 16) % 440);
}

function dims(aspectRatio: string, resolution = "720p"): { w: number; h: number } {
  const short = resolution === "1080p" ? 1080 : 720;
  const long = resolution === "1080p" ? 1920 : 1280;
  return aspectRatio === "9:16" ? { w: short, h: long } : { w: long, h: short };
}

const MAC_FONT = "/System/Library/Fonts/Helvetica.ttc";

let drawtextAvailable: boolean | undefined;
async function canDrawtext(): Promise<boolean> {
  if (drawtextAvailable === undefined) {
    try {
      const { execa } = await import("execa");
      const { stdout } = await execa("ffmpeg", ["-hide_banner", "-filters"]);
      drawtextAvailable = / drawtext /.test(stdout);
    } catch {
      drawtextAvailable = false;
    }
  }
  return drawtextAvailable;
}

/** drawtext label filter, or the no-op `null` filter when this ffmpeg build lacks drawtext */
async function textFilter(label: string, size: number): Promise<string> {
  if (!(await canDrawtext())) return "null";
  const safe = label.replace(/[^A-Za-z0-9 .,\-]/g, " ").slice(0, 40).trim() || "frame";
  const font = fs.existsSync(MAC_FONT) ? `fontfile=${MAC_FONT}:` : "";
  return `drawtext=${font}text='${safe}':fontcolor=white:fontsize=${size}:x=(w-text_w)/2:y=(h-text_h)/2`;
}

const BEAT_CONTENT: Record<string, { action: string; dialogue: string; emotion: string }> = {
  hook: { action: "She leans into the camera holding the product, eyebrows raised.", dialogue: "Okay, stop scrolling. You need to see this.", emotion: "playful urgency" },
  problem: { action: "She gestures at the situation, mildly exasperated.", dialogue: "I was so over the usual options. Nothing actually worked.", emotion: "relatable frustration" },
  reveal: { action: "She lifts the product to camera and turns the label to the lens.", dialogue: "Then I found this — and honestly, watch what it does.", emotion: "excited reveal" },
  result: { action: "She uses the product on camera so the result is visible.", dialogue: "You can literally see the difference — right here, right now.", emotion: "satisfied delight" },
  cta: { action: "She points at the camera, then below to the caption.", dialogue: "Tap the link below and try it yourself.", emotion: "confident invitation" },
};

export class MockProvider implements Provider {
  name = "mock";

  async generateJson(req: TextRequest): Promise<string> {
    if (req.prompt.includes("QC_JUDGE")) {
      return JSON.stringify({ pass: true, reasons: [] });
    }
    if (req.prompt.includes("QC_TRANSCRIBE")) {
      return JSON.stringify({ transcript: "" }); // mock clips have no speech — check self-skips
    }
    if (req.prompt.includes("SPEECH_TIMING")) {
      const duration = parseFloat(req.prompt.match(/DURATION:\s*([\d.]+)/)?.[1] ?? "8");
      return JSON.stringify({ speechStart: 0.2, speechEnd: Math.max(0.5, duration - 2) });
    }
    if (req.prompt.includes("ALTERNATES_REQUEST")) {
      const count = parseInt(req.prompt.match(/ALTERNATES_COUNT:\s*(\d+)/)?.[1] ?? "1", 10);
      const alternates = Array.from({ length: count }, (_, k) => ({
        dialogue: `Alternate take ${k + 2}: a completely different opening line.`,
        action: `alternate ${k + 2} staging: she enters frame differently and presents the product`,
        camera: "crash zoom",
        emotion: "curious energy",
        startFramePrompt: `Alternate ${k + 2} opening: woman at a visibly different position by the pool, distinct pose and framing, product in hand`,
      }));
      return JSON.stringify({ alternates });
    }
    const m = req.prompt.match(/BEAT_SKELETON_JSON:\s*(\[[\s\S]*?\])\s*END_BEAT_SKELETON_JSON/);
    if (!m) throw new Error("mock provider: no known marker (BEAT_SKELETON_JSON / ALTERNATES_REQUEST / QC_JUDGE) found in prompt");
    const skeleton = JSON.parse(m[1]) as Array<{ id: string; title: string; goal: string; durationSeconds: number; transitionOut: string }>;
    const product = req.prompt.match(/PRODUCT_NAME:\s*(.+)/)?.[1]?.trim() || "Demo Product";

    const beats = skeleton.map((b) => {
      const c = BEAT_CONTENT[b.id] ?? BEAT_CONTENT.hook;
      return {
        id: b.id,
        title: b.title,
        goal: b.goal,
        durationSeconds: b.durationSeconds,
        camera: "handheld selfie framing, chest-up, slight natural sway",
        action: c.action,
        dialogue: c.dialogue,
        emotion: c.emotion,
        startFramePrompt: `${b.title} start frame: woman chest-up facing camera by the pool, holding ${product}`,
        endFramePrompt: `${b.title} end frame: woman mid-gesture facing camera by the pool, ${product} visible`,
        transitionOut: b.transitionOut,
      };
    });

    return JSON.stringify({
      version: 1,
      campaign: {
        name: "mock-campaign",
        product: { name: product, description: `${product} — a delightful demo product`, keyClaims: ["works instantly", "tastes great", "no junk"] },
        audience: "25-40 wellness-curious social scrollers",
        platform: "tiktok",
        cta: "Tap the link to try it",
      },
      style: {
        personaVisual: "woman in her late 20s, long dark brown hair, warm tan skin, light freckles, white linen shirt",
        personaVoice: "warm, casual, fast-but-clear delivery",
        wardrobe: "white linen button-up shirt, gold pendant necklace",
        setting: "resort poolside at golden hour, turquoise water, palm shadows",
        lighting: "warm golden-hour sunlight from camera left",
        cameraLanguage: "handheld selfie UGC, eye-level, slight movement",
        mood: "sunny, authentic, energetic",
      },
      beats,
    });
  }

  async generateImage(req: ImageRequest): Promise<void> {
    const { w, h } = dims(req.aspectRatio, "1080p");
    ensureDir(path.dirname(req.outPath));
    const color = colorFor(req.prompt);
    const label = path.basename(req.outPath, path.extname(req.outPath));
    await ffmpeg(["-f", "lavfi", "-i", `color=c=${color}:s=${w}x${h}`, "-vf", await textFilter(label, 64), "-frames:v", "1", req.outPath]);
  }

  async generateVideo(req: VideoRequest): Promise<VideoResult> {
    const { w, h } = dims(req.aspectRatio, req.resolution);
    const d = req.durationSeconds;
    const tone = toneFor(req.prompt);
    const label = path.basename(req.outPath, ".mp4");
    const dt = await textFilter(label, 48);
    ensureDir(path.dirname(req.outPath));

    const vcodec = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "24", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-t", String(d)];

    if (req.firstFramePath && req.lastFramePath) {
      // crossfade first→last keyframe so match-continuity is visible in the mock output
      const half = d / 2;
      await ffmpeg([
        "-loop", "1", "-t", String(half + 1), "-i", req.firstFramePath,
        "-loop", "1", "-t", String(half + 1), "-i", req.lastFramePath,
        "-f", "lavfi", "-i", `sine=frequency=${tone}:duration=${d}`,
        "-filter_complex",
        `[0:v]scale=${w}:${h},setsar=1[v0];[1:v]scale=${w}:${h},setsar=1[v1];[v0][v1]xfade=transition=fade:duration=1:offset=${half - 0.5},${dt}[v];[2:a]volume=1.4,volume=0.25:enable='gte(t,${Math.max(0.5, d - 2).toFixed(2)})'[a]`,
        "-map", "[v]", "-map", "[a]", ...vcodec, req.outPath,
      ]);
    } else if (req.firstFramePath) {
      await ffmpeg([
        "-loop", "1", "-t", String(d), "-i", req.firstFramePath,
        "-f", "lavfi", "-i", `sine=frequency=${tone}:duration=${d}`,
        "-filter_complex", `[0:v]scale=${w}:${h},setsar=1,${dt}[v];[1:a]volume=1.4,volume=0.25:enable='gte(t,${Math.max(0.5, d - 2).toFixed(2)})'[a]`,
        "-map", "[v]", "-map", "[a]", ...vcodec, req.outPath,
      ]);
    } else {
      await ffmpeg([
        "-f", "lavfi", "-i", `color=c=${colorFor(req.prompt)}:s=${w}x${h}:r=24`,
        "-f", "lavfi", "-i", `sine=frequency=${tone}:duration=${d}`,
        "-filter_complex", `[0:v]${dt}[v];[1:a]volume=1.4,volume=0.25:enable='gte(t,${Math.max(0.5, d - 2).toFixed(2)})'[a]`,
        "-map", "[v]", "-map", "[a]", ...vcodec, req.outPath,
      ]);
    }
    return { path: req.outPath };
  }

  async listModels(): Promise<string[]> {
    return ["mock (local ffmpeg synthesis — no API)"];
  }
}
