/**
 * Match all bathroom catalog entries to MapVX toilet POIs (same logic as map/index.html).
 *
 * Prerequisites:
 *   1. Local static server on port 8765 serving sima_services (see README / prior sessions).
 *   2. Copy tools/.mapvx-local.example.json → tools/.mapvx-local.json with a real apiKey.
 *   3. npx playwright install chromium  (first run only)
 *
 * Usage:
 *   node tools/match-bathroom-catalog.mjs
 *   node tools/match-bathroom-catalog.mjs --only bano-pb-afex
 *   node tools/match-bathroom-catalog.mjs --out data/bathroom-mapvx-patches.json
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const localConfigPath = resolve(here, ".mapvx-local.json");
const defaultOut = resolve(repoRoot, "data/bathroom-mapvx-patches.json");

function parseArgs(argv) {
  const args = { only: null, out: defaultOut, headless: true };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--only" && argv[i + 1]) {
      args.only = argv[++i];
    } else if (argv[i] === "--out" && argv[i + 1]) {
      args.out = resolve(process.cwd(), argv[++i]);
    } else if (argv[i] === "--headed") {
      args.headless = false;
    }
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

function primaryAnchorLocal(entry) {
  const stores = entry.anchorStores || [];
  for (const store of stores) {
    if (store.role === "primary" && store.local) return String(store.local);
  }
  for (const store of stores) {
    if (store.local) return String(store.local);
  }
  return "";
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = loadLocalConfig();
  const baseUrl = (cfg.baseUrl || "http://localhost:8765").replace(/\/$/, "");
  const mapPath = cfg.mapPath || "/map/";
  const mapUrl = baseUrl + mapPath;

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
  let services = (catalog.services || []).filter((s) => s.type === "bathroom");
  if (args.only) {
    services = services.filter((s) => s.id === args.only);
    if (!services.length) {
      console.error("No bathroom with id:", args.only);
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
        const poi = resolved.toiletPoi;
        out.push({
          id: entry.id,
          ok: !!(poi && poi.ref && poi.lat != null && poi.lng != null),
          resolvedBy: resolved.resolvedBy,
          mapvxId: resolved.place && resolved.place.mapvxId,
          poiRef: poi && poi.ref,
          lat: poi && poi.lat,
          lng: poi && poi.lng,
          floor_key: poi && poi.floor_key,
          error: poi ? null : "no toiletPoi from matcher",
        });
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
        resolvedBy: row.resolvedBy || "nearest-toilet-poi",
        floor_key: row.floor_key || null,
      };
      console.log("OK  ", row.id, "→", row.poiRef, row.lat + "," + row.lng);
    } else {
      console.log("FAIL", row.id, "→", row.error || "unknown");
    }
  }

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "tools/match-bathroom-catalog.mjs",
    matched: okCount,
    total: results.length,
    patches,
  };

  writeFileSync(args.out, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log("\nWrote", args.out, `(${okCount}/${results.length} matched)`);
  if (okCount < results.length) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
