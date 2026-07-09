#!/usr/bin/env node
// Same output shape as build-runtime-manifest.mjs, but hashes the content
// as committed in the git tree (via `git cat-file`) instead of the local
// working-tree files on disk. This avoids the recurring "stale manifest"
// bug on Windows checkouts with core.autocrlf=true, where the on-disk
// bytes (CRLF) differ from the LF-normalized blob that actually gets
// deployed/served — see git history of runtime-sync/manifests/cencomall.json
// for prior incidents of this exact issue.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import process from "process";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("Usage: scripts/build-runtime-manifest-from-git.mjs <project-slug> <base-url> [version] [rollback-to] [ref]");
  process.exit(1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const projectSlug = args[0];
const baseUrl = args[1].replace(/\/+$/, "");
const version = args[2] || new Date().toISOString().slice(0, 10);
const rollbackTo = args[3] || null;
const ref = args[4] || "HEAD";
const projectRootRel = path.posix.join("projects", projectSlug, "Assets", "StreamingAssets", "sima_services");

function gitLsTree(ref, relBase) {
  const out = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "--", relBase], {
    cwd: rootDir,
    maxBuffer: 1024 * 1024 * 200,
  }).toString("utf8");
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function gitBlob(ref, relPath) {
  return execFileSync("git", ["show", `${ref}:${relPath}`], {
    cwd: rootDir,
    maxBuffer: 1024 * 1024 * 200,
  });
}

const paths = gitLsTree(ref, projectRootRel)
  .filter((p) => !p.endsWith(".meta") && !p.endsWith(".DS_Store"))
  .sort((a, b) => a.localeCompare(b));

const files = paths.map((relFull) => {
  const buf = gitBlob(ref, relFull);
  const rel = path.posix.relative(projectRootRel, relFull);
  return {
    path: rel,
    size: buf.length,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
  };
});

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

console.log(`Wrote git-blob-based runtime manifest for ${projectSlug} (ref=${ref}) -> runtime-sync/manifests/${projectSlug}.json`);
