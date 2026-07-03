import fs from "node:fs";
import type { Storyboard, Template, Beat } from "../types.js";
import { log } from "../util/log.js";

// Optional projects/<name>/script.md — user-authored lines the planner must use
// VERBATIM. Format:
//
//   ## hook
//   "Okay, stop scrolling. You need to see this."
//   action: leans into the camera holding the can
//
//   ## hook@2
//   "POV: your gut finally found a soda it likes."
//
// `## <beat>` locks the base line; `## <beat>@N` (N ≥ 2) locks alternate takes
// (see `adstitch alternates`). Beats you omit are written by the LLM.

export interface ScriptBeat {
  dialogue: string;
  action?: string;
}

export interface ParsedScript {
  base: Record<string, ScriptBeat>;
  /** beatId → alternate number (the N in @N, ≥2) → locked line */
  alternates: Record<string, Record<number, ScriptBeat>>;
}

export function parseScript(file: string): ParsedScript {
  const base: Record<string, ScriptBeat> = {};
  const alternates: Record<string, Record<number, ScriptBeat>> = {};
  let current: ScriptBeat | undefined;
  let currentLines: string[] = [];
  const pending: Array<{ target: ScriptBeat; lines: string[] }> = [];

  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    const header = line.match(/^##\s+([a-z0-9-]+)(?:@(\d+))?\s*$/i);
    if (header) {
      const id = header[1].toLowerCase();
      const alt = header[2] ? parseInt(header[2], 10) : undefined;
      current = { dialogue: "" };
      currentLines = [];
      pending.push({ target: current, lines: currentLines });
      if (alt === undefined || alt <= 1) {
        base[id] = current;
      } else {
        (alternates[id] ??= {})[alt] = current;
      }
      continue;
    }
    if (!current || !line || line.startsWith("#")) continue;
    const action = line.match(/^action:\s*(.+)$/i);
    if (action) {
      current.action = action[1].trim();
    } else {
      currentLines.push(line);
    }
  }

  for (const { target, lines } of pending) {
    const joined = lines.join(" ").replace(/\s+/g, " ").trim();
    target.dialogue = joined.replace(/^["'“]+|["'”]+$/g, "");
  }
  // drop empty entries
  for (const id of Object.keys(base)) if (!base[id].dialogue) delete base[id];
  for (const id of Object.keys(alternates)) {
    for (const n of Object.keys(alternates[id])) {
      if (!alternates[id][+n].dialogue) delete alternates[id][+n];
    }
    if (!Object.keys(alternates[id]).length) delete alternates[id];
  }
  return { base, alternates };
}

export function validateScript(script: ParsedScript, template: Template, file: string): void {
  const valid = new Set(template.beats.map((b) => b.id));
  for (const id of [...Object.keys(script.base), ...Object.keys(script.alternates)]) {
    if (!valid.has(id)) {
      throw new Error(`${file}: unknown beat "${id}" — valid beats for this template: ${[...valid].join(", ")}`);
    }
  }
}

/**
 * Merge hand-authored `## beat@N` lines into beats[i].alternates — the user's
 * lines always win over LLM-generated alternates. Missing lower slots are
 * filled from the base beat (with a warning: a base-identical take is a wasted render).
 */
export function applyScriptAlternates(sb: Storyboard, script: ParsedScript): void {
  for (const [beatId, byN] of Object.entries(script.alternates)) {
    const beat = sb.beats.find((b) => b.id === beatId);
    if (!beat) continue;
    const arr = (beat.alternates ??= []);
    for (const [nStr, locked] of Object.entries(byN)) {
      const idx = parseInt(nStr, 10) - 2;
      while (arr.length <= idx) {
        const fillN = arr.length + 2;
        if (fillN !== parseInt(nStr, 10)) {
          log.warn(`script.md defines ${beatId}@${nStr} but not ${beatId}@${fillN} — filling @${fillN} from the base beat (identical take; consider adding a line or running: adstitch alternates)`);
        }
        arr.push({ dialogue: beat.dialogue, action: beat.action, camera: beat.camera, emotion: beat.emotion, startFramePrompt: beat.startFramePrompt });
      }
      arr[idx] = { ...arr[idx], dialogue: locked.dialogue, ...(locked.action ? { action: locked.action } : {}) };
    }
  }
}

const paceCheck = (label: string, dialogue: string, durationSeconds: number) => {
  const words = dialogue.split(/\s+/).filter(Boolean).length;
  const cap = Math.round(durationSeconds * 2.5);
  if (words > cap) {
    log.warn(
      `beat "${label}": ${words} words in ${durationSeconds}s (~${(words / 2.2).toFixed(1)}s of speech) — likely truncated. Trim the line or raise durationSeconds (4/6/8).`,
    );
  }
};

/** ~2.2 words/sec is a natural UGC pace; past ~2.5 Veo tends to truncate the line */
export function warnDialoguePacing(sb: Storyboard): void {
  for (const beat of sb.beats) {
    paceCheck(beat.id, beat.dialogue, beat.durationSeconds);
    beat.alternates?.forEach((alt, k) => paceCheck(`${beat.id}@${k + 2}`, alt.dialogue, beat.durationSeconds));
  }
}
