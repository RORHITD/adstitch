import fs from "node:fs";
import type { Storyboard, Template } from "../types.js";
import { log } from "../util/log.js";

// Optional projects/<name>/script.md — user-authored lines the planner must use
// VERBATIM. Format:
//
//   ## hook
//   "Okay, stop scrolling. You need to see this."
//   action: leans into the camera holding the can
//
//   ## problem
//   I was so over the usual options.
//
// Beat ids must match the template; beats you omit are written by the LLM.

export interface ScriptBeat {
  dialogue: string;
  action?: string;
}

export function parseScript(file: string): Record<string, ScriptBeat> {
  const out: Record<string, ScriptBeat> = {};
  let current: string | undefined;
  const dialogueLines: Record<string, string[]> = {};

  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    const header = line.match(/^##\s+([a-z0-9-]+)\s*$/i);
    if (header) {
      current = header[1].toLowerCase();
      out[current] = { dialogue: "" };
      dialogueLines[current] = [];
      continue;
    }
    if (!current || !line || line.startsWith("#")) continue;
    const action = line.match(/^action:\s*(.+)$/i);
    if (action) {
      out[current].action = action[1].trim();
    } else {
      dialogueLines[current].push(line);
    }
  }

  for (const [id, lines] of Object.entries(dialogueLines)) {
    const joined = lines.join(" ").replace(/\s+/g, " ").trim();
    out[id].dialogue = joined.replace(/^["'“]+|["'”]+$/g, "");
    if (!out[id].dialogue) delete out[id];
  }
  return out;
}

export function validateScript(script: Record<string, ScriptBeat>, template: Template, file: string): void {
  const valid = new Set(template.beats.map((b) => b.id));
  for (const id of Object.keys(script)) {
    if (!valid.has(id)) {
      throw new Error(`${file}: unknown beat "${id}" — valid beats for this template: ${[...valid].join(", ")}`);
    }
  }
}

/** ~2.2 words/sec is a natural UGC pace; past ~2.5 Veo tends to truncate the line */
export function warnDialoguePacing(sb: Storyboard): void {
  for (const beat of sb.beats) {
    const words = beat.dialogue.split(/\s+/).filter(Boolean).length;
    const cap = Math.round(beat.durationSeconds * 2.5);
    if (words > cap) {
      log.warn(
        `beat "${beat.id}": ${words} words in ${beat.durationSeconds}s (~${(words / 2.2).toFixed(1)}s of speech) — likely truncated. Trim the line or raise durationSeconds (4/6/8).`,
      );
    }
  }
}
