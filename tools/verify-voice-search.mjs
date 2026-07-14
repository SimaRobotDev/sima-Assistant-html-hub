/**
 * Voice search pipeline smoke test:
 * native payload normalization + query cleanup + MarketSearch.searchVoice
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
const catalogPath = resolve(services, "data/market-catalog.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

function loadModule(relativePath, extraSetup) {
  const sandbox = { window: {}, console, URLSearchParams };
  sandbox.window = sandbox;
  sandbox.window.location = { search: "", protocol: "https:" };
  sandbox.fetch = async () => ({
    ok: true,
    json: async () => catalog,
  });
  if (extraSetup) extraSetup(sandbox);
  vm.runInContext(readFileSync(resolve(services, relativePath), "utf8"), vm.createContext(sandbox));
  return sandbox.window;
}

const localeMod = loadModule("shared/locale.js");
const i18nMod = loadModule("shared/market-query-i18n.js");
const payloadMod = loadModule("shared/native-payload.js");
const searchMod = loadModule("shared/market-search.js");

const SimaLocale = localeMod.SimaLocale;
const MarketQueryI18n = i18nMod.MarketQueryI18n;
const SimaNativePayload = payloadMod.SimaNativePayload;
const MarketSearch = searchMod.MarketSearch;

await MarketSearch.loadCatalog();
if (!MarketSearch.isReady()) throw new Error("MarketSearch not ready");
console.log("catalog ready:", MarketSearch.getCatalogSize());

const payloadCases = [
  {
    name: "GPT open_store_navigation + args.extra",
    input: { action: "open_store_navigation", args: { extra: "mcdonald" } },
    expectQuery: "mcdonald",
  },
  {
    name: "voice_search transcript",
    input: { type: "voice_search", transcript: "zara" },
    expectQuery: "zara",
  },
  {
    name: "nested payload envelope",
    input: { type: "market_search", payload: { text: "jumbo" } },
    expectQuery: "jumbo",
  },
  {
    name: "ignore TTS message field when query present",
    input: { type: "market_search", message: "Te muestro cómo llegar a Zara.", query: "zara" },
    expectQuery: "zara",
  },
  {
    name: "extract brand from TTS-only message",
    input: { type: "market_search", message: "Te muestro cómo llegar a Zara." },
    expectQuery: "Zara",
  },
  {
    name: "RN WebView wrapper envelope",
    input: { type: "webview_message", payload: { type: "market_search", query: "zara" } },
    expectQuery: "zara",
  },
  {
    name: "RN double-stringified transcript",
    input: JSON.stringify(JSON.stringify({ type: "voice_search", transcript: "nike" })),
    expectQuery: "nike",
  },
];

let payloadFails = 0;
for (const testCase of payloadCases) {
  const normalized = SimaNativePayload.normalize(testCase.input);
  const query =
    typeof normalized === "string"
      ? normalized.trim()
      : SimaNativePayload.extractSearchQuery(normalized);
  const ok = query === testCase.expectQuery;
  console.log((ok ? "PASS" : "FAIL") + " payload: " + testCase.name + " -> " + JSON.stringify(query));
  if (!ok) payloadFails++;
}

const voiceQueries = [
  { q: "quiero comer en mcdonald", locale: "es", min: 1, brandIncludes: "mc donald" },
  { q: "donde esta zara", locale: "es", min: 1, brandIncludes: "zara" },
  { q: "buscar jumbo", locale: "es", min: 1, brandIncludes: "jumbo" },
  { q: "I want Nike shoes", locale: "en", min: 1, brandIncludes: "nike" },
  { q: "quiero comprar zapatillas nike", locale: "es", min: 1, brandIncludes: "nike" },
  { q: "where is the pharmacy", locale: "en", min: 1 },
];

let voiceFails = 0;
for (const testCase of voiceQueries) {
  const attempts = MarketQueryI18n.buildSearchAttempts(testCase.q, testCase.locale || "es");
  let result = null;
  for (const attempt of attempts) {
    result = MarketSearch.searchVoice(attempt, { limit: 20 });
    if (result.results.length) break;
  }
  const top = result.results[0];
  const brand = MarketSearch.normalizeText(top && (top.brand || top.name));
  const ok =
    result.results.length >= testCase.min &&
    (!testCase.brandIncludes || brand.includes(testCase.brandIncludes));
  console.log(
    (ok ? "PASS" : "FAIL") +
      ' voice: "' + testCase.q + '" -> ' +
      result.results.length +
      " (" +
      (result.searchMode || "n/a") +
      ")" +
      (top ? " top=" + (top.brand || top.name) : "")
  );
  if (!ok) voiceFails++;
}

const totalFails = payloadFails + voiceFails;
if (totalFails) {
  console.error("\nVoice verification failed:", totalFails);
  process.exit(1);
}

console.log("\nAll voice search verification tests passed.");
