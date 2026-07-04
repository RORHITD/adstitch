import { z } from "zod";

// ---------------------------------------------------------------------------
// Storyboard — the contract between the LLM planner and the render pipeline.
// The code owns the prompt templates; the LLM only fills semantic fields.
// ---------------------------------------------------------------------------

export const TransitionSchema = z.enum(["cut", "match", "end"]);
export type Transition = z.infer<typeof TransitionSchema>;

// A scripted alternate take of a beat (hook-matrix testing): different line AND
// a visually distinct opening scene, same locked persona/wardrobe/location.
export const AlternateSchema = z.object({
  dialogue: z.string(),
  action: z.string(),
  camera: z.string(),
  emotion: z.string(),
  startFramePrompt: z.string(),
});
export type Alternate = z.infer<typeof AlternateSchema>;

export const BeatSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  goal: z.string(),
  durationSeconds: z.number().int().min(4).max(8),
  camera: z.string().describe("framing + movement for this shot"),
  action: z.string().describe("what physically happens, start state → end state"),
  dialogue: z.string().describe("exact spoken line, must fit the duration"),
  emotion: z.string(),
  startFramePrompt: z.string().describe("still-image description of the first frame"),
  endFramePrompt: z.string().optional().describe("still-image description of the last frame; required when transitionOut=match"),
  /** variant v>1 renders alternates[v-2] — see `adstitch alternates` */
  alternates: z.array(AlternateSchema).optional(),
  // How this beat connects to the NEXT beat:
  //   cut   = intentional editorial cut (identity/scene locked, new angle)
  //   match = frame-matched: this beat's last frame IS the next beat's first frame
  //   end   = final beat
  transitionOut: TransitionSchema,
});
export type Beat = z.infer<typeof BeatSchema>;

export const StoryboardSchema = z.object({
  version: z.literal(1),
  campaign: z.object({
    name: z.string(),
    product: z.object({
      name: z.string(),
      description: z.string(),
      keyClaims: z.array(z.string()),
    }),
    audience: z.string(),
    platform: z.string(),
    cta: z.string(),
  }),
  style: z.object({
    personaVisual: z.string().describe("detailed physical description of the on-camera person"),
    personaVoice: z.string(),
    wardrobe: z.string(),
    setting: z.string(),
    lighting: z.string(),
    cameraLanguage: z.string(),
    mood: z.string(),
  }),
  beats: z.array(BeatSchema).min(2),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;

// ---------------------------------------------------------------------------
// Formula templates (templates/*.json) — beat skeletons the LLM fills in.
// ---------------------------------------------------------------------------

export const TemplateSchema = z.object({
  name: z.string(),
  description: z.string(),
  beats: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      goal: z.string(),
      durationSeconds: z.number().int(),
      transitionOut: TransitionSchema,
    }),
  ),
});
export type Template = z.infer<typeof TemplateSchema>;

// ---------------------------------------------------------------------------
// Manifest — on-disk pipeline state for resume/regen and the cost ledger.
// ---------------------------------------------------------------------------

export interface ArtifactRecord {
  /** sha256 over every input that determines this artifact (prompts, params, input-file hashes) */
  inputHash: string;
  path: string;
  model?: string;
  costUsd?: number;
  remoteUri?: string;
  /** auto-QC verdict for video segments */
  qc?: { pass: boolean; reasons: string[]; attempts: number };
  /** the seed actually rendered with (differs from the plan seed after a QC re-roll) */
  actualSeed?: number;
  /** cached speech-span analysis for video segments */
  timing?: { speechStart: number; speechEnd: number };
  createdAt: string;
}

export interface Manifest {
  version: 1;
  /** keyed by artifact id, e.g. "cast/persona", "keyframe/hook-start", "segment/hook", "segment/hook@2", "final/ad" */
  artifacts: Record<string, ArtifactRecord>;
  ledger: Array<{ at: string; kind: "image" | "video" | "text"; model: string; detail: string; costUsd: number }>;
}

// ---------------------------------------------------------------------------
// Render-time structures
// ---------------------------------------------------------------------------

export interface SegmentPlan {
  /** the EFFECTIVE beat — for alternate variants, alternate fields merged over the base */
  beat: Beat;
  index: number;
  variant: number; // 1-based; 1 is the default take
  firstFramePath: string;
  /** set only when this beat frame-matches into the next one */
  lastFramePath?: string;
  prompt: string;
  negativePrompt: string;
  outPath: string;
  /** set for seed re-roll variants; alternates vary by content instead */
  seed?: number;
}
