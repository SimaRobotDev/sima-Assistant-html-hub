/**
 * Runs build-market-i18n-overlay.mjs --resume in a loop until all catalog
 * stores with descriptions have es, en and pt in the overlay.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const catalogPath = resolve(
  repoRoot,
  "projects/cencomall/Assets/StreamingAssets/sima_services/data/market-catalog.json"
);
const outPath = resolve(
  repoRoot,
  "projects/cencomall/Assets/StreamingAssets/sima_services/data/market-catalog-i18n.json"
);
const buildScript = resolve(here, "build-market-i18n-overlay.mjs");

function countPending() {
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const need = catalog.filter((item) => String(item.brand_description || "").trim()).length;
  let overlay = { stores: {} };
  if (existsSync(outPath)) {
    overlay = JSON.parse(readFileSync(outPath, "utf8"));
  }
  const stores = overlay.stores || {};
  let complete = 0;
  for (const item of catalog) {
    const id = String(item.id);
    const desc = String(item.brand_description || "").trim();
    if (!desc) continue;
    const row = stores[id];
    if (row && row.es && row.en && row.pt) complete += 1;
  }
  return { need, complete, pending: need - complete };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const pauseMs = Number(process.env.I18N_RUN_PAUSE_MS || 150000);
const maxRuns = Number(process.env.I18N_MAX_RUNS || 200);

for (let run = 1; run <= maxRuns; run += 1) {
  const before = countPending();
  console.log(`\n=== run ${run}/${maxRuns} complete=${before.complete}/${before.need} pending=${before.pending} ===`);
  if (before.pending <= 0) {
    console.log("all store descriptions translated");
    process.exit(0);
  }

  const result = spawnSync(process.execPath, [buildScript, "--resume"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      I18N_TRANSLATE_DELAY_MS: process.env.I18N_TRANSLATE_DELAY_MS || "3500",
      I18N_RATE_LIMIT_PAUSE_MS: process.env.I18N_RATE_LIMIT_PAUSE_MS || "120000",
    },
  });

  const after = countPending();
  console.log(`after run: complete=${after.complete}/${after.need} pending=${after.pending} exit=${result.status}`);
  if (after.pending <= 0) {
    console.log("all store descriptions translated");
    process.exit(0);
  }
  if (after.complete === before.complete) {
    console.log(`no progress this run; sleeping ${pauseMs}ms before retry`);
    await sleep(pauseMs);
  } else {
    await sleep(10000);
  }
}

console.error("max runs reached with pending translations");
process.exit(1);
