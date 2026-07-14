/**
 * Adds Spanish (es) descriptions from market-catalog.json into the i18n overlay.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const catalogPath = resolve(
  repoRoot,
  "projects/cencomall/Assets/StreamingAssets/sima_services/data/market-catalog.json"
);
const outPath = resolve(
  repoRoot,
  "projects/cencomall/Assets/StreamingAssets/sima_services/data/market-catalog-i18n.json"
);

const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const byId = new Map(
  catalog.map((item) => [String(item.id), String(item.brand_description || "").trim()])
);

let overlay = { version: 1, generatedAt: new Date().toISOString(), stores: {} };
if (existsSync(outPath)) {
  overlay = JSON.parse(readFileSync(outPath, "utf8"));
  if (!overlay.stores) overlay.stores = {};
}

let added = 0;
for (const [id, desc] of byId.entries()) {
  if (!desc) continue;
  if (!overlay.stores[id]) overlay.stores[id] = {};
  if (!overlay.stores[id].es) {
    overlay.stores[id].es = desc;
    added += 1;
  }
}

overlay.generatedAt = new Date().toISOString();
writeFileSync(outPath, JSON.stringify(overlay), "utf8");
console.log(
  "backfill es:",
  added,
  "stores updated;",
  Object.keys(overlay.stores).length,
  "total in overlay"
);
