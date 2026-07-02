# Ad science cheat sheet (2025–2026, cited research digest)

Numbers that should shape every script. Sources verified against Meta/TikTok first-party docs where marked (1P).

## Hooks
- **Payoff lands by second 3.** 63% of highest-CTR TikToks show the key message in the first 3s; ~90% of ad recall accrues in the first 6s (1P TikTok).
- **Triple hook:** visual + spoken line + text overlay fire together and must be complementary, not redundant. Overlay ≤7 words, on screen ~0:00.5–0:04.
- **Variants must differ VISUALLY in the first 3–5s** — Meta dedupes creatives whose opening visuals match; text-only swaps don't count as new creative.
- Proven patterns to rotate: value promise · statement of intent ("watch me X with only Y") · question/invitation · demographic/pain callout ("if you're in your 30s and…") · negative ("stop doing X") · hot take · transformation tease · trend-test ("I tested the viral…") · curiosity gap · listicle open ("3 reasons…") · price shock · POV framing · direct-address · comment-reply/green-screen · pattern-interrupt props (post-it, text-message screen, whiteboard).
- Optimize hook rate = 3s views ÷ impressions (target 30–40%, rework <25%) — but promote/kill on CPA/ROAS, not hook rate (they barely correlate).

## Structure constants (any template)
- Product proposition ≤3s; problem named ≤10s; product visibly on screen through the body (+65% brand affinity, 1P TikTok); CTA spoken + shown in the final 3–5s, soft-phrased.
- Visual change every ~2s in the 5–15s window (hold-rate lever).
- Dialogue ≈2.2–2.5 words/sec (adstitch caps at 2.2 — trust the pacing warnings).
- **Durations:** TikTok 21–34s (+280% conversion vs shorter/longer, 1P) · Reels 15–30s · Stories ≤15s hard cap (longer gets split) · Shorts 10–30s. adstitch's ~26–34s templates sit in the sweet spot; cut a 3-beat ≤15s edit for Stories.

## Safe zones (1080×1920)
Keep faces, product, captions inside **x[65, 888] × y[288, 1248]** (cross-platform union: clears TikTok's right rail/caption stack, Meta's top 14%/bottom 35%, Shorts' 15%/35%). Caption anchor y≈1050–1250. Frame 1 = the cover: hero pose + product + overlay inside the box; export it as a custom thumbnail PNG for TikTok/Meta.

## Sound & captions
Always both: burned captions (muted Feed/Stories delivery) AND voice/music (+87% conversions for spoken offer, +80% for on-screen offer text, 1P TikTok; Meta: music/VO +13% incremental conversions). adstitch generates voice in-clip and music in post.

## Testing doctrine
- Default **3 hook variants per body, cap 5**; hold body/CTA/offer/landing constant; one variable per test.
- Diagnostic routing: low hook rate → swap hook · low hold rate → fix body pacing · watch-but-no-click → fix CTA/offer.
- Judge only after 48–72h AND ~2× target CPA spent. Kill: hook <20–25%, hold <10%, CTR <0.8% (Meta)/<1.5% (TikTok), CPA >2–3× target. Only 4–8% of ads become winners — volume is the game; ~70% iterations of winners / 30% new concepts.
- Fatigue: Meta creative lifespan 2–4 weeks; TikTok ~7 days — refresh hooks on winners rather than re-testing bodies.
- Name ads parseably: `{yyyymmdd}_{concept}_{angle}_{hook01}_{template}_{persona}_{v01}`.

## AI-specific quality levers
- Persona drift at cut points is the #1 detectable artifact (adstitch's keyframe lock exists for this). Avoid tight mouth close-ups and complex finger work. Cutaway/b-roll beats reduce on-camera avatar seconds. Match lighting language across beats (the style block does this).
- Expect a measurable label tax (TikTok AIGC label is mandatory; Meta auto-labels) — polish narrows it; simple text-forward formats overperform anyway.
