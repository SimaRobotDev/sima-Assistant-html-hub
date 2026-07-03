/**
 * Smoke test: load MarketSearch with mocked fetch and run key queries.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const catalogPath = resolve(
  root,
  "projects/cencomall/Assets/StreamingAssets/sima_services/data/market-catalog.json"
);
const manifestPath = resolve(
  root,
  "projects/cencomall/Assets/StreamingAssets/sima_services/shared/store-logos/store-logos.manifest.json"
);
const catalogJsonpPath = catalogPath.replace(".json", ".jsonp.js");
const manifestJsonpPath = manifestPath.replace(".json", ".jsonp.js");
const searchPath = resolve(
  root,
  "projects/cencomall/Assets/StreamingAssets/sima_services/shared/market-search.js"
);

const catalogRaw = readFileSync(catalogPath, "utf8");
const catalog = JSON.parse(catalogRaw);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// --- jsonp companions match source JSON ---
function extractJsonpGlobal(path, globalName) {
  const src = readFileSync(path, "utf8");
  const prefix = `window.${globalName} = `;
  const idx = src.indexOf(prefix);
  if (idx < 0) throw new Error(`missing ${prefix} in ${path}`);
  const jsonText = src.slice(idx + prefix.length).replace(/;\s*$/, "");
  return JSON.parse(jsonText);
}

const catalogFromJsonp = extractJsonpGlobal(catalogJsonpPath, "__MARKET_CATALOG__");
const manifestFromJsonp = extractJsonpGlobal(manifestJsonpPath, "__STORE_LOGO_MANIFEST__");
if (catalogFromJsonp.length !== catalog.length) {
  throw new Error(`catalog jsonp length ${catalogFromJsonp.length} != ${catalog.length}`);
}
if (JSON.stringify(manifestFromJsonp) !== JSON.stringify(manifest)) {
  throw new Error("manifest jsonp does not match manifest.json");
}
console.log("jsonp sync: OK (catalog=" + catalog.length + " entries, manifest keys=" + Object.keys(manifest).filter((k) => k[0] !== "_").length + ")");

// --- manifest PNG files exist ---
import { existsSync } from "node:fs";
const logosDir = resolve(root, "projects/cencomall/Assets/StreamingAssets/sima_services/shared/store-logos");
const missingPng = [];
for (const [key, val] of Object.entries(manifest)) {
  if (key.startsWith("_")) continue;
  const file = typeof val === "string" ? val : val?.file;
  if (file && !existsSync(resolve(logosDir, file))) missingPng.push(file);
}
if (missingPng.length) throw new Error("missing PNGs: " + missingPng.join(", "));
console.log("manifest PNGs: OK");

// --- MarketSearch with mocked fetch (http path) ---
const sandbox = { window: {}, console };
sandbox.window = sandbox;
sandbox.fetch = async () => ({
  ok: true,
  json: async () => catalog,
});
const ctx = vm.createContext(sandbox);
vm.runInContext(readFileSync(searchPath, "utf8"), ctx);

const MS = sandbox.window.MarketSearch;
await MS.loadCatalog();
if (!MS.isReady()) throw new Error("MarketSearch not ready after loadCatalog");
if (MS.getCatalogSize() !== catalog.length) {
  throw new Error("catalog size mismatch after load");
}
console.log("loadCatalog (fetch path): OK size=" + MS.getCatalogSize());

const queries = [
  { q: "mcdonald", min: 1, expectBrand: "mc donald" },
  { q: "adidas", min: 1, expectBrand: "adidas" },
  { q: "puma", min: 1, expectBrand: "puma" },
  { q: "casa ideas", min: 1, expectBrand: "casaidea" },
  { q: "jumbo", min: 1, expectBrand: "jumbo" },
  { q: "zapatillas", min: 3 },
  { q: "zara", min: 1, expectBrand: "zara" },
];

let failed = 0;
for (const { q, min, expectBrand } of queries) {
  const r = MS.search(q, { limit: 30 });
  const names = r.results.map((x) => MS.normalizeText(x.brand || x.name));
  const ok = r.results.length >= min && (!expectBrand || names.some((n) => n.includes(expectBrand)));
  console.log(
    (ok ? "PASS" : "FAIL") +
      `  "${q}" → ${r.results.length} results` +
      (r.results[0] ? ` (top: ${r.results[0].brand || r.results[0].name})` : "")
  );
  if (!ok) failed++;
}

if (failed) process.exit(1);
console.log("\nAll search smoke tests passed.");
