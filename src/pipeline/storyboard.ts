import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { StoryboardSchema, AlternateSchema, type Storyboard, type Template } from "../types.js";
import type { Provider } from "../providers/types.js";
import type { Config } from "../config.js";
import type { Project } from "./state.js";
import { loadManifest, saveManifest, isFresh, recordArtifact } from "./state.js";
import { storyboardRequestPrompt, alternatesRequestPrompt, type LockedPersona } from "./prompts.js";
import { parseScript, validateScript, applyScriptAlternates, warnDialoguePacing, type ParsedScript } from "./script.js";
import { beatFrames } from "./keyframes.js";
import { hashInputs, readJson, writeJson } from "../util/fs.js";
import { log } from "../util/log.js";

export function stripFences(text: string): string {
  return text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
}

function guessProductName(brief: string): string {
  return brief.match(/^\s*Name:\s*(.+)$/m)?.[1]?.trim() ?? "the product";
}

function readProjectScript(project: Project, templatePath: string): ParsedScript | undefined {
  const scriptPath = path.join(project.dir, "script.md");
  if (!fs.existsSync(scriptPath)) return undefined;
  const script = parseScript(scriptPath);
  validateScript(script, readJson<Template>(templatePath), scriptPath);
  return script;
}

export function readProjectPersona(project: Project): LockedPersona | undefined {
  const metaPath = path.join(project.dir, "project.json");
  if (!fs.existsSync(metaPath)) return undefined;
  return readJson<{ persona?: LockedPersona }>(metaPath).persona;
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

  const script = readProjectScript(project, templatePath);
  if (script) {
    const baseCount = Object.keys(script.base).length;
    const altCount = Object.values(script.alternates).reduce((s, byN) => s + Object.keys(byN).length, 0);
    log.info(`script.md found — ${baseCount} locked line(s)${altCount ? ` + ${altCount} alternate line(s)` : ""}: ${Object.keys(script.base).join(", ")}`);
  }
  const persona = readProjectPersona(project);
  if (persona) log.info(`locked persona: ${persona.name ?? "unnamed"}`);

  // Only BASE script lines join the hash — alternate lines feed beat.alternates
  // and must not invalidate the whole storyboard (and cascade re-renders).
  const inputHash = hashInputs({ brief, template, script: script?.base, persona, model: cfg.models.text, provider: provider.name });
  if (!force && isFresh(manifest, "storyboard", inputHash)) {
    log.dim(`storyboard unchanged — skipping (use --force to re-plan)`);
    const sb = readStoryboard(project);
    // alternate script lines may still have changed — apply and persist
    if (script && Object.keys(script.alternates).length) {
      applyScriptAlternates(sb, script);
      warnDialoguePacing(sb);
      writeJson(project.storyboardPath, sb);
    }
    return sb;
  }

  const prompt = storyboardRequestPrompt(brief, template, guessProductName(brief), script?.base, persona);
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

    // The code owns the structure: re-impose skeleton ids/durations/transitions,
    // then the locked persona, then locked script lines.
    const sb = result.data;
    if (sb.beats.length !== template.beats.length) {
      lastError = `expected ${template.beats.length} beats, got ${sb.beats.length}`;
      continue;
    }
    sb.beats = sb.beats.map((beat, i) => {
      const id = template.beats[i].id;
      const locked = script?.base[id];
      return {
        ...beat,
        id,
        durationSeconds: template.beats[i].durationSeconds,
        transitionOut: template.beats[i].transitionOut,
        ...(locked ? { dialogue: locked.dialogue, ...(locked.action ? { action: locked.action } : {}) } : {}),
      };
    });
    if (persona) {
      sb.style.personaVisual = persona.personaVisual;
      sb.style.personaVoice = persona.personaVoice;
      if (persona.wardrobe) sb.style.wardrobe = persona.wardrobe;
    }

    // re-plan must not wipe alternates the `alternates` command produced
    if (fs.existsSync(project.storyboardPath)) {
      try {
        const previous = readJson<Storyboard>(project.storyboardPath);
        for (const beat of sb.beats) {
          const old = previous.beats?.find((b) => b.id === beat.id);
          if (old?.alternates?.length) beat.alternates = old.alternates;
        }
      } catch {
        // unreadable previous storyboard — nothing to carry over
      }
    }
    if (script) applyScriptAlternates(sb, script);
    warnDialoguePacing(sb);

    writeJson(project.storyboardPath, sb);
    recordArtifact(manifest, "storyboard", { inputHash, path: project.storyboardPath, model: cfg.models.text });
    saveManifest(project, manifest);
    log.ok(`storyboard written → ${project.storyboardPath}`);
    return sb;
  }
  throw new Error(`storyboard generation failed after 2 attempts: ${lastError}`);
}

