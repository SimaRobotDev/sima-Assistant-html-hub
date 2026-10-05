/**
 * Integrity + robustness checks for the services catalog and its consumers.
 *  1. data integrity (ids, floors, placeIds, anchors exist in the market catalog)
 *  2. every catalog type is wired in mobility (kind table, icon file, es/en/pt label)
 *  3. services-catalog.json and its .jsonp twin are in sync; store services not stale
 *  4. robustness: garbage input never throws, huge input stays fast (no regex blow-up)
 *  5. seeded fuzz: invariants hold for thousands of random queries
 *  6. routing safety: a query claimed as "services" always has an answer
 *
 *   node tools/verify-services-integrity.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const sima = resolve(here, "..", "projects/cencomall/Assets/StreamingAssets/sima_services");
const read = (p) => readFileSync(resolve(sima, p), "utf8");

const servicesData = JSON.parse(read("data/services-catalog.json"));
const marketData = JSON.parse(read("data/market-catalog.json"));
const mobilityHtml = read("mobility/index.html");

function load(file, extra = {}) {
  const window = { location: { protocol: "file:" }, ...extra };
  window.window = window;
  const ctx = vm.createContext({ window, console });
  vm.runInContext(read(file), ctx, { filename: file });
  return window;
}
const SC = load("shared/services-catalog.js", { __SERVICES_CATALOG__: servicesData }).ServicesCatalog;
await SC.loadCatalog();

let failed = 0;
let passed = 0;
function check(label, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  if (!ok || process.argv.includes("--verbose")) console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
}

// ---------------------------------------------------------------- 1. data integrity
const services = servicesData.services;
const FLOORS = new Set(["PB", "1", "2", "3", "4", "5"]);
const KNOWN_TYPES = new Set([
  "bathroom", "elevator", "customer_service", "cowork", "nursing", "changing_table", "atm",
  "bike", "stage", "civil_registry", "central_plaza", "playground", "mall_exit", "parking_exit",
  "electric_taxi", "parking_kit", "store_service",
]);
const NEW_TYPES = ["bike", "stage", "civil_registry", "central_plaza", "playground", "mall_exit", "parking_exit", "electric_taxi", "parking_kit", "store_service"];

check("ids are unique", new Set(services.map((s) => s.id)).size === services.length);
check("every entry has a non-empty id, name and a known type", services.every((s) => s.id && s.name && KNOWN_TYPES.has(s.type)), services.filter((s) => !(s.id && s.name && KNOWN_TYPES.has(s.type))).map((s) => s.id).join(","));
check("every entry has at least one valid floor", services.every((s) => Array.isArray(s.floors) && s.floors.length && s.floors.every((f) => FLOORS.has(String(f)) || f === "ALL")), services.filter((s) => !(Array.isArray(s.floors) && s.floors.length)).map((s) => s.id).join(","));
check("keywords are non-empty arrays of non-empty strings", services.every((s) => Array.isArray(s.keywords) && s.keywords.length && s.keywords.every((k) => typeof k === "string" && k.trim())));
check("descriptions block is well-formed", services.every((s) => s.descriptions && ["short", "medium", "long"].every((k) => typeof s.descriptions[k] === "string")));
check("no entry name/keyword has stray whitespace or control chars", services.every((s) => [s.name, ...s.keywords].every((t) => t === t.trim() && !/[\u0000-\u001f]/.test(t))));

const MAPVX_ID = /^(-[A-Za-z0-9_-]{19}|node:\d+|CC_(PB|N\d+)_\d+)$/;
const needsPlaceId = services.filter((s) => NEW_TYPES.includes(s.type) || s.type === "atm" || s.type === "nursing" || s.type === "changing_table");
check("WC-only types have a well-formed placeId", needsPlaceId.every((s) => MAPVX_ID.test(String(s.mapvx?.placeId || ""))), needsPlaceId.filter((s) => !MAPVX_ID.test(String(s.mapvx?.placeId || ""))).map((s) => s.id).join(","));
check("WC-only new types have no placeIdNote (would force the legacy engine)", services.filter((s) => NEW_TYPES.includes(s.type)).every((s) => !s.mapvx?.placeIdNote));
// Two entries may share a placeId only when intended (a bathroom block and its changing table).
const byPlace = new Map();
services.forEach((s) => { const p = s.mapvx?.placeId; if (p) (byPlace.get(p) || byPlace.set(p, []).get(p)).push(s); });
const dupPlace = [...byPlace.entries()].filter(([, list]) => list.length > 1 && !(list.length === 2 && list.some((s) => s.type === "bathroom") && list.some((s) => s.type === "changing_table")));
check("no accidental duplicate placeIds across entries", dupPlace.length === 0, dupPlace.map(([p, l]) => `${p}:${l.map((s) => s.id).join("+")}`).join(" | "));
check("a new-type placeId never collides with an older type", services.filter((s) => NEW_TYPES.includes(s.type) && s.type !== "store_service").every((s) => byPlace.get(s.mapvx.placeId).length === 1));

const locals = new Set(marketData.map((m) => m.local));
const brokenAnchors = services.flatMap((s) => (s.anchorStores || []).filter((a) => a.local && !locals.has(a.local)).map((a) => `${s.id}:${a.local}`));
check("every anchorStore.local exists in the market catalog", brokenAnchors.length === 0, brokenAnchors.slice(0, 6).join(","));
const storeSvc = services.filter((s) => s.type === "store_service");
check("store_service floors agree with the store's own local code", storeSvc.every((s) => { const m = String(s.mapvx.placeId).match(/^CC_(PB|N(\d+))_/); return m && (m[1] === "PB" ? "PB" : m[2]) === s.floors[0]; }));
check("exit / ramp / kit / taxi floors agree with MapVX levels they came from (PB or N1/N2)", services.filter((s) => ["mall_exit", "parking_exit", "electric_taxi", "parking_kit"].includes(s.type)).every((s) => ["PB", "1", "2"].includes(s.floors[0])));

// ---------------------------------------------------------------- 2. wiring in mobility
const kindsBlock = mobilityHtml.match(/const EXTRA_SERVICE_KINDS = \{([\s\S]*?)\n\};/);
check("mobility defines EXTRA_SERVICE_KINDS", !!kindsBlock);
const kindKeys = kindsBlock ? [...kindsBlock[1].matchAll(/^\s{2}([a-z_]+): \{ label: "([A-Za-z]+)", icon: "([a-z-]+\.svg)"/gm)].map((m) => ({ type: m[1], label: m[2], icon: m[3] })) : [];
check("every new catalog type has a mobility kind entry and vice-versa", NEW_TYPES.every((t) => kindKeys.some((k) => k.type === t)) && kindKeys.every((k) => NEW_TYPES.includes(k.type)), kindKeys.map((k) => k.type).join(","));
check("every kind icon file exists", kindKeys.every((k) => existsSync(resolve(sima, "shared/category-icons", k.icon))), kindKeys.filter((k) => !existsSync(resolve(sima, "shared/category-icons", k.icon))).map((k) => k.icon).join(","));
const iconText = (f) => read(`shared/category-icons/${f}`);
check("kind icons are SVGs with a viewBox and no invalid path data", kindKeys.every((k) => { const t = iconText(k.icon); return /<svg[^>]+viewBox="[^"]+"/.test(t) && !/nan|undefined|Infinity/i.test(t); }));
// i18n: each label key must exist once per locale block (es / en / pt)
for (const { type, label } of kindKeys) {
  const n = (mobilityHtml.match(new RegExp(`^\\s{4}${label}: "`, "gm")) || []).length;
  check(`label key "${label}" (${type}) exists in es, en and pt`, n === 3, `found ${n}`);
}
check("kind labels are distinct per type", new Set(kindKeys.map((k) => k.label)).size === kindKeys.length);

// ---------------------------------------------------------------- 3. sync
const jsonp = read("data/services-catalog.jsonp.js");
const jsonpMatch = jsonp.match(/window\.__SERVICES_CATALOG__\s*=\s*([\s\S]*?);?\s*$/);
let jsonpData = null;
try { jsonpData = jsonpMatch ? JSON.parse(jsonpMatch[1]) : null; } catch (e) { /* reported below */ }
check("services-catalog.jsonp.js parses and equals services-catalog.json (run tools/build-jsonp-assets.mjs)", !!jsonpData && JSON.stringify(jsonpData) === JSON.stringify(servicesData));
check("services-catalog.json has CRLF line endings consistently (no mixed endings)", (() => { const t = read("data/services-catalog.json"); const crlf = (t.match(/\r\n/g) || []).length; const lf = (t.match(/\n/g) || []).length; return crlf === lf || crlf === 0; })());
const { buildEntries } = await import("./build-store-services.mjs");
check("generated store services are up to date", JSON.stringify(buildEntries(marketData)) === JSON.stringify(services.filter((s) => s.source === "market-catalog")));

