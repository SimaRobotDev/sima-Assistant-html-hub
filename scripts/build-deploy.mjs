#!/usr/bin/env node
import fs from "fs";
import path from "path";
import process from "process";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);
const baseUrlArg =
  args[0] ||
  process.env.DEPLOY_BASE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const sourceProjectsDir = path.join(rootDir, "projects");
const manifestsDir = path.join(rootDir, "runtime-sync", "manifests");
const deployDir = path.join(rootDir, "deploy");

const projectSlugs = fs.existsSync(manifestsDir)
  ? fs.readdirSync(manifestsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.basename(name, ".json"))
      .sort()
  : [];

if (projectSlugs.length === 0) {
  console.error("No runtime manifests found in runtime-sync/manifests.");
  process.exit(1);
}

function ensureCleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function copyTree(source, target) {
  if (!fs.existsSync(source)) {
    return false;
  }

  fs.cpSync(source, target, {
    recursive: true,
    force: true,
    dereference: false,
    filter: (src) => !src.endsWith(".meta") && !src.endsWith(".DS_Store"),
  });

  return true;
}

function resolveProjectBaseUrl(slug) {
  if (!baseUrlArg) {
    return null;
  }

  const normalized = baseUrlArg.endsWith("/") ? baseUrlArg : `${baseUrlArg}/`;
  return new URL(`${slug}/`, normalized).toString().replace(/\/$/, "");
}

function buildIndex(projects) {
  const rows = projects
    .map((project) => {
      const manifestPath = `/${project.slug}/manifest.json`;
      return `<li><a href="${manifestPath}">${project.slug}</a> - <code>${manifestPath}</code></li>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>SIMA HTML Hub</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 40px; line-height: 1.5; }
      code { background: #f2f2f2; padding: 0.15rem 0.35rem; border-radius: 4px; }
      a { color: #0057b8; }
    </style>
  </head>
  <body>
    <h1>SIMA HTML Hub</h1>
    <p>Manifest publicados por proyecto.</p>
    <ul>
      ${rows}
    </ul>
  </body>
</html>`;
}

ensureCleanDir(deployDir);

const builtProjects = [];

for (const slug of projectSlugs) {
  const manifestSource = path.join(manifestsDir, `${slug}.json`);
  const projectSource = path.join(sourceProjectsDir, slug, "Assets", "StreamingAssets", "sima_services");
  const projectDeployDir = path.join(deployDir, slug);

  if (!fs.existsSync(projectSource)) {
    console.warn(`Skipping ${slug}: source project tree not found at ${projectSource}`);
    continue;
  }

  fs.mkdirSync(projectDeployDir, { recursive: true });
  copyTree(projectSource, projectDeployDir);

  const manifest = readJson(manifestSource);
  const projectBaseUrl = resolveProjectBaseUrl(slug);
  if (projectBaseUrl) {
    manifest.baseUrl = projectBaseUrl;
  }
  manifest.generatedAt = new Date().toISOString();
  writeJson(path.join(projectDeployDir, "manifest.json"), manifest);

  builtProjects.push({ slug });
}

writeJson(path.join(deployDir, "_projects.json"), builtProjects);
fs.writeFileSync(path.join(deployDir, "index.html"), buildIndex(builtProjects), "utf8");

console.log(`Built deploy output in ${path.relative(rootDir, deployDir)}`);
if (!baseUrlArg) {
  console.log("Note: set DEPLOY_BASE_URL to rewrite manifest.baseUrl for runtime.");
}
