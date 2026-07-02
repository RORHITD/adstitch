# Competitor Research Playbook (empirically verified 2026-07-02)

Execute once per product, 15–30 min. Output = the Market Insights brief (§3) written into the project's `brief.md` under `# Market insights`. Collect **verbatims, not summaries** (quote ≤25 words + URL + date), and compliance-tag every theme (§4).

The insights feed the script three ways: complaint themes → Problem beat + objections; praise themes → table stakes the ad must not concede; competitor ad angles → patterns to break or avoid.

## 1. Source access matrix (live-tested; don't rediscover this)

| Source | Direct fetch | Working path |
|---|---|---|
| Reddit | BLOCKED (403 platform-wide) | WebSearch snippets + PullPush API |
| Amazon reviews | BLOCKED (login wall since 2024) | WebSearch snippets (`{product} amazon reviews "customers say"`, `"returned it" OR "broke after"`) |
| Apple App Store | **WORKS** | `https://itunes.apple.com/us/rss/customerreviews/id={APP_ID}/sortBy=mostRecent/page=1/json` — 50/page, pages 1–10, filter 1–2★ (complaints) / 5★ (praise) client-side; sweep /gb/ /ca/ /au/ storefronts; `sortBy=mostHelpful` = highest verbatim density |
| Google Play | PARTIAL | fetch app page with reviews-targeted prompt; expect 3–4 reviews |
| Trustpilot | BLOCKED (403) | WebSearch: `trustpilot {brand} 1 star complaints "cancel" OR "refund"` |
| G2/Capterra/TrustRadius | BLOCKED (Cloudflare) | WebSearch: `site:g2.com {product} "what do you dislike"` |
| HN Algolia | **WORKS** | `https://hn.algolia.com/api/v1/search?query={product}&tags=comment` — brutal, quotable SaaS complaints |
| PullPush (Reddit archive) | **WORKS** | `https://api.pullpush.io/reddit/search/comment/?q="{brand}"&size=100` — sort by score client-side; archive-weighted (weak on last ~12mo), <15 req/min |
| YouTube | titles only | `{product} review site:youtube.com` — titles ARE angle intel ("Overpriced?", "Unsponsored", "3-Year Update" = skepticism frames to pre-empt); read written reviews for the same language |
| TikTok | BLOCKED (JS shell) | `site:tiktok.com {brand} honest` + `/discover/` SEO pages — caption sentiment in spoken register (ideal dialogue material) |
| Meta Ad Library web | BLOCKED for fetch | **MCP tool `ads_library_search` (verified working)** or hand the human `facebook.com/ads/library/?active_status=active&country=US&q={brand}` |
| TikTok Creative Center | 5 ads w/o login | fallback searches; hand the human the URL if logged in |

**Query discipline:** natural phrasing wins (`AG1 reddit honest review complaints price`); stacked quoted-OR operators return nothing. If `site:reddit.com` yields nothing, drop the operator, keep the word "reddit". Stop any path after 2 dead ends.

## 2. Meta Ad Library extraction (the highest-yield 8 minutes)

With the MCP tool: (1) `search_terms="{brand}"`, `countries:["US"]`, `ad_active_status:"ACTIVE"`, `limit:50` → get page_id + estimated_total_count; (2) re-query by `page_ids` to enumerate their ads; (3) one **category-term** query to map the whole market's angles.

Extract per competitor: **active ad count** (80 = scaling, 4 = maintenance) · **longevity** — `ad_delivery_start_time` >30–60 days old = proven winner (Meta keeps spending because it converts); mine long-runners' hooks first · dominant angle per long-runner · offers observed. Impression-range buckets now show on ads (<1K … 1M+). Flag 3–5 `ad_snapshot_url`s for the user to eyeball in a browser (full video isn't fetchable). No spend/CTR/targeting exists for commercial ads — don't over-claim.

## 3. Market Insights schema (write this into brief.md)

```jsonc
{
  "competitors": [ // 3-4 max: leader + closest price rival + the one whose ads are everywhere
    { "name": "", "positioning": "their homepage H1, not your inference",
      "price_offer": { "price": "", "structure": "", "guarantee": "", "current_promo": "" },
      "complaint_themes": [ { "theme": "", "frequency_signal": "12 mentions across 3 threads",
        "verbatim": { "quote": "≤25 words", "url": "", "date": "" },
        "compliance": "usable|rewrite-pov|paraphrase-only|unusable" } ],   // top 3, ranked by frequency × emotional intensity
      "praise_themes": [ { "theme": "", "verbatim": {}, "is_table_stake": true } ],  // top 3
      "ad_intel": { "active_ad_count": 0, "oldest_running_days": 0,
        "dominant_angles": [], "hooks_observed": [], "offers_observed": [] } } ],
  "category_language": {           // 10-15 phrases minimum — what makes AI dialogue sound human
    "problem_phrases": ["choking down", "$90 a month for vibes"],
    "desire_phrases": ["actually feel a difference"],
    "cliches_to_avoid": ["game-changer"] },   // saturated ad-speak seen in competitor ads
  "objections": [ { "objection": "", "severity": "", "counter_angle": "", "proof_required": "" } ],
  "table_stakes": [],              // praised across ≥2 competitors → never concede these
  "differentiators": [ { "claim": "", "substantiation": "have|need|none", "risk": "" } ],
  "angle_map": { "saturated": [], "underused": [], "forbidden": [] }
}
```

Rules: a "theme" needs ≥3 independent mentions (else it's a `gaps` note) · praise shared by ≥2 competitors = table stake, not a differentiator · complaints with concrete detail (numbers, time, sensory words) convert best into visual script moments.

## 4. Legal gate while extracting (full detail: docs/COMPLIANCE.md)

- Default **unbranded** competitor references ("my old greens powder"). TikTok bans negative judgements on a named brand's price/quality even when true; Meta allows truthful substantiated naming but never their logo/pack/UI.
- **Paraphrase complaints into openly dramatized dialogue** — facts aren't copyrightable, exact review text is; never screenshot review UI; a recognizable username in a paid ad = right-of-publicity exposure.
- Tag `rewrite-pov` on anything second-person + personal attribute ("Do you struggle with bloating?" → "I was bloated every night until…" / "Bloating after every meal isn't normal").
- Tag `unusable`: needs unsubstantiated claims, health/beauty/weight before-after, or named-brand disparagement.

## 5. Timed sequence

- **Phase 0 (2-3m):** `best {category} 2026` + `{brand} alternatives` → pick 3 competitors; fetch each homepage → positioning + price/offer.
- **Phase 1 (6-9m) complaints:** 2-3 queries per competitor from §1 (category-appropriate rows); bucket into themes with frequency signals; harvest problem_phrases simultaneously.
- **Phase 2 (3-4m) praise:** `{brand} reddit "love it" OR "actually works"` / Apple RSS 5★ / G2 "like best" → table_stakes + praise-unique-to-one → objections against us.
- **Phase 3 (5-8m) ad intel:** §2. No MCP → snippet searches + browser to-do links for the user.
- **Phase 4 (4-6m) synthesize:** fill schema, compliance-tag everything, then sanity check: ≥6 category_language phrases, ≥3 objections with counters, ≥1 underused angle — spend leftover budget on the weakest section. Emit JSON + 5-line executive summary (dominant angle, the gap we attack, the objection to kill first, the table stake to match, forbidden moves).

15-min minimum: 2 competitors, halve phases 1-3, never skip the compliance pass.
