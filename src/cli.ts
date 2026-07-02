#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { loadConfig, type Config } from "./config.js";
import type { Provider } from "./providers/types.js";
import { GeminiProvider } from "./providers/gemini.js";
import { MockProvider } from "./providers/mock.js";
import { projectPaths, loadProject, ensureProjectDirs, loadManifest, saveManifest, type Project } from "./pipeline/state.js";
import { planStoryboard, readStoryboard } from "./pipeline/storyboard.js";
import { ensureCast } from "./pipeline/cast.js";
import { generateKeyframes, beatFrames } from "./pipeline/keyframes.js";
import { generateSegments, segmentPath } from "./pipeline/videos.js";
import { stitchAd } from "./pipeline/stitch.js";
import { estimateRun, printEstimate, printLedger } from "./pipeline/cost.js";
import { hasFfmpeg } from "./util/ffmpeg.js";
import { readJson, writeJson } from "./util/fs.js";
import { log } from "./util/log.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// For the Google key vars, the repo .env deliberately OVERRIDES inherited shell
// env — stale keys exported from shell profiles are a common silent failure.
const ENV_OVERRIDES = new Set(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);

function loadDotEnv(): void {
  const envFile = path.join(repoRoot, ".env");
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, name, raw] = m;
    const value = raw.replace(/^["']|["']$/g, "");
    if (!value) continue;
    if (!(name in process.env) || ENV_OVERRIDES.has(name)) process.env[name] = value;
  }
}

interface Ctx {
  cfg: Config;
  provider: Provider;
  projectsRoot: string;
}

function makeCtx(opts: { provider?: string; projectsDir?: string }, projectName?: string): Ctx {
  const projectsRoot = opts.projectsDir ? path.resolve(opts.projectsDir) : path.join(repoRoot, "projects");
  const projectDir = projectName ? path.join(projectsRoot, projectName) : undefined;
  const cfg = loadConfig(repoRoot, projectDir, opts.provider ? { provider: opts.provider } : {});
  const provider: Provider = cfg.provider === "mock" ? new MockProvider() : new GeminiProvider();
  return { cfg, provider, projectsRoot };
}

function templateFile(name: string): string {
  const file = path.join(repoRoot, "templates", `${name}.json`);
  if (!fs.existsSync(file)) {
    const available = fs.readdirSync(path.join(repoRoot, "templates")).map((f) => f.replace(/\.json$/, "")).join(", ");
    throw new Error(`template "${name}" not found. Available: ${available}`);
  }
  return file;
}

function projectTemplate(project: Project, override?: string): string {
  if (override) return templateFile(override);
  const metaPath = path.join(project.dir, "project.json");
  const meta = fs.existsSync(metaPath) ? readJson<{ template?: string }>(metaPath) : {};
  return templateFile(meta.template ?? "ugc-5beat");
}

function parseKV(spec?: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!spec) return out;
  for (const part of spec.split(",")) {
    const [k, v] = part.split("=");
    const n = Number(v);
    if (!k || !Number.isInteger(n) || n < 1) throw new Error(`bad spec "${part}" — expected e.g. hook=3`);
    out[k.trim()] = n;
  }
  return out;
}

function parseBeats(sbBeatIds: string[], spec?: string): string[] | undefined {
  if (!spec) return undefined;
  const ids = spec.split(",").map((s) => s.trim());
  for (const id of ids) {
    if (!sbBeatIds.includes(id)) throw new Error(`unknown beat "${id}" — valid: ${sbBeatIds.join(", ")}`);
  }
  return ids;
}

