import fs from "node:fs";
import path from "node:path";
import type { Storyboard } from "../types.js";
import type { LockedPersona } from "./prompts.js";
import type { Project } from "./state.js";
import { castPaths } from "./cast.js";
import { ensureDir, readJson, writeJson } from "../util/fs.js";

// Repo-level persona library (personas/<slug>/, gitignored): a portrait image
// + the locked text description. Reusing one across campaigns gives Higgsfield
// Soul-ID-style continuity: the portrait becomes assets/persona.png (identity
// lock for every keyframe) and the text is imposed verbatim on the storyboard.

export function personasDir(repoRoot: string): string {
  return path.join(repoRoot, "personas");
}

export function savePersona(repoRoot: string, slug: string, project: Project, sb: Storyboard): string {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`persona slug must be kebab-case: "${slug}"`);
  const portraitSrc = castPaths(project).personaRefs[0];
  if (!fs.existsSync(portraitSrc)) {
    throw new Error(`no persona image at ${portraitSrc} — run "adstitch cast ${project.name}" first, or drop assets/persona.png`);
  }
  const dir = ensureDir(path.join(personasDir(repoRoot), slug));
  fs.copyFileSync(portraitSrc, path.join(dir, "portrait.png"));
  const record: LockedPersona = {
    name: slug,
    personaVisual: sb.style.personaVisual,
    personaVoice: sb.style.personaVoice,
    wardrobe: sb.style.wardrobe,
  };
  writeJson(path.join(dir, "persona.json"), record);
  return dir;
}

export function listPersonas(repoRoot: string): Array<{ slug: string; record: LockedPersona }> {
  const dir = personasDir(repoRoot);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((slug) => fs.existsSync(path.join(dir, slug, "persona.json")))
    .sort()
    .map((slug) => ({ slug, record: readJson<LockedPersona>(path.join(dir, slug, "persona.json")) }));
}

export function loadPersona(repoRoot: string, slug: string): { record: LockedPersona; portraitPath: string } {
  const dir = path.join(personasDir(repoRoot), slug);
  const jsonPath = path.join(dir, "persona.json");
  const portraitPath = path.join(dir, "portrait.png");
  if (!fs.existsSync(jsonPath) || !fs.existsSync(portraitPath)) {
    const available = listPersonas(repoRoot).map((p) => p.slug).join(", ") || "(none saved yet)";
    throw new Error(`persona "${slug}" not found — available: ${available}`);
  }
  return { record: readJson<LockedPersona>(jsonPath), portraitPath };
}
