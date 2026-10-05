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
// Stores that give a service (store_service) only answer specific asks; the full
// "servicios del mall" listing is the mall's own services.
const mallServices = servicesData.services.filter((s) => s.type !== "store_service");

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
  `"servicios del mall" returns all ${mallServices.length} catalog services`,
  all.length === mallServices.length,
  `got ${all.length}`
);
const types = new Set(all.map((r) => r.type));
const catalogTypes = new Set(mallServices.map((s) => s.type));
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
  `"servicios del mall" -> all ${mallServices.length} services incl. 15 ATMs`,
  allNow.length === mallServices.length && allNow.filter((r) => r.type === "atm").length === 15,
  `got ${allNow.length}`
);
// Other intents must not pull ATMs in.
["baños", "ascensor", "servicio al cliente", "cowork", "mudador"].forEach((q) =>
  check(`"${q}" -> no ATMs`, !SC.search(q).some((r) => r.type === "atm"))
);

// ---- 4. MapVX "Servicios" points (bike, stage, plaza, exits, taxis…) ----
const EXTRA = {
  bike: { n: 1, q: ["bicicletero", "bike costanera", "donde dejo mi bicicleta", "bike rack", "bicycle parking"] },
  stage: { n: 1, q: ["escenario", "stage"] },
  civil_registry: { n: 1, q: ["registro civil", "renovar carnet", "civil registry"] },
  central_plaza: { n: 1, q: ["plaza central", "central plaza", "praça central"] },
  playground: { n: 1, q: ["plaza de juegos", "juegos infantiles", "playground", "parque infantil"] },
  mall_exit: { n: 4, q: ["salidas", "salida", "exits", "saídas do shopping", "salir del mall"] },
  parking_exit: { n: 4, q: ["salida estacionamiento", "rampa de autos", "rampa a estacionamientos", "parking exit", "salida al estacionamiento", "estacionamiento salida"] },
  electric_taxi: { n: 1, q: ["taxis electricos", "electric taxi", "parada de taxis"] },
  parking_kit: { n: 1, q: ["kit de servicios parking", "parking kit", "kit parking"] },
};
for (const [type, { n, q }] of Object.entries(EXTRA)) {
  const entries = servicesData.services.filter((s) => s.type === type);
  check(`catalog has ${n} "${type}" entries`, entries.length === n, `got ${entries.length}`);
  check(
    `"${type}" entries are WC-eligible (placeId, no placeIdNote, no coordinates)`,
    entries.every((s) => s.mapvx?.placeId && !s.mapvx.placeIdNote && s.mapvx.lat == null)
  );
  q.forEach((query) => {
    const r = SC.search(query);
    check(
      `${type.padEnd(14)} "${query}" -> all ${n} of its type, nothing else`,
      SC.looksLikeServicesQuery(query) && SC.extraTypeFromQuery(query) === type && r.length === n && r.every((x) => x.type === type),
      `intent=${SC.extraTypeFromQuery(query) || "-"} got ${r.length} [${[...new Set(r.map((x) => x.type))].join(",")}]`
    );
  });
}
// Exits / ramps live on several levels: totem floor ranks first, none are hidden.
const exitsN2 = SC.search("salidas", { preferFloor: "2" });
check(
  "exits from a totem on N2: all 4 listed, the N2 one first",
  exitsN2.length === 4 && exitsN2[0].floors.includes("2"),
  exitsN2.map((r) => r.floors.join()).join("|")
);
check(
  "parking exits from a totem on N2: all 4 listed (none on N2)",
  SC.search("salida estacionamiento", { preferFloor: "2" }).length === 4
);
// Not part of this catalog / owned by another flow.
["salida de emergencia", "salidas de emergencia", "emergency exit", "taxi", "plaza", "estacionamiento", "zara", "adidas", "farmacia"].forEach((q) =>
  check(`no extra intent "${q}"`, !SC.extraTypeFromQuery(q))
);
// No store / brand name in the market catalog may read as one of these asks.
const extraBrandHits = [...new Set(marketData.map((i) => i.brand_name))].filter((b) => b && SC.looksLikeExtraServiceQuery(b));
check("no store brand name is mistaken for an extra-service query", extraBrandHits.length === 0, extraBrandHits.join("|"));
// The second N5 restroom block sits next to the patio de comidas one.
const n5 = SC.search("baños nivel 5");
check(
  '"baños nivel 5" -> both N5 restroom blocks',
  n5.length === 2 && n5.every((r) => r.type === "bathroom" && r.floors.includes("5") && r.placeId),
  n5.map((r) => r.id).join("|")
);
check(
  '"baños" -> 10 restrooms, none lost to the new entry',
  SC.search("baños").filter((r) => r.type === "bathroom").length === 10 && SC.search("baños").length === 10
);
// Other intents must not pull the new types in.
["baños", "ascensor", "servicio al cliente", "cowork", "mudador", "cajero", "lactancia"].forEach((q) =>
  check(`"${q}" -> no extra types`, !SC.search(q).some((r) => Object.keys(EXTRA).includes(r.type)))
);

