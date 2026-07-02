export interface TextRequest {
  model: string;
  prompt: string;
  temperature?: number;
}

export interface ImageRequest {
  model: string;
  prompt: string;
  aspectRatio: string;
  /** local file paths used for identity/product consistency */
  referenceImagePaths?: string[];
  outPath: string;
}

export interface VideoRequest {
  model: string;
  prompt: string;
  negativePrompt?: string;
  /** local PNG/JPG path — the exact first frame */
  firstFramePath?: string;
  /** local PNG/JPG path — the exact last frame (Veo 3.1 first+last interpolation) */
  lastFramePath?: string;
  /** local image paths passed as Veo referenceImages (asset type, max 3) */
  referenceImagePaths?: string[];
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
  personGeneration: string;
  seed?: number;
  outPath: string;
  pollIntervalMs: number;
  timeoutMs: number;
}

export interface VideoResult {
  path: string;
  /** provider-side URI (Veo keeps files ~2 days; needed for scene extension) */
  remoteUri?: string;
}

export interface Provider {
  name: string;
  generateJson(req: TextRequest): Promise<string>;
  generateImage(req: ImageRequest): Promise<void>;
  generateVideo(req: VideoRequest): Promise<VideoResult>;
  /** list model ids visible to this credential (for `adstitch models`) */
  listModels?(): Promise<string[]>;
}
