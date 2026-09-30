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

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
