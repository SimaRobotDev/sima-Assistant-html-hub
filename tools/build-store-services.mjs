/**
 * Derives "stores that offer a service" (repairs / technical service) from the
 * market catalog and writes them into data/services-catalog.json as
 * type "store_service" entries, so the services search (the one the LLM calls)
 * can answer "where do I get my watch repaired?".
 *
 * Nothing is copied by hand: a store qualifies when ITS OWN catalog card says so
 * (keywords / sub-categories). Generated entries carry source:"market-catalog";
 * re-running replaces exactly those and never touches hand-written entries.
 *
 *   node tools/build-store-services.mjs           # regenerate the entries
 *   node tools/build-store-services.mjs --check   # exit 1 if they are stale
 *
 * Run it (then tools/build-jsonp-assets.mjs) whenever market-catalog.json changes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, "..", "projects/cencomall/Assets/StreamingAssets/sima_services/data");
const marketPath = resolve(dataDir, "market-catalog.json");
const servicesPath = resolve(dataDir, "services-catalog.json");

export const SOURCE = "market-catalog";
export const TYPE = "store_service";

// Repairs. "arreglo floral" is a bouquet, not a repair.
const REPAIR_RE = /\b(reparaci[oó]n(es)?|reparar|repara|arreglos?|arreglar|repair)\b/i;
const NOT_REPAIR_RE = /\barreglos?\s+(floral(es)?|de\s+flores)\b/i;
// Technical service / support.
const TECH_RE = /\b(servicio\s+t[eé]cnico|asistencia\s+t[eé]cnica|soporte\s+t[eé]cnico)\b/i;

function norm(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slug(value) {
  return norm(value).replace(/\s+/g, "-");
}

function floorKey(store) {
  const levels = (store.market_levels || []).map((l) => String(l).trim().toUpperCase()).filter(Boolean);
  if (levels.length) return levels[0] === "0" ? "PB" : levels[0];
  const m = String(store.local || "").toUpperCase().match(/^CC_(PB|N\d+)_/);
  if (!m) return "";
  return m[1] === "PB" ? "PB" : m[1].slice(1);
}

function floorLabel(key) {
  return key === "PB" ? "Planta Baja" : `Nivel ${key}`;
}

export function qualifies(store) {
  const text = `${store.keywords || ""} | ${(store.brand_sub_categories || []).join(" ; ")}`;
  const repair = REPAIR_RE.test(text) && !NOT_REPAIR_RE.test(text);
  const tech = TECH_RE.test(text);
  return { repair, tech, ok: repair || tech };
}

// "servicio técnico" and "reparación" are one ask for a visitor: every generated
// entry answers to both phrasings, plus its own store keywords.
const BASE_KEYWORDS = [
  "servicio tecnico", "servicios tecnicos", "asistencia tecnica", "soporte tecnico",
  "reparacion", "reparaciones", "reparar",
  "repair", "repairs", "technical service", "tech support",
  "servico tecnico", "assistencia tecnica", "conserto", "consertar",
];

export function buildEntries(market) {
  const entries = [];
  for (const store of market) {
    const q = qualifies(store);
    if (!q.ok || !store.local || !store.brand_name) continue;
    const key = floorKey(store);
    if (!key) continue;

    const own = String(store.keywords || "")
      .split(",")
      .map(norm)
      .filter((t) => t && t.length >= 3);
    const keywords = [...new Set([
      ...BASE_KEYWORDS,
      ...own,
      norm(store.brand_name),
      floorLabel(key).toLowerCase(),
      key === "PB" ? "piso pb" : `piso ${key}`,
    ])].slice(0, 60);

    const what = q.tech && q.repair ? "servicio técnico y reparación" : q.tech ? "servicio técnico" : "reparación";
    entries.push({
      id: `tienda-${slug(store.brand_name)}-${String(store.local).toLowerCase()}`,
      type: TYPE,
      source: SOURCE,
      sector: slug(store.brand_name),
      name: `${store.brand_name} (${floorLabel(key)})`,
      floors: [key],
      features: {},
      anchorStores: [{ brand: store.brand_name, local: store.local, role: "primary", floors: [key] }],
      descriptions: {
        short: `${store.brand_name} ofrece ${what} en ${floorLabel(key)}.`,
        medium: "",
        long: "",
      },
      keywords,
      mapvx: { placeId: store.local, placeIdSource: "market-catalog" },
    });
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

function serialize(catalog) {
  return JSON.stringify(catalog, null, 2).replace(/\n/g, "\r\n") + "\r\n";
}

function main() {
  const market = JSON.parse(readFileSync(marketPath, "utf8"));
  const catalog = JSON.parse(readFileSync(servicesPath, "utf8"));
  const kept = catalog.services.filter((s) => s.source !== SOURCE);
  const generated = buildEntries(market);
  const next = { ...catalog, services: [...kept, ...generated] };

  if (process.argv.includes("--check")) {
    const current = catalog.services.filter((s) => s.source === SOURCE);
    const same = JSON.stringify(current) === JSON.stringify(generated);
    console.log(same
      ? `store services up to date (${generated.length} entries)`
      : `STALE: services-catalog.json has ${current.length} generated entries, the market catalog yields ${generated.length}. Run: node tools/build-store-services.mjs`);
    process.exit(same ? 0 : 1);
  }

  writeFileSync(servicesPath, serialize(next));
  console.log(`wrote ${generated.length} store_service entries (kept ${kept.length} hand-written):`);
  generated.forEach((e) => console.log(`  ${e.id}  ${e.name}`));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
