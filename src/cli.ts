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
import { planStoryboard, readStoryboard, planAlternates } from "./pipeline/storyboard.js";
import { ensureCast } from "./pipeline/cast.js";
import { generateKeyframes, beatFrames } from "./pipeline/keyframes.js";
import { generateSegments, segmentPath } from "./pipeline/videos.js";
import { savePersona, listPersonas, loadPersona } from "./pipeline/personas.js";
import { generateBroll } from "./pipeline/broll.js";
import { verifyFinal } from "./pipeline/verify.js";
import { stitchAd } from "./pipeline/stitch.js";
import { estimateRun, printEstimate, printLedger } from "./pipeline/cost.js";
import { hasFfmpeg } from "./util/ffmpeg.js";
import { readJson, writeJson } from "./util/fs.js";
import { log } from "./util/log.js";

// packageRoot = where adstitch is installed (shipped templates live here);
// workRoot = the user's current directory (their projects/personas/config/.env).
// In a git clone they're the same place; for npm-installed usage they differ —
// user data must never land inside node_modules.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = process.cwd();

// For the Google key vars, the workspace .env deliberately OVERRIDES inherited
// shell env — stale keys exported from shell profiles are a common silent failure.
const ENV_OVERRIDES = new Set(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);

function loadDotEnv(): void {
  for (const envFile of [path.join(workRoot, ".env"), path.join(packageRoot, ".env")]) {
    if (!fs.existsSync(envFile)) continue;
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const [, name, raw] = m;
      const value = raw.replace(/^["']|["']$/g, "");
      if (!value) continue;
      if (!(name in process.env) || ENV_OVERRIDES.has(name)) process.env[name] = value;
    }
    return; // first .env found wins
  }
}

interface Ctx {
  cfg: Config;
  provider: Provider;
  projectsRoot: string;
}

function makeCtx(opts: { provider?: string; projectsDir?: string }, projectName?: string): Ctx {
  const projectsRoot = opts.projectsDir ? path.resolve(opts.projectsDir) : path.join(workRoot, "projects");
  const projectDir = projectName ? path.join(projectsRoot, projectName) : undefined;
  const cfg = loadConfig(workRoot, projectDir, opts.provider ? { provider: opts.provider } : {});
  const provider: Provider = cfg.provider === "mock" ? new MockProvider() : new GeminiProvider();
  return { cfg, provider, projectsRoot };
}

function templateFile(name: string): string {
  // user templates in the workspace win over the shipped set
  for (const root of [workRoot, packageRoot]) {
    const file = path.join(root, "templates", `${name}.json`);
    if (fs.existsSync(file)) return file;
  }
  const shipped = fs.readdirSync(path.join(packageRoot, "templates")).map((f) => f.replace(/\.json$/, ""));
  const custom = fs.existsSync(path.join(workRoot, "templates"))
    ? fs.readdirSync(path.join(workRoot, "templates")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""))
    : [];
  throw new Error(`template "${name}" not found. Available: ${[...new Set([...custom, ...shipped])].join(", ")}`);
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
  .option("--persona <slug>", "attach a saved persona (portrait + locked description)")
  .description("scaffold a new campaign project")
  .action((name: string, opts) => {
    templateFile(opts.template); // validate early
    const projectsRoot = program.opts().projectsDir ? path.resolve(program.opts().projectsDir) : path.join(workRoot, "projects");
    const project = projectPaths(projectsRoot, name);
    if (fs.existsSync(project.briefPath)) throw new Error(`project "${name}" already exists at ${project.dir}`);
    const persona = opts.persona ? loadPersona(workRoot, opts.persona) : undefined;
    ensureProjectDirs(project);
    fs.writeFileSync(project.briefPath, BRIEF_TEMPLATE(opts.product));
    if (persona) {
      fs.copyFileSync(persona.portraitPath, path.join(project.assetsDir, "persona.png"));
      writeJson(path.join(project.dir, "project.json"), { template: opts.template, persona: persona.record });
      log.ok(`persona "${opts.persona}" attached — portrait → assets/persona.png, description locked into planning`);
    } else {
      writeJson(path.join(project.dir, "project.json"), { template: opts.template });
    }
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
  .option("--candidates <n>", "N alternates per frame; pick by overwriting the primary file", (v: string) => parseInt(v, 10), 1)
  .option("--force")
  .description("generate boundary/start keyframes with identity references")
  .action(async (name: string, opts) => {
    const ctx = makeCtx(program.opts(), name);
    const project = loadProject(ctx.projectsRoot, name);
    const sb = readStoryboard(project);
    const beats = parseBeats(sb.beats.map((b) => b.id), opts.beats);
    const cast = await ensureCast(project, sb, ctx.provider, ctx.cfg);
    await generateKeyframes(project, sb, cast, ctx.provider, ctx.cfg, opts.force, beats, opts.candidates);
  });

program
  .command("videos")
  .argument("<name>")
  .option("--beats <ids>", "comma-separated beat ids to render (default: all)")
  .option("--variants <spec>", "takes per beat, e.g. hook=3 — renders scripted alternates when the beat has them, else seed re-rolls")
  .option("--fast", "use the fast (cheaper) video model")
  .option("--draft", "use the lite draft model (~8x cheaper than quality)")
  .option("--model <id>", "explicit video model id")
  .option("--force", "re-render even if inputs are unchanged")
  .option("--no-qc", "skip auto-QC (SSIM + judge + single re-roll on failure)")
  .option("--yes", "skip the spend confirmation")
  .description("render each beat with Veo (first/last-frame conditioned)")
  .action(async (name: string, opts) => {
    const ctx = makeCtx(program.opts(), name);
    const project = loadProject(ctx.projectsRoot, name);
    const sb = readStoryboard(project);
    const model = videoModel(ctx, opts);
    const variants = parseKV(opts.variants);
    const beats = parseBeats(sb.beats.map((b) => b.id), opts.beats);
    const qc = opts.qc === false ? false : undefined; // undefined → config decides
    const est = estimateRun(project, sb, ctx.cfg, model, variants, beats);
    printEstimate(est, { qcReroll: qc !== false && ctx.cfg.qc.enabled });
    await confirmSpend(ctx, est.totalUsd, !!opts.yes);
    const cast = await ensureCast(project, sb, ctx.provider, ctx.cfg);
    await generateKeyframes(project, sb, cast, ctx.provider, ctx.cfg);
    const res = await generateSegments(project, sb, cast, ctx.provider, ctx.cfg, { beats, variants, model, force: opts.force, qc });
    log.ok(`segments done (${res.generated} rendered, ${res.cached} cached) — next: adstitch stitch ${name}`);
  });

program
  .command("alternates")
  .argument("<name>")
  .argument("<spec>", "takes per beat INCLUDING the base, e.g. hook=3 (= base + 2 alternates)")
  .option("--force", "regenerate even if the base beat is unchanged")
  .description("write scripted alternate takes (different line + visually distinct opening) into the storyboard")
  .action(async (name: string, spec: string, opts) => {
    const ctx = makeCtx(program.opts(), name);
    const project = loadProject(ctx.projectsRoot, name);
    const parsed = parseKV(spec);
    const sb = await planAlternates(project, ctx.provider, ctx.cfg, projectTemplate(project), parsed, opts.force);
    for (const b of sb.beats) {
      b.alternates?.forEach((a, k) => log.dim(`${b.id}@${k + 2}  "${a.dialogue}"`));
    }
    const variantSpec = Object.entries(parsed).map(([k, v]) => `${k}=${v}`).join(",");
    log.info(`render them: adstitch videos ${name} --variants ${variantSpec}   then: adstitch stitch ${name} --matrix ${Object.keys(parsed).join(",")}`);
  });

program
  .command("stitch")
  .argument("<name>")
  .option("--transition <t>", "cut | smooth", undefined)
  .option("--pick <spec>", "variant picks, e.g. hook=2")
  .option("--matrix <beats>", "emit one final per variant combo of these beats, e.g. --matrix hook")
  .option("--music <file>", "background music bed mixed under the voice")
  .option("--music-volume <v>", "music level 0-1", parseFloat)
  .option("--style <s>", "plain | flow (one-take, speech-aware tail ramping) | tight (cut to the spoken lines)", "plain")
  .option("--cutaways", "tight style: hide joins under product B-roll inserts (run `adstitch broll` first)")
  .option("--trim-tail <s>", "plain style: manual seconds cut from clip ends at match joins", parseFloat)
  .option("--trim-head <s>", "plain style: manual seconds cut from clip starts at match joins", parseFloat)
  .option("--out <name>", "output basename")
  .description("normalize + join segments (+ optional music bed) into the final ad")
  .action(async (name: string, opts) => {
    const ctx = makeCtx(program.opts(), name);
    const project = loadProject(ctx.projectsRoot, name);
    const sb = readStoryboard(project);
    const transition = (opts.transition ?? ctx.cfg.defaults.transition) as "cut" | "smooth";
    const style = opts.style as "plain" | "flow" | "tight";
    if (!["plain", "flow", "tight"].includes(style)) throw new Error(`unknown style "${style}" — use plain | flow | tight`);
    const trimTail = opts.trimTail;
    const trimHead = opts.trimHead;

    if (opts.matrix) {
      const ids = parseBeats(sb.beats.map((b) => b.id), opts.matrix)!;
      const axes = ids.map((id) => {
        let takes = 1;
        while (fs.existsSync(segmentPath(project, sb, id, takes + 1))) takes++;
        if (takes === 1) log.warn(`--matrix ${id}: only 1 take on disk — render more first: adstitch videos ${name} --variants ${id}=N`);
        return Array.from({ length: takes }, (_, k) => [id, k + 1] as [string, number]);
      });
      const combos = axes.reduce<Array<Array<[string, number]>>>((acc, axis) => acc.flatMap((c) => axis.map((a) => [...c, a])), [[]]);
      const basePicks = parseKV(opts.pick);
      // sequential: stitchAd shares a .norm scratch dir per project
      for (const combo of combos) {
        const out = await stitchAd(project, sb, ctx.cfg, {
          transition,
          trimTail, trimHead,
          style, cutaways: opts.cutaways,
          picks: { ...basePicks, ...Object.fromEntries(combo) },
          musicPath: opts.music,
          musicVolume: opts.musicVolume,
          outName: `${opts.out ?? project.name}-${combo.map(([id, v]) => `${id}${v}`).join("-")}`,
        }, ctx.provider);
        log.ok(`matrix final: ${out}`);
      }
      return;
    }

    const out = await stitchAd(project, sb, ctx.cfg, {
      transition,
      trimTail, trimHead,
      style, cutaways: opts.cutaways,
      picks: parseKV(opts.pick),
      musicPath: opts.music,
      musicVolume: opts.musicVolume,
      outName: opts.out,
    }, ctx.provider);
    log.ok(`final ad: ${out}`);
  });

program
  .command("run")
  .argument("<name>")
  .option("--variants <spec>", "takes per beat, e.g. hook=3 (scripted alternates when present)")
  .option("--fast", "use the fast (cheaper) video model")
  .option("--draft", "use the lite draft model (~8x cheaper than quality)")
  .option("--model <id>", "explicit video model id")
  .option("--transition <t>", "cut | smooth")
  .option("--music <file>")
  .option("--no-qc", "skip auto-QC")
  .option("--yes", "skip the spend confirmation")
  .description("full pipeline: plan → cast → keyframes → videos → stitch")
  .action(async (name: string, opts) => {
    const ctx = makeCtx(program.opts(), name);
    const project = loadProject(ctx.projectsRoot, name);

    log.step("1/5 storyboard");
    const sb = await planStoryboard(project, ctx.provider, ctx.cfg, projectTemplate(project));

    const model = videoModel(ctx, opts);
    const variants = parseKV(opts.variants);
    const qc = opts.qc === false ? false : undefined;
    const est = estimateRun(project, sb, ctx.cfg, model, variants);
    printEstimate(est, { qcReroll: qc !== false && ctx.cfg.qc.enabled });
    await confirmSpend(ctx, est.totalUsd, !!opts.yes);

    log.step("2/5 cast references");
    const cast = await ensureCast(project, sb, ctx.provider, ctx.cfg);

    log.step("3/5 keyframes");
    await generateKeyframes(project, sb, cast, ctx.provider, ctx.cfg);

    log.step("4/5 video segments");
    const res = await generateSegments(project, sb, cast, ctx.provider, ctx.cfg, { variants, model, qc });
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
  .option("--no-qc")
  .option("--yes")
  .description("invalidate one beat and re-render it (existing variant takes re-render too)")
  .action(async (name: string, beatId: string, opts) => {
    const ctx = makeCtx(program.opts(), name);
    const project = loadProject(ctx.projectsRoot, name);
    const sb = readStoryboard(project);
    const idx = sb.beats.findIndex((b) => b.id === beatId);
    if (idx < 0) throw new Error(`unknown beat "${beatId}" — valid: ${sb.beats.map((b) => b.id).join(", ")}`);

    const manifest = loadManifest(project);

    // how many takes each beat had BEFORE we drop anything — deleted variant
    // takes must come back in the re-render
    const preCounts: Record<string, number> = {};
    for (const key of Object.keys(manifest.artifacts)) {
      const m = key.match(/^segment\/([a-z0-9-]+)(?:@(\d+))?$/);
      if (m) preCounts[m[1]] = Math.max(preCounts[m[1]] ?? 1, m[2] ? parseInt(m[2], 10) : 1);
    }

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
      for (const key of Object.keys(manifest.artifacts)) {
        if (key.startsWith(`keyframe/${beatId}-start@`)) dropArtifact(key);
      }
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
    const variants = Object.fromEntries(beats.filter((id) => (preCounts[id] ?? 1) > 1).map((id) => [id, preCounts[id]]));
    const qc = opts.qc === false ? false : undefined;
    const est = estimateRun(project, sb, ctx.cfg, model, variants, beats);
    printEstimate(est, { qcReroll: qc !== false && ctx.cfg.qc.enabled });
    await confirmSpend(ctx, est.totalUsd, !!opts.yes);
    const cast = await ensureCast(project, sb, ctx.provider, ctx.cfg);
    await generateKeyframes(project, sb, cast, ctx.provider, ctx.cfg);
    const res = await generateSegments(project, sb, cast, ctx.provider, ctx.cfg, { beats, variants, model, qc });
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
    const manifest = loadManifest(project);
    sb.beats.forEach((b, i) => {
      const kf = fs.existsSync(frames[i].firstPath) && (!frames[i].lastPath || fs.existsSync(frames[i].lastPath!));
      let takes = 0;
      while (fs.existsSync(segmentPath(project, sb, b.id, takes + 1))) takes++;
      const qcRec = manifest.artifacts[`segment/${b.id}`]?.qc;
      const qcMark = qcRec ? (qcRec.pass ? " qc✓" : " qc✗") : "";
      const vidMark = takes ? `vid✓${takes > 1 ? `×${takes}` : ""}` : "vid·";
      log.dim(`${b.id.padEnd(10)} ${String(b.durationSeconds).padStart(2)}s [${b.transitionOut.padEnd(5)}] ${kf ? "kf✓" : "kf·"} ${vidMark}${qcMark}  "${b.dialogue.slice(0, 60)}"`);
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
    printEstimate(estimateRun(project, sb, ctx.cfg, videoModel(ctx, opts), parseKV(opts.variants)), { qcReroll: ctx.cfg.qc.enabled });
    printLedger(project);
  });

program
  .command("verify")
  .argument("<name>")
  .option("--final <f>", "final basename or path (default: newest final/*.mp4)")
  .description("gate a finished ad: full-script speech check, visual identity/artifact sweep, join-audio profile")
  .action(async (name: string, opts) => {
    const ctx = makeCtx(program.opts(), name);
    const project = loadProject(ctx.projectsRoot, name);
    const sb = readStoryboard(project);
    let finalPath: string;
    if (opts.final) {
      finalPath = fs.existsSync(opts.final) ? path.resolve(opts.final) : path.join(project.finalDir, `${opts.final.replace(/\.mp4$/, "")}.mp4`);
    } else {
      const finals = fs.readdirSync(project.finalDir).filter((f) => f.endsWith(".mp4"))
        .map((f) => path.join(project.finalDir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (!finals.length) throw new Error(`no finals in ${project.finalDir} — run: adstitch stitch ${name}`);
      finalPath = finals[0];
    }
    if (!fs.existsSync(finalPath)) throw new Error(`final not found: ${finalPath}`);
    const { pass } = await verifyFinal(project, sb, ctx.provider, ctx.cfg, finalPath);
    if (!pass) process.exit(1);
  });

program
  .command("broll")
  .argument("<name>")
  .option("--count <n>", "number of product cutaway clips", (v: string) => parseInt(v, 10), 2)
  .option("--fast")
  .option("--draft", "use the lite draft model", true)
  .option("--model <id>")
  .option("--force")
  .option("--yes", "skip the spend confirmation")
  .description("render person-free product close-ups used as cutaway inserts (stitch --style tight --cutaways)")
  .action(async (name: string, opts) => {
    const ctx = makeCtx(program.opts(), name);
    const project = loadProject(ctx.projectsRoot, name);
    const sb = readStoryboard(project);
    const model = videoModel(ctx, { ...opts, draft: opts.fast || opts.model ? false : opts.draft });
    const rate = ctx.cfg.pricing.videoPerSecond[model] ?? 0.4;
    const est = opts.count * 4 * rate;
    log.money(`estimated spend: ~$${est.toFixed(2)} (${opts.count} × 4s ${model})`);
    await confirmSpend(ctx, est, !!opts.yes);
    const outs = await generateBroll(project, sb, ctx.provider, ctx.cfg, { count: opts.count, model, force: opts.force });
    log.ok(`B-roll ready: ${outs.map((o) => path.basename(o)).join(", ")} — use: adstitch stitch ${name} --style tight --cutaways`);
  });

const personaCmd = program.command("persona").description("reusable persona library (portrait + locked description, shared across campaigns)");

personaCmd
  .command("save")
  .argument("<slug>", "kebab-case persona name")
  .requiredOption("--from <project>", "project whose persona to save")
  .description("save a project's persona (portrait + storyboard description) to the library")
  .action((slug: string, opts) => {
    const ctx = makeCtx(program.opts(), opts.from);
    const project = loadProject(ctx.projectsRoot, opts.from);
    const sb = readStoryboard(project);
    const dir = savePersona(workRoot, slug, project, sb);
    log.ok(`persona "${slug}" saved → ${dir}`);
    log.info(`reuse it: adstitch init <new-project> --persona ${slug}`);
  });

personaCmd
  .command("list")
  .description("list saved personas")
  .action(() => {
    const all = listPersonas(workRoot);
    if (!all.length) {
      log.info("no personas saved yet — adstitch persona save <slug> --from <project>");
      return;
    }
    for (const { slug, record } of all) log.dim(`${slug.padEnd(22)} ${record.personaVisual.slice(0, 90)}`);
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
