# Architecture

## Pipeline

```
brief.md ──plan──▶ storyboard.json ──cast──▶ cast/*.png ──keyframes──▶ keyframes/*.png
                                                                          │
final/<name>.mp4 ◀──stitch── segments/*.mp4 ◀──────────videos────────────┘
```

Each stage reads the previous stage's on-disk output and records what it produced
in `manifest.json`. Stages are independently runnable; `run` chains all five.

- **plan** (`pipeline/storyboard.ts`) — LLM turns the brief + a formula template
  into a validated `storyboard.json` (zod `StoryboardSchema`). The code re-imposes
  the template's beat ids/durations/transitions after parsing, so the LLM cannot
  drift timing or the continuity plan. One retry with the validation errors fed back.
- **cast** (`pipeline/cast.ts`) — resolves identity references. User files in
  `assets/` (persona*/product*) always win; otherwise generated once from the
  storyboard descriptions.
- **keyframes** (`pipeline/keyframes.ts`) — `beatFrames()` is the continuity map:
  it decides which beats get their own start frame vs share a boundary file. All
  frames are generated with cast references attached.
- **videos** (`pipeline/videos.ts`) — one Veo call per beat×variant, first-frame
  (and last-frame, in match mode) conditioned, concurrency-limited, manifest saved
  after every completed render so paid work survives crashes.
- **stitch** (`pipeline/stitch.ts`) — normalize (geometry/fps/codec/loudness) →
  concat or xfade chain → optional music bed → `final/`.

## State & idempotence

`manifest.json` maps artifact ids (`cast/persona`, `keyframe/hook-start`,
`segment/hook@2`, …) to `{ inputHash, path, model, costUsd, remoteUri }` plus an
append-only spend ledger. `inputHash` is a sha256 over *all* determining inputs:
prompts, model ids, generation params, and the **content hashes of input files**
(keyframes, references). Consequences:

- re-running anything is free unless an input actually changed;
- editing `storyboard.json` by hand invalidates exactly the affected artifacts;
- `regen <beat> --keyframes` just deletes artifacts — the hash system then
  re-renders the beat *and any neighbor that consumed a deleted boundary frame*.

`remoteUri` stores the provider-side file (Veo retains ~2 days), kept for a future
`extend` continuity mode.

## Providers

`providers/types.ts` defines three narrow capabilities: `generateJson`,
`generateImage`, `generateVideo` (+ optional `listModels`). `gemini.ts` implements
all three against `@google/genai`; `mock.ts` synthesizes everything locally with
ffmpeg so the full pipeline (including stitch math) is testable at $0. The
pipeline treats providers as interchangeable — see PROVIDERS.md to add fal.ai /
Replicate / local ComfyUI.

## Code owns templates, LLM owns content

The single most important design rule (`pipeline/prompts.ts`): every video prompt
is assembled **in code** from a shared style block + the beat's semantic fields.
The LLM never writes final prompts. This guarantees cross-segment consistency and
makes prompt engineering a code change, not a model-behavior hope.

## Error handling

- transient API failures: bounded retries with jitter (`util/log.ts:retry`);
- Veo RAI filtering: surfaced with the filter reason instead of a generic failure;
- feature-combination rejections (e.g. referenceImages on a model that doesn't
  support them): auto-retry without the optional feature, with a warning;
- ffmpeg builds without `drawtext` (mock labels): detected, degrades to unlabeled.

## Future (deliberately not built yet)

- `continuity: "extract"` (last-frame chaining) and `"extend"` (Veo scene
  extension) as alternatives to keyframe mode.
- Caption/text-overlay pass (platform-native burned captions) in stitch.
- Audio ducking (sidechain) under dialogue instead of fixed music level.
- fal.ai provider for Kling/Wan/Hailuo, ComfyUI provider for local Wan 2.2.
- Batch mode: N briefs → N ads.