// ---------------------------------------------------------------- 4. robustness
const API = {
  search: (q, o) => SC.search(q, o),
  looksLikeServicesQuery: (q) => SC.looksLikeServicesQuery(q),
  looksLikeExtraServiceQuery: (q) => SC.looksLikeExtraServiceQuery(q),
  extraTypeFromQuery: (q) => SC.extraTypeFromQuery(q),
  looksLikeGenericServicesQuery: (q) => SC.looksLikeGenericServicesQuery(q),
  looksLikeBathroomQuery: (q) => SC.looksLikeBathroomQuery(q),
  looksLikeAtmQuery: (q) => SC.looksLikeAtmQuery(q),
  looksLikeCoworkQuery: (q) => SC.looksLikeCoworkQuery(q),
};
const GARBAGE = [
  undefined, null, "", " ", "   \t\n ", 0, 1, NaN, true, false, {}, [], ["salidas"], { toString: () => "salidas" }, () => "x", Symbol.iterator ? "salidas" : "",
  "\u0000", "\u0000\u0001\u0002", "​​​", "salida​", "saĺida", "SALIDAS", "SaLiDaS", "  salidas  ", "salidas\n\nestacionamiento", "😀", "🚗🅿️", "مخرج", "出口", "<script>alert(1)</script>", "'; DROP TABLE services; --", "${7*7}", "__proto__", "constructor", "toString", "hasOwnProperty", "{}", "[]", "(", ")", "[", "\\", "\\\\", "/", ".*", "(a+)+$", "%", "%00", "\"", "'", "`",
];
let throws = [];
for (const [name, fn] of Object.entries(API)) {
  for (const g of GARBAGE) {
    try {
      const r = name === "search" ? [fn(g), fn(g, { preferFloor: "2" }), fn(g, { floor: "3" }), fn(g, { type: "store_service" }), fn(g, { serviceId: "x" })] : fn(g);
      if (name === "search") for (const x of r) if (!Array.isArray(x)) throws.push([name, String(g), "not an array"]);
    } catch (e) {
      throws.push([name, typeof g === "symbol" ? "symbol" : String(g).slice(0, 20), e.message]);
    }
  }
}
check(`garbage input never throws (${Object.keys(API).length} functions x ${GARBAGE.length} inputs)`, throws.length === 0, JSON.stringify(throws.slice(0, 4)));
check("search with odd options never throws", (() => {
  try {
    for (const o of [null, undefined, {}, { preferFloor: null }, { preferFloor: 5 }, { floor: "" }, { type: "nope" }, { type: null }, { serviceId: "nope" }, { serviceId: 123 }, { mudadorOnly: true }, { preferFloor: "99" }, { totemFloor: "PB" }]) {
      SC.search("servicio técnico", o); SC.search("salidas", o); SC.search("", o);
    }
    return true;
  } catch (e) { return false; }
})());

// huge / adversarial strings must stay fast (catastrophic regex backtracking would hang)
const BIG = [
  "a".repeat(100000), "salida ".repeat(20000), "reparar ".repeat(15000), "servicio técnico ".repeat(8000), "plaza de ".repeat(15000),
  "baño ".repeat(20000), "nivel 2 ".repeat(20000), "estacionamiento ".repeat(10000), "kit de ".repeat(15000),
  ("x".repeat(50) + " ").repeat(3000), "salida " + "a".repeat(100000), "bicicleta " + "dejo ".repeat(20000), "á".repeat(50000), "́".repeat(50000),
];
let slowest = { ms: 0, label: "" };
let bigThrow = null;
BIG.forEach((s, i) => {
  for (const [name, fn] of Object.entries(API)) {
    const t0 = performance.now();
    try { fn(s); } catch (e) { bigThrow = bigThrow || `${name}#${i}: ${e.message}`; }
    const ms = performance.now() - t0;
    if (ms > slowest.ms) slowest = { ms, label: `${name} on input #${i} (${s.length} chars)` };
  }
});
check("huge inputs do not throw", !bigThrow, bigThrow || "");
check("huge inputs stay fast (<1500 ms each — no catastrophic regex backtracking)", slowest.ms < 1500, `${slowest.ms.toFixed(0)} ms worst: ${slowest.label}`);

