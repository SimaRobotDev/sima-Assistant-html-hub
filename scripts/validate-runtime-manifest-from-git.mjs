#!/usr/bin/env node
/**
 * Validate runtime manifest hashes against git blobs (LF), not the Windows
 * working tree (CRLF). Matches build-runtime-manifest-from-git.mjs.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import process from "process";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Usage: scripts/validate-runtime-manifest-from-git.mjs <manifest-path> [ref]");
  process.exit(1);
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.resolve(args[0]);
const ref = args[1] || "HEAD";
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const projectRootRel = path.posix.join(
  "projects",
  manifest.project,
  "Assets",
  "StreamingAssets",
  "sima_services"
);

let failures = 0;
for (const file of manifest.files || []) {
  const relFull = path.posix.join(projectRootRel, file.path);
  let buf;
  try {
    buf = execFileSync("git", ["show", `${ref}:${relFull}`], {
      cwd: rootDir,
      maxBuffer: 1024 * 1024 * 200,
    });
  } catch (e) {
    console.error(`Missing in git ${ref}: ${file.path}`);
    failures += 1;
    continue;
  }
  const actual = crypto.createHash("sha256").update(buf).digest("hex");
  if (actual !== file.sha256 || buf.length !== file.size) {
    console.error(
      `Hash/size mismatch: ${file.path} expected ${file.sha256}/${file.size} got ${actual}/${buf.length}`
    );
    failures += 1;
  }
}

if (failures) {
  console.error(`Manifest git validation failed: ${failures} issue(s)`);
  process.exit(2);
}
console.log(`Manifest git-valid: ${manifest.project} ${manifest.version} ref=${ref} files=${(manifest.files || []).length}`);
