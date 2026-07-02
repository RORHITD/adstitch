# Roadmap

From a 4-agent research pass (2026-07-02): code audit vs current Gemini API docs, commercial-tool comparison (Higgsfield/Arcads/Creatify/MakeUGC/Icon/AdCreative), practitioner-complaint mining, and ad-science research. Fix-now audit items (stale pricing, referenceImages incompatibility, 1080p×8s guard, negativePrompt fallback, retry classification, mock provenance, cache-aware estimates, smoke test) and the **Veo 3.1 Lite draft tier** shipped same day.

Positioning note from the research: every major competitor's worst reviews are about **billing/credit opacity, not model quality** (Higgsfield "unlimited" scandals, Arcads/MakeUGC 2.8★ Trustpilot, Creatify credit burn). adstitch's answer is structural: BYO key, per-artifact ledger, cache-aware estimate-and-confirm, $0 mock rehearsal, $1.70 draft tier.

| # | Feature | Why | Touches | Effort | Value |
|---|---|---|---|---|---|
| 1 | **Hook matrix automation** (scripted alternates, not seed re-rolls) | Higgsfield ships 25+ hook variations; 3-hooks-per-body is media-buyer doctrine; variants must differ *visually* to survive Meta dedupe. Only the hook re-bills — the other ~26s of segments are shared across all combos, which per-video-priced competitors can't match | storyboard alternates → `videos --variants`, `stitch --matrix` | S | High |
| 2 | **Caption burn-in + .srt sidecar** | #1 finishing gap in every tool ("needs CapCut after"); +80% conversions for on-screen offer text (TikTok 1P). Local ffmpeg lacks drawtext/libass → render caption PNGs in Node (`@napi-rs/canvas`), composite with `overlay=enable=between(t,a,b)`; beat timings already known at stitch | new pipeline/captions.ts + stitch.ts | M | High |
| 3 | **Auto-QC of segments** | Real-world yield is brutal (Kalshi: ~4% of gens usable, all human-screened). After each segment: pHash first-frame-vs-keyframe (proves conditioning), one multimodal flash-judge call (same person? gibberish text? hand morphing? label legible?) ~$0.001, auto re-roll once on fail via existing regen machinery — "only pay for usable clips" | pipeline/qc.ts between videos/stitch | M | High |
| 4 | **Voice continuity** | Top stitched-Veo complaint: per-clip voices vary. Rung 1: `stitch --voice-lock` = ElevenLabs speech-to-speech over the stitched track (preserves timing/lipsync, unifies voice). Rung 2: Gemini TTS (30 consistent named voices) for VO-template ads. Rung 3: Veo `extend` mode carries voice natively | stitch.ts post-pass, providers/elevenlabs.ts | M | High |
| 5 | **Batch mode** (CSV/dir of briefs → N ads) | Meta rewards 15+ variants/campaign; competitors headline it; practitioners glue n8n+Sheets to fake it | cli `batch` over existing stages, global pLimit, one aggregate confirm | M | High |
| 6 | **Localization** (winner → N languages) | Nobody regenerates the *ad itself* per language (they dub after). Here: translate dialogue under the same pacing caps → sibling project reusing cast+keyframes → only video cost re-bills (~$1.70/language on Lite). Test Veo non-English speech quality; fall back to #4 | cli `localize` + script.ts | M | High |
| 7 | **Persona library** (cross-campaign reuse) | Arcads/Creatify actor libraries are the product; Higgsfield Soul ID = persistent identity. `personas/<name>/` (portrait + persona.json with visual/voice/wardrobe text), `init --persona <name>` | cast.ts + init | S | Med-High |
| 8 | **Stories/platform cuts** | Stories hard-caps at 15s (longer gets split); emit a 3-beat ≤15s edit (hook→reveal→cta) from existing segments — free, local | stitch.ts `--platform stories` | S | Med |
| 9 | Compliance pre-flight (`check` cmd) | AdCreative sells this; Meta personal-attributes + health claims are the top rejection drivers; rules already encoded in prompts — lint storyboard.json against them | new check cmd | S | Med |
| 10 | Lyria 3 music generation (`--music generate:<vibe>`) | `lyria-3-clip-preview` $0.04/30s — kills the royalty-free-music hunt | provider generateMusic + stitch | S | Med |
| 11 | URL ingestion (landing page → brief + product images) | Creatify URL-to-video / Higgsfield Click-to-Ad prove table stakes; /makead already fetches text — add image pull into assets/ | /makead skill | S | Med |
| 12 | `extend` continuity mode | Native +7s×20 chaining on the Gemini API; carries voice/scene; `remoteUri` already stored (2-day retention) | videos.ts, gemini.ts | M | Med |
| 13 | Direct Meta publish | Meta Ads MCP can create campaign/adset/creative/ad from Claude | /makead or `publish` cmd | M | Med |
| 14 | Cover/thumbnail export | Frame 1 = de facto poster everywhere; export hero keyframe + overlay as PNG for custom upload | stitch.ts | S | Low-Med |
| 15 | 4K master tier ($0.60/s, 8s-only) | New Veo tier for ship-version masters | config enum + validation | S | Low |
| 16 | Two-pass loudnorm | single-pass dynamic mode can pump on quiet clips | stitch.ts | S | Low |

Refuted by research (don't build): separate product-background-replacement (Nano Banana keyframes with real product refs already do this); 16:9-from-9:16 crop exports (destroys composition — re-render natively at 16:9 instead).
