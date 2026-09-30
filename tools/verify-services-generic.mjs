/**
 * Smoke test: generic "servicios del mall" intent (es / en / pt).
 *  - which queries are the generic listing vs. a specific service / store ask
 *  - the listing returns EVERY catalog service (all types)
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const sima = resolve(here, "..", "projects/cencomall/Assets/StreamingAssets/sima_services");

const servicesData = JSON.parse(readFileSync(resolve(sima, "data/services-catalog.json"), "utf8"));

function load(file, extra = {}) {
  const window = { location: { protocol: "file:" }, ...extra };
  const ctx = vm.createContext({ window, console });
  vm.runInContext(readFileSync(resolve(sima, file), "utf8"), ctx, { filename: file });
  return window;
}

const SC = load("shared/services-catalog.js", { __SERVICES_CATALOG__: servicesData }).ServicesCatalog;
await SC.loadCatalog();

let failed = 0;
function check(label, ok, detail = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
}

// ---- 1. intent detection ----
const GENERIC = [
  // es
  "servicio mall", "servicios de mall", "mall servicios", "servicios del mall",
  "servicios", "servicio", "los servicios del centro comercial", "servicios generales del mall",
  "quiero ver los servicios del mall", "qué servicios hay en el mall", "todos los servicios",
  "servicios costanera center", "serivicios del mall", "sevicios mall", "servicios mall nivel 2",
  // en
  "mall services", "services", "service mall", "shopping center services", "mall service",
  "show me all the mall services", "what services are there in the mall", "mall's services",
  "all services", "servces mall", "mall amenities", "mall facilities",
  // pt
  "serviços do shopping", "servicos do mall", "serviço shopping", "shopping servicos",
  "shopping serviços", "todos os serviços do shopping", "quais serviços tem no shopping",
  "servicos do centro comercial",
];
const NOT_GENERIC = [
  "baños", "ascensor", "servicio al cliente", "customer service", "atención al cliente",
  "servicio sanitario", "cowork", "sala de lactancia", "mudador",
  "servicios de belleza", "servicio técnico", "servicio de lavandería", "beauty services",
  "serviços de beleza", "mall", "zapatillas", "adidas", "farmacia", "multiservice", "Multiservice",
  "cajero", "mall information",
];
GENERIC.forEach((q) =>
  check(`generic   "${q}"`, SC.looksLikeGenericServicesQuery(q) && SC.looksLikeServicesQuery(q))
);
NOT_GENERIC.forEach((q) => check(`specific  "${q}"`, !SC.looksLikeGenericServicesQuery(q)));

// Specific intents must keep being services queries (routing unchanged).
["baños", "ascensor", "servicio al cliente", "cowork", "mudador"].forEach((q) =>
  check(`still a services query "${q}"`, SC.looksLikeServicesQuery(q))
);

// ---- 2. listing returns EVERYTHING in services-catalog.json ----
const all = SC.search("servicios del mall");
check(
  `"servicios del mall" returns all ${servicesData.services.length} catalog services`,
  all.length === servicesData.services.length,
  `got ${all.length}`
);
const types = new Set(all.map((r) => r.type));
const catalogTypes = new Set(servicesData.services.map((s) => s.type));
check(
  "every catalog type is present",
  [...catalogTypes].every((t) => types.has(t)),
  [...types].join(",")
);
check(
  "no duplicate ids",
  new Set(all.map((r) => r.id)).size === all.length
);
for (const q of ["mall services", "serviços do shopping", "servicio mall", "mall servicios"]) {
  const r = SC.search(q);
  check(`"${q}" -> same full listing`, r.length === all.length, `got ${r.length}`);
}
// totem on N2 must NOT hide the N3-only Zara elevator bank in the full listing.
const onN2 = SC.search("servicios del mall", { preferFloor: "2" });
check(
  "totem floor N2 still lists every service (incl. N3-only elevator)",
  onN2.length === all.length && onN2.some((r) => r.id === "ascensor-zara")
);
check(
  "totem floor N2 lists N2 services first within a type",
  (() => {
    const bathrooms = onN2.filter((r) => r.type === "bathroom");
    return bathrooms[0].floors.includes("2");
  })()
);
const n2 = SC.search("servicios del mall nivel 2");
check(
  '"servicios del mall nivel 2" scopes to floor 2',
  n2.length > 0 && n2.length < all.length && n2.every((r) => r.floors.includes("2")),
  `got ${n2.length}`
);
// Specific searches unchanged.
check('"baños" -> only bathrooms', SC.search("baños").every((r) => r.type === "bathroom"));
check('"ascensor" -> only elevators', SC.search("ascensor").every((r) => r.type === "elevator"));
check(
  '"servicio al cliente" -> customer service first',
  SC.search("servicio al cliente")[0]?.type === "customer_service"
);

// ---- 3. ATMs (type "atm") ----
const atmEntries = servicesData.services.filter((s) => s.type === "atm");
check("catalog has 15 ATM entries", atmEntries.length === 15, `got ${atmEntries.length}`);
check(
  "every ATM has its own placeId, no placeIdNote (WC-eligible)",
  atmEntries.every((s) => s.mapvx?.placeId && !s.mapvx.placeIdNote) &&
    new Set(atmEntries.map((s) => s.mapvx.placeId)).size === atmEntries.length
);
check("ATM ids are unique", new Set(atmEntries.map((s) => s.id)).size === atmEntries.length);

const ATM_QUERIES = [
  "cajero", "cajeros", "cajero automático", "cajeros automaticos", "un cajero", "dónde hay un cajero",
  "quiero sacar plata", "necesito retirar dinero", "cajro",
  "atm", "ATM", "atms", "where is the atm", "cash machine", "cash point", "withdraw cash",
  "caixa eletrônico", "caixa automatico", "onde tem um caixa eletrônico", "preciso sacar dinheiro",
];
ATM_QUERIES.forEach((q) => {
  const r = SC.search(q);
  check(
    `atm      "${q}" -> all ATMs only`,
    SC.looksLikeAtmQuery(q) && SC.looksLikeServicesQuery(q) && r.length === atmEntries.length && r.every((x) => x.type === "atm"),
    `got ${r.length} [${[...new Set(r.map((x) => x.type))].join(",")}]`
  );
});
const atmN2 = SC.search("cajero nivel 2");
check(
  '"cajero nivel 2" -> only the 3 ATMs on floor 2',
  atmN2.length === 3 && atmN2.every((r) => r.type === "atm" && r.floors.includes("2")),
  `got ${atmN2.length}`
);
const atmPb = SC.search("atm planta baja");
check(
  '"atm planta baja" -> only PB ATMs',
  atmPb.length === 3 && atmPb.every((r) => r.floors.includes("PB")),
  `got ${atmPb.length}`
);
// Like bathrooms: from a totem, only that floor's ATMs (a floor with none shows all).
const expectedOnFloor = { PB: 3, 1: 3, 2: 3, 3: 2, 4: 2, 5: 2 };
for (const [floor, n] of Object.entries(expectedOnFloor)) {
  const r = SC.search("cajero", { preferFloor: floor });
  check(
    `totem on ${floor}: only that floor's ${n} ATMs`,
    r.length === n && r.every((x) => x.type === "atm" && x.floors.includes(floor)),
    `got ${r.length} [${[...new Set(r.map((x) => x.floors.join()))].join("/")}]`
  );
}
check(
  "totem on a floor without ATMs (6): falls back to all 15",
  SC.search("cajero", { preferFloor: "6" }).length === 15
);
check(
  'explicit floor in the query wins over the totem floor ("cajero nivel 4" from N1)',
  (() => {
    const r = SC.search("cajero nivel 4", { preferFloor: "1" });
    return r.length === 2 && r.every((x) => x.floors.includes("4"));
  })()
);
check(
  "ATM card carries placeId for the WC map",
  SC.search("cajero", { preferFloor: "3" }).every((r) => r.placeId && !r.placeIdNote)
);
check(
  "generic listing still shows every ATM whatever the totem floor",
  SC.search("servicios del mall", { preferFloor: "1" }).filter((r) => r.type === "atm").length === 15
);
["cajera", "cajeras", "caja", "la cajera", "cajón"].forEach((q) =>
  check(`not atm   "${q}"`, !SC.looksLikeAtmQuery(q))
);
// No store / brand name in the market catalog may read as an ATM ask.
const marketData = JSON.parse(readFileSync(resolve(sima, "data/market-catalog.json"), "utf8"));
const brandHits = [...new Set(marketData.map((i) => i.brand_name))].filter((b) => b && SC.looksLikeAtmQuery(b));
check("no store brand name is mistaken for an ATM query", brandHits.length === 0, brandHits.join("|"));

// Generic listing now includes the ATMs too (still EVERY catalog service).
const allNow = SC.search("servicios del mall");
check(
  `"servicios del mall" -> all ${servicesData.services.length} services incl. 15 ATMs`,
  allNow.length === servicesData.services.length && allNow.filter((r) => r.type === "atm").length === 15,
  `got ${allNow.length}`
);
// Other intents must not pull ATMs in.
["baños", "ascensor", "servicio al cliente", "cowork", "mudador"].forEach((q) =>
  check(`"${q}" -> no ATMs`, !SC.search(q).some((r) => r.type === "atm"))
);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