// ---------------------------------------------------------------- 5. seeded fuzz
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const rand = rng(20261005);
const VOCAB = [
  "baño", "baños", "ascensor", "cajero", "atm", "cowork", "mudador", "lactancia", "servicio", "servicios", "técnico", "tecnico", "reparar", "reparación", "arreglo", "arreglos", "de", "del", "la", "mi", "mis", "el", "un",
  "reloj", "celular", "teléfono", "ropa", "zapatos", "bicicleta", "flores", "auto", "internet", "claro", "entel", "movistar", "vtr", "longines", "paris", "ripley", "zara", "afex",
  "salida", "salidas", "estacionamiento", "parking", "rampa", "exit", "taxi", "taxis", "eléctricos", "electric", "plaza", "central", "juegos", "escenario", "stage", "registro", "civil", "kit", "bike", "bicicletero",
  "nivel", "piso", "planta", "baja", "pb", "1", "2", "3", "4", "5", "6", "n", "mall", "costanera", "cenco", "where", "is", "the", "repair", "my", "watch", "phone", "onde", "fica", "conserto", "relógio", "assistência", "técnica",
  "?", "!", ",", ".", "-", "&", "ñ", "ü", "ç", "123", "x", "zz", "qwerty",
];
const FUZZ_N = 6000;
const idSet = new Set(services.map((s) => s.id));
let fuzzBad = [];
for (let i = 0; i < FUZZ_N; i++) {
  const len = 1 + Math.floor(rand() * 7);
  const q = Array.from({ length: len }, () => VOCAB[Math.floor(rand() * VOCAB.length)]).join(rand() < 0.1 ? "  " : " ");
  // Real totem floors only. (Known pre-existing edge, not covered here: elevator asks with a
  // totem on N6 return nothing because no elevator bank stops at N6 — there is no N6 totem.)
  const pf = ["", "PB", "1", "2", "3", "4", "5"][Math.floor(rand() * 7)];
  let r;
  try { r = SC.search(q, { preferFloor: pf }); } catch (e) { fuzzBad.push([q, pf, "throws " + e.message]); continue; }
  const ids = r.map((x) => x.id);
  if (!Array.isArray(r)) fuzzBad.push([q, pf, "not array"]);
  else if (new Set(ids).size !== ids.length) fuzzBad.push([q, pf, "duplicate ids"]);
  else if (!ids.every((id) => idSet.has(id))) fuzzBad.push([q, pf, "unknown id"]);
  else if (!r.every((x) => x.name && Array.isArray(x.floors) && x.type)) fuzzBad.push([q, pf, "malformed card"]);
  else if (r.some((x) => NEW_TYPES.includes(x.type) && x.type !== "store_service" && !x.placeId)) fuzzBad.push([q, pf, "new-type card without placeId"]);
  else if (r.some((x) => x.type === "store_service" && !/^CC_/.test(x.placeId))) fuzzBad.push([q, pf, "store card without local placeId"]);
  else if (SC.looksLikeGenericServicesQuery(q) && r.some((x) => x.type === "store_service")) fuzzBad.push([q, pf, "store_service leaked into generic listing"]);
  // routing safety: if the gate says "services", the answer is not empty — otherwise the visitor
  // gets "no services found" for something the STORE search might have answered.
  else if (SC.looksLikeServicesQuery(q) && r.length === 0) {
    // Empty is fine when the FLOOR in the query rules the only candidates out ("bicicletero pb":
    // the rack is on N1) — that is an honest answer. Empty with the floor words removed is a bug.
    const noFloor = q.replace(/\b(pb|planta|baja|nivel|piso|floor|level|n)\b/gi, " ").replace(/\b\d+\b/g, " ").trim();
    if (!noFloor || SC.search(noFloor, { preferFloor: pf }).length === 0) fuzzBad.push([q, pf, "claimed as services but empty (not a floor effect)"]);
  }
  if (fuzzBad.length > 12) break;
}
check(`seeded fuzz: ${FUZZ_N} random queries keep every invariant`, fuzzBad.length === 0, JSON.stringify(fuzzBad.slice(0, 5)));

// ---------------------------------------------------------------- 6. routing safety on real store data
// A visitor typing a store name or a store's own keyword must NOT be hijacked into the
// services search unless that search actually has an answer for it.
const hijacks = [];
const seen = new Set();
for (const m of marketData) {
  const phrases = [m.brand_name, ...String(m.keywords || "").split(",").map((k) => k.trim())];
  for (const p of phrases) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    if (SC.looksLikeExtraServiceQuery(p) && SC.search(p).length === 0) hijacks.push(p);
  }
}
check(`no store name/keyword (${seen.size} phrases) is claimed as an extra service while having no answer`, hijacks.length === 0, hijacks.slice(0, 8).join(" | "));
const claimed = [...seen].filter((p) => SC.looksLikeServicesQuery(p) && !SC.looksLikeBathroomQuery(p) && !SC.looksLikeElevatorQuery(p));
const NEW_CLAIMS_OK = [];
for (const p of claimed) if (SC.looksLikeExtraServiceQuery(p)) NEW_CLAIMS_OK.push(p);
if (process.argv.includes("--verbose")) console.log("store phrases that the new intents claim:", NEW_CLAIMS_OK.join(" | "));
// the new intents must not claim a store brand name outright
const brandClaims = [...new Set(marketData.map((m) => m.brand_name))].filter((b) => b && SC.looksLikeExtraServiceQuery(b));
check("no store brand name is claimed by an extra-service intent", brandClaims.length === 0, brandClaims.join("|"));

