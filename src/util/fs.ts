import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function sha256File(file: string): string {
  return sha256(fs.readFileSync(file));
}

/** stable hash over all inputs that determine an artifact (params + input-file contents) */
export function hashInputs(params: unknown, files: string[] = []): string {
  const fileHashes = files.map((f) => (fs.existsSync(f) ? sha256File(f) : `missing:${f}`));
  return sha256(JSON.stringify({ params, fileHashes }));
}

/** find user-supplied asset images like assets/product*.png|jpg|jpeg|webp */
export function findAssets(dir: string, prefix: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().startsWith(prefix) && /\.(png|jpe?g|webp)$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

export function mimeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}
