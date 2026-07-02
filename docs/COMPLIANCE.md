# Compliance — AI ad rules that actually get ads rejected (verified July 2026)

The storyboard planner enforces the script-side rules automatically (prompts.ts
rules 10–12). The platform-side steps are on you at upload time.

## Non-negotiables

1. **FTC fake-testimonial rule (16 CFR 465, in force):** an AI persona claiming
   personal experience or results ("I lost 10 lbs", "cleared my skin in a week")
   is a fake testimonial — up to ~$53k per violation, each ad counted
   separately. The persona must be a **presenter**: demonstrative ("watch what
   happens"), design claims ("built to…"), or attributed proof ("customers
   report…" — only with real substantiation). First-person feelings about the
   *category* are fine ("I was so over the usual options").
2. **TikTok requires the AIGC disclosure toggle** on AI-generated ads — undisclosed
   AI content is an explicit rejection ground. Flip "AI-generated content" in
   Ads Manager on every upload; note campaign duplication resets it.
3. **Meta auto-labels AI ads from June 1, 2026** (C2PA detection; Veo embeds
   SynthID). Don't strip metadata to dodge the label — that pattern-matches
   "Circumventing Systems" and risks the ad account, not just the ad.
4. **No second-person personal-attribute hooks** ("Do you struggle with
   [condition]?", "Depression getting you down?") — per-se Meta violation.
   Rewrite POV: first-person creator ("I was bloated every night until…") or
   general truth ("Bloating after every meal isn't normal").
5. **No before/after transformations in health/beauty/weight** on either
   platform, regardless of truth. Safe categories for the before-after
   template: cleaning, organization, non-medical cosmetics results.
6. **Every objective claim needs pre-existing substantiation** (FTC "reasonable
   basis"; health claims ≈ human RCTs). Claims come from the brief's "Key
   claims" — the planner is instructed never to invent them.
7. **Persona must be original** — no resemblance to an identifiable real person
   or celebrity (banned everywhere even with an AI label). NY GBL §396-b (since
   June 9, 2026) additionally requires conspicuous disclosure when an ad uses an
   AI human-seeming performer.
8. **Competitors:** default to unbranded references ("my old greens powder",
   "the $90 one"). Plain-text naming is possible on Meta with substantiation,
   but TikTok bans negative judgements about a named brand's price/quality even
   when true. Never show a competitor's logo, pack, or UI.
9. **No fake UI in creatives** — play buttons, countdown timers, OS dialogs
   ("nonexistent functionality").

## Quality/perception notes (not policy, but measured)

- AI-labeled ads carry a measurable trust tax; polished execution narrows it.
- The most-scrutinized artifacts: lip-sync drift, dead-eye smiles, hand
  morphing, and persona drift at cut points — adstitch's keyframe lock attacks
  the last one; prompts avoid tight mouth close-ups and complex finger work.
- 21–34s total runtime is TikTok's measured conversion sweet spot; ≤15s for
  Story placements.
