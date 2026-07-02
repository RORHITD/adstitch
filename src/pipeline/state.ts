import fs from "node:fs";
import path from "node:path";
import type { Manifest, ArtifactRecord } from "../types.js";
import { ensureDir, readJson, writeJson } from "../util/fs.js";

export interface Project {
  name: string;
  dir: string;
  briefPath: string;
  assetsDir: string;
  castDir: string;
  keyframesDir: string;
  segmentsDir: string;
  finalDir: string;
  storyboardPath: string;
  manifestPath: string;
}

export function projectPaths(projectsRoot: string, name: string): Project {
  const dir = path.join(projectsRoot, name);
  return {
    name,
    dir,
    briefPath: path.join(dir, "brief.md"),
    assetsDir: path.join(dir, "assets"),
    castDir: path.join(dir, "cast"),
    keyframesDir: path.join(dir, "keyframes"),
    segmentsDir: path.join(dir, "segments"),
    finalDir: path.join(dir, "final"),
    storyboardPath: path.join(dir, "storyboard.json"),
    manifestPath: path.join(dir, "manifest.json"),
  };
}

export function loadProject(projectsRoot: string, name: string): Project {
  const p = projectPaths(projectsRoot, name);
  if (!fs.existsSync(p.dir)) {
    throw new Error(`project "${name}" not found at ${p.dir} — run: adstitch init ${name}`);
  }
  return p;
}

export function loadManifest(p: Project): Manifest {
  if (!fs.existsSync(p.manifestPath)) return { version: 1, artifacts: {}, ledger: [] };
  return readJson<Manifest>(p.manifestPath);
}

export function saveManifest(p: Project, m: Manifest): void {
  writeJson(p.manifestPath, m);
}

/** true when the artifact was already produced from identical inputs and its file still exists */
export function isFresh(m: Manifest, id: string, inputHash: string): boolean {
  const rec = m.artifacts[id];
  return !!rec && rec.inputHash === inputHash && fs.existsSync(rec.path);
}

export function recordArtifact(
  m: Manifest,
  id: string,
  rec: Omit<ArtifactRecord, "createdAt">,
  ledgerEntry?: { kind: "image" | "video" | "text"; model: string; detail: string; costUsd: number },
): void {
  m.artifacts[id] = { ...rec, createdAt: new Date().toISOString() };
  if (ledgerEntry) m.ledger.push({ at: new Date().toISOString(), ...ledgerEntry });
}

export function spentUsd(m: Manifest): number {
  return m.ledger.reduce((s, e) => s + e.costUsd, 0);
}

export function ensureProjectDirs(p: Project): void {
  for (const d of [p.dir, p.assetsDir, p.castDir, p.keyframesDir, p.segmentsDir, p.finalDir]) ensureDir(d);
}
