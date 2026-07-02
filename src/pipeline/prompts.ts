import type { Beat, Storyboard, Template } from "../types.js";

// The code owns every prompt template; the LLM only fills semantic fields.
// This guarantees the style block is byte-identical across all segments —
// which is half of what keeps clips consistent enough to stitch.

export const DEFAULT_NEGATIVE_PROMPT = [
  "subtitles",
  "captions",
  "on-screen text",
  "watermark",
  "logo overlays",
  "background music",
  "jump cuts",
  "scene change",
  "different person",
  "wardrobe change",
  "morphing",
  "distorted hands",
  "extra fingers",
].join(", ");

export function styleBlock(sb: Storyboard, aspectRatio: string): string {
  const s = sb.style;
  return [
    `STYLE — identical in every segment of this ad:`,
    `- Person on camera: ${s.personaVisual}. Voice: ${s.personaVoice}.`,
    `- Wardrobe (never changes): ${s.wardrobe}`,
    `- Location: ${s.setting}`,
    `- Lighting: ${s.lighting}`,
    `- Camera style: ${s.cameraLanguage}`,
    `- Mood: ${s.mood}`,
    `- Format: photorealistic vertical ${aspectRatio} UGC smartphone video, realistic skin texture, natural hand movement, true-to-life color.`,
  ].join("\n");
}

export function videoPrompt(sb: Storyboard, beat: Beat, aspectRatio: string): string {
  return [
    styleBlock(sb, aspectRatio),
    "",
    `THIS SHOT — "${beat.title}" (${beat.durationSeconds}s, one continuous take, no cuts):`,
    `Camera: ${beat.camera}`,
    `Action: ${beat.action}`,
    `She looks into the lens and says, "${beat.dialogue}" — delivered with ${beat.emotion}.`,
    `The product "${sb.campaign.product.name}" looks exactly like the first-frame image, label sharp and readable.`,
    `Audio: her natural voice, subtle ambience that matches the location. No music, no on-screen text.`,
  ].join("\n");
}

export function keyframePrompt(sb: Storyboard, framePrompt: string, aspectRatio: string): string {
  const s = sb.style;
  return [
    `Photorealistic vertical ${aspectRatio} still frame from a UGC smartphone video (not a studio photo).`,
    `Use the attached reference images as ground truth: the person's face, hair and body must be IDENTICAL to the person reference; the product and its label must be IDENTICAL to the product reference.`,
    `Wardrobe: ${s.wardrobe}. Location: ${s.setting}. Lighting: ${s.lighting}. Mood: ${s.mood}.`,
    `FRAME: ${framePrompt}`,
    `Slightly imperfect casual smartphone framing. No text, no watermark, no borders.`,
  ].join("\n");
}

export function castPersonaPrompt(sb: Storyboard, aspectRatio: string): string {
  return [
    `Photorealistic vertical ${aspectRatio} reference portrait for a UGC ad character, chest-up, facing camera, neutral friendly expression.`,
    `Person: ${sb.style.personaVisual}`,
    `Wardrobe: ${sb.style.wardrobe}. Location: ${sb.style.setting}. Lighting: ${sb.style.lighting}.`,
    `Natural skin texture, no retouching, no text, no watermark.`,
  ].join("\n");
}

export function castProductPrompt(sb: Storyboard, aspectRatio: string): string {
  const p = sb.campaign.product;
  return [
    `Photorealistic vertical ${aspectRatio} product reference photo of ${p.name}: ${p.description}.`,
    `Clean packshot on a simple surface in the ad's location (${sb.style.setting}), label facing camera, crisp and readable.`,
    `No text overlays, no watermark.`,
  ].join("\n");
}

export function storyboardRequestPrompt(
  brief: string,
  template: Template,
  productNameGuess: string,
  script?: Record<string, { dialogue: string; action?: string }>,
): string {
  const skeleton = template.beats;
  const paceRule = skeleton
    .map((b) => `- ${b.id} (${b.durationSeconds}s): dialogue MUST be ≤ ${Math.max(6, Math.round(b.durationSeconds * 2.2))} words`)
    .join("\n");

  const scriptSection = script && Object.keys(script).length
    ? `\nLOCKED SCRIPT — the user wrote these lines. Use them as the "dialogue" fields VERBATIM (do not rewrite, shorten, or extend them; ignore the word caps for these beats). Design camera, action and frames around them:\n${Object.entries(
        script,
      )
        .map(([id, s]) => `- ${id}: "${s.dialogue}"${s.action ? ` (action note: ${s.action})` : ""}`)
        .join("\n")}\n`
    : "";

  return `You are a senior direct-response creative director planning a stitched multi-segment UGC video ad.
Each segment will be generated INDEPENDENTLY by a video model, so consistency comes only from what you write here.

PRODUCT_NAME: ${productNameGuess}

CREATIVE BRIEF:
---
${brief}
---

${scriptSection}
BEAT SKELETON — keep ids, durations and transitions exactly as given, fill in the content:
BEAT_SKELETON_JSON:
${JSON.stringify(skeleton, null, 2)}
END_BEAT_SKELETON_JSON

HARD RULES:
1. ONE persona for the whole ad. "personaVisual" must be forensic-level specific (apparent age, ethnicity, face shape, hair color/length/style, skin, distinguishing features) so an image model can recreate the SAME person every time. Same for "wardrobe" — exact garments and colors, they never change.
2. One location, one lighting setup, one camera language for the whole ad. Beats vary by FRAMING and ACTION, not by scenery.
3. Dialogue must fit the clip length at a natural speaking pace:
${paceRule}
   Never exceed the cap. No emojis, no stage directions inside dialogue.
4. "startFramePrompt" / "endFramePrompt" describe a SINGLE FROZEN FRAME (pose, gaze, product position, framing) — not motion.
5. When a beat's transitionOut is "match": its endFramePrompt IS the literal first frame of the next beat. Write the next beat's startFramePrompt to describe that same frame, and make the pose physically reachable within the beat's duration.
6. When transitionOut is "cut": the next beat starts on a NEW framing/angle of the same person in the same location (that's the intentional editorial cut).
7. "action" describes a continuous, physically plausible movement arc from the start frame to the end of the shot. Keep hands simple (holding, pointing, lifting — no complex finger work).
8. The product must appear or be referenced in every beat; the label stays legible when featured.
9. Platform-native tone: this must feel like a real person talking to their phone, not a commercial voiceover.

Return ONLY a JSON object with this exact shape (no markdown, no commentary):
{
  "version": 1,
  "campaign": {
    "name": string, "product": { "name": string, "description": string, "keyClaims": string[] },
    "audience": string, "platform": string, "cta": string
  },
  "style": {
    "personaVisual": string, "personaVoice": string, "wardrobe": string, "setting": string,
    "lighting": string, "cameraLanguage": string, "mood": string
  },
  "beats": [ { "id": string, "title": string, "goal": string, "durationSeconds": number, "camera": string,
               "action": string, "dialogue": string, "emotion": string, "startFramePrompt": string,
               "endFramePrompt": string, "transitionOut": "cut" | "match" | "end" } ]
}`;
}