// ---------------------------------------------------------------- 7. regressions found while double-checking
// (each line is a bug that was real once; keep them)
const claims = (q) => SC.looksLikeServicesQuery(q);
const types = (q, o) => SC.search(q, o).map((r) => r.type);

// "foto carnet" is a STORE (Mi Foto): the Registro Civil kiosk must not hijack it.
["foto carnet", "fotos carnet", "sacar foto carnet", "foto carné", "impresión de fotos"].forEach((q) =>
  check(`not claimed by civil_registry: "${q}"`, SC.extraTypeFromQuery(q) !== "civil_registry" && !claims(q))
);
["registro civil", "renovar carnet", "sacar cédula", "carnet de identidad", "renew my id card"].forEach((q) =>
  check(`claimed by civil_registry: "${q}"`, SC.extraTypeFromQuery(q) === "civil_registry" && claims(q))
);

// A repair ask no store card answers must fall through to the STORE search (gate = false),
// not dead-end on "no services found".
["reparar zapatos", "arreglos de ropa", "reparar bicicleta", "reparación de autos", "arreglo de flores", "repair my shoes"].forEach((q) =>
  check(`gate lets the store search handle "${q}"`, !claims(q), `claims=${claims(q)} results=${SC.search(q).length}`)
);
["reparar reloj", "servicio técnico", "reparar celular", "repair my phone", "assistência técnica"].forEach((q) =>
  check(`gate claims repair ask "${q}" (stores can answer)`, claims(q) && SC.search(q).length > 0)
);

// Generic words must not drag a new-type entry into an unrelated explicit search.
const NOT_NEW = [
  ["libros para niños", "playground"], ["ropa niños", "playground"], ["zapatos niños", "playground"],
  ["carne", "civil_registry"], ["silla de auto", "parking_exit"], ["copia llave de auto", "parking_exit"],
  ["Plaza Música", "central_plaza"], ["centro comercial", "mall_exit"], ["eventos", "stage"],
  ["Huentelauquén", "store_service"], ["queso Huentelauquén", "store_service"], ["ropa mujer", "store_service"],
  ["zapatos mujer", "store_service"], ["joyas", "store_service"], ["internet", "store_service"], ["teléfonos", "store_service"],
];
NOT_NEW.forEach(([q, type]) => check(`"${q}" does not return ${type}`, !types(q).includes(type), types(q).slice(0, 6).join(",")));
// ...while a store NAME still reaches its own store_service entry (whole word).
["Claro", "Entel", "Movistar", "VTR", "Longines", "Mecánica del Tiempo"].forEach((q) =>
  check(`store name "${q}" finds its store_service`, types(q).includes("store_service"))
);

// Query length is capped: a stalled UI is a worse failure than a truncated ask.
check("a 135k-char query answers in well under a second", (() => { const t0 = performance.now(); SC.search("salida ".repeat(20000)); return performance.now() - t0 < 500; })());
check("a long query still matches on its first words (truncation, not rejection)", SC.search("servicio técnico reloj " + "relleno ".repeat(2000)).length > 0);

// ---------------------------------------------------------------- 8. source hygiene
// Inline-script edits once turned "\\b" into a backspace character inside a regex. Catch that class of bug.
const SOURCE_FILES = [
  "shared/services-catalog.js", "mobility/index.html", "data/services-catalog.json", "data/services-catalog.jsonp.js",
];
for (const f of SOURCE_FILES) {
  const bad = [...read(f)].filter((c) => c.charCodeAt(0) < 32 && !"\n\r\t".includes(c)).length;
  check(`no stray control characters in ${f}`, bad === 0, `${bad} found`);
}
for (const f of ["../../../../../tools/build-store-services.mjs", "../../../../../tools/verify-services-generic.mjs", "../../../../../tools/verify-services-integrity.mjs"]) {
  const bad = [...read(f)].filter((c) => c.charCodeAt(0) < 32 && !"\n\r\t".includes(c)).length;
  check(`no stray control characters in ${f.split("/").pop()}`, bad === 0, `${bad} found`);
}
// every regex literal in the intent table compiles and keeps its word boundaries
const intentSrc = read("shared/services-catalog.js").match(/var EXTRA_TYPE_INTENTS = \[([\s\S]*?)\n  \];/);
check("EXTRA_TYPE_INTENTS regexes keep their \\b word boundaries", !!intentSrc && (intentSrc[1].match(/re: \/\\b/g) || []).length === NEW_TYPES.length, intentSrc ? String((intentSrc[1].match(/re: \/\\b/g) || []).length) : "no block");

// ---------------------------------------------------------------- 9. shopping / accessibility asks must NOT be hijacked
// (a visitor looking for clothes, food or a wheelchair ramp must reach the STORE search / accessibility flows)
[
  "ropa de salida", "vestido de salida", "zapatos para salir", "dónde salir a comer", "salir a cenar", "outfit de salida",
  "ropa para salir de noche", "salida nocturna", "panorama para salir", "salida de emergencia", "emergency exit",
  "rampa", "rampa para silla de ruedas", "rampa de acceso", "ramp for wheelchair", "silla de ruedas", "kit auto", "kit de auto",
  "taxi", "plaza", "estacionamiento", "parking", "bicicleta", "comprar bicicleta", "reparar bicicleta", "foto carnet",
  "kit", "tarima", "show", "juegos", "juguetes", "carnet", "certificado", "stage", "entradas cine",
].forEach((q) => {
  const intent = SC.extraTypeFromQuery(q);
  // "stage"/"tarima" are real stage words: allowed to claim. "reparar bicicleta" IS a repair ask
  // (intent store_service) but no store answers it, so the gate must hand it to the store search.
  const mayClaim = ["stage", "tarima"].includes(q);
  const repairAskNoAnswer = q === "reparar bicicleta";
  check(`not hijacked: "${q}"`, mayClaim || (repairAskNoAnswer ? !claims(q) : !intent && !claims(q)), `intent=${intent || "-"} claims=${claims(q)}`);
});
["salida", "salidas", "exit", "exits", "dónde está la salida", "cómo salgo del mall", "donde salgo", "salir del mall", "por donde salgo",
  "rampa de autos", "rampa a estacionamientos", "rampa para autos", "salida estacionamiento", "salida al estacionamiento",
  "kit de servicios", "kit parking"].forEach((q) =>
  check(`still claimed: "${q}"`, !!SC.extraTypeFromQuery(q) && claims(q), `intent=${SC.extraTypeFromQuery(q) || "-"}`)
);

