# Continuity: why stitched AI clips usually don't match, and how adstitch fixes it

## The failure mode

Generate five 8-second clips from five text prompts and every clip invents its own
actress, outfit, kitchen, lighting and camera. Even prompting "same woman, same
pool" doesn't work — the model has no memory between generations. Starting each
clip from a fresh image helps the *first* frame but the *ends* remain uncontrolled,
so clip 2 never lines up with where clip 1 stopped. That's the "start and end of
each video completely changes" problem.

## The three locks

### 1. Identity lock — same person, product, place in every generation

- **Cast references.** Real product photos from `assets/` (or a generated persona
  portrait) are attached as reference images to **every keyframe generation**
  (Nano Banana honors multi-image identity), so all frames contain the same face,
  wardrobe and label.
- **One style block.** The code — not the LLM — assembles every video prompt, and
  the style block (persona description, wardrobe, setting, lighting, camera
  language, mood) is **byte-identical across all beats**. Beats differ only in the
  SHOT section (framing, action, dialogue).

### 2. Boundary control — every clip starts (and optionally ends) on a chosen frame

Veo 3.1 accepts an exact **first frame** (`image`) and an exact **last frame**
(`config.lastFrame`). adstitch exploits this two ways:

**Cut mode (`transitionOut: "cut"`)** — the default, and what Higgsfield-style ads
actually do. Each beat gets its own start keyframe: a *different angle* of the
*same person in the same scene*, all generated from the same cast references. The
joins are intentional editorial cuts — they read as filmmaking, not as glitches,
because identity/scene/lighting carry across.

**Match mode (`transitionOut: "match"`)** — for the "one continuous take" feel.
Adjacent beats share ONE boundary image:

```
keyframes:   K0 ──────── K1 ──────── K2 ──────── K3 ──────── K4
              \  beat 1  /\  beat 2  /\  beat 3  /\  beat 4  /...
segment 1:   first=K0, last=K1
segment 2:   first=K1, last=K2     ← starts on the SAME file segment 1 ended on
segment 3:   first=K2, last=K3
```

The cut lands on literally identical pixels, so plain concatenation is seamless.
Any residual micro-difference reads as a beat of stillness, not a scene change
(`--transition smooth` adds a 0.15s crossfade if you want extra insurance).

Because all boundary frames exist **before** any video is rendered, segments
generate **in parallel** — no waiting for clip N to finish to start clip N+1, and
any single segment can be re-rolled without touching the others (`regen`).

The storyboard planner is instructed to make each `match` boundary physically
reachable within the beat's duration and to write the next beat's start as the
same frozen frame — a boundary you can't plausibly move to in 6 seconds produces
rubber-banding motion.

### 3. Post lock — make the files themselves join cleanly

- normalize every segment to identical codec/fps/geometry (scale + pad, never
  stretch) and **loudness** (`loudnorm I=-16`), so neither the image nor the
  volume jumps at cuts;
- hard-cut concat by default, optional 0.15s micro-crossfade;
- optional **music bed mixed after the join** — a continuous bed papers over
  per-clip ambience differences. Never generate music inside the clips (it would
  clash at every cut); prompts explicitly ask for voice + ambience only.

## Secondary levers (already wired in)

- **Dialogue pacing:** ≤ ~2.2 words/second per beat, enforced in the storyboard
  prompt, so Veo never truncates a line mid-sentence.
- **negativePrompt:** subtitles/captions/on-screen text/watermarks/music/scene
  change/different person — kills Veo's occasional burned-in captions.
- **Variants:** `--variants hook=3` re-rolls just the hook with different seeds
  (identical boundary frames), the standard creative-testing move; pick with
  `stitch --pick hook=2`.
- **Regen cascade:** artifacts are content-hashed; regenerating a shared boundary
  keyframe automatically invalidates and re-renders both neighboring segments.

## Alternatives considered (and where they'd fit)

- **Extract-last-frame chaining** (render clip 1 → grab its final frame → seed
  clip 2): guarantees pixel-continuity but forces serial rendering, accumulates
  drift, and leaves each clip's end uncontrolled. Match mode dominates it when
  first+last conditioning is available; worth adding as a fallback for providers
  that only support a start image.
- **Veo scene extension** (`video` param continues from the final second): great
  for one long take, but least controllable at ad-beat boundaries and ties you to
  provider-side file retention (~2 days). Possible future `continuity: "extend"`.
