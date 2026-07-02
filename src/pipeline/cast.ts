import path from "node:path";
import type { Storyboard } from "../types.js";
import type { Provider } from "../providers/types.js";
import type { Config } from "../config.js";
import type { Project } from "./state.js";
import { loadManifest, saveManifest, isFresh, recordArtifact } from "./state.js";
import { castPersonaPrompt, castProductPrompt } from "./prompts.js";
import { findAssets, hashInputs } from "../util/fs.js";
import { log } from "../util/log.js";

export interface Cast {
  personaRefs: string[];
  productRefs: string[];
}

/** resolve reference paths WITHOUT generating anything (for cost estimates) */
export function castPaths(project: Project): Cast {
  const userPersona = findAssets(project.assetsDir, "persona");
  const userProduct = findAssets(project.assetsDir, "product");
  return {
    personaRefs: userPersona.length ? userPersona : [path.join(project.castDir, "persona.png")],
    productRefs: userProduct.length ? userProduct : [path.join(project.castDir, "product.png")],
  };
}

/**
 * Resolve the reference images that lock identity across every keyframe.
 * User-supplied files in assets/ always win (real product photos make real ads);
 * otherwise references are generated once from the storyboard descriptions.
 */
export async function ensureCast(project: Project, sb: Storyboard, provider: Provider, cfg: Config, force = false): Promise<Cast> {
  const manifest = loadManifest(project);
  const imageModel = cfg.defaults.useHqKeyframes ? cfg.models.imageHq : cfg.models.image;
  const isMock = provider.name === "mock";
  const imageCost = isMock ? 0 : (cfg.pricing.imagePerImage[imageModel] ?? 0.1);
  const recModel = isMock ? "mock" : imageModel;
  const aspect = cfg.defaults.aspectRatio;

  const userPersona = findAssets(project.assetsDir, "persona");
  const userProduct = findAssets(project.assetsDir, "product");

  let personaRefs = userPersona;
  if (personaRefs.length) {
    log.dim(`persona reference from assets/: ${personaRefs.map((p) => path.basename(p)).join(", ")}`);
  } else {
    const out = path.join(project.castDir, "persona.png");
    const prompt = castPersonaPrompt(sb, aspect);
    const inputHash = hashInputs({ prompt, model: imageModel, aspect });
    if (force || !isFresh(manifest, "cast/persona", inputHash)) {
      log.info(`generating persona reference (${imageModel})`);
      await provider.generateImage({ model: imageModel, prompt, aspectRatio: aspect, outPath: out });
      recordArtifact(manifest, "cast/persona", { inputHash, path: out, model: recModel, costUsd: imageCost },
        { kind: "image", model: recModel, detail: "cast/persona", costUsd: imageCost });
    } else {
      log.dim("persona reference unchanged — skipping");
    }
    personaRefs = [out];
  }

  let productRefs = userProduct;
  if (productRefs.length) {
    log.dim(`product reference from assets/: ${productRefs.map((p) => path.basename(p)).join(", ")}`);
  } else {
    log.warn("no assets/product*.png found — generating a fictional product shot. For a real ad, drop real product photos into assets/ (they become ground truth for every frame).");
    const out = path.join(project.castDir, "product.png");
    const prompt = castProductPrompt(sb, aspect);
    const inputHash = hashInputs({ prompt, model: imageModel, aspect });
    if (force || !isFresh(manifest, "cast/product", inputHash)) {
      await provider.generateImage({ model: imageModel, prompt, aspectRatio: aspect, outPath: out });
      recordArtifact(manifest, "cast/product", { inputHash, path: out, model: recModel, costUsd: imageCost },
        { kind: "image", model: recModel, detail: "cast/product", costUsd: imageCost });
    } else {
      log.dim("product reference unchanged — skipping");
    }
    productRefs = [out];
  }

  saveManifest(project, manifest);
  return { personaRefs, productRefs };
}

/** persona first, then products — capped at 3 total (Veo/Nano Banana reference limit) */
export function referenceSet(cast: Cast): string[] {
  return [...cast.personaRefs.slice(0, 1), ...cast.productRefs].slice(0, 3);
}
