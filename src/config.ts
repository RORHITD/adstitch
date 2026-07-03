import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

// Model IDs and pricing move fast — everything lives here and can be overridden
// in adstitch.config.json (repo root) or <project>/adstitch.config.json.
// Run `adstitch models` to list what your API key can actually see.

export const ConfigSchema = z.object({
  provider: z.enum(["gemini", "mock"]).default("gemini"),
  models: z
    .object({
      text: z.string().default("gemini-2.5-flash"),
      image: z.string().default("gemini-2.5-flash-image"),
      imageHq: z.string().default("gemini-3-pro-image"),
      video: z.string().default("veo-3.1-generate-preview"),
      videoFast: z.string().default("veo-3.1-fast-generate-preview"),
      videoLite: z.string().default("veo-3.1-lite-generate-preview"),
    })
    .prefault({}),
  defaults: z
    .object({
      aspectRatio: z.enum(["9:16", "16:9"]).default("9:16"),
      resolution: z.enum(["720p", "1080p"]).default("720p"),
      personGeneration: z.string().default("allow_adult"),
      fps: z.number().int().default(24),
      concurrency: z.number().int().min(1).max(8).default(2),
      transition: z.enum(["cut", "smooth"]).default("cut"),
      /** attach cast reference images to Veo calls too (experimental; auto-retries without on API rejection) */
      videoReferenceImages: z.boolean().default(false),
      useHqKeyframes: z.boolean().default(true),
      pollIntervalMs: z.number().int().default(10_000),
      videoTimeoutMs: z.number().int().default(10 * 60_000),
    })
    .prefault({}),
  qc: z
    .object({
      /** auto-QC every rendered segment (SSIM conditioning check + multimodal judge), re-roll once on failure */
      enabled: z.boolean().default(true),
      /** first-frame vs keyframe similarity floor — lenient by design (catches wrong-scene, not codec noise) */
      ssimThreshold: z.number().default(0.35),
    })
    .prefault({}),
  /** USD estimates only — verify against https://ai.google.dev/gemini-api/docs/pricing */
  pricing: z
    .object({
      videoPerSecond: z.record(z.string(), z.number()).default({
        "veo-3.1-generate-preview": 0.4,
        "veo-3.1-fast-generate-preview": 0.1,
        "veo-3.1-lite-generate-preview": 0.05,
      }),
      imagePerImage: z.record(z.string(), z.number()).default({
        "gemini-2.5-flash-image": 0.039,
        "gemini-3.1-flash-image": 0.067,
        "gemini-3-pro-image": 0.134,
        "gemini-3-pro-image-preview": 0.134,
      }),
    })
    .prefault({}),
});
export type Config = z.infer<typeof ConfigSchema>;

function readJsonIfExists(file: string): unknown {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function deepMerge(base: any, over: any): any {
  if (over === undefined) return base;
  if (typeof base !== "object" || typeof over !== "object" || Array.isArray(base) || Array.isArray(over)) return over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

export function loadConfig(repoRoot: string, projectDir?: string, cliOverrides: Record<string, unknown> = {}): Config {
  const repoCfg = readJsonIfExists(path.join(repoRoot, "adstitch.config.json"));
  const projCfg = projectDir ? readJsonIfExists(path.join(projectDir, "adstitch.config.json")) : {};
  const merged = deepMerge(deepMerge(deepMerge({}, repoCfg), projCfg), cliOverrides);
  return ConfigSchema.parse(merged);
}

export function videoDims(aspectRatio: string, resolution: string): { w: number; h: number } {
  const short = resolution === "1080p" ? 1080 : 720;
  const long = resolution === "1080p" ? 1920 : 1280;
  return aspectRatio === "9:16" ? { w: short, h: long } : { w: long, h: short };
}
