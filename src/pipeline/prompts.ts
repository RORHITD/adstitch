import type { Beat, Storyboard, Template } from "../types.js";

export interface LockedPersona {
  name?: string;
  personaVisual: string;
  personaVoice: string;
  wardrobe?: string;
}

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
    `Audio: her natural voice, subtle ambience that matches the location. No background music.`,
    `Strictly no on-screen text of any kind: no subtitles, no captions, no watermarks, no logos.`,
  ].join("\n");
}

export function alternatesRequestPrompt(
  sb: Storyboard,
  beat: Beat,
  count: number,
  aspectRatio: string,
  lockedLines?: Record<number, { dialogue: string; action?: string }>,
): string {
  const cap = Math.max(6, Math.round(beat.durationSeconds * 2.2));
  const base = {
    title: beat.title,
    goal: beat.goal,
    durationSeconds: beat.durationSeconds,
    camera: beat.camera,
    action: beat.action,
    dialogue: beat.dialogue,
    emotion: beat.emotion,
    startFramePrompt: beat.startFramePrompt,
  };
  const matchRule =
    beat.transitionOut === "match" && beat.endFramePrompt
      ? `\n5. CRITICAL: this beat frame-matches into the next one. Every alternate's "action" MUST end with the person in exactly this frozen end frame: "${beat.endFramePrompt}". Design the motion arc so that pose is physically reachable from the alternate's start frame within ${beat.durationSeconds}s.`
      : "";
  const lockedSection = lockedLines && Object.keys(lockedLines).length
    ? `\nLOCKED LINES — the user wrote these; use them VERBATIM as the dialogue for the given alternate number:\n${Object.entries(lockedLines)
        .map(([n, s]) => `- alternate ${+n - 1} of ${count}: "${s.dialogue}"${s.action ? ` (action note: ${s.action})` : ""}`)
        .join("\n")}\n`
    : "";

  return `You are a senior direct-response creative director writing ALTERNATE HOOK-STYLE TAKES of one beat for creative testing. The rest of the ad is locked; only this beat varies.
ALTERNATES_REQUEST
ALTERNATES_COUNT: ${count}

${styleBlock(sb, aspectRatio)}

PRODUCT: ${sb.campaign.product.name} — ${sb.campaign.product.description}
BASE BEAT (${beat.id}):
${JSON.stringify(base, null, 2)}
${lockedSection}
RULES:
1. Each alternate uses a DIFFERENT proven opening pattern (pick the best ${count} DIFFERENT fits for this product/audience): value promise · statement of intent ("watch me…") · question/invitation · demographic/pain callout · negative ("stop doing X") · hot take · trend-test ("I tested the viral…") · curiosity gap · price shock · POV framing. Never reuse the base beat's pattern.
2. "startFramePrompt" must describe a VISUALLY DISTINCT frozen frame from the base and from every other alternate — different pose, prop, framing, or position in the SAME location with the SAME person, wardrobe, and lighting (platforms dedupe visually similar openings).
3. dialogue ≤ ${cap} words, natural spoken register, no emojis. Same compliance rules as the base ad: presenter framing, no invented experience claims, no second-person personal-attribute questions.
4. "camera": ONE move from: slow push-in, crash zoom, handheld selfie sway, slow orbit/arc, whip-pan into frame, dolly-out reveal, static with subject lean-in.${matchRule}

Return ONLY a JSON object (no markdown): {"alternates": [{"dialogue": string, "action": string, "camera": string, "emotion": string, "startFramePrompt": string}]} with exactly ${count} items.`;
}

export function qcJudgePrompt(sb: Storyboard): string {
  return `QC_JUDGE
You are a strict quality inspector for AI-generated video ad segments.
Image 1 is the intended first-frame keyframe. The remaining images are frames sampled from the start, middle, and end of the rendered segment.
The person who must appear: ${sb.style.personaVisual}
The product: ${sb.campaign.product.name}.

FAIL the segment if ANY of these is true:
(a) the person in the video frames is clearly a DIFFERENT person than image 1 (face, hair, or wardrobe changed);
(b) burned-in subtitles, captions, watermarks, or any overlaid text appear;
(c) grotesque anatomical artifacts: mangled or extra fingers, warped face, melted features;
(d) the product label is prominently featured but illegibly garbled;
(e) the scene bears no resemblance to image 1 (wrong location or framing entirely).
Minor softness, small motion blur, natural pose changes, or slight color shift are NOT failures.

Return ONLY JSON: {"pass": boolean, "reasons": string[]} — reasons empty when passing, each reason ≤12 words otherwise.`;
}

export function keyframePrompt(sb: Storyboard, framePrompt: string, aspectRatio: string): string {
  const s = sb.style;
  return [
    `Photorealistic vertical ${aspectRatio} still frame from a UGC smartphone video (not a studio photo).`,
    `Use the attached reference images as ground truth: the person's face, hair and body must be IDENTICAL to the person reference; the product and its label must be IDENTICAL to the product reference.`,
    `Wardrobe: ${s.wardrobe}. Location: ${s.setting}. Lighting: ${s.lighting}. Mood: ${s.mood}.`,
    `FRAME: ${framePrompt}`,
    `Compose with the subject's face and the product in the vertical middle of the frame — the top ~15% and bottom ~35% get covered by platform UI and captions.`,
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
  persona?: LockedPersona,
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

  const personaSection = persona
    ? `\nLOCKED PERSONA — a saved persona is attached to this project. Use these EXACT values verbatim as style.personaVisual and style.personaVoice${persona.wardrobe ? " and style.wardrobe" : ""}; design everything else around this person:\npersonaVisual: ${persona.personaVisual}\npersonaVoice: ${persona.personaVoice}${persona.wardrobe ? `\nwardrobe: ${persona.wardrobe}` : ""}\n`
    : "";

  return `You are a senior direct-response creative director planning a stitched multi-segment UGC video ad.
Each segment will be generated INDEPENDENTLY by a video model, so consistency comes only from what you write here.

PRODUCT_NAME: ${productNameGuess}

CREATIVE BRIEF:
---
${brief}
---

${scriptSection}${personaSection}
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
10. COMPLIANCE (non-negotiable): the persona is a PRESENTER, not a fake customer. Never invent first-person experience or result claims ("I lost 10 lbs", "cleared my skin", "I noticed it on day one") — the FTC treats an AI persona claiming personal experience as a fake testimonial. Allowed framings: demonstrative ("here's how it works", "watch what happens"), design claims ("built for…", "designed to…"), or attributed proof ("customers report…") ONLY when the brief substantiates it. First-person feelings about the CATEGORY are fine ("I was so tired of X options"); invented product-experience results are not.
11. Never open with a second-person personal-attribute question ("Do you struggle with [condition]?" — platform violation). Use first-person-creator or general-truth phrasing ("Bloating after every meal isn't normal").
12. Frame compositions: keep the face and product in the vertical middle of the frame; platform UI covers the top ~15% and bottom ~35%. Avoid prolonged tight close-ups of the mouth and complex finger work (the two most scrutinized AI artifacts).
13. Camera: name ONE simple proven move per beat in the "camera" field — choose from: slow push-in, crash zoom (hooks), handheld selfie sway, slow orbit/arc (product reveals), whip-pan into frame, dolly-out reveal, static with subject lean-in. One move per shot, no combinations.

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
