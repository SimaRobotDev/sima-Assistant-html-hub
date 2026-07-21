/**
 * Patch map/index.html (UTF-16) with elevator list/match/export tools.
 * Idempotent.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const mapHtml = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../projects/cencomall/Assets/StreamingAssets/sima_services/map/index.html"
);

const buf = readFileSync(mapHtml);
let text = buf.toString("utf16le");
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

if (text.includes("runListElevatorPois")) {
  console.log("elevator tools already present");
  process.exit(0);
}

const btnNeedle =
  '<button type="button" onclick="exportBathroomMapvxPatches()">Exportar patches JSON</button>';
if (!text.includes(btnNeedle)) {
  console.error("Could not find bathroom export button");
  process.exit(1);
}

text = text.replace(
  btnNeedle,
  `${btnNeedle}
      <button type="button" onclick="runListElevatorPois()">Listar ascensores en mapa</button>
      <button type="button" onclick="runMatchElevatorCatalog()">Cruzar catálogo elevators ↔ POI</button>
      <button type="button" onclick="exportElevatorMapvxPatches()">Exportar patches ascensores</button>
      <button class="primary" type="button" onclick="runElevatorMapTest()">Ver mapa ascensor</button>
      <button class="primary" type="button" onclick="runElevatorRouteTest()">Ver ruta al ascensor</button>`
);

if (text.includes("function bathroomBridgeOptions(entry)")) {
  text = text.replace(
    `return {
      poiType: "service",
      serviceId: entry.id,
      name: entry.name,`,
    `return {
      poiType: "service",
      serviceType: entry.type || "bathroom",
      serviceId: entry.id,
      name: entry.name,`
  );
}

const fnInsert = `
function getElevatorEntries() {
  return (ServicesCatalog.getAll() || []).filter(function (e) {
    return e && e.type === "elevator";
  });
}

function getSelectedElevatorEntry() {
  const entry = getSelectedBathroomEntry();
  if (entry && entry.type === "elevator") return entry;
  return null;
}

async function runListElevatorPois() {
  clearLog();
  if (!isUnityWebView()) applyManualConfig(false);
  logConfigStatus();
  try {
    await MapVxBridge.ensureReady();
    const container = document.getElementById("map-container");
    await MapVxBridge.ensureMap(container);
    const floors = (MapVxBridge.getMapFloors && MapVxBridge.getMapFloors()) || [];
    const seen = {};
    const all = [];
    logLine("Listando ascensores (class=elevator)…", "ok");

    async function collectCurrentFloor(label) {
      await new Promise(function (r) { setTimeout(r, 450); });
      const live = (MapVxBridge.listElevatorPoisOnMap && MapVxBridge.listElevatorPoisOnMap()) || [];
      logLine("Piso " + label + ": " + live.length + " ascensor(es)", live.length ? "ok" : "warn");
      live.forEach(function (poi) {
        const key = poi.ref + "|" + (poi.floor_key || "");
        if (seen[key]) return;
        seen[key] = true;
        all.push(poi);
        logLine(
          "  ref=" + poi.ref + " floor=" + poi.floor_key + " lat=" + poi.lat + " lng=" + poi.lng,
          "ok"
        );
      });
    }

    if (floors && floors.length) {
      for (let i = 0; i < floors.length; i++) {
        const floorKey = floors[i].key || floors[i].id || floors[i].floorKey || floors[i];
        try {
          if (MapVxBridge.switchFloor) await MapVxBridge.switchFloor(String(floorKey));
        } catch (eFloor) { /* continue */ }
        await collectCurrentFloor(String(floorKey));
      }
    } else {
      await collectCurrentFloor("(actual)");
    }

    logLine("Total únicos: " + all.length, all.length ? "ok" : "warn");
    if (all.length) {
      logLine(JSON.stringify(all, null, 2));
    }
  } catch (e) {
    logLine("✗ " + (e.message || e), "err");
  }
}

async function runMatchElevatorCatalog() {
  clearLog();
  if (!isUnityWebView()) applyManualConfig(false);
  logConfigStatus();
  try {
    await ServicesCatalog.loadCatalog();
    await MapVxBridge.ensureReady();
    const container = document.getElementById("map-container");
    const services = getElevatorEntries();
    if (!services.length) {
      logLine("No hay entradas type=elevator en el catálogo.", "warn");
      return;
    }
    logLine("Cruzando " + services.length + " ascensores del catálogo…", "ok");
    for (let i = 0; i < services.length; i++) {
      const entry = services[i];
      try {
        const resolved = await MapVxBridge.matchServiceCatalogEntry(entry, container);
        const poi = resolved.elevatorPoi;
        logLine(
          "✓ " + entry.id + " → " + resolved.resolvedBy +
            " ref=" + (resolved.place && resolved.place.mapvxId) +
            (poi ? " floor=" + poi.floor_key : ""),
          "ok"
        );
        if (poi) {
          logLine(
            '  mapvx patch: "poiRef": "' + poi.ref + '", "lat": ' + poi.lat + ', "lng": ' + poi.lng,
            "ok"
          );
        }
      } catch (err) {
        logLine("✗ " + entry.id + ": " + (err.message || err), "err");
      }
    }
  } catch (e) {
    logLine("✗ " + (e.message || e), "err");
  }
}

