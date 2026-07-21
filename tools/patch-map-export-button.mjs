/**
 * One-shot helper: add "Exportar patches JSON" to map/index.html (UTF-16 safe).
 * Re-run is a no-op if the button already exists.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mapHtml = resolve(
  here,
  "../projects/cencomall/Assets/StreamingAssets/sima_services/map/index.html"
);

const buf = readFileSync(mapHtml);
let enc = "utf8";
let text = buf.toString("utf8");
if (buf[0] === 0xff && buf[1] === 0xfe) {
  text = buf.toString("utf16le");
  enc = "utf16le";
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
}

if (text.includes("exportBathroomMapvxPatches")) {
  console.log("export button already present");
  process.exit(0);
}

const btnNeedle =
  '<button type="button" onclick="runMatchBathroomCatalog()">Cruzar catálogo ↔ POI</button>';
if (!text.includes(btnNeedle)) {
  // UTF-16 / legacy encoding variants — try looser match
  const re = /<button type="button" onclick="runMatchBathroomCatalog\(\)">[\s\S]*?<\/button>/;
  if (!re.test(text)) {
    console.error("Could not find runMatchBathroomCatalog button");
    process.exit(1);
  }
  text = text.replace(
    re,
    btnNeedle +
      '\n      <button type="button" onclick="exportBathroomMapvxPatches()">Exportar patches JSON</button>'
  );
} else if (!text.includes("exportBathroomMapvxPatches")) {
  text = text.replace(
    btnNeedle,
    btnNeedle +
      '\n      <button type="button" onclick="exportBathroomMapvxPatches()">Exportar patches JSON</button>'
  );
}

const fnNeedle = "async function runMatchBathroomCatalog()";
const insert = `async function exportBathroomMapvxPatches() {
  clearLog();
  if (!isUnityWebView()) applyManualConfig(false);
  logConfigStatus();
  try {
    await ServicesCatalog.loadCatalog();
    await MapVxBridge.ensureReady();
    const container = document.getElementById("map-container");
    const services = ServicesCatalog.getAll();
    const patches = {};
    let matched = 0;
    logLine("Exportando patches para " + services.length + " baños…", "ok");
    for (let i = 0; i < services.length; i++) {
      const entry = services[i];
      try {
        const resolved = await MapVxBridge.matchServiceCatalogEntry(entry, container);
        const poi = resolved.toiletPoi;
        if (!poi || !poi.ref || poi.lat == null || poi.lng == null) {
          logLine("✗ " + entry.id + ": sin toiletPoi", "err");
          continue;
        }
        matched++;
        patches[entry.id] = {
          poiRef: poi.ref,
          mapvxId: (resolved.place && resolved.place.mapvxId) || null,
          lat: poi.lat,
          lng: poi.lng,
          validatedAt: new Date().toISOString().slice(0, 10),
          resolvedBy: resolved.resolvedBy || "nearest-toilet-poi",
          floor_key: poi.floor_key || null,
        };
        logLine("✓ " + entry.id + " poiRef=" + poi.ref, "ok");
      } catch (err) {
        logLine("✗ " + entry.id + ": " + (err.message || err), "err");
      }
    }
    const payload = {
      version: 1,
      generatedAt: new Date().toISOString(),
      source: "map/index.html exportBathroomMapvxPatches",
      matched: matched,
      total: services.length,
      patches: patches,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bathroom-mapvx-patches.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    logLine("Descargado bathroom-mapvx-patches.json (" + matched + "/" + services.length + ")", "ok");
  } catch (e) {
    logLine("✗ " + (e.message || e), "err");
  }
}

`;

if (!text.includes(fnNeedle)) {
  console.error("Could not find runMatchBathroomCatalog function");
  process.exit(1);
}
text = text.replace(fnNeedle, insert + fnNeedle);

if (enc === "utf16le") {
  writeFileSync(mapHtml, Buffer.from("\ufeff" + text, "utf16le"));
} else {
  writeFileSync(mapHtml, text, "utf8");
}
console.log("patched map/index.html (" + enc + ")");
