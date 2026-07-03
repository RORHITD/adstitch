---
name: makead
description: Turn a product idea or ad script into a finished stitched video ad using adstitch. Use when the user gives an ad idea, product, or script and wants the full ad produced (competitor research → script → keyframes → videos → final stitch), or wants to iterate on an existing ad project.
---

# makead — idea in, finished ad out

You are the researcher + creative director; adstitch (this repo's CLI) is the deterministic renderer. The user gives an idea or a script; you do everything else, checkpointing before money is spent.

Commands run from the repo root: `node dist/cli.js <cmd>`. First time in a session run `doctor`; stop if the key/ffmpeg is broken. References for your phases: `references/research-playbook.md` (Phase 1), `references/ad-science.md` (Phase 2), `docs/COMPLIANCE.md` (always).

## Phase 0 — Intake (no cost)

Collect in one round: product name + what it is (or URL — fetch it for facts and voice), audience, platform (default tiktok 9:16), CTA/offer, and **substantiated claims only** — never invent product claims; anything factual (pricing, ingredients, results) gets verified against the user or their site before it enters copy.

## Phase 1 — Market research (no cost, 15–30 min)

Execute `references/research-playbook.md`: 3 competitors → complaint themes (with verbatims), praise themes/table stakes, live-ad intel via the Meta Ads Library MCP tool when available, category language, angle map. Compliance-tag every theme as you go.

Write the result into the project's `brief.md` under `# Market insights` (JSON block + the 5-line executive summary) — the storyboard planner reads the whole brief, so real complaint language flows straight into the Problem beat and dialogue.

## Phase 2 — Script (no cost; user approves before any spend)

Template by intent (`templates/`): `ugc-5beat` default · `problem-solution` functional demo · `listicle` objection-heavy categories · `before-after` (never health/beauty/weight) · `testimonial` ONLY with real substantiated customer quotes · `ugc-5beat-seamless` one-take feel.

Apply `references/ad-science.md`: payoff by second 3; hooks from the taxonomy aimed at the angle-map's *underused* space; dialogue ≤2.2 words × seconds per beat; persona = presenter, never a fake customer (FTC); no second-person personal-attribute hooks; product visible throughout; CTA = one action.

Show the script as plain copyable text, one line per beat + action notes. Offer 3 hook alternatives (visually distinct scenes, not word swaps). Iterate until the user approves.

**Viral-ad cloning:** if the user shares an ad they like (link or description), break down its structure — hook pattern, beat order, per-beat seconds, camera language, tone — and rebuild that structure for their product (never their footage, persona, or claims). Map it onto the closest template, overriding beat goals as needed.

## Phase 3 — Project files (no cost)

```bash
node dist/cli.js init <name> --template <t> --product "<product>"
```

Write `brief.md` (Phase 0 + 1 content) and `script.md` (approved lines, verbatim-locked):

```md
## hook
"<approved line>"
action: <staging note>
```

Ask for real product photos → `projects/<name>/assets/product1.png…` (the single biggest quality lever; wait if they have them). Then `plan <name>` and show the beat table; hand-edit `storyboard.json` if anything reads wrong.

## Phase 4 — See the creative before committing (~$0.15, then ~$1)

1. **Style frame first:** `keyframes <name> --beats reveal --candidates 3` → three takes on the hero frame (~$0.40). Show the user: right persona? right vibe? label correct? Pick by overwriting the primary file (`cp b2-reveal-start.alt2.png b2-reveal-start.png`); adjust `storyboard.json` style fields and re-run until it looks like the ad they imagined.
2. Then the full set: `keyframes <name>` → eyeball all frames (same face everywhere, poses sensible, face+product vertically centered — top 15%/bottom 35% get covered by platform UI).

Do not render video until keyframes pass.

## Phase 5 — Render + stitch (confirmed spend)

```bash
node dist/cli.js videos <name> --draft     # ~$1.70 full ad on Veo Lite — the iteration tier
node dist/cli.js stitch <name>
```

Iterate at draft prices (`regen <name> <beat> --draft`, `--variants hook=3` ≈ $0.40/extra hook). When the creative is right: `videos <name> --force --fast` (~$3.40) or quality (`--force`, ~$13.60) for the ship version, then `stitch`. First-ever run on a fresh key: validate with `--beats hook` first. Deliver `projects/<name>/final/*.mp4`.

## Phase 6 — Ship + iterate

- A/B: `--variants hook=3` + `stitch --pick hook=2 --out <name>-h2`. Hooks must differ *visually* to count as different creatives — vary `startFramePrompt` scenes across variants, not just words.
- Music bed: `stitch <name> --music <file.mp3>`.
- Name exports parseably: `{yyyymmdd}_{concept}_{angle}_{hook}_{template}` via `--out`.
- **Upload compliance (tell the user, every time):** TikTok → flip the "AI-generated content" toggle (mandatory; duplication resets it). Meta auto-labels AI ads — never strip metadata. Details: `docs/COMPLIANCE.md`.
- Kill/refresh doctrine and safe-zone specs: `references/ad-science.md`.

## Rules

- Rehearse anything for $0: `--provider mock --yes`.
- Never bypass the spend confirmation on the user's behalf; show the estimate (it's cache-aware — unchanged work shows $0).
- Model IDs churn: `models` lists what the key sees; override in `adstitch.config.json`.
- Troubleshooting: `doctor`, `status <name>`, `docs/CONTINUITY.md`.