async function exportElevatorMapvxPatches() {
  clearLog();
  if (!isUnityWebView()) applyManualConfig(false);
  logConfigStatus();
  try {
    await ServicesCatalog.loadCatalog();
    await MapVxBridge.ensureReady();
    const container = document.getElementById("map-container");
    const services = getElevatorEntries();
    const patches = {};
    let matched = 0;
    logLine("Exportando patches para " + services.length + " ascensores…", "ok");
    for (let i = 0; i < services.length; i++) {
      const entry = services[i];
      try {
        const resolved = await MapVxBridge.matchServiceCatalogEntry(entry, container);
        const poi = resolved.elevatorPoi;
        if (poi && poi.ref && poi.lat != null && poi.lng != null) {
          matched++;
          patches[entry.id] = {
            poiRef: poi.ref,
            mapvxId: (resolved.place && resolved.place.mapvxId) || null,
            lat: poi.lat,
            lng: poi.lng,
            validatedAt: new Date().toISOString().slice(0, 10),
            resolvedBy: resolved.resolvedBy || "nearest-elevator-poi",
            floor_key: poi.floor_key || null,
          };
          logLine("✓ " + entry.id + " poiRef=" + poi.ref, "ok");
          continue;
        }
        const place = resolved.place;
        if (place && place.mapvxId && place.position && place.position.lat != null) {
          matched++;
          patches[entry.id] = {
            poiRef: place.mapvxId,
            mapvxId: place.mapvxId,
            lat: place.position.lat,
            lng: place.position.lng,
            validatedAt: new Date().toISOString().slice(0, 10),
            resolvedBy: resolved.resolvedBy || "catalog-coords",
            floor_key: null,
          };
          logLine("✓ " + entry.id + " poiRef=" + place.mapvxId + " (from place)", "ok");
          continue;
        }
        logLine("✗ " + entry.id + ": sin elevatorPoi", "err");
      } catch (err) {
        logLine("✗ " + entry.id + ": " + (err.message || err), "err");
      }
    }
    const payload = {
      version: 1,
      generatedAt: new Date().toISOString(),
      source: "map/index.html exportElevatorMapvxPatches",
      matched: matched,
      total: services.length,
      patches: patches,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "elevator-mapvx-patches.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    logLine("Descargado elevator-mapvx-patches.json (" + matched + "/" + services.length + ")", "ok");
  } catch (e) {
    logLine("✗ " + (e.message || e), "err");
  }
}

async function runElevatorMapTest() {
  clearLog();
  if (!isUnityWebView()) applyManualConfig(false);
  logConfigStatus();
  let entry = getSelectedElevatorEntry();
  if (!entry) entry = getElevatorEntries()[0] || null;
  if (!entry) {
    logLine("No hay ascensores en el catálogo (type=elevator). Selecciona uno o agrégalo al catálogo.", "err");
    return;
  }
  try {
    await MapVxBridge.ensureReady();
    const container = document.getElementById("map-container");
    const result = await MapVxBridge.showServicePlace(container, bathroomBridgeOptions(entry));
    logLine("✓ Mapa ascensor — " + result.resolvedBy, "ok");
    logLine("  title: " + result.title);
    logLine("  mapvxId: " + result.mapvxId);
    if (result.elevatorPoi) logLine("  elevatorPoi.ref: " + result.elevatorPoi.ref, "ok");
  } catch (e) {
    logLine("✗ " + (e.message || e), "err");
  }
}

async function runElevatorRouteTest() {
  clearLog();
  if (!isUnityWebView()) applyManualConfig(false);
  logConfigStatus();
  let entry = getSelectedElevatorEntry();
  if (!entry) entry = getElevatorEntries()[0] || null;
  if (!entry) {
    logLine("No hay ascensores en el catálogo (type=elevator).", "err");
    return;
  }
  const totem = (window.MAPVX_CONFIG && window.MAPVX_CONFIG.totemPlaceId) || "";
  if (!totem) {
    logLine("Falta totemPlaceId (origen). Pégalo en Config MapVX y guarda.", "err");
    return;
  }
  try {
    await MapVxBridge.ensureReady();
    const container = document.getElementById("map-container");
    const result = await MapVxBridge.showServiceRouteTo(container, bathroomBridgeOptions(entry));
    logLine("✓ Ruta ascensor — " + result.resolvedBy, "ok");
    logLine("  mapvxId destino: " + result.mapvxId);
    if (result.routeStarted || result.routeActive) {
      logLine("→ Ruta animada iniciada.", "ok");
    } else if (result.routeSkipped) {
      logLine("Ruta omitida: " + result.routeSkipped, "warn");
    } else if (result.routeError) {
      logLine("Ruta falló: " + result.routeError, "err");
    }
  } catch (e) {
    logLine("✗ " + (e.message || e), "err");
  }
}

`;

const insertBefore = "async function exportBathroomMapvxPatches()";
if (!text.includes(insertBefore)) {
  console.error("Could not find exportBathroomMapvxPatches");
  process.exit(1);
}
text = text.replace(insertBefore, fnInsert + insertBefore);

writeFileSync(mapHtml, Buffer.from("\ufeff" + text, "utf16le"));
console.log("patched map/index.html with elevator tools");
