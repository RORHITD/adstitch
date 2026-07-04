# Contributing to adstitch

PRs welcome — this tool got better every time a real ad run surprised us, and yours will too.

## Dev setup

```bash
git clone https://github.com/RORHITD/adstitch && cd adstitch
npm install && npm run build
npm test          # 25-assertion mock e2e — no API key, no cost, ~60s
```

Everything is testable for **$0** via the mock provider (`--provider mock --yes`): it synthesizes keyframes/clips locally with ffmpeg and exercises the full pipeline including stitching math, caching, QC flow, alternates, and personas. Only ffmpeg is required (`brew install ffmpeg`).

## Ground rules

- **`npm test` must stay green.** New pipeline behavior needs a smoke assertion (see `scripts/smoke.mjs` — they're cheap to add).
- **No install scripts, ever.** This package ships zero `postinstall`/`prepare` hooks and dependencies are chosen partly for having none. PRs adding lifecycle scripts will be declined.
- **Never break the cache contract.** Every artifact is content-hashed over ALL its inputs (`segmentInputHash`/`keyframeInputHash`); anything that changes generation inputs must flow into the hash, and anything that doesn't must stay out (see the QC re-roll canonical-hash comment in `pipeline/videos.ts` for the cautionary tale).
- **The code owns prompt templates; LLMs fill fields** (`pipeline/prompts.ts`). Consistency across segments depends on this — don't move prompt assembly into model calls.
- **Real-API learnings are gold.** If the Gemini API rejects a parameter or a model behaves unexpectedly, a PR with the error message + fix (degrade ladder pattern in `providers/gemini.ts`) helps everyone.

## Good first contributions

See [ROADMAP.md](ROADMAP.md) — prioritized with implementation sketches. Standouts: caption burn-in + .srt (#2), voice-lock via speech-to-speech (#4), batch mode (#5), localization (#6), new providers (fal.ai/Kling, ComfyUI/Wan — interface in `docs/PROVIDERS.md`), and formula templates (pure JSON in `templates/`).

## Compliance matters

This tool encodes FTC/platform ad rules (`docs/COMPLIANCE.md`, prompt rules 10–12). Creative features must not weaken them — e.g., anything generating testimonial-style copy must keep the presenter-not-fake-customer constraint.
