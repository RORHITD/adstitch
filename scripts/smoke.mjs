#!/usr/bin/env node
// Mock-provider end-to-end smoke test: full pipeline + duration assertions.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const proj = path.join(root, "projects", "__smoke");
const cli = `node ${path.join(root, "dist/cli.js")}`;
const sh = (cmd) => execSync(cmd, { cwd: root, stdio: "pipe" }).toString();

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

fs.rmSync(proj, { recursive: true, force: true });
try {
  sh(`${cli} init __smoke --template ugc-5beat-seamless --product SmokeTest`);
  sh(`${cli} run __smoke --provider mock --yes`);

  const final = path.join(proj, "final", "__smoke-cut.mp4");
  check("final video exists", fs.existsSync(final));

  const dur = parseFloat(
    sh(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${final}"`),
  );
  const expected = 8 + 6 + 8 + 6 + 6;
  check("duration ≈ Σ beats", Math.abs(dur - expected) < 1.5, `${dur.toFixed(2)}s vs ${expected}s`);

  const manifest = JSON.parse(fs.readFileSync(path.join(proj, "manifest.json"), "utf8"));
  const segs = Object.keys(manifest.artifacts).filter((k) => k.startsWith("segment/"));
  check("5 segments recorded", segs.length === 5, segs.join(", "));
  check("mock provenance", segs.every((k) => manifest.artifacts[k].model === "mock"));
  check("ledger total is $0", manifest.ledger.every((e) => e.costUsd === 0));

  // seamless mode: adjacent segments share boundary keyframes
  const boundaries = fs.readdirSync(path.join(proj, "keyframes")).filter((f) => f.includes("-to-"));
  check("4 shared boundary keyframes", boundaries.length === 4, boundaries.join(", "));

  // cache: second run must render nothing
  const rerun = sh(`${cli} run __smoke --provider mock --yes`);
  check("second run fully cached", /0 rendered, 5 cached/.test(rerun));
} catch (err) {
  check("pipeline ran", false, String(err.stderr || err.message).slice(0, 400));
} finally {
  fs.rmSync(proj, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
