import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";
import path from "node:path";
import type { ImageRequest, Provider, TextRequest, VideoRequest, VideoResult } from "./types.js";
import { log, retry, sleep } from "../util/log.js";
import { ensureDir, mimeFor } from "../util/fs.js";

function localImage(file: string): { imageBytes: string; mimeType: string } {
  return { imageBytes: fs.readFileSync(file).toString("base64"), mimeType: mimeFor(file) };
}

export class GeminiProvider implements Provider {
  name = "gemini";
  private ai: GoogleGenAI;
  private apiKey: string;

  constructor() {
    const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!key) {
      throw new Error("GEMINI_API_KEY is not set. Copy .env.example to .env (or export it) with a key from https://aistudio.google.com/apikey");
    }
    // the SDK prefers GOOGLE_API_KEY when both are set — make GEMINI_API_KEY authoritative
    if (process.env.GEMINI_API_KEY && process.env.GOOGLE_API_KEY && process.env.GOOGLE_API_KEY !== process.env.GEMINI_API_KEY) {
      delete process.env.GOOGLE_API_KEY;
    }
    this.apiKey = key;
    this.ai = new GoogleGenAI({ apiKey: key });
  }

  async generateJson(req: TextRequest): Promise<string> {
    const parts: any[] = [];
    for (const img of req.images ?? []) {
      parts.push({ inlineData: { data: fs.readFileSync(img).toString("base64"), mimeType: mimeFor(img) } });
    }
    for (const vid of req.videos ?? []) {
      parts.push({ inlineData: { data: fs.readFileSync(vid).toString("base64"), mimeType: "video/mp4" } });
    }
    parts.push({ text: req.prompt });
    const res = await retry(
      () =>
        this.ai.models.generateContent({
          model: req.model,
          contents: [{ role: "user", parts }],
          config: { responseMimeType: "application/json", temperature: req.temperature ?? 0.7 },
        }),
      { label: `text(${req.model})` },
    );
    const text = res.text;
    if (!text) throw new Error(`${req.model} returned no text`);
    return text;
  }

  async generateImage(req: ImageRequest): Promise<void> {
    const parts: any[] = [];
    for (const ref of req.referenceImagePaths ?? []) {
      parts.push({ inlineData: { data: fs.readFileSync(ref).toString("base64"), mimeType: mimeFor(ref) } });
    }
    parts.push({ text: req.prompt });

    const call = (withAspect: boolean) =>
      this.ai.models.generateContent({
        model: req.model,
        contents: [{ role: "user", parts }],
        config: withAspect
          ? ({ responseModalities: ["IMAGE"], imageConfig: { aspectRatio: req.aspectRatio } } as any)
          : ({ responseModalities: ["IMAGE"] } as any),
      });

    let res;
    try {
      res = await retry(() => call(true), { label: `image(${req.model})`, tries: 2 });
    } catch (err) {
      log.warn(`image call with aspectRatio config failed (${(err as Error).message}); retrying without imageConfig`);
      res = await retry(() => call(false), { label: `image(${req.model})` });
    }

    const imgPart = res.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data);
    if (!imgPart?.inlineData?.data) {
      const reason = res.candidates?.[0]?.finishReason ?? "no candidates";
      throw new Error(`${req.model} returned no image (${reason})`);
    }
    ensureDir(path.dirname(req.outPath));
    fs.writeFileSync(req.outPath, Buffer.from(imgPart.inlineData.data, "base64"));
  }

  async generateVideo(req: VideoRequest): Promise<VideoResult> {
    const config: any = {
      aspectRatio: req.aspectRatio,
      resolution: req.resolution,
      durationSeconds: req.durationSeconds,
      personGeneration: req.personGeneration,
      numberOfVideos: 1,
    };
    if (req.negativePrompt) config.negativePrompt = req.negativePrompt;
    // req.seed is deliberately NOT sent: the Gemini API rejects the seed param
    // ("seed parameter is not supported"). Generation is nondeterministic, so
    // re-rolls vary anyway; the seed only differentiates variant cache hashes.
    if (req.lastFramePath) config.lastFrame = localImage(req.lastFramePath);
    if (req.referenceImagePaths?.length) {
      config.referenceImages = req.referenceImagePaths.slice(0, 3).map((p) => ({
        referenceType: "asset",
        image: localImage(p),
      }));
    }

    const request: any = { model: req.model, prompt: req.prompt, config };
    if (req.firstFramePath) request.image = localImage(req.firstFramePath);

    // Optional config features vary by model version; on invalid-argument
    // rejections, degrade one feature at a time. negativePrompt content is
    // already folded into the prompt text, so dropping the param is safe.
    const degradable = ["referenceImages", "negativePrompt"] as const;
    let operation: any;
    for (;;) {
      try {
        operation = await retry(() => this.ai.models.generateVideos(request), { label: `veo(${req.model})`, tries: 2 });
        break;
      } catch (err) {
        const next = degradable.find((k) => config[k] !== undefined);
        if (!next) throw err;
        log.warn(`Veo rejected the call (${(err as Error).message}); retrying without ${next}`);
        delete config[next];
      }
    }

    const started = Date.now();
    while (!operation.done) {
      if (Date.now() - started > req.timeoutMs) {
        throw new Error(`Veo operation timed out after ${Math.round(req.timeoutMs / 60000)}min (${operation.name ?? "unnamed"})`);
      }
      await sleep(req.pollIntervalMs);
      operation = await retry(() => this.ai.operations.getVideosOperation({ operation }), { label: "veo poll", retryAll: true });
    }

    if (operation.error) {
      throw new Error(`Veo operation failed: ${operation.error.message ?? JSON.stringify(operation.error)}`);
    }
    const generated = operation.response?.generatedVideos?.[0];
    if (!generated?.video) {
      const filtered = operation.response?.raiMediaFilteredReasons?.join("; ");
      throw new Error(filtered ? `Veo filtered the output: ${filtered}` : "Veo returned no video");
    }

    ensureDir(path.dirname(req.outPath));
    try {
      await this.ai.files.download({ file: generated.video, downloadPath: req.outPath });
    } catch (err) {
      // fallback: direct fetch of the file URI
      const uri: string | undefined = generated.video.uri;
      if (!uri) throw err;
      const resp = await fetch(uri, { headers: { "x-goog-api-key": this.apiKey } });
      if (!resp.ok) throw new Error(`video download failed: HTTP ${resp.status}`);
      fs.writeFileSync(req.outPath, Buffer.from(await resp.arrayBuffer()));
    }
    if (!fs.existsSync(req.outPath) || fs.statSync(req.outPath).size < 10_000) {
      throw new Error(`downloaded video looks empty: ${req.outPath}`);
    }
    return { path: req.outPath, remoteUri: generated.video.uri };
  }

  async listModels(): Promise<string[]> {
    const names: string[] = [];
    const pager: any = await (this.ai.models as any).list({ config: { pageSize: 100 } });
    for await (const m of pager) names.push((m.name ?? "").replace(/^models\//, ""));
    return names;
  }
}