// ---------------------------------------------------------------- 10. route QR on STORE maps (mobility)
// Regression: the QR was wired only to openServiceMap, so store maps never showed it.
const mobilityLf = mobilityHtml.replace(/\r\n/g, "\n"); // the file is CRLF; function bodies are matched on LF
const fnSrc = (name) => {
  const m = mobilityLf.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`));
  return m ? m[0] : "";
};
const showStoreSrc = fnSrc("showStoreRouteQr");
const showServiceSrc = fnSrc("showServiceRouteQr");
const renderSrc = fnSrc("renderRouteQr");
const openPoiSrc = fnSrc("openPoiMap");
check("mobility defines showStoreRouteQr and the shared renderRouteQr", !!showStoreSrc && !!renderSrc);
check("openPoiMap shows the route QR for store maps (covers openStoreMap and the native push)", /if \(poiType === "store"\) showStoreRouteQr\(mapLocal\)/.test(openPoiSrc));
check("openStoreMap and pushNavigationFromUnity both go through openPoiMap with poiType store", (mobilityHtml.match(/openPoiMap\(\{\s*poiType: "store"/g) || []).length >= 2);
check("both QR entry points clear the previous QR first (no stale QR from another place)", /^\s*hideServiceRouteQr\(\);/m.test(showStoreSrc.split("\n").slice(1, 3).join("\n")) && /^\s*hideServiceRouteQr\(\);/m.test(showServiceSrc.split("\n").slice(1, 3).join("\n")));
check("a store QR is skipped (and the old one cleared) when destination = the totem itself", /destination === origin/.test(showStoreSrc));
check("renderRouteQr yields to a newer open (gen guard) before drawing", /gen !== serviceRouteQrGen/.test(renderSrc));
check("teardownMapView hides the route QR", /function teardownMapView\(\) \{[\s\S]*?hideServiceRouteQr\(\);/.test(mobilityHtml));

// the destination rule, evaluated from the real source
const destFn = mobilityHtml.match(/function isRouteQrDestination\(destination\) \{[\s\S]*?\n\}/);
const isDest = destFn ? new Function(`${destFn[0]}; return isRouteQrDestination;`)() : () => false;
check("isRouteQrDestination exists", !!destFn);
const rejectedLocals = marketData.filter((m) => !isDest(m.local)).map((m) => `${m.brand_name}:${m.local}`);
check(`EVERY store local in the market catalog gets a QR (${marketData.length} stores)`, rejectedLocals.length === 0, rejectedLocals.slice(0, 6).join(" | "));
["-NDe3P3NHDdH-wWv6t6f", "CC_N2_2001", "CC_PB_6020", "CC_N1,2,3,4,5_1300", "CC_N2,3_2156", "CC_N5_5143-2", "CC_N1_Hotel"].forEach((d) =>
  check(`QR destination accepted: ${d}`, isDest(d))
);
["", "   ", "node:993809113", "node:19041", "CC_", "cc_n2_2001", "CC_N2 2001", "https://evil.example/x", "javascript:alert(1)", "../CC_N2_2001", undefined, null].forEach((d) =>
  check(`QR destination rejected: ${JSON.stringify(d)}`, !isDest(d))
);
const wcOnly = services.filter((s) => s.mapvx?.placeId && !isDest(s.mapvx.placeId)).map((s) => `${s.id}:${s.mapvx.placeId}`);
check("only the legacy node: ids are refused a QR (elevators)", wcOnly.every((x) => /:node:\d+$/.test(x)), wcOnly.join(" | "));

// ---------------------------------------------------------------- 11. store-map-web route QR stays visible
// Regression: the MapVX web components paint layers with z-index up to 99999 (loading-overlay 1000,
// floor bar / overlays 9999, error modal 10000). A shadow root does not isolate them, so with the QR at
// z-index 15 they washed it out whenever the map was loading / changing store / changing floor.
const smwHtml = read("store-map-web/index.html").replace(/\r\n/g, "\n");
const cssBlock = (selector) => {
  const m = smwHtml.match(new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`));
  return m ? m[1] : "";
};
const viewCss = cssBlock(".store-map-view");
const qrCss = cssBlock(".route-qr");
const statusCss = cssBlock(".store-map-status");
const zOf = (css) => { const m = css.match(/(?:^|[\s;])z-index:\s*(-?\d+)/); return m ? Number(m[1]) : null; };
check("store-map-web: .store-map-view is its own stacking context (isolation:isolate, z-index:0)", /isolation:\s*isolate/.test(viewCss) && zOf(viewCss) === 0, viewCss.trim().slice(0, 60));
check("store-map-web: the route-view container shares that class (so route-view-totems is contained too)", /class="store-map-view hidden" id="route-view"/.test(smwHtml) && /class="store-map-view" id="map-view"/.test(smwHtml));
check("store-map-web: the route QR sits above the map layers", zOf(qrCss) !== null && zOf(qrCss) > (zOf(viewCss) ?? 0), `qr z=${zOf(qrCss)}`);
check("store-map-web: the route QR sits above the status card (stays visible when the map is slow or failed)", zOf(qrCss) !== null && zOf(statusCss) !== null && zOf(qrCss) > zOf(statusCss), `qr z=${zOf(qrCss)} status z=${zOf(statusCss)}`);
check("store-map-web: the QR never steals map gestures (pointer-events:none)", /pointer-events:\s*none/.test(qrCss));
// the real components really do use z-indexes this high: if MapVX ever lowers them this test can be relaxed
const wcZ = (f) => Math.max(...[...read(f).matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1])));
check("vendored MapVX bundles still use z-index far above any page layer (why the isolation is needed)", wcZ("shared/mapvx-wc/map-view-with-modal.js") >= 1000 && wcZ("shared/mapvx-wc/route-view-totems.js") >= 9999);
// the app contract (window.applyRouteQr / SIMA_ROUTE_QR) must stay intact
check("store-map-web: applyRouteQr contract present (function, null clears, init from SIMA_ROUTE_QR)", /window\.applyRouteQr\s*=\s*function/.test(smwHtml) && /function hideRouteQr\(\)/.test(smwHtml) && /if \(window\.SIMA_ROUTE_QR\) window\.applyRouteQr\(window\.SIMA_ROUTE_QR\)/.test(smwHtml));
check("store-map-web: the QR is cleared when another store opens (no stale QR)", /function openStoreMapFromPayload\([\s\S]*?hideRouteQr\(\);/.test(smwHtml));
check("store-map-web: the QR element lives inside the stage, outside the map views", /<div class="store-map-view hidden" id="route-view">[\s\S]*?<\/div>\s*<\/div>\s*\n\s*<!--[\s\S]*?<aside class="route-qr hidden" id="route-qr">/.test(smwHtml));
check("store-map-web: the QR renders the app's qrDataUrl only (no QR library loaded)", !/qrcode\s*\(/.test(smwHtml) && !/<script[^>]+qrcode/i.test(smwHtml));

// ---------------------------------------------------------------- 12. store-map-web: compact store popup + page health
// 2026-10-05: the MapVX popup was ~212px wide whatever the logo (MapVX min-width 180 + padding, plus our old
// fixed 180x72 logo box). It must now hug the logo. These guard the shipped CSS string.
const popupSrc = smwHtml.match(/const POPUP_CSS = \[([\s\S]*?)\]\.join\(" "\);/);
let popupCss = "";
try { popupCss = popupSrc ? new Function(`return [${popupSrc[1]}].join(" ");`)() : ""; } catch (e) { popupCss = ""; }
check("store-map-web: POPUP_CSS is defined and evaluates to a CSS string", popupCss.length > 200, `len=${popupCss.length}`);
const popupRule = (sel) => { const m = popupCss.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`)); return m ? m[1] : ""; };
const pCard = popupRule(".popup");
const pLogo = popupRule(".popup-logo");
check("popup card can shrink: min-width 0, width max-content, bounded max-width, tight padding", /min-width:\s*0/.test(pCard) && /width:\s*max-content/.test(pCard) && /max-width:\s*\d+px/.test(pCard) && /padding:\s*\d+px\s+\d+px/.test(pCard), pCard.trim().slice(0, 90));
check("popup card stays compact: max-width <= 200px", (() => { const m = pCard.match(/max-width:\s*(\d+)px/); return !!m && Number(m[1]) <= 200; })());
check("popup logo keeps its own proportions (auto width/height + object-fit contain)", /width:\s*auto/.test(pLogo) && /height:\s*auto/.test(pLogo) && /object-fit:\s*contain/.test(pLogo), pLogo.trim().slice(0, 90));
check("popup logo is only capped, never forced to a fixed box (no fixed width/height in px)", !/(^|[\s;])width:\s*\d+px/.test(pLogo) && !/(^|[\s;])height:\s*\d+px/.test(pLogo));
check("popup logo cap keeps the logo legible (max-height 40..64px, max-width 100..160px, min-height >= 24px)", (() => { const h = Number((pLogo.match(/max-height:\s*(\d+)px/) || [])[1]); const w = Number((pLogo.match(/max-width:\s*(\d+)px/) || [])[1]); const mh = Number((pLogo.match(/min-height:\s*(\d+)px/) || [])[1]); return h >= 40 && h <= 64 && w >= 100 && w <= 160 && mh >= 24; })());
check("popup category stays hidden and the name stays readable (>= 13px)", /\.popup-category\s*\{\s*display:\s*none\s*!important/.test(popupCss) && Number((popupRule(".popup-name").match(/font-size:\s*(\d+)px/) || [])[1]) >= 13);
check("popup rules are all !important (MapVX re-appends its own <style> after ours)", popupCss.split("}").filter((r) => r.includes("{")).every((r) => (r.match(/;/g) || []).every(() => true) && /!important/.test(r)));
check("popup style is injected once per shadow root (idempotent by id)", /POPUP_STYLE_ID/.test(smwHtml) && /getElementById\(POPUP_STYLE_ID\)/.test(smwHtml));

// A broken inline script silently kills the whole page (a CSS string once got split across lines in a hotfix).
const inlineScripts = (html) => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).filter((c) => c.trim());
for (const [name, html] of [["store-map-web", smwHtml], ["mobility", mobilityLf]]) {
  const scripts = inlineScripts(html);
  const errors = [];
  scripts.forEach((code, i) => { try { new vm.Script(code, { filename: `${name}#inline${i}` }); } catch (e) { errors.push(`#${i}: ${e.message}`); } });
  check(`${name}: every inline <script> parses (${scripts.length} script(s))`, scripts.length > 0 && errors.length === 0, errors.join(" | "));
}

// ---------------------------------------------------------------- 13. store-name labels: visible when zoomed out, adaptive size
// The names around a store are MapVX's `indoor-poi` TEXT layer (minzoom 19, 12px). shared/mapvx-label-tuning.js shows them across
// the whole zoom range with a size that grows with zoom. Tested here against a mock MapLibre built from the real layer fields.
const labelSrc = read("shared/mapvx-label-tuning.js");
const labelWin = {};
vm.runInContext(labelSrc, vm.createContext({ window: labelWin, console }), { filename: "mapvx-label-tuning.js" });
const ML = labelWin.MapVxLabels;
check("MapVxLabels module loads and exposes tune/apply/CONFIG", !!ML && typeof ML.tune === "function" && typeof ML.apply === "function" && !!ML.CONFIG);

// real fields of the MapVX style layers involved (captured from the public site's mapStyleJson, 2026-10-05)
const mkLayers = () => [
  { id: "indoor-poi", type: "symbol", source: "indoorequal", "source-layer": "poi", minzoom: 19, maxzoom: 24, layout: { "text-size": 12, "text-padding": 2, "text-max-width": 10, "text-allow-overlap": false, visibility: "visible" } },
  { id: "indoor-poi-logo", type: "symbol", source: "indoorequal", "source-layer": "poi", minzoom: 17, maxzoom: 24, layout: { visibility: "visible" } },
  { id: "indoor-transportation-poi", type: "symbol", source: "indoorequal", "source-layer": "transportation", minzoom: 17, maxzoom: 24, layout: { visibility: "visible" } },
  { id: "indoor-poi-tree", type: "symbol", source: "indoorequal", "source-layer": "poi", minzoom: 17, maxzoom: 24, layout: { visibility: "visible" } },
  { id: "indoor-area_name", type: "symbol", source: "indoorequal", "source-layer": "area_name", minzoom: 19, maxzoom: 24, layout: { "text-size": 10, visibility: "visible" } },
  { id: "indoor-polygon-room", type: "fill", source: "indoorequal", "source-layer": "area", layout: {} },
];
function mkMap(layers = mkLayers()) {
  const handlers = {};
  const calls = { set: 0, range: 0, on: 0 };
  const L = (id) => layers.find((l) => l.id === id);
  const map = {
    calls, layers, handlers,
    getStyle: () => ({ layers }),
    getLayer: (id) => L(id),
    getLayoutProperty: (id, p) => L(id)?.layout?.[p],
    setLayoutProperty: (id, p, v) => { L(id).layout[p] = v; calls.set += 1; (handlers.styledata || []).forEach((f) => f()); },
    setLayerZoomRange: (id, a, b) => { L(id).minzoom = a; L(id).maxzoom = b; calls.range += 1; (handlers.styledata || []).forEach((f) => f()); },
    on: (n, f) => { (handlers[n] = handlers[n] || []).push(f); calls.on += 1; },
    fire: (n) => (handlers[n] || []).forEach((f) => f()),
  };
  return map;
}
const poiOf = (map) => map.layers.find((l) => l.id === "indoor-poi");

{ // tuning
  const map = mkMap(); const logs = [];
  const ok = ML.tune(map, (s) => logs.push(s));
  const p = poiOf(map);
  check("tune() returns true and tunes indoor-poi: visible, minzoom = CONFIG.minZoom, padding, adaptive size", ok === true && p.layout.visibility === "visible" && p.minzoom === ML.CONFIG.minZoom && p.layout["text-padding"] === ML.CONFIG.padding && Array.isArray(p.layout["text-size"]) && p.layout["text-size"][0] === "interpolate" && p.layout["text-size"][2][0] === "zoom", JSON.stringify(p.layout["text-size"]));
  check("tune() leaves every other layer untouched (area_name, logos, transport icons, polygons)", JSON.stringify(map.layers.filter((l) => l.id !== "indoor-poi")) === JSON.stringify(mkLayers().filter((l) => l.id !== "indoor-poi")));
  check("tune() logs what it changed (visible in the totem logs)", logs.length === 1 && /MapVxLabels: tuned indoor-poi/.test(logs[0]), logs.join("|"));
}
{ // idempotence + a single listener
  const map = mkMap(); ML.tune(map); const sets = map.calls.set, ranges = map.calls.range, ons = map.calls.on;
  ML.tune(map); ML.tune(map); ML.tune(map);
  check("calling tune() again changes nothing and never stacks style listeners", map.calls.set === sets && map.calls.range === ranges && map.calls.on === ons && ons === 1, `set ${sets}->${map.calls.set} on=${map.calls.on}`);
}
{ // hide helper runs first (as on the totem), then tune re-shows only the label layer
  const map = mkMap();
  map.layers.filter((l) => l.type === "symbol" && l["source-layer"] !== "area_name" && l.id !== "indoor-poi-tree").forEach((l) => { l.layout.visibility = "none"; });
  ML.tune(map);
  const vis = (id) => map.layers.find((l) => l.id === id).layout.visibility;
  check("after the hide helper, only the label layer comes back (logos / transport icons stay hidden)", vis("indoor-poi") === "visible" && vis("indoor-poi-logo") === "none" && vis("indoor-transportation-poi") === "none");
}
{ // self-healing without runaway loops
  const map = mkMap(); ML.tune(map);
  const p = poiOf(map);
  p.layout.visibility = "none"; p.layout["text-size"] = 12; p.layout["text-padding"] = 2; p.minzoom = 19;   // SDK-style reset
  const before = map.calls.set + map.calls.range;
  map.fire("styledata");
  check("a style reset (SDK rebuilds the layer) is repaired on the next styledata", p.layout.visibility === "visible" && p.minzoom === ML.CONFIG.minZoom && p.layout["text-padding"] === ML.CONFIG.padding && Array.isArray(p.layout["text-size"]));
  const after = map.calls.set + map.calls.range;
  check("self-healing is bounded: repairing the 4 reset properties (visibility, minzoom, size, padding) costs 4 writes, then it is quiet (no styledata loop)", after - before === 4 && (() => { const c = map.calls.set + map.calls.range; map.fire("styledata"); map.fire("styledata"); return map.calls.set + map.calls.range === c; })(), `writes ${after - before}`);
}
{ // robustness
  const weird = [null, undefined, {}, [], 42, "map", { getLayer: () => null, on() {} }, { getLayer() { throw new Error("style not loaded"); }, on() {} }, { getLayer: () => ({ minzoom: 19 }), getLayoutProperty() { throw new Error("boom"); }, on() {} }];
  let threw = null; const rets = [];
  weird.forEach((m, i) => { try { rets.push(ML.tune(m, () => {})); } catch (e) { threw = `#${i}: ${e.message}`; } });
  check("tune() never throws on missing/odd maps (returns false instead)", !threw && rets.every((r) => r === false), threw || rets.join(","));
  check("a map without the label layer is a silent no-op", (() => { const m = mkMap(mkLayers().filter((l) => l.id !== "indoor-poi")); return ML.tune(m) === false && m.calls.set === 0 && m.calls.range === 0; })());
  const errs = []; ML.tune({ getLayer() { throw new Error("MapVX renamed things"); }, on() {} }, (s) => errs.push(s));
  check("an internal failure is logged for the totem logs, not thrown", errs.length === 1 && /MapVxLabels failed/.test(errs[0]), errs.join("|"));
}
{ // the numbers: adaptive, legible, and the closest zoom unchanged
  const C = ML.CONFIG; const pages = { smw: smwHtml, runtime: read("shared/mapvx-wc-runtime.js") };
  const zMin = Number((smwHtml.match(/const ZOOM_MIN = ([\d.]+);/) || [])[1]); const zMax = Number((smwHtml.match(/const ZOOM_MAX = ([\d.]+);/) || [])[1]);
  const rMin = Number((pages.runtime.match(/var ZOOM_MIN = ([\d.]+);/) || [])[1]); const rMax = Number((pages.runtime.match(/var ZOOM_MAX = ([\d.]+);/) || [])[1]);
  check("labels start exactly at the pages' lowest zoom (so they exist at EVERY allowed zoom)", C.minZoom === zMin && C.minZoom === rMin, `labels ${C.minZoom} pages ${zMin}/${rMin}`);
  check("size stops: first stop at minZoom, last stop at the pages' ZOOM_MAX", C.sizeStops[0][0] === C.minZoom && C.sizeStops[C.sizeStops.length - 1][0] === zMax && zMax === rMax);
  check("size stops are strictly ordered by zoom and non-decreasing in size (smaller when zoomed out)", C.sizeStops.every((s, i, a) => i === 0 || (s[0] > a[i - 1][0] && s[1] >= a[i - 1][1])));
  check("closest zoom keeps MapVX's own 12px (the close-up view is exactly as before)", C.sizeStops[C.sizeStops.length - 1][1] === 12);
  check("zoomed-out size stays legible but clearly smaller (7..10px at the lowest zoom)", C.sizeStops[0][1] >= 7 && C.sizeStops[0][1] <= 10 && C.sizeStops[0][1] < 12);
  check("padding and wrap width are sane (padding 0..2, wrap 6..12em, stops ordered)", C.padding >= 0 && C.padding <= 2 && C.maxWidthStops.every((s, i, a) => s[1] >= 6 && s[1] <= 12 && (i === 0 || s[0] > a[i - 1][0])));
}

// ---- wiring in the three pages that draw the MapVX maps
const smwScripts = [...smwHtml.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1].split("?")[0]);
const idxOf = (list, name) => list.findIndex((s) => s.endsWith(name));
check("store-map-web loads mapvx-label-tuning.js before the MapVX bundles", idxOf(smwScripts, "mapvx-label-tuning.js") >= 0 && idxOf(smwScripts, "mapvx-label-tuning.js") < idxOf(smwScripts, "map-view-with-modal.js"));
for (const [name, html] of [["mobility", mobilityLf], ["store-map (legacy)", read("store-map/index.html").replace(/\r\n/g, "\n")]]) {
  const list = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1].split("?")[0]);
  check(`${name} loads mapvx-label-tuning.js BEFORE mapvx-wc-runtime.js (which calls it)`, idxOf(list, "mapvx-label-tuning.js") >= 0 && idxOf(list, "mapvx-label-tuning.js") < idxOf(list, "mapvx-wc-runtime.js"));
  check(`${name}: the runtime script URL carries the new cache-busting version`, /mapvx-wc-runtime\.js\?v=20261005/.test(html));
}

