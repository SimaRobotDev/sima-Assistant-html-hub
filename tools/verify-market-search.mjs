/**
 * Smoke test: MarketSearch slim catalog + multi-token scoring + bridge payload.
 * Guion ~18 queries (marca, keyword, multi-token, footwear, 0 hits, setCatalog).
 */
import { readFileSync, existsSync } from "node:fs";
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
console.log("jsonp sync: OK (catalog=" + catalog.length + " entries)");

// Slim shape: no heavy fields in listing
const heavyKeys = ["brand_description", "market_photos", "market_schedules", "market_instagram", "market_phone"];
const heavyHits = catalog.filter((item) => heavyKeys.some((k) => {
  const v = item[k];
  if (Array.isArray(v)) return v.length > 0;
  return v != null && String(v).trim() !== "";
})).length;
if (heavyHits > 0) {
  throw new Error("slim catalog still has heavy fields on " + heavyHits + " items");
}
const missingLocal = catalog.filter((item) => !String(item.local || "").trim() || item.id == null);
if (missingLocal.length) {
  throw new Error("slim catalog missing id/local on " + missingLocal.length + " items");
}
console.log("slim catalog: OK (no heavy listing fields; all have id+local)");

const logosDir = resolve(root, "projects/cencomall/Assets/StreamingAssets/sima_services/shared/store-logos");
const missingPng = [];
for (const [key, val] of Object.entries(manifest)) {
  if (key.startsWith("_")) continue;
  const file = typeof val === "string" ? val : val?.file;
  if (file && !existsSync(resolve(logosDir, file))) missingPng.push(file);
}
if (missingPng.length) throw new Error("missing PNGs: " + missingPng.join(", "));
console.log("manifest PNGs: OK");

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
  { q: "nike", min: 1, expectBrand: "nike" },
  { q: "casa ideas", min: 1, expectBrand: "casaidea" },
  { q: "jumbo", min: 1, expectBrand: "jumbo" },
  { q: "zara", min: 1, expectBrand: "zara" },
  { q: "zapatillas", min: 3 },
  { q: "nike zapatillas", min: 1, expectBrand: "nike" },
  { q: "adidas zapatillas", min: 1, expectBrand: "adidas" },
  { q: "adidas original", min: 1, expectBrand: "adidas original" },
  { q: "adidas originals", min: 1, expectBrand: "adidas original" },
  { q: "zapatos deportivos", min: 3, rejectBrand: /econ[oó]pticas|gmo|ray ban|sunglass|all nutrition|winkler|place vendome/i },
  { q: "ropa mujer", min: 1 },
  { q: "vestuario", min: 3 },
  { q: "gastronomia", min: 3 },
  { q: "CC_N5_5560", min: 1 }, // exact local
  { q: "tiendaquenotexistexyz", min: 0, max: 0, allowRelated: false },
  { q: "zzzznohit999", min: 0, max: 0, allowRelated: false },
  { q: "falabella", min: 1, expectBrand: "falabella" },
];

let failed = 0;
for (const { q, min, max, expectBrand, rejectBrand, allowRelated } of queries) {
  const r = MS.search(q, { limit: 30, allowRelated: allowRelated !== false });
  const names = r.results.map((x) => MS.normalizeText(x.brand || x.name));
  const hasBrand = !expectBrand || names.some((n) => n.includes(expectBrand));
  const rejected = rejectBrand
    ? r.results.filter((x) => rejectBrand.test(String(x.brand || x.name || "")))
    : [];
  const withinMax = max == null || r.results.length <= max;
  const ok = r.results.length >= min && withinMax && hasBrand && rejected.length === 0;

  // Bridge payload always present (including 0 hits)
  const bridge = MS.toBridgeSearchPayload(
    { query: q, results: r.results, totalMatches: allowRelated === false ? r.results.length : r.totalMatches },
    { seq: 1, topN: 8 }
  );
  const bridgeOk =
    bridge.type === "market_search_results" &&
    bridge.query === q &&
    typeof bridge.totalMatches === "number" &&
    Array.isArray(bridge.results) &&
    (r.results.length === 0
      ? bridge.results.length === 0
      : bridge.results.every((row) => row.id != null && String(row.local || "").length > 0));

  const topIsBrand =
    !expectBrand ||
    !r.results[0] ||
    MS.normalizeText(r.results[0].brand || r.results[0].name).includes(expectBrand);
  // For marca+producto, top result should be the brand when expectBrand is set.
  const rankOk = !expectBrand || !q.includes(" ") || topIsBrand || r.results.length === 0;

  console.log(
    (ok && bridgeOk && rankOk ? "PASS" : "FAIL") +
      `  "${q}" → ${r.results.length} results` +
      (r.results[0] ? ` (top: ${r.results[0].brand || r.results[0].name})` : "") +
      ` bridge=${bridge.results.length}/${bridge.totalMatches}` +
      (rejected.length ? ` leaked=${rejected.map((x) => x.brand).join(",")}` : "") +
      (!bridgeOk ? " [bridge]" : "") +
      (!rankOk ? " [rank]" : "")
  );
  if (!ok || !bridgeOk || !rankOk) failed++;
}

// setCatalog must require id+local
try {
  MS.setCatalog([{ brand_name: "NoLocal", id: 1 }]);
  console.log("FAIL  setCatalog accepted item without local");
  failed++;
} catch (e) {
  console.log("PASS  setCatalog rejects missing local/id");
}

const setInfo = MS.setCatalog([
  { id: 999001, local: "CC_TEST_1", brand_name: "Test Brand", keywords: "test", brand_categories: "Test" },
  { id: 999002, brand_name: "Drop Me" }, // dropped
]);
if (setInfo.catalogSize !== 1 || setInfo.dropped !== 1) {
  console.log("FAIL  setCatalog size/dropped", setInfo);
  failed++;
} else {
  console.log("PASS  setCatalog preserves id+local (dropped=" + setInfo.dropped + ")");
}
const setSearch = MS.search("test brand", { limit: 5 });
if (!setSearch.results.length || !setSearch.results[0].local) {
  console.log("FAIL  setCatalog search missing local");
  failed++;
} else {
  console.log("PASS  setCatalog searchable with local=" + setSearch.results[0].local);
}

if (failed) {
  console.error("\n" + failed + " check(s) failed");
  process.exit(1);
}
console.log("\nAll search smoke tests passed (" + queries.length + " queries + setCatalog).");