async function confirmSpend(ctx: Ctx, estTotal: number, yes: boolean): Promise<void> {
  if (ctx.provider.name === "mock") {
    log.dim("mock provider — the estimate above is what a real run would cost; $0.00 will be spent");
    return;
  }
  if (yes) return;
  if (!process.stdin.isTTY) {
    throw new Error(`this run spends real money (~$${estTotal.toFixed(2)}). Re-run with --yes to confirm.`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Proceed and spend ~$${estTotal.toFixed(2)}? (y/N) `)).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") throw new Error("aborted");
}

function videoModel(ctx: Ctx, opts: { fast?: boolean; draft?: boolean; model?: string }): string {
  if (opts.model) return opts.model;
  if (opts.draft) return ctx.cfg.models.videoLite;
  return opts.fast ? ctx.cfg.models.videoFast : ctx.cfg.models.video;
}

const BRIEF_TEMPLATE = (product: string) => `# Product
Name: ${product}
What it is: <one paragraph — what it does, what makes it different>
Key claims: <comma-separated, only claims you can substantiate>

# Audience
<who is this for, what do they currently do instead, what do they feel>

# Platform
tiktok

# CTA
<what should the viewer do — e.g. "Tap the link to get 20% off">

# Persona (optional — describe the on-camera creator; leave blank to let the planner invent one)

# Notes (optional — tone, references, competitor ads you like, things to avoid)

<!-- Want exact lines? Create script.md next to this file:
## hook
"Your verbatim opening line."
action: optional staging note
Beats you omit are written by the planner. -->
`;

const program = new Command();
program
  .name("adstitch")
  .description("Stitched multi-beat ad creatives from a product brief — Veo/Gemini powered, continuity-safe")
  .option("--provider <name>", "gemini | mock")
  .option("--projects-dir <dir>", "override projects root");

program
  .command("init")
  .argument("<name>", "project name (kebab-case)")
  .option("--template <t>", "formula template", "ugc-5beat")
  .option("--product <p>", "product name to prefill the brief", "My Product")
  .description("scaffold a new campaign project")
  .action((name: string, opts) => {
    templateFile(opts.template); // validate early
    const projectsRoot = program.opts().projectsDir ? path.resolve(program.opts().projectsDir) : path.join(repoRoot, "projects");
    const project = projectPaths(projectsRoot, name);
    if (fs.existsSync(project.briefPath)) throw new Error(`project "${name}" already exists at ${project.dir}`);
    ensureProjectDirs(project);
    fs.writeFileSync(project.briefPath, BRIEF_TEMPLATE(opts.product));
    writeJson(path.join(project.dir, "project.json"), { template: opts.template });
    log.ok(`project created: ${project.dir}`);
    log.info(`1. edit ${project.briefPath}`);
    log.info(`2. drop real product photos into ${project.assetsDir}/ as product1.png, product2.png … (strongly recommended)`);
    log.info(`   optional: a persona image as persona.png to lock the on-camera person`);
    log.info(`3. adstitch run ${name}   (or step-by-step: plan → cast → keyframes → videos → stitch)`);
  });

program
  .command("plan")
  .argument("<name>")
  .option("--template <t>", "override the project's formula template")
  .option("--force", "re-plan even if the brief is unchanged")
  .description("brief.md → storyboard.json (LLM)")
  .action(async (name: string, opts) => {
    const ctx = makeCtx(program.opts(), name);
    const project = loadProject(ctx.projectsRoot, name);
    const sb = await planStoryboard(project, ctx.provider, ctx.cfg, projectTemplate(project, opts.template), opts.force);
    for (const b of sb.beats) log.dim(`${b.id.padEnd(10)} ${b.durationSeconds}s  [${b.transitionOut.padEnd(5)}] "${b.dialogue}"`);
    log.info(`review/edit ${project.storyboardPath} before rendering — it is the single source of truth`);
  });

program
  .command("cast")
  .argument("<name>")
  .option("--force")
  .description("resolve/generate the identity reference images (persona + product)")
  .action(async (name: string, opts) => {
    const ctx = makeCtx(program.opts(), name);
    const project = loadProject(ctx.projectsRoot, name);
    const sb = readStoryboard(project);
    const cast = await ensureCast(project, sb, ctx.provider, ctx.cfg, opts.force);
    log.ok(`cast ready — persona: ${cast.personaRefs.join(", ")} | product: ${cast.productRefs.join(", ")}`);
  });

program
  .command("keyframes")
  .argument("<name>")
  .option("--beats <ids>", "only these beat ids — cheap creative preview (e.g. --beats reveal)")
  .option("--force")
  .description("generate boundary/start keyframes with identity references")
  .action(async (name: string, opts) => {
    const ctx = makeCtx(program.opts(), name);
    const project = loadProject(ctx.projectsRoot, name);
    const sb = readStoryboard(project);
    const beats = parseBeats(sb.beats.map((b) => b.id), opts.beats);
    const cast = await ensureCast(project, sb, ctx.provider, ctx.cfg);
    await generateKeyframes(project, sb, cast, ctx.provider, ctx.cfg, opts.force, beats);
  });

program
  .command("videos")
  .argument("<name>")
  .option("--beats <ids>", "comma-separated beat ids to render (default: all)")
  .option("--variants <spec>", "extra takes per beat, e.g. hook=3,cta=2")
  .option("--fast", "use the fast (cheaper) video model")
  .option("--draft", "use the lite draft model (~8x cheaper than quality)")
  .option("--model <id>", "explicit video model id")
  .option("--force", "re-render even if inputs are unchanged")
  .option("--yes", "skip the spend confirmation")
  .description("render each beat with Veo (first/last-frame conditioned)")
  .action(async (name: string, opts) => {
    const ctx = makeCtx(program.opts(), name);
    const project = loadProject(ctx.projectsRoot, name);
    const sb = readStoryboard(project);
    const model = videoModel(ctx, opts);
    const variants = parseKV(opts.variants);
    const beats = parseBeats(sb.beats.map((b) => b.id), opts.beats);
    const est = estimateRun(project, sb, ctx.cfg, model, variants, beats);
    printEstimate(est);
    await confirmSpend(ctx, est.totalUsd, !!opts.yes);
    const cast = await ensureCast(project, sb, ctx.provider, ctx.cfg);
    await generateKeyframes(project, sb, cast, ctx.provider, ctx.cfg);
    const res = await generateSegments(project, sb, cast, ctx.provider, ctx.cfg, { beats, variants, model, force: opts.force });
    log.ok(`segments done (${res.generated} rendered, ${res.cached} cached) — next: adstitch stitch ${name}`);
  });

program
  .command("stitch")
  .argument("<name>")
  .option("--transition <t>", "cut | smooth", undefined)
  .option("--pick <spec>", "variant picks, e.g. hook=2")
  .option("--music <file>", "background music bed mixed under the voice")
  .option("--music-volume <v>", "music level 0-1", parseFloat)
  .option("--out <name>", "output basename")
  .description("normalize + join segments (+ optional music bed) into the final ad")
  .action(async (name: string, opts) => {
    const ctx = makeCtx(program.opts(), name);
    const project = loadProject(ctx.projectsRoot, name);
    const sb = readStoryboard(project);
    const out = await stitchAd(project, sb, ctx.cfg, {
      transition: (opts.transition ?? ctx.cfg.defaults.transition) as "cut" | "smooth",
      picks: parseKV(opts.pick),
      musicPath: opts.music,
      musicVolume: opts.musicVolume,
      outName: opts.out,
    });
    log.ok(`final ad: ${out}`);
  });

program
  .command("run")
  .argument("<name>")
  .option("--variants <spec>", "extra takes per beat, e.g. hook=3")
  .option("--fast", "use the fast (cheaper) video model")
  .option("--draft", "use the lite draft model (~8x cheaper than quality)")
  .option("--model <id>", "explicit video model id")
  .option("--transition <t>", "cut | smooth")
  .option("--music <file>")
  .option("--yes", "skip the spend confirmation")
  .description("full pipeline: plan → cast → keyframes → videos → stitch")
  .action(async (name: string, opts) => {
    const ctx = makeCtx(program.opts(), name);
    const project = loadProject(ctx.projectsRoot, name);

    log.step("1/5 storyboard");
    const sb = await planStoryboard(project, ctx.provider, ctx.cfg, projectTemplate(project));

    const model = videoModel(ctx, opts);
    const variants = parseKV(opts.variants);
    const est = estimateRun(project, sb, ctx.cfg, model, variants);
    printEstimate(est);
    await confirmSpend(ctx, est.totalUsd, !!opts.yes);

    log.step("2/5 cast references");
    const cast = await ensureCast(project, sb, ctx.provider, ctx.cfg);

    log.step("3/5 keyframes");
    await generateKeyframes(project, sb, cast, ctx.provider, ctx.cfg);

    log.step("4/5 video segments");
    const res = await generateSegments(project, sb, cast, ctx.provider, ctx.cfg, { variants, model });
    log.ok(`${res.generated} rendered, ${res.cached} cached`);

    log.step("5/5 stitch");
    const out = await stitchAd(project, sb, ctx.cfg, {
      transition: (opts.transition ?? ctx.cfg.defaults.transition) as "cut" | "smooth",
      musicPath: opts.music,
    });
    log.ok(`final ad: ${out}`);
  });

program
  .command("regen")
  .argument("<name>")
  .argument("<beatId>")
  .option("--keyframes", "also regenerate this beat's keyframes (neighbors sharing a boundary re-render too)")
  .option("--fast")
  .option("--draft")
  .option("--model <id>")
  .option("--yes")
  .description("invalidate one beat and re-render it")
  .action(async (name: string, beatId: string, opts) => {
    const ctx = makeCtx(program.opts(), name);
    const project = loadProject(ctx.projectsRoot, name);
    const sb = readStoryboard(project);
    const idx = sb.beats.findIndex((b) => b.id === beatId);
    if (idx < 0) throw new Error(`unknown beat "${beatId}" — valid: ${sb.beats.map((b) => b.id).join(", ")}`);

    const manifest = loadManifest(project);
    const deletedPaths: string[] = [];
    const dropArtifact = (id: string) => {
      const rec = manifest.artifacts[id];
      if (!rec) return;
      if (fs.existsSync(rec.path)) fs.rmSync(rec.path);
      deletedPaths.push(rec.path);
      delete manifest.artifacts[id];
    };

    for (const key of Object.keys(manifest.artifacts)) {
      if (key === `segment/${beatId}` || key.startsWith(`segment/${beatId}@`)) dropArtifact(key);
    }
    if (opts.keyframes) {
      dropArtifact(`keyframe/${beatId}-start`);
      dropArtifact(`keyframe/${beatId}-boundary`);
    }
    saveManifest(project, manifest);

    // any beat whose first/last frame file was deleted must re-render
    const frames = beatFrames(project, sb);
    const affected = new Set<string>([beatId]);
    sb.beats.forEach((b, i) => {
      if (deletedPaths.includes(frames[i].firstPath) || (frames[i].lastPath && deletedPaths.includes(frames[i].lastPath!))) {
        affected.add(b.id);
      }
    });

    const model = videoModel(ctx, opts);
    const beats = [...affected];
    const est = estimateRun(project, sb, ctx.cfg, model, {}, beats);
    printEstimate(est);
    await confirmSpend(ctx, est.totalUsd, !!opts.yes);
    const cast = await ensureCast(project, sb, ctx.provider, ctx.cfg);
    await generateKeyframes(project, sb, cast, ctx.provider, ctx.cfg);
    const res = await generateSegments(project, sb, cast, ctx.provider, ctx.cfg, { beats, model });
    log.ok(`re-rendered ${res.generated} segment(s) [${beats.join(", ")}] — next: adstitch stitch ${name}`);
  });

program
  .command("status")
  .argument("<name>")
  .description("show pipeline progress for a project")
  .action((name: string) => {
    const ctx = makeCtx(program.opts(), name);
    const project = loadProject(ctx.projectsRoot, name);
    log.info(`project: ${project.dir}`);
    const hasSb = fs.existsSync(project.storyboardPath);
    log[hasSb ? "ok" : "warn"](`storyboard.json ${hasSb ? "present" : "missing — run: adstitch plan " + name}`);
    if (!hasSb) return;
    const sb = readStoryboard(project);
    const frames = beatFrames(project, sb);
    sb.beats.forEach((b, i) => {
      const kf = fs.existsSync(frames[i].firstPath) && (!frames[i].lastPath || fs.existsSync(frames[i].lastPath!));
      const seg = fs.existsSync(segmentPath(project, sb, b.id));
      const marks = `${kf ? "kf✓" : "kf·"} ${seg ? "vid✓" : "vid·"}`;
      log.dim(`${b.id.padEnd(10)} ${String(b.durationSeconds).padStart(2)}s [${b.transitionOut.padEnd(5)}] ${marks}  "${b.dialogue.slice(0, 60)}"`);
    });
    if (fs.existsSync(project.finalDir)) {
      for (const f of fs.readdirSync(project.finalDir).filter((f) => f.endsWith(".mp4"))) log.ok(`final/${f}`);
    }
    printLedger(project);
  });

program
  .command("cost")
  .argument("<name>")
  .option("--fast")
  .option("--draft")
  .option("--model <id>")
  .option("--variants <spec>")
  .description("estimate spend for a full render + show recorded spend")
  .action((name: string, opts) => {
    const ctx = makeCtx(program.opts(), name);
    const project = loadProject(ctx.projectsRoot, name);
    const sb = readStoryboard(project);
    printEstimate(estimateRun(project, sb, ctx.cfg, videoModel(ctx, opts), parseKV(opts.variants)));
    printLedger(project);
  });

program
  .command("doctor")
  .description("verify environment: ffmpeg, API key, model visibility")
  .action(async () => {
    log[(await hasFfmpeg()) ? "ok" : "error"]("ffmpeg + ffprobe");
    const source = process.env.GEMINI_API_KEY ? "GEMINI_API_KEY" : "GOOGLE_API_KEY";
    const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    log[key ? "ok" : "error"](key
      ? `API key set (${source}, …${key.slice(-4)}) — note: the repo .env overrides shell-exported Google keys`
      : "GEMINI_API_KEY missing — copy .env.example to .env and add a key from https://aistudio.google.com/apikey");
    if (!key) return;
    try {
      const ctx = makeCtx({ provider: "gemini" });
      const models = (await ctx.provider.listModels?.()) ?? [];
      log.ok(`API reachable (${models.length} models visible)`);
      for (const want of [ctx.cfg.models.text, ctx.cfg.models.image, ctx.cfg.models.imageHq, ctx.cfg.models.video, ctx.cfg.models.videoFast, ctx.cfg.models.videoLite]) {
        const found = models.some((m) => m === want || m.startsWith(want));
        log[found ? "ok" : "warn"](`model ${want}${found ? "" : " — not in list (IDs churn; check `adstitch models` and override in adstitch.config.json)"}`);
      }
    } catch (err) {
      log.error(`API check failed: ${(err as Error).message}`);
    }
  });

program
  .command("models")
  .description("list model ids visible to your API key (veo/image/gemini)")
  .action(async () => {
    const ctx = makeCtx(program.opts());
    const models = (await ctx.provider.listModels?.()) ?? [];
    for (const m of models.filter((m) => /veo|image|imagen|gemini/i.test(m))) console.log(m);
  });

loadDotEnv();
program.parseAsync().catch((err: Error) => {
  log.error(err.message);
  process.exit(1);
});
