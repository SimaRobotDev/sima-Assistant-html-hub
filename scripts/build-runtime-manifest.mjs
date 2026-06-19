#!/usr/bin/env node
import fs from "fs";
import path from "path";
import crypto from "crypto";
import process from "process";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("Usage: scripts/build-runtime-manifest.mjs <project-slug> <base-url> [version] [rollback-to]");
  process.exit(1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const projectSlug = args[0];
const baseUrl = args[1].replace(/\/+$/, "");
const version = args[2] || new Date().toISOString().slice(0, 10);
const rollbackTo = args[3] || null;
const projectRoot = path.join(rootDir, "projects", projectSlug, "Assets", "StreamingAssets", "sima_services");

if (!fs.existsSync(projectRoot)) {
  console.error(`Project path not found: ${projectRoot}`);
  process.exit(1);
}

function walk(dir, relBase = "") {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;
    if (entry.name.endsWith(".meta")) continue;
    const abs = path.join(dir, entry.name);
    const rel = path.posix.join(relBase, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(abs, rel));
    } else if (entry.isFile()) {
      const buf = fs.readFileSync(abs);
      out.push({
        path: rel,
        size: buf.length,
        sha256: crypto.createHash("sha256").update(buf).digest("hex"),
      });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const files = walk(projectRoot);
const entryPoints = files
  .filter((file) => file.path.endsWith("/index.html"))
  .map((file) => ({
    service: file.path.split("/")[0],
    entry: file.path,
  }))
  .sort((a, b) => a.service.localeCompare(b.service));

const manifest = {
  schemaVersion: 1,
  project: projectSlug,
  version,
  baseUrl,
  generatedAt: new Date().toISOString(),
  hashAlgorithm: "sha256",
  rollbackTo,
  entryPoints,
  files,
};

const outputDir = path.join(rootDir, "runtime-sync", "manifests");
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(
  path.join(outputDir, `${projectSlug}.json`),
  JSON.stringify(manifest, null, 2) + "\n"
);

console.log(`Wrote runtime manifest for ${projectSlug} -> runtime-sync/manifests/${projectSlug}.json`);
