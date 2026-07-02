---
name: makead
description: Turn a product idea or ad script into a finished stitched video ad using adstitch. Use when the user gives an ad idea, product, or script and wants the full ad produced (research → script → keyframes → videos → final stitch), or wants to iterate on an existing ad project.
---

# makead — idea in, finished ad out

You are the researcher + creative director; adstitch (this repo's CLI) is the deterministic renderer. The user gives an idea or a script; you do everything else, checkpointing with them before money is spent.

All commands run from the repo root: `node dist/cli.js <cmd>` (or `adstitch <cmd>` if linked). First time in a session, run `node dist/cli.js doctor` and stop if the key/ffmpeg is broken.

## Phase 1 — Understand (no cost)

If the user gave only an idea, collect what's missing (ask once, together): product name + what it is, audience, platform (default tiktok 9:16), CTA/offer, and **substantiated claims only** — never invent product claims; verify anything factual (pricing, "no card", ingredients, results) against the user or their site before it goes in copy.

If they gave a URL, fetch it for product facts and voice. Optionally search for 2-3 winning hook patterns in the product's category — steal the *pattern*, not the words.

## Phase 2 — Script (no cost; the user approves this)

Pick a template: `ugc-5beat` (default; editorial cuts), `ugc-5beat-seamless` (one-take feel), `before-after`, `testimonial`. Durations are fixed per template (4/6/8s beats).

Draft the script and show it as plain copyable text, one line per beat, word-capped at **≤ 2.2 words × the beat's seconds** (hook 8s → ≤17 words). Hooks: pattern-interrupt, first-person, no brand-speak. CTA: one action.

Iterate with the user until approved. Do not proceed to spend without an approved script.

## Phase 3 — Project files (no cost)

```bash
node dist/cli.js init <name> --template <t> --product "<product>"
```

- Write `projects/<name>/brief.md` (product/audience/CTA/notes from Phase 1).
- Write `projects/<name>/script.md` with the approved lines (verbatim-locked by the planner):

```md
## hook
"<approved line>"
action: <optional staging note>
```

- Tell the user to drop real product photos in `projects/<name>/assets/` as `product1.png…` — this is the single biggest quality lever. Wait for them if they have photos; generated product shots are a last resort.

Then `node dist/cli.js plan <name>` and show the beat table (dialogue + start-frame descriptions). Edit `storyboard.json` fields directly if anything reads wrong (it re-renders only what changed).

## Phase 4 — Keyframes checkpoint (~$1)

```bash
node dist/cli.js keyframes <name> && open projects/<name>/keyframes/
```

Have the user eyeball: same face everywhere? label readable? poses sensible? Fix by editing that beat's `startFramePrompt`/`endFramePrompt` in storyboard.json and re-running keyframes (only changed frames regenerate). Do not render video until keyframes pass.

## Phase 5 — Render + stitch (main spend; confirm first)

```bash
node dist/cli.js videos <name> --fast     # ~$5 for a 34s ad; shows estimate, asks confirmation
node dist/cli.js stitch <name>
```

Deliver `projects/<name>/final/*.mp4`. First-ever real run on a fresh key: validate with one beat first (`--beats hook`, ~$1.20).

## Phase 6 — Iterate

- Weak beat: `node dist/cli.js regen <name> <beat>` (add `--keyframes` to redo its frames; neighbors sharing a boundary re-render automatically).
- A/B hooks: `videos <name> --fast --variants hook=3`, then `stitch <name> --pick hook=2 --out <name>-hookB`.
- Music bed: `stitch <name> --music <file.mp3>`.
- Happy with the creative: re-render final on the quality model (drop `--fast`, ~$14.50) before running as an ad.

## Rules

- Rehearse anything for $0 with `--provider mock --yes` (placeholder clips, real pipeline).
- Never bypass the spend confirmation on someone else's behalf; show the estimate.
- Costs and model IDs live in `adstitch.config.json`; `node dist/cli.js models` lists what the key can see if an ID 404s.
- Troubleshooting: `doctor` (env), `status <name>` (progress + ledger), docs/CONTINUITY.md (why joins work).
