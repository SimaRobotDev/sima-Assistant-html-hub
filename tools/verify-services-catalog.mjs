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
const bathrooms = all.filter((e) => e.type === "bathroom");
const elevators = all.filter((e) => e.type === "elevator");
console.log(
  "catalog ready:",
  all.length,
  "services (",
  bathrooms.length,
  "bathrooms,",
  elevators.length,
  "elevators)"
);
if (bathrooms.length !== 9) throw new Error("expected 9 bathrooms, got " + bathrooms.length);
if (elevators.length < 1) throw new Error("expected at least 1 elevator, got " + elevators.length);

const cases = [
  { q: "baños", min: 1, type: "bathroom" },
  { q: "banos nivel 2", min: 1, max: 3, type: "bathroom" },
  { q: "ripley nivel 3", min: 1, max: 3 },
  { q: "mudador", min: 1, max: 4, type: "bathroom" },
  { q: "afex", min: 1, max: 3 },
  { q: "patio de comidas", min: 1, max: 3 },
  { serviceId: "bano-n2-ripley", min: 1, max: 1 },
  { q: "ascensor", min: 1, max: 4, type: "elevator" },
  { q: "ascensores", min: 1, max: 4, type: "elevator" },
  { q: "elevador ripley", min: 1, max: 2, type: "elevator" },
  { q: "ascensor zara", min: 1, max: 1, type: "elevator" },
  { q: "ascensor decathlon", min: 1, max: 1, type: "elevator" },
  { q: "ascensor h&m", min: 1, max: 2, type: "elevator" },
  { q: "ascensor nivel 5", min: 1, max: 4, type: "elevator" },
  { serviceId: "ascensor-ripley", min: 1, max: 1 },
  { serviceId: "ascensor-zara", min: 1, max: 1 },
];

let fails = 0;
for (const testCase of cases) {
  const results = testCase.serviceId
    ? ServicesCatalog.search("", { serviceId: testCase.serviceId })
    : ServicesCatalog.search(testCase.q);
  const typeOk =
    !testCase.type ||
    results.every((row) => !row.type || row.type === testCase.type);
  const ok =
    results.length >= testCase.min &&
    (!testCase.max || results.length <= testCase.max) &&
    typeOk;
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
{
  const ranked = ServicesCatalog.search("ascensor ripley", { preferFloor: "2" });
  const top = ranked[0] && ranked[0].id;
  const ok = top === "ascensor-ripley";
  console.log((ok ? "PASS" : "FAIL") + ' "ascensor ripley" preferFloor=2 -> top=' + (top || "-"));
  if (!ok) fails++;
}
{
  const card = ServicesCatalog.toResultCard(
    ServicesCatalog.getById("ascensor-ripley"),
    { preferFloor: "5" }
  );
  const ok = card.anchorLocal === "CC_N5_5524";
  console.log(
    (ok ? "PASS" : "FAIL") +
      " ascensor-ripley preferFloor=5 anchor=" +
      (card.anchorLocal || "-")
  );
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
      "/" +
      all.length +
      " bathroomsComplete=" +
      bathrooms.filter(hasCompleteMapvx).length +
      "/9 elevatorsComplete=" +
      elevators.filter(hasCompleteMapvx).length +
      "/" +
      elevators.length +
      " incomplete=" +
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

if (!ServicesCatalog.looksLikeElevatorQuery("dónde está el ascensor")) {
  console.log("FAIL looksLikeElevatorQuery");
  fails++;
} else {
  console.log("PASS looksLikeElevatorQuery");
}

if (fails) {
  console.error("\n" + fails + " services catalog test(s) failed.");
  process.exit(1);
}

console.log("\nAll services catalog verification tests passed.");
