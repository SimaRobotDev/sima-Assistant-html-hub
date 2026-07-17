/**
 * Generates <script>-loadable companions for JSON assets that must load under
 * file:// (Android WebView blocks fetch()/XHR on file:// URLs).
 *
 * Re-run this whenever the source JSON changes so the .jsonp.js stays in sync:
 *   node tools/build-jsonp-assets.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// [sourceJson, outputJs, globalName]
const targets = [
  [
    "projects/cencomall/Assets/StreamingAssets/sima_services/data/market-catalog.json",
    "projects/cencomall/Assets/StreamingAssets/sima_services/data/market-catalog.jsonp.js",
    "__MARKET_CATALOG__",
  ],
  [
    "projects/cencomall/Assets/StreamingAssets/sima_services/data/market-catalog-i18n.json",
    "projects/cencomall/Assets/StreamingAssets/sima_services/data/market-catalog-i18n.jsonp.js",
    "__MARKET_CATALOG_I18N__",
  ],
  [
    "projects/cencomall/Assets/StreamingAssets/sima_services/shared/store-logos/store-logos.manifest.json",
    "projects/cencomall/Assets/StreamingAssets/sima_services/shared/store-logos/store-logos.manifest.jsonp.js",
    "__STORE_LOGO_MANIFEST__",
  ],
  [
    "projects/cencomall/Assets/StreamingAssets/sima_services/data/services-catalog.json",
    "projects/cencomall/Assets/StreamingAssets/sima_services/data/services-catalog.jsonp.js",
    "__SERVICES_CATALOG__",
  ],
];

let generated = 0;
for (const [srcRel, outRel, globalName] of targets) {
  const src = resolve(repoRoot, srcRel);
  const out = resolve(repoRoot, outRel);
  if (!existsSync(src)) {
    console.warn(`skip (missing): ${srcRel}`);
    continue;
  }
  const raw = readFileSync(src, "utf8");
  // Validate it parses, but keep the original text to avoid reformatting churn.
  JSON.parse(raw);
  const banner = `/* AUTO-GENERATED from ${srcRel} by tools/build-jsonp-assets.mjs. Do not edit by hand. */\n`;
  writeFileSync(out, `${banner}window.${globalName} = ${raw.trim()};\n`, "utf8");
  console.log(`wrote ${outRel}`);
  generated += 1;
}

console.log(`done (${generated} file(s))`);
