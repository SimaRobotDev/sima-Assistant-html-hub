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

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `all passed (${passed} checks)`);
process.exit(failed ? 1 : 0);
