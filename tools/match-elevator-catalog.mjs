/**
 * Match elevator catalog entries to MapVX elevator POIs (same flow as bathrooms).
 *
 * Prerequisites:
 *   1. Local static server on port 8765 serving sima_services.
 *   2. Copy tools/.mapvx-local.example.json → tools/.mapvx-local.json with a real apiKey.
 *   3. npx playwright install chromium  (first run only)
 *
 * Usage:
 *   node tools/match-elevator-catalog.mjs
 *   node tools/match-elevator-catalog.mjs --only ascensor-ripley
 *   node tools/match-elevator-catalog.mjs --out data/elevator-mapvx-patches.json
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const localConfigPath = resolve(here, ".mapvx-local.json");
const defaultOut = resolve(repoRoot, "data/elevator-mapvx-patches.json");

function parseArgs(argv) {
  const args = { only: null, out: defaultOut, headless: true };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--only" && argv[i + 1]) args.only = argv[++i];
    else if (argv[i] === "--out" && argv[i + 1]) args.out = resolve(process.cwd(), argv[++i]);
    else if (argv[i] === "--headed") args.headless = false;
  }
  return args;
}

function loadLocalConfig() {
  if (!existsSync(localConfigPath)) {
    console.error(
      "Missing tools/.mapvx-local.json — copy tools/.mapvx-local.example.json and set apiKey."
    );
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(localConfigPath, "utf8"));
  if (!cfg.apiKey || cfg.apiKey === "YOUR_MAPVX_API_KEY") {
    console.error("Set a real MapVX apiKey in tools/.mapvx-local.json");
    process.exit(1);
  }
  return cfg;
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = loadLocalConfig();
  const baseUrl = (cfg.baseUrl || "http://localhost:8765").replace(/\/$/, "");
  const mapUrl = baseUrl + (cfg.mapPath || "/map/");

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("Playwright not installed. Run: npm i -D playwright && npx playwright install chromium");
    process.exit(1);
  }

  const catalogPath = resolve(
    repoRoot,
    "projects/cencomall/Assets/StreamingAssets/sima_services/data/services-catalog.json"
  );
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  let services = (catalog.services || []).filter((s) => s.type === "elevator");
  if (args.only) {
    services = services.filter((s) => s.id === args.only);
    if (!services.length) {
      console.error("No elevator with id:", args.only);
      process.exit(1);
    }
  }

  console.log("Opening", mapUrl, "…");
  const browser = await chromium.launch({ headless: args.headless });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const sessionConfig = {
    apiKey: cfg.apiKey,
    parentPlace: cfg.parentPlace || "-N19VjzEVIj2RDKu7i4r",
    institutionId: cfg.institutionId || "-N19VgPNxo3jiBtu583Z",
    lang: cfg.lang || "es",
  };

  await page.goto(mapUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.evaluate((stored) => {
    sessionStorage.setItem("cencomall_mapvx_test_config", JSON.stringify(stored));
  }, sessionConfig);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(
    () => typeof window.MapVxBridge !== "undefined" && typeof window.ServicesCatalog !== "undefined",
    { timeout: 120000 }
  );
  await page.waitForFunction(
    () => window.ServicesCatalog && window.ServicesCatalog.isReady && window.ServicesCatalog.isReady(),
    { timeout: 120000 }
  );

  const results = await page.evaluate(async (serviceIds) => {
    const out = [];
    const container = document.getElementById("map-container");
    await MapVxBridge.ensureReady();
    const all = ServicesCatalog.getAll();
    for (const id of serviceIds) {
      const entry = all.find((e) => e.id === id);
      if (!entry) {
        out.push({ id, error: "not in catalog" });
        continue;
      }
      try {
        const resolved = await MapVxBridge.matchServiceCatalogEntry(entry, container);
        const poi = resolved.elevatorPoi;
        const place = resolved.place;
        if (poi && poi.ref && poi.lat != null && poi.lng != null) {
          out.push({
            id: entry.id,
            ok: true,
            resolvedBy: resolved.resolvedBy,
            mapvxId: place && place.mapvxId,
            poiRef: poi.ref,
            lat: poi.lat,
            lng: poi.lng,
            floor_key: poi.floor_key,
            bankSize: poi.bankSize || 1,
          });
        } else if (place && place.mapvxId && place.position) {
          out.push({
            id: entry.id,
            ok: true,
            resolvedBy: resolved.resolvedBy,
            mapvxId: place.mapvxId,
            poiRef: place.mapvxId,
            lat: place.position.lat,
            lng: place.position.lng,
            floor_key: null,
            bankSize: 1,
          });
        } else {
          out.push({ id: entry.id, ok: false, error: "no elevatorPoi from matcher" });
        }
      } catch (err) {
        out.push({
          id: entry.id,
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    }
    return out;
  }, services.map((s) => s.id));

  await browser.close();

  const patches = {};
  let okCount = 0;
  for (const row of results) {
    if (row.ok) {
      okCount++;
      patches[row.id] = {
        poiRef: row.poiRef,
        mapvxId: row.mapvxId || null,
        lat: row.lat,
        lng: row.lng,
        validatedAt: todayIsoDate(),
        resolvedBy: row.resolvedBy || "nearest-elevator-poi",
        floor_key: row.floor_key || null,
        bankSize: row.bankSize || 1,
      };
      console.log(
        "OK  ",
        row.id,
        "→",
        row.poiRef,
        row.lat + "," + row.lng,
        row.bankSize > 1 ? "(bank " + row.bankSize + ")" : ""
      );
    } else {
      console.log("FAIL", row.id, "→", row.error || "unknown");
    }
  }

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "tools/match-elevator-catalog.mjs",
    matched: okCount,
    total: results.length,
    patches,
  };

  writeFileSync(args.out, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log("\nWrote", args.out, `(${okCount}/${results.length} matched)`);
  console.log("Apply with: node tools/apply-elevator-mapvx-patches.mjs --apply --jsonp");
  if (okCount < results.length) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
