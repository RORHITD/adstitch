# adstitch

Generate **stitched multi-beat video ad creatives** (Hook → Problem → Product Reveal → Result → CTA) from a product brief, using the Gemini API (Veo 3.1 + Nano Banana) directly — the Higgsfield workflow without the Higgsfield bill.

The hard part of stitching AI clips is that each generation reinvents the person, wardrobe, set and lighting, so cuts look like different ads spliced together. adstitch solves continuity structurally — see [docs/CONTINUITY.md](docs/CONTINUITY.md):

1. **Identity lock** — one persona + real product photos become *reference images* for every keyframe; one style block is repeated byte-identically in every video prompt.
2. **Boundary control** — every segment is generated **from an exact first frame** (and, in seamless mode, **to an exact last frame**) using Veo 3.1 first/last-frame conditioning. Adjacent segments share the literal same boundary image, so joins are invisible.
3. **Post lock** — segments are normalized (codec/fps/geometry/loudness) and joined with hard cuts or micro-crossfades, with an optional music bed mixed *after* the join.

## Quickstart

```bash
npm install && npm run build
cp .env.example .env        # add your key from https://aistudio.google.com/apikey
node dist/cli.js doctor     # verify ffmpeg + key + models

node dist/cli.js init my-ad --template ugc-5beat --product "GlowPop Probiotic Soda"
# 1. edit projects/my-ad/brief.md  (see examples/poppi-style-brief.md)
# 2. drop REAL product photos into projects/my-ad/assets/ as product1.png…
#    optional: persona.png to lock the on-camera person
node dist/cli.js run my-ad          # plan → cast → keyframes → videos → stitch
open projects/my-ad/final/*.mp4
```

Try the whole pipeline **free** first with the mock provider (ffmpeg-synthesized placeholder clips, real stitching):

```bash
node dist/cli.js run my-ad --provider mock --yes
```

## Commands

| Command | What it does |
| --- | --- |
| `init <name> [--template t] [--product p]` | scaffold a campaign project |
| `plan <name>` | brief.md → `storyboard.json` (edit it — it's the source of truth) |
| `cast <name>` | resolve/generate persona + product reference images |
| `keyframes <name>` | generate start/boundary frames with identity references |
| `videos <name> [--fast] [--beats ids] [--variants hook=3]` | render each beat with Veo (parallel, resumable) |
| `stitch <name> [--transition cut\|smooth] [--music f.mp3] [--pick hook=2]` | normalize + join + optional music bed |
| `run <name>` | all of the above |
| `regen <name> <beat> [--keyframes]` | invalidate one beat and re-render (boundary changes cascade to neighbors automatically) |
| `status` / `cost` / `doctor` / `models` | progress, spend estimate + ledger, env check, live model list |

Every artifact is content-hashed in `manifest.json`: re-runs skip anything whose inputs didn't change, so a crash or an edit never re-bills finished work. Real-money runs show a cost estimate and ask for confirmation (`--yes` to skip).

## Two ways to drive it

**Give it a script.** Drop a `script.md` next to the brief with your exact lines — the planner uses them verbatim and designs visuals around them (beats you omit are written for you; over-long lines get a pacing warning):

```md
## hook
"Okay, stop scrolling. You need to see this."
action: leans into the camera holding the can

## cta
"Tap the link below — 20% off this week."
```

**Give it an idea.** In Claude Code, run `/makead` from this repo: Claude researches the product, drafts the script with you (word-capped per beat), writes the project files, checkpoints you on the $1 keyframes, then renders and stitches the final ad.

## Templates

`ugc-5beat` (the classic stitched ad, editorial cuts), `ugc-5beat-seamless` (frame-matched, plays like one take), `before-after`, `testimonial`. Add your own JSON to `templates/` — durations must be 4/6/8s (Veo's allowed lengths).

## Cost (estimates — verify current pricing)

A 34s five-beat ad at 720p vertical:

| Tier | Video | Keyframes (~7 imgs) | Total |
| --- | --- | --- | --- |
| `veo-3.1-fast` | 34s × $0.15 ≈ $5.10 | ≈ $0.95 | **≈ $6** |
| `veo-3.1` | 34s × $0.40 ≈ $13.60 | ≈ $0.95 | **≈ $14.50** |

Extra hook variants for A/B testing: ~$1.20 (fast) / ~$3.20 (quality) each. Rates live in `adstitch.config.json` → `pricing`.

## Configuration

Optional `adstitch.config.json` at the repo root or inside a project (project wins). Everything has sane defaults; the useful knobs:

```jsonc
{
  "provider": "gemini",
  "models": { "video": "veo-3.1-generate-preview", "videoFast": "veo-3.1-fast-generate-preview" },
  "defaults": {
    "aspectRatio": "9:16", "resolution": "720p", "concurrency": 2,
    "useHqKeyframes": true,          // Nano Banana Pro for keyframes (better identity lock)
    "videoReferenceImages": false    // experimental: also pass cast refs to Veo itself
  }
}
```

Model IDs churn — `adstitch models` lists what your key can see; override in config. The repo `.env` **overrides** shell-exported `GEMINI_API_KEY`/`GOOGLE_API_KEY` on purpose (stale shell keys are a classic silent failure).

## Notes

- **Real product photos matter.** Generated product shots drift; photos in `assets/` become ground truth for every frame.
- Dialogue is auto-capped (~2.2 words/sec) so Veo doesn't truncate speech mid-clip.
- Music is mixed in post, never generated per-clip (per-clip music clashes at every cut). Prompts and `negativePrompt` suppress subtitles/captions/on-screen text.
- `personGeneration` defaults to `allow_adult`; image-to-video person generation has regional restrictions (EU/UK/CH/MENA) — see Google's docs.
- Adding providers (fal.ai, Replicate, local ComfyUI/Wan): [docs/PROVIDERS.md](docs/PROVIDERS.md).