// ---- 5. Cowork on two levels (N2 + N4) ----
const coworks = servicesData.services.filter((s) => s.type === "cowork");
check("catalog has 2 cowork entries (N2, N4)", coworks.length === 2 && coworks.some((s) => s.floors.includes("4")), `got ${coworks.length}`);
check(
  "N4 cowork is WC-eligible (placeId, no placeIdNote, no coordinates)",
  coworks.filter((s) => s.floors.includes("4")).every((s) => s.mapvx?.placeId && !s.mapvx.placeIdNote && s.mapvx.lat == null)
);
["cowork", "coworking", "co-work", "espacio de trabajo", "workspace"].forEach((q) => {
  const r = SC.search(q);
  check(`cowork   "${q}" -> both levels, cowork only`, r.length === 2 && r.every((x) => x.type === "cowork"), `got ${r.length}`);
});
check('"cowork nivel 4" -> only the N4 one', (() => { const r = SC.search("cowork nivel 4"); return r.length === 1 && r[0].floors.includes("4"); })());
check("totem on N4: its own cowork", (() => { const r = SC.search("cowork", { preferFloor: "4" }); return r.length === 1 && r[0].floors.includes("4"); })());
check("totem on N2: its own cowork", (() => { const r = SC.search("cowork", { preferFloor: "2" }); return r.length === 1 && r[0].floors.includes("2"); })());
check("totem on N3 (no cowork): both listed", SC.search("cowork", { preferFloor: "3" }).length === 2);

check(
  "N4 cowork is anchored to Paris (CC_N4_1200); '\"cowork paris\"' finds it",
  (() => {
    const n4 = coworks.find((s) => s.floors.includes("4"));
    const r = SC.search("cowork paris");
    return n4?.anchorStores?.[0]?.local === "CC_N4_1200" && r.length === 1 && r[0].floors.includes("4") && r[0].anchorLocal === "CC_N4_1200";
  })()
);

// ---- 7. Stores that give a service (store_service), derived from the market catalog ----
const { buildEntries } = await import("./build-store-services.mjs");
const generatedNow = buildEntries(marketData);
const generatedInCatalog = servicesData.services.filter((s) => s.source === "market-catalog");
check(
  "store_service entries are up to date with market-catalog.json (else: node tools/build-store-services.mjs)",
  JSON.stringify(generatedNow) === JSON.stringify(generatedInCatalog),
  `catalog ${generatedInCatalog.length} vs market ${generatedNow.length}`
);
check("every store_service entry is generated (none hand-typed)", servicesData.services.filter((s) => s.type === "store_service").every((s) => s.source === "market-catalog"));
check(
  "store_service entries are WC-eligible: placeId = the store's local, anchored to it, no coordinates",
  generatedInCatalog.every((s) => s.mapvx?.placeId && s.mapvx.placeId === s.anchorStores?.[0]?.local && s.mapvx.lat == null && !s.mapvx.placeIdNote)
);
check("store_service ids are unique", new Set(generatedInCatalog.map((s) => s.id)).size === generatedInCatalog.length);

const brandsFor = (query, opts) => SC.search(query, opts).filter((r) => r.type === "store_service").map((r) => r.name.replace(/ [(].*$/, ""));
const sameSet = (a, b) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
const STORE_CASES = [
  ["servicio técnico", ["Claro", "Entel", "Longines", "Mecánica del Tiempo", "Movistar", "VTR"]],
  ["reparación", ["Claro", "Entel", "Longines", "Mecánica del Tiempo", "Movistar", "VTR"]],
  ["dónde arreglo mi reloj", ["Longines", "Mecánica del Tiempo"]],
  ["reparar reloj", ["Longines", "Mecánica del Tiempo"]],
  ["repair watch", ["Longines", "Mecánica del Tiempo"]],
  ["conserto de relógio", ["Longines", "Mecánica del Tiempo"]],
  ["reparar celular", ["Claro", "Entel", "Movistar", "VTR"]],
  ["repair my phone", ["Claro", "Entel", "Movistar", "VTR"]],
  ["assistência técnica celular", ["Claro", "Entel", "Movistar", "VTR"]],
  ["servicio técnico Claro", ["Claro"]],
  ["servicio técnico nivel 2", ["Longines"]],
  ["servicio técnico planta baja", ["Claro", "Entel", "Mecánica del Tiempo", "Movistar", "VTR"]],
];
STORE_CASES.forEach(([query, expected]) => {
  const got = brandsFor(query);
  check(`store svc "${query}" -> ${expected.join(", ")}`, SC.looksLikeServicesQuery(query) && sameSet(got, expected), got.join(", ") || "(none)");
});
// Asking for something no store repairs is an honest empty answer, never "everything".
["arreglos de ropa", "reparar zapatos", "reparar bicicleta", "reparación de autos"].forEach((query) =>
  check(`store svc "${query}" -> no results (no store repairs that)`, SC.search(query).length === 0, `got ${SC.search(query).length}`)
);
check('"arreglo de flores" is not a repair ask', !SC.extraTypeFromQuery("arreglo de flores") && brandsFor("arreglo de flores").length === 0);
check("generic listing never includes store_service", !SC.search("servicios del mall").some((r) => r.type === "store_service"));
["servicios", "baños", "ascensor", "cajero", "cowork", "servicio al cliente", "lactancia", "mudador", "salidas", "bicicletero"].forEach((query) =>
  check(`"${query}" -> no store_service`, !SC.search(query).some((r) => r.type === "store_service"))
);
check("store_service card carries placeId for the WC map", SC.search("servicio técnico").every((r) => r.placeId && /^CC_/.test(r.placeId)));
check(
  "store_service from a totem on N2: still lists every store, N2 first",
  (() => { const r = SC.search("servicio técnico", { preferFloor: "2" }); return r.length === 7 && r[0].floors.includes("2"); })()
);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