const AlternatesResponseSchema = z.object({ alternates: z.array(AlternateSchema).min(1) });

/**
 * Generate scripted alternates for the given beats (spec: { hook: 3 } = base + 2
 * alternates). Base beat fields are untouched, so existing segment hashes stay
 * valid; only the alternate takes render as new work.
 */
export async function planAlternates(
  project: Project,
  provider: Provider,
  cfg: Config,
  templatePath: string,
  spec: Record<string, number>,
  force = false,
): Promise<Storyboard> {
  const sb = readStoryboard(project);
  const manifest = loadManifest(project);
  const script = readProjectScript(project, templatePath);
  const frames = beatFrames(project, sb);

  for (const [beatId, total] of Object.entries(spec)) {
    const i = sb.beats.findIndex((b) => b.id === beatId);
    if (i < 0) throw new Error(`unknown beat "${beatId}" — valid: ${sb.beats.map((b) => b.id).join(", ")}`);
    if (total < 2) throw new Error(`${beatId}=${total}: the count includes the base take — use at least 2 (base + 1 alternate)`);
    if (frames[i].reusedBoundary) {
      throw new Error(`beat "${beatId}" starts on a shared boundary frame (previous beat is "match") and cannot have alternate openings`);
    }
    const beat = sb.beats[i];
    const count = total - 1;

    const baseFields = {
      goal: beat.goal, camera: beat.camera, action: beat.action, dialogue: beat.dialogue,
      emotion: beat.emotion, startFramePrompt: beat.startFramePrompt, endFramePrompt: beat.endFramePrompt,
      durationSeconds: beat.durationSeconds, transitionOut: beat.transitionOut,
    };
    const inputHash = hashInputs({ beat: baseFields, count, model: cfg.models.text, provider: provider.name });
    if (!force && isFresh(manifest, `alternates/${beatId}`, inputHash) && (beat.alternates?.length ?? 0) >= count) {
      log.dim(`alternates/${beatId} unchanged — skipping (use --force to regenerate)`);
      continue;
    }

    const lockedLines = script?.alternates[beatId];
    const prompt = alternatesRequestPrompt(sb, beat, count, cfg.defaults.aspectRatio, lockedLines);
    let lastError = "";
    let done = false;
    for (let attempt = 1; attempt <= 2 && !done; attempt++) {
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
      const result = AlternatesResponseSchema.safeParse(parsed);
      if (!result.success) {
        lastError = result.error.issues.map((iss) => `${iss.path.join(".")}: ${iss.message}`).join("; ");
        continue;
      }
      if (result.data.alternates.length < count) {
        lastError = `expected ${count} alternates, got ${result.data.alternates.length}`;
        continue;
      }
      beat.alternates = result.data.alternates.slice(0, count);
      recordArtifact(manifest, `alternates/${beatId}`, { inputHash, path: project.storyboardPath, model: cfg.models.text });
      log.ok(`${beatId}: ${count} alternate(s) written`);
      done = true;
    }
    if (!done) throw new Error(`alternates for "${beatId}" failed after 2 attempts: ${lastError}`);
  }

  if (script) applyScriptAlternates(sb, script);
  warnDialoguePacing(sb);
  writeJson(project.storyboardPath, sb);
  saveManifest(project, manifest);
  return sb;
}

export function readStoryboard(project: Project): Storyboard {
  if (!fs.existsSync(project.storyboardPath)) {
    throw new Error(`no storyboard.json in ${project.dir} — run: adstitch plan ${project.name}`);
  }
  return StoryboardSchema.parse(readJson(project.storyboardPath));
}
