#!/usr/bin/env node
// Mock-provider end-to-end smoke test: full pipeline + duration assertions,
// hook-matrix alternates, auto-QC (incl. forced-fail re-roll), persona library.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const proj = path.join(root, "projects", "__smoke");
const cli = `node ${path.join(root, "dist/cli.js")}`;
const sh = (cmd) => execSync(cmd, { cwd: root, stdio: "pipe" }).toString();
const dur = (f) => parseFloat(sh(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${f}"`));
const manifest = () => JSON.parse(fs.readFileSync(path.join(proj, "manifest.json"), "utf8"));

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

fs.rmSync(proj, { recursive: true, force: true });
fs.rmSync(path.join(root, "projects", "__smokep"), { recursive: true, force: true });
fs.rmSync(path.join(root, "personas", "smokep"), { recursive: true, force: true });

try {
  // ---- core pipeline -------------------------------------------------------
  sh(`${cli} init __smoke --template ugc-5beat-seamless --product SmokeTest`);
  sh(`${cli} run __smoke --provider mock --yes`);

  const final = path.join(proj, "final", "__smoke-cut.mp4");
  check("final video exists", fs.existsSync(final));
  const expected = 8 + 8 + 8 + 8 + 6;
  const d0 = dur(final);
  check("duration ≈ Σ beats", Math.abs(d0 - expected) < 1.5, `${d0.toFixed(2)}s vs ${expected}s`);

  let m = manifest();
  const baseSegs = Object.keys(m.artifacts).filter((k) => k.startsWith("segment/") && !k.includes("@"));
  check("5 segments recorded", baseSegs.length === 5, baseSegs.join(", "));
  check("mock provenance", baseSegs.every((k) => m.artifacts[k].model === "mock"));
  check("ledger total is $0", m.ledger.every((e) => e.costUsd === 0));
  check("qc ran and passed", baseSegs.every((k) => m.artifacts[k].qc?.pass === true && m.artifacts[k].qc?.attempts === 1));

  const boundaries = fs.readdirSync(path.join(proj, "keyframes")).filter((f) => f.includes("-to-"));
  check("4 shared boundary keyframes", boundaries.length === 4, boundaries.join(", "));

  const rerun = sh(`${cli} run __smoke --provider mock --yes`);
  check("second run fully cached", /0 rendered, 5 cached/.test(rerun));

  // ---- speech-aware stitch styles -----------------------------------------
  // mock timing: speechStart=0.2, speechEnd=d-2 → flow ramps each match clip at
  // (d-2)+0.25: 8s clips → 6.25 + 1.75/2 = 7.125; cta stays 6 → total ≈ 34.5
  sh(`${cli} stitch __smoke --provider mock --style flow --out flow-test`);
  const flowFinal = path.join(proj, "final", "flow-test.mp4");
  check("flow style stitched", fs.existsSync(flowFinal));
  const flowDur = dur(flowFinal);
  check("flow duration ≈ ramped math", Math.abs(flowDur - 34.5) < 1.2, `${flowDur.toFixed(2)}s vs 34.5s`);
  check("speech timing cached", Object.keys(manifest().artifacts).filter((k) => k.startsWith("timing/")).length === 5);

  sh(`${cli} broll __smoke --provider mock --yes`);
  check("broll clips rendered", fs.existsSync(path.join(proj, "segments", "broll-1.mp4")) && fs.existsSync(path.join(proj, "segments", "broll-2.mp4")));
  sh(`${cli} stitch __smoke --provider mock --style tight --cutaways --out tight-test`);
  const tightFinal = path.join(proj, "final", "tight-test.mp4");
  check("tight+cutaways stitched", fs.existsSync(tightFinal));
  // tight: 4 clips → (6.35-0.05)=6.3 each, cta → (4.35-0.05)=4.3, + 4×0.7 inserts ≈ 32.3
  const tightDur = dur(tightFinal);
  check("tight duration ≈ speech-cut math", Math.abs(tightDur - 32.3) < 1.5, `${tightDur.toFixed(2)}s vs 32.3s`);

  // ---- hook matrix ---------------------------------------------------------
  const altOut = sh(`${cli} alternates __smoke hook=2 --provider mock`);
  check("alternates written", /hook: 1 alternate\(s\) written/.test(altOut));
  const altAgain = sh(`${cli} alternates __smoke hook=2 --provider mock`);
  check("alternates idempotent", /unchanged — skipping/.test(altAgain));

  const varOut = sh(`${cli} videos __smoke --provider mock --variants hook=2 --yes`);
  check("only the alternate rendered", /1 rendered, 5 cached/.test(varOut));

  m = manifest();
  check("keyframe/hook-start@2 recorded", !!m.artifacts["keyframe/hook-start@2"]);
  check("segment/hook@2 recorded", !!m.artifacts["segment/hook@2"]);
  check(
    "alternate has a distinct input hash",
    m.artifacts["segment/hook@2"] && m.artifacts["segment/hook"] &&
      m.artifacts["segment/hook@2"].inputHash !== m.artifacts["segment/hook"].inputHash,
  );

  sh(`${cli} stitch __smoke --provider mock --matrix hook`);
  const m1 = path.join(proj, "final", "__smoke-hook1.mp4");
  const m2 = path.join(proj, "final", "__smoke-hook2.mp4");
  check("matrix emitted both finals", fs.existsSync(m1) && fs.existsSync(m2));
  check("matrix durations match", Math.abs(dur(m1) - dur(m2)) < 0.5, `${dur(m1).toFixed(2)}s vs ${dur(m2).toFixed(2)}s`);

  // ---- script.md @N lock ---------------------------------------------------
  fs.writeFileSync(path.join(proj, "script.md"), `## hook@2\n"Scripted alternate line from the user."\n`);
  sh(`${cli} plan __smoke --provider mock`);
  const sb = JSON.parse(fs.readFileSync(path.join(proj, "storyboard.json"), "utf8"));
  check("script @2 line locked verbatim", sb.beats[0].alternates?.[0]?.dialogue === "Scripted alternate line from the user.");
  const scriptedOut = sh(`${cli} videos __smoke --provider mock --variants hook=2 --yes`);
  check("script @2 change re-renders only that take", /1 rendered, 5 cached/.test(scriptedOut));

  // ---- QC forced fail → single re-roll, cache stays canonical ---------------
  fs.writeFileSync(path.join(proj, "adstitch.config.json"), JSON.stringify({ qc: { ssimThreshold: 1.01 } }));
  const regenOut = sh(`${cli} regen __smoke problem --provider mock --yes 2>&1`);
  check("qc failure detected + re-rolled", /QC failed segment\/problem/.test(regenOut) && /re-rolling once/.test(regenOut));
  m = manifest();
  check("qc verdict recorded (fail, 2 attempts)", m.artifacts["segment/problem"]?.qc?.pass === false && m.artifacts["segment/problem"]?.qc?.attempts === 2);
  check("rejected take parked", fs.readdirSync(path.join(proj, "segments")).some((f) => f.includes("problem") && f.endsWith(".rejected.mp4")));
  const afterQc = sh(`${cli} videos __smoke --provider mock --yes`);
  check("canonical hash survives qc re-roll (no re-bill loop)", /0 rendered, 5 cached/.test(afterQc));
  fs.rmSync(path.join(proj, "adstitch.config.json"));

  // ---- persona library ------------------------------------------------------
  sh(`${cli} persona save smokep --from __smoke`);
  const personaJson = path.join(root, "personas", "smokep", "persona.json");
  check("persona saved", fs.existsSync(personaJson) && fs.existsSync(path.join(root, "personas", "smokep", "portrait.png")));
  const rec = JSON.parse(fs.readFileSync(personaJson, "utf8"));
  rec.personaVisual = "SMOKE PERSONA LOCKED TEST";
  fs.writeFileSync(personaJson, JSON.stringify(rec));

  sh(`${cli} init __smokep --persona smokep --product SmokeTest2`);
  check("portrait copied into project", fs.existsSync(path.join(root, "projects", "__smokep", "assets", "persona.png")));
  sh(`${cli} plan __smokep --provider mock`);
  const sb2 = JSON.parse(fs.readFileSync(path.join(root, "projects", "__smokep", "storyboard.json"), "utf8"));
  check("persona description locked verbatim", sb2.style.personaVisual === "SMOKE PERSONA LOCKED TEST");
} catch (err) {
  check("pipeline ran", false, String(err.stderr || err.message).slice(0, 500));
} finally {
  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(path.join(root, "projects", "__smokep"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "personas", "smokep"), { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
