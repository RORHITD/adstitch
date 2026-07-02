import fs from "node:fs";
import { StoryboardSchema, type Storyboard, type Template } from "../types.js";
import type { Provider } from "../providers/types.js";
import type { Config } from "../config.js";
import type { Project } from "./state.js";
import { loadManifest, saveManifest, isFresh, recordArtifact } from "./state.js";
import { storyboardRequestPrompt } from "./prompts.js";
import { hashInputs, readJson, writeJson } from "../util/fs.js";
import { log } from "../util/log.js";

function stripFences(text: string): string {
  return text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
}

function guessProductName(brief: string): string {
  return brief.match(/^\s*Name:\s*(.+)$/m)?.[1]?.trim() ?? "the product";
}

export async function planStoryboard(
  project: Project,
  provider: Provider,
  cfg: Config,
  templatePath: string,
  force = false,
): Promise<Storyboard> {
  const brief = fs.readFileSync(project.briefPath, "utf8");
  const template = readJson<Template>(templatePath);
  const manifest = loadManifest(project);

  const inputHash = hashInputs({ brief, template, model: cfg.models.text, provider: provider.name });
  if (!force && isFresh(manifest, "storyboard", inputHash)) {
    log.dim(`storyboard unchanged — skipping (use --force to re-plan)`);
    return readJson<Storyboard>(project.storyboardPath);
  }

  const prompt = storyboardRequestPrompt(brief, template, guessProductName(brief));
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await provider.generateJson({
      model: cfg.models.text,
      prompt: attempt === 1 ? prompt : `${prompt}\n\nYour previous attempt was invalid: ${lastError}\nReturn corrected JSON only.`,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFences(raw));
    } catch (err) {
      lastError = `not valid JSON (${(err as Error).message})`;
      continue;
    }
    const result = StoryboardSchema.safeParse(parsed);
    if (!result.success) {
      lastError = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      log.warn(`storyboard failed validation (attempt ${attempt}): ${lastError}`);
      continue;
    }

    // The code owns the structure: re-impose skeleton ids/durations/transitions
    // so the LLM can't drift the timing or the continuity plan.
    const sb = result.data;
    if (sb.beats.length !== template.beats.length) {
      lastError = `expected ${template.beats.length} beats, got ${sb.beats.length}`;
      continue;
    }
    sb.beats = sb.beats.map((beat, i) => ({
      ...beat,
      id: template.beats[i].id,
      durationSeconds: template.beats[i].durationSeconds,
      transitionOut: template.beats[i].transitionOut,
    }));

    writeJson(project.storyboardPath, sb);
    recordArtifact(manifest, "storyboard", { inputHash, path: project.storyboardPath, model: cfg.models.text });
    saveManifest(project, manifest);
    log.ok(`storyboard written → ${project.storyboardPath}`);
    return sb;
  }
  throw new Error(`storyboard generation failed after 2 attempts: ${lastError}`);
}

export function readStoryboard(project: Project): Storyboard {
  if (!fs.existsSync(project.storyboardPath)) {
    throw new Error(`no storyboard.json in ${project.dir} — run: adstitch plan ${project.name}`);
  }
  return StoryboardSchema.parse(readJson(project.storyboardPath));
}
