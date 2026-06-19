#!/usr/bin/env node
import fs from "fs";
import path from "path";
import crypto from "crypto";
import process from "process";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Usage: scripts/validate-runtime-manifest.mjs <manifest-path>");
  process.exit(1);
}

const manifestPath = path.resolve(args[0]);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.join(
  rootDir,
  "projects",
  manifest.project,
  "Assets",
  "StreamingAssets",
  "sima_services"
);

if (!fs.existsSync(projectRoot)) {
  console.error(`Project path not found: ${projectRoot}`);
  process.exit(1);
}

let failures = 0;

for (const file of manifest.files || []) {
  const abs = path.join(projectRoot, file.path);
  if (!fs.existsSync(abs)) {
    console.error(`Missing file: ${file.path}`);
    failures += 1;
    continue;
  }
  const buf = fs.readFileSync(abs);
  const actual = crypto.createHash("sha256").update(buf).digest("hex");
  if (actual !== file.sha256) {
    console.error(`Hash mismatch: ${file.path}`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`Manifest validation failed: ${failures} issue(s)`);
  process.exit(2);
}

console.log(`Manifest valid: ${manifest.project} ${manifest.version}`);

