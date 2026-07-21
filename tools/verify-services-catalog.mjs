/**
 * Smoke test for services-catalog.json + ServicesCatalog search helpers.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const services = resolve(
  root,
  "projects/cencomall/Assets/StreamingAssets/sima_services"
);
const catalogPath = resolve(services, "data/services-catalog.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

function loadModule(relativePath) {
  const sandbox = { window: {}, console, URLSearchParams };
  sandbox.window = sandbox;
  sandbox.window.location = { search: "", protocol: "https:" };
  vm.runInContext(readFileSync(resolve(services, relativePath), "utf8"), vm.createContext(sandbox));
  return sandbox.window;
}

const mod = loadModule("shared/services-catalog.js");
const ServicesCatalog = mod.ServicesCatalog;

mod.window.location.protocol = "file:";
mod.window.__SERVICES_CATALOG__ = catalog;
await ServicesCatalog.loadCatalog();

if (!ServicesCatalog.isReady()) throw new Error("ServicesCatalog not ready");
const all = ServicesCatalog.getAll();
console.log("catalog ready:", all.length, "bathrooms");
if (all.length !== 9) throw new Error("expected 9 bathrooms, got " + all.length);

const cases = [
  { q: "baños", min: 1 },
  { q: "banos nivel 2", min: 1, max: 3 },
  { q: "ripley nivel 3", min: 1, max: 2 },
  { q: "mudador", min: 1, max: 4 },
  { q: "afex", min: 1, max: 2 },
  { q: "patio de comidas", min: 1, max: 2 },
  { serviceId: "bano-n2-ripley", min: 1, max: 1 },
];

let fails = 0;
for (const testCase of cases) {
  const results = testCase.serviceId
    ? ServicesCatalog.search("", { serviceId: testCase.serviceId })
    : ServicesCatalog.search(testCase.q);
  const ok =
    results.length >= testCase.min &&
    (!testCase.max || results.length <= testCase.max);
  console.log(
    (ok ? "PASS" : "FAIL") +
      " " +
      (testCase.serviceId || '"' + testCase.q + '"') +
      " -> " +
      results.length +
      (results[0] ? " (" + results[0].id + ")" : "")
  );
  if (!ok) fails++;
}

// Totem floor preference: generic "baños" on level 5 should rank food-court bathroom first.
{
  const ranked = ServicesCatalog.search("baños", { preferFloor: "5" });
  const top = ranked[0] && ranked[0].id;
  const ok = top === "bano-n5-comidas";
  console.log((ok ? "PASS" : "FAIL") + ' "baños" preferFloor=5 -> top=' + (top || "-"));
  if (!ok) fails++;
}
{
  const ranked = ServicesCatalog.search("baños", { preferFloor: "PB" });
  const top = ranked[0] && ranked[0].id;
  const ok = top === "bano-pb-afex";
  console.log((ok ? "PASS" : "FAIL") + ' "baños" preferFloor=PB -> top=' + (top || "-"));
  if (!ok) fails++;
}

for (const entry of all) {
  const card = ServicesCatalog.toResultCard(entry);
  if (!card.id || !card.name || !card.anchorLocal) {
    console.log("FAIL card missing fields:", entry.id, card);
    fails++;
  }
}

function isValidCoord(value) {
  return value != null && Number.isFinite(Number(value));
}

function hasCompleteMapvx(entry) {
  const mv = entry.mapvx || {};
  const poiRef = mv.poiRef ? String(mv.poiRef).trim() : "";
  const mapvxId = mv.mapvxId ? String(mv.mapvxId).trim() : "";
  return !!(poiRef || mapvxId) && isValidCoord(mv.lat) && isValidCoord(mv.lng) && !!mv.validatedAt;
}

{
  const withMapvx = all.filter(hasCompleteMapvx);
  const incomplete = all.filter((entry) => {
    const mv = entry.mapvx || {};
    const any =
      mv.poiRef ||
      mv.mapvxId ||
      mv.lat != null ||
      mv.lng != null ||
      mv.validatedAt;
    return any && !hasCompleteMapvx(entry);
  });
  console.log(
    "mapvx catalog: complete=" +
      withMapvx.length +
      "/9 incomplete=" +
      incomplete.length
  );
  for (const entry of incomplete) {
    console.log("FAIL incomplete mapvx block:", entry.id, entry.mapvx);
    fails++;
  }
  for (const entry of withMapvx) {
    const card = ServicesCatalog.toResultCard(entry);
    if (!isValidCoord(card.mapvxLat) || !isValidCoord(card.mapvxLng)) {
      console.log("FAIL mapvx coords on card:", entry.id);
      fails++;
    }
  }
}

if (fails) {
  console.error("\n" + fails + " services catalog test(s) failed.");
  process.exit(1);
}

console.log("\nAll services catalog verification tests passed.");
