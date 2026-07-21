/**
 * Apply verified elevator MapVX patches into services-catalog.json.
 *
 * Safe by default (dry-run). Requires poiRef + lat + lng + validatedAt on each patch.
 *
 * Usage:
 *   node tools/apply-elevator-mapvx-patches.mjs
 *   node tools/apply-elevator-mapvx-patches.mjs --apply
 *   node tools/apply-elevator-mapvx-patches.mjs --apply --only ascensor-n2-ripley
 *   node tools/apply-elevator-mapvx-patches.mjs --apply --jsonp
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const catalogPath = resolve(
  repoRoot,
  "projects/cencomall/Assets/StreamingAssets/sima_services/data/services-catalog.json"
);
const defaultPatchesPath = resolve(repoRoot, "data/elevator-mapvx-patches.json");
const altPatchesPath = resolve(
  repoRoot,
  "projects/cencomall/Assets/StreamingAssets/sima_services/data/elevator-mapvx-patches.json"
);

function parseArgs(argv) {
  const args = { apply: false, jsonp: false, only: null, patches: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--apply") args.apply = true;
    else if (argv[i] === "--jsonp") args.jsonp = true;
    else if (argv[i] === "--only" && argv[i + 1]) args.only = argv[++i];
    else if (argv[i] === "--patches" && argv[i + 1]) args.patches = resolve(process.cwd(), argv[++i]);
  }
  if (!args.patches) {
    if (existsSync(defaultPatchesPath)) args.patches = defaultPatchesPath;
    else if (existsSync(altPatchesPath)) args.patches = altPatchesPath;
    else args.patches = defaultPatchesPath;
  }
  return args;
}

function isValidCoord(value) {
  return value != null && Number.isFinite(Number(value));
}

function validatePatch(id, patch) {
  const errors = [];
  if (!patch || typeof patch !== "object") {
    errors.push("patch must be an object");
    return errors;
  }
  if (!patch.poiRef || !String(patch.poiRef).trim()) errors.push("missing poiRef");
  if (!isValidCoord(patch.lat)) errors.push("invalid lat");
  if (!isValidCoord(patch.lng)) errors.push("invalid lng");
  if (!patch.validatedAt) errors.push("missing validatedAt (YYYY-MM-DD)");
  if (patch.poiRef === "REPLACE_ME") errors.push("placeholder poiRef");
  return errors;
}

function main() {
  const args = parseArgs(process.argv);
  if (!existsSync(args.patches)) {
    console.error("Patches file not found:", args.patches);
    console.error("Export from /map/ → Exportar patches ascensores");
    process.exit(1);
  }

  const patchDoc = JSON.parse(readFileSync(args.patches, "utf8"));
  const patchMap = patchDoc.patches || patchDoc;
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const services = catalog.services || [];

  let changed = 0;
  let skipped = 0;

  for (const entry of services) {
    if (entry.type !== "elevator") continue;
    if (args.only && entry.id !== args.only) continue;

    const patch = patchMap[entry.id];
    if (!patch) {
      console.log("skip (no patch):", entry.id);
      skipped++;
      continue;
    }

    const errors = validatePatch(entry.id, patch);
    if (errors.length) {
      console.log("FAIL validate", entry.id, "→", errors.join("; "));
      skipped++;
      continue;
    }

    entry.mapvx = entry.mapvx || {};
    const next = {
      poiRef: String(patch.poiRef).trim(),
      mapvxId: patch.mapvxId != null ? patch.mapvxId : null,
      lat: Number(patch.lat),
      lng: Number(patch.lng),
      validatedAt: String(patch.validatedAt),
    };

    const prev = JSON.stringify(entry.mapvx);
    const nextStr = JSON.stringify(next);
    if (prev === nextStr) {
      console.log("unchanged:", entry.id);
      continue;
    }

    console.log(
      (args.apply ? "APPLY" : "DRY-RUN") +
        " " +
        entry.id +
        " poiRef=" +
        next.poiRef +
        " lat=" +
        next.lat +
        " lng=" +
        next.lng
    );
    if (args.apply) entry.mapvx = next;
    changed++;
  }

  if (!args.apply) {
    console.log("\nDry-run only. Re-run with --apply to write catalog.");
    process.exit(changed ? 0 : 1);
  }

  if (!changed) {
    console.log("\nNo catalog changes written.");
    process.exit(0);
  }

  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n", "utf8");
  console.log("\nUpdated", catalogPath, "(" + changed + " elevator(s))");

  if (args.jsonp) {
    const r = spawnSync("node", ["tools/build-jsonp-assets.mjs"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    if (r.status !== 0) process.exit(r.status || 1);
  }
}

main();
