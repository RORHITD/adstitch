# Roadmap

From a 4-agent research pass (2026-07-02): code audit vs current Gemini API docs, commercial-tool comparison (Higgsfield/Arcads/Creatify/MakeUGC/Icon/AdCreative), practitioner-complaint mining, and ad-science research. Fix-now audit items (stale pricing, referenceImages incompatibility, 1080p×8s guard, negativePrompt fallback, retry classification, mock provenance, cache-aware estimates, smoke test) and the **Veo 3.1 Lite draft tier** shipped same day.

Positioning note from the research: every major competitor's worst reviews are about **billing/credit opacity, not model quality** (Higgsfield "unlimited" scandals, Arcads/MakeUGC 2.8★ Trustpilot, Creatify credit burn). adstitch's answer is structural: BYO key, per-artifact ledger, cache-aware estimate-and-confirm, $0 mock rehearsal, $1.70 draft tier.

| # | Feature | Why | Touches | Effort | Value |
|---|---|---|---|---|---|
| 1 | ~~**Hook matrix automation**~~ **SHIPPED 2026-07-03** | `alternates <name> hook=3` (LLM alternates, distinct patterns + visually distinct openings) + `script.md ## hook@2` verbatim locks + `videos --variants` + `stitch --matrix` | — | — | — |
| 2 | **Caption burn-in + .srt sidecar** | #1 finishing gap in every tool ("needs CapCut after"); +80% conversions for on-screen offer text (TikTok 1P). Local ffmpeg lacks drawtext/libass → render caption PNGs in Node (`@napi-rs/canvas`), composite with `overlay=enable=between(t,a,b)`; beat timings already known at stitch | new pipeline/captions.ts + stitch.ts | M | High |
| 3 | ~~**Auto-QC of segments**~~ **SHIPPED 2026-07-03** | SSIM first-frame-vs-keyframe + multimodal judge per segment, auto re-roll once (user-approved), rejected takes parked, verdicts in manifest, `--no-qc` escape | — | — | — |
| 4 | **Voice continuity** | Top stitched-Veo complaint: per-clip voices vary. Rung 1: `stitch --voice-lock` = ElevenLabs speech-to-speech over the stitched track (preserves timing/lipsync, unifies voice). Rung 2: Gemini TTS (30 consistent named voices) for VO-template ads. Rung 3: Veo `extend` mode carries voice natively | stitch.ts post-pass, providers/elevenlabs.ts | M | High |
| 5 | **Batch mode** (CSV/dir of briefs → N ads) | Meta rewards 15+ variants/campaign; competitors headline it; practitioners glue n8n+Sheets to fake it | cli `batch` over existing stages, global pLimit, one aggregate confirm | M | High |
| 6 | **Localization** (winner → N languages) | Nobody regenerates the *ad itself* per language (they dub after). Here: translate dialogue under the same pacing caps → sibling project reusing cast+keyframes → only video cost re-bills (~$1.70/language on Lite). Test Veo non-English speech quality; fall back to #4 | cli `localize` + script.ts | M | High |
| 7 | ~~**Persona library**~~ **SHIPPED 2026-07-03** | `persona save <slug> --from <project>` / `persona list` / `init --persona <slug>` — portrait becomes the identity ref, description imposed verbatim on planning | — | — | — |
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

## vs Higgsfield (mechanical teardown, 2026-07-02)

Verified against their live product/pricing/docs:

| | Higgsfield | adstitch |
|---|---|---|
| Stitched 30s+ ad | **No** — Marketing Studio caps at 15s; official guidance: "batch two prompts and cut them together in post-production" | Core loop: N beats, auto-stitched, frame-matched joins |
| Continuity | Reference conditioning + Soul ID identity lock; start/end-frame exists only as a **manual** tool | Same identity-lock idea (keyframes + refs) PLUS automatic shared-boundary first/last-frame chaining |
| Product fidelity | Nano Banana keyframes-first (their best trick) | Same architecture, with *user's real product photos* as ground truth |
| 30s ad cost | $1–11 first take, ×3–5 retry tax → **$28–57 realistic** (Plus tier), + subscription + expiring credits + throttled "unlimited" queues | $2.65 draft / $4.35 fast / $14.50 quality, BYO key, cache never re-bills, per-artifact ledger |
| Script control | Prompt-level; no NLE; "prompt adherence 4.8/10" (reviews) | script.md verbatim lock; storyboard.json is fully editable text |
| Safe zones | **None** (auto-reframe only) | Encoded in keyframe/storyboard prompts + caption specs |
| Output rights | ToS grants them a perpetual, transferable license to your outputs | Yours (Google API terms) |
| Batch/API | MCP + credit gates | roadmap #5; hash-cached variants already cheaper structurally |

Adopted from the teardown (shipped same day): 4-candidate keyframe picker (`keyframes --candidates N` — their UGC Factory pattern), named camera-move vocabulary in the planner (their preset library, as prompt language, incl. "Robo Arm"-style orbit for product reveals). Adopt later (folded into table above): virality pre-score → part of #3 auto-QC; Topaz-style upscale/grain finishing pass (S, low); b-roll/cutaway beat type to reduce avatar screen time (S, med — template goal change); viral-ad structural cloning → /makead skill (shipped, no code).
