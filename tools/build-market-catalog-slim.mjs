/**
 * Build slim OTA market catalog for Cencomall.
 *
 * Sources (first available wins):
 *   1) --from-file <path>  (full dump JSON array)
 *   2) GET $CENCOMALLS_MARKET_API_URL or https://stg.cencomalls.cl/api/market?mall=costanera
 *      with Authorization: Bearer $CENCOMALLS_API_TOKEN (required for live API)
 *   3) existing data/market-catalog.json (re-project / slim in place)
 *
 * Writes:
 *   projects/cencomall/.../data/market-catalog.json
 * then regenerates JSONP via tools/build-jsonp-assets.mjs
 *
 * Usage:
 *   node tools/build-market-catalog-slim.mjs
 *   node tools/build-market-catalog-slim.mjs --from-file ./Api\ Market.json
 *   CENCOMALLS_API_TOKEN=... node tools/build-market-catalog-slim.mjs --fetch
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outJson = resolve(
  repoRoot,
  "projects/cencomall/Assets/StreamingAssets/sima_services/data/market-catalog.json"
);

const SLIM_KEYS = [
  "id",
  "local",
  "brand_name",
  "market_name",
  "keywords",
  "brand_categories",
  "brand_level1_categories",
  "brand_sub_categories",
  "market_levels",
  "renovation",
  "mall",
  "brand_logo",
];

function parseArgs(argv) {
  const args = { fetch: false, fromFile: "", mall: "costanera", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fetch") args.fetch = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--from-file") args.fromFile = String(argv[++i] || "").trim();
    else if (a === "--mall") args.mall = String(argv[++i] || "costanera").trim();
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function unwrapList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.markets)) return payload.markets;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

function projectSlim(item) {
  const out = {};
  for (const key of SLIM_KEYS) {
    if (item[key] !== undefined && item[key] !== null) out[key] = item[key];
  }
  // Normalize required search/map fields.
  if (out.id != null) out.id = Number.isFinite(Number(out.id)) ? Number(out.id) : out.id;
  out.local = String(out.local || "").trim();
  out.brand_name = String(out.brand_name || "").trim();
  out.market_name = String(out.market_name || "").trim();
  out.keywords = String(out.keywords || "").trim();
  out.brand_categories = String(out.brand_categories || "").trim();
  if (!Array.isArray(out.brand_level1_categories)) {
    out.brand_level1_categories = out.brand_level1_categories
      ? [String(out.brand_level1_categories)]
      : [];
  }
  if (!Array.isArray(out.brand_sub_categories)) {
    out.brand_sub_categories = out.brand_sub_categories
      ? [String(out.brand_sub_categories)]
      : [];
  }
  if (!Array.isArray(out.market_levels)) {
    out.market_levels = out.market_levels ? [String(out.market_levels)] : [];
  }
  out.mall = String(out.mall || "costanera").trim() || "costanera";
  return out;
}

function validateSlim(list) {
  const missing = [];
  list.forEach(function (item, idx) {
    if (item.id == null || item.id === "") missing.push({ idx, reason: "id" });
    if (!item.local) missing.push({ idx, reason: "local", id: item.id });
  });
  return missing;
}

async function fetchFromApi(mall) {
  const base =
    process.env.CENCOMALLS_MARKET_API_URL ||
    `https://stg.cencomalls.cl/api/market?mall=${encodeURIComponent(mall)}`;
  const token = process.env.CENCOMALLS_API_TOKEN || process.env.CENCOMALLS_API_KEY || "";
  if (!token) {
    throw new Error(
      "Live fetch requires CENCOMALLS_API_TOKEN (Bearer). Use --from-file or omit --fetch to slim the existing JSON."
    );
  }
  const res = await fetch(base, {
    headers: {
      Accept: "application/json",
      Authorization: "Bearer " + token,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`market API HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return unwrapList(await res.json());
}

function loadFromFile(path) {
  const abs = resolve(repoRoot, path);
  if (!existsSync(abs)) throw new Error("file not found: " + abs);
  const raw = JSON.parse(readFileSync(abs, "utf8"));
  const list = unwrapList(raw);
  if (!list.length) throw new Error("no market items in " + abs);
  return list;
}

function printHelp() {
  console.log(`build-market-catalog-slim.mjs

Options:
  --fetch              Pull list from Cencomalls API (needs CENCOMALLS_API_TOKEN)
  --from-file <path>   Project slim from a local full dump
  --mall <slug>        Mall query param (default: costanera)
  --dry-run            Print stats only, do not write

Env:
  CENCOMALLS_API_TOKEN / CENCOMALLS_API_KEY
  CENCOMALLS_MARKET_API_URL  (override list URL)

After write, regenerates JSONP companions via tools/build-jsonp-assets.mjs.
Then bump OTA: npm run build:manifests -- --project cencomall
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  let source = "";
  let full = [];

  if (args.fromFile) {
    full = loadFromFile(args.fromFile);
    source = "file:" + args.fromFile;
  } else if (args.fetch) {
    full = await fetchFromApi(args.mall);
    source = "api";
  } else if (existsSync(outJson)) {
    full = loadFromFile(outJson);
    source = "existing-catalog";
  } else {
    throw new Error("No source. Pass --from-file, --fetch, or ensure market-catalog.json exists.");
  }

  const slim = full.map(projectSlim);
  const missing = validateSlim(slim);
  if (missing.length) {
    console.warn("WARNING: " + missing.length + " items missing id/local (kept; map will fail for those)");
    console.warn(missing.slice(0, 8));
  }

  const fullBytes = Buffer.byteLength(JSON.stringify(full));
  const slimBytes = Buffer.byteLength(JSON.stringify(slim));
  console.log({
    source,
    count: slim.length,
    fullKB: +(fullBytes / 1024).toFixed(1),
    slimKB: +(slimBytes / 1024).toFixed(1),
    ratio: +(slimBytes / Math.max(fullBytes, 1)).toFixed(3),
    missingRequired: missing.length,
  });

  if (args.dryRun) return;

  writeFileSync(outJson, JSON.stringify(slim) + "\n", "utf8");
  console.log("wrote " + outJson);

  const jsonp = spawnSync(process.execPath, [resolve(here, "build-jsonp-assets.mjs")], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (jsonp.status !== 0) {
    throw new Error("build-jsonp-assets.mjs failed with status " + jsonp.status);
  }
}

main().catch(function (err) {
  console.error(err.message || err);
  process.exit(1);
});