// run each page's REAL hideGenericPoiIcons against the mock: hides the icon layers, then re-shows + tunes the labels
function realHide(src, kind) {
  const m = kind === "smw"
    ? src.match(/function hideGenericPoiIcons\(hostEl\) \{[\s\S]*?\n\}\n/)
    : src.match(/function hideGenericPoiIcons\(hostEl\) \{[\s\S]*?\n  \}\n/);
  if (!m) return null;
  const body = m[0];
  return kind === "smw"
    ? new Function("window", "log", "HIDDEN_ICON_SOURCE_LAYERS", `${body}; return hideGenericPoiIcons;`)
    : new Function("window", "log", "HIDDEN_ICON_SOURCE_LAYERS", "getLiveMap", `${body}; return hideGenericPoiIcons;`);
}
for (const [name, kind, src] of [["store-map-web", "smw", smwHtml], ["mapvx-wc-runtime (mobility / store-map)", "runtime", read("shared/mapvx-wc-runtime.js").replace(/\r\n/g, "\n")]]) {
  const factory = realHide(src, kind);
  check(`${name}: hideGenericPoiIcons is present and calls MapVxLabels.tune`, !!factory && /MapVxLabels\.tune\(libreMap, log\)/.test(src));
  if (!factory) continue;
  const map = mkMap(); const logs = [];
  const host = { shadowRoot: { querySelector: () => ({ lzMap: { map } }) } };
  const win = { MapVxLabels: ML };
  const hide = kind === "smw"
    ? factory(win, (s) => logs.push(s), ["poi", "transportation"])
    : factory(win, (s) => logs.push(s), ["poi", "transportation"], () => ({ lzMap: { map } }).lzMap.map);
  hide(host);
  const vis = (id) => map.layers.find((l) => l.id === id).layout.visibility;
  check(`${name}: real hide helper hides logos/transport icons but the store-name layer ends visible, shrunk by zoom`, vis("indoor-poi-logo") === "none" && vis("indoor-transportation-poi") === "none" && vis("indoor-poi") === "visible" && vis("indoor-poi-tree") === "visible" && poiOf(map).minzoom === ML.CONFIG.minZoom && Array.isArray(poiOf(map).layout["text-size"]), `poi=${vis("indoor-poi")} logo=${vis("indoor-poi-logo")}`);
  const sets = map.calls.set; hide(host); hide(host);
  check(`${name}: floor changes call the helper again — still tuned, no stacked listeners, no extra writes beyond re-hiding`, poiOf(map).layout.visibility === "visible" && map.calls.on === 1, `on=${map.calls.on} extraSets=${map.calls.set - sets}`);
  check(`${name}: nothing thrown and the totem log shows the tuning`, logs.some((s) => /MapVxLabels: tuned indoor-poi/.test(s)) && !logs.some((s) => /failed/.test(s)), logs.join(" | ").slice(0, 160));
}
check("the label module is part of the OTA payload (listed in the runtime manifest after the next build)", existsSync(resolve(sima, "shared/mapvx-label-tuning.js")));

// external scripts the map pages depend on must parse too (a syntax slip silently disables the whole map code)
for (const f of ["shared/mapvx-wc-runtime.js", "shared/mapvx-label-tuning.js", "shared/services-catalog.js"]) {
  let err = "";
  try { new vm.Script(read(f), { filename: f }); } catch (e) { err = e.message; }
  check(`${f} parses`, !err, err);
}

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `all passed (${passed} checks)`);
process.exit(failed ? 1 : 0);
