/**
 * Builds data/market-catalog-i18n.json with machine-translated store descriptions.
 * Categories are handled at runtime via shared/market-i18n.js (static dictionary).
 *
 * Usage:
 *   node tools/build-market-i18n-overlay.mjs
 *   node tools/build-market-i18n-overlay.mjs --limit 50
 *   node tools/build-market-i18n-overlay.mjs --resume
 *
 * Then regenerate JSONP companions:
 *   node tools/build-jsonp-assets.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
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

const args = new Set(process.argv.slice(2));
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;
const resume = args.has("--resume");
const delayMs = Number(process.env.I18N_TRANSLATE_DELAY_MS || 800);
const maxRetries = Number(process.env.I18N_TRANSLATE_RETRIES || 5);
const rateLimitPauseMs = Number(process.env.I18N_RATE_LIMIT_PAUSE_MS || 30000);
const chunkSize = Number(process.env.I18N_TRANSLATE_CHUNK_SIZE || 450);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function splitChunks(text, size) {
  const value = String(text || "").trim();
  if (!value) return [];
  if (value.length <= size) return [value];
  const chunks = [];
  let rest = value;
  while (rest.length > size) {
    var cut = rest.lastIndexOf(" ", size);
    if (cut < size * 0.6) cut = size;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function googleTranslate(text, targetLang, attempt) {
  attempt = attempt || 0;
  const chunks = splitChunks(text, chunkSize);
  const parts = [];
  for (var i = 0; i < chunks.length; i += 1) {
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=es&tl=" +
      encodeURIComponent(targetLang) +
      "&dt=t&q=" +
      encodeURIComponent(chunks[i]);
    const res = await fetch(url);
    if (res.status === 429 || res.status === 503) {
      if (attempt >= maxRetries) throw new Error("translate rate limited");
      await sleep(rateLimitPauseMs * (attempt + 1));
      return googleTranslate(text, targetLang, attempt + 1);
    }
    if (!res.ok) throw new Error("translate HTTP " + res.status);
    const json = await res.json();
    const piece = Array.isArray(json && json[0])
      ? json[0].map(function (row) { return row && row[0]; }).join("")
      : "";
    if (!piece) throw new Error("empty translation");
    parts.push(String(piece).trim());
    if (chunks.length > 1) await sleep(250);
  }
  return parts.join(" ").trim();
}

async function translateText(text, langpair, attempt) {
  var target = "en";
  if (String(langpair || "").indexOf("pt") >= 0) target = "pt";
  return googleTranslate(text, target, attempt);
}

const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
let overlay = { version: 1, generatedAt: new Date().toISOString(), stores: {} };

if (resume && existsSync(outPath)) {
  overlay = JSON.parse(readFileSync(outPath, "utf8"));
  if (!overlay.stores) overlay.stores = {};
  console.log("resume:", Object.keys(overlay.stores).length, "stores already translated");
}

let processed = 0;
let skipped = 0;
let failed = 0;

for (const item of catalog) {
  if (processed >= limit) break;
  const id = String(item.id != null ? item.id : "");
  const desc = String(item.brand_description || "").trim();
  if (!id || !desc) {
    skipped += 1;
    continue;
  }
  if (resume && overlay.stores[id]?.en && overlay.stores[id]?.pt) {
    if (!overlay.stores[id].es) overlay.stores[id].es = desc;
    skipped += 1;
    continue;
  }

  const pending = Object.keys(overlay.stores).filter(function (sid) {
    var row = overlay.stores[sid];
    return !(row && row.en && row.pt);
  }).length;
  process.stdout.write(`[pending=${pending}] id=${id} … `);
  try {
    const existing = overlay.stores[id] || {};
    const es = desc;
    let en = existing.en;
    let pt = existing.pt;

    if (!en) {
      en = await translateText(desc, "es|en");
      await sleep(delayMs);
    }
    if (!pt) {
      pt = await translateText(desc, "es|pt-BR");
      await sleep(delayMs);
    }

    overlay.stores[id] = { es, en, pt };
    processed += 1;
    console.log("ok");
  } catch (error) {
    failed += 1;
    console.log("fail:", error.message);
    if (String(error.message).includes("rate limited")) {
      overlay.generatedAt = new Date().toISOString();
      writeFileSync(outPath, JSON.stringify(overlay), "utf8");
      console.log(`paused after rate limit (${Object.keys(overlay.stores).length} stores saved); waiting ${rateLimitPauseMs}ms…`);
      await sleep(rateLimitPauseMs);
      continue;
    }
  }

  if (processed > 0 && processed % 5 === 0) {
    overlay.generatedAt = new Date().toISOString();
    writeFileSync(outPath, JSON.stringify(overlay), "utf8");
    console.log("checkpoint saved", Object.keys(overlay.stores).length);
  }
}

overlay.generatedAt = new Date().toISOString();
writeFileSync(outPath, JSON.stringify(overlay), "utf8");
console.log(`done: translated=${processed} skipped=${skipped} failed=${failed} totalStores=${Object.keys(overlay.stores).length}`);
