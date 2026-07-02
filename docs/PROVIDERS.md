# Adding a provider

A provider implements three narrow methods (`src/providers/types.ts`):

```ts
interface Provider {
  name: string;
  generateJson(req: TextRequest): Promise<string>;          // storyboard planning
  generateImage(req: ImageRequest): Promise<void>;          // keyframes (writes req.outPath)
  generateVideo(req: VideoRequest): Promise<VideoResult>;   // segments (writes req.outPath)
  listModels?(): Promise<string[]>;
}
```

You can mix capabilities: e.g. keep Gemini for `generateJson`/`generateImage` and
route only `generateVideo` elsewhere (make a small composite provider).

## What the pipeline expects from `generateVideo`

- Honor `firstFramePath` — the segment MUST begin on (approximately) that image.
- If the backend supports an end-frame constraint, honor `lastFramePath`; if not,
  **throw when it's set** so the user knows to use a cut-only template rather than
  silently producing un-matchable clips.
- Respect `durationSeconds`, `aspectRatio`, and write a plain .mp4 with audio
  (or silence) to `outPath`. The stitcher normalizes codecs, so exact encoding
  doesn't matter.

## Capability map (for planning)

| Backend | first frame | last frame | reference images | native audio |
| --- | --- | --- | --- | --- |
| Veo 3.1 (Gemini API) | ✓ | ✓ | ✓ (3 asset) | ✓ |
| Kling 2.x (via fal.ai) | ✓ | ✓ (start+end) | varies | ✗/limited |
| Wan 2.2 (local ComfyUI) | ✓ | FLF2V workflows | via IP-adapter | ✗ |
| Runway / Luma | ✓ | ✓ (keyframes) | varies | varies |

No last-frame support ⇒ only `cut` templates (or implement extract-last-frame
chaining: render serially, `util/ffmpeg.ts:extractLastFrame` the previous segment,
pass it as the next `firstFramePath`).

No native audio ⇒ plan a TTS pass for dialogue (ElevenLabs etc.) mixed in stitch —
not implemented yet; keep dialogue out of the video prompt in that case.

## Wiring

1. `src/providers/<name>.ts` implementing `Provider`.
2. Add the name to `ConfigSchema.provider` enum in `src/config.ts`.
3. Instantiate it in `makeCtx()` in `src/cli.ts`.
4. Add pricing entries to `pricing` config so estimates and the ledger stay honest.
