/**
 * MapVX Web SDK wrapper for UniWebView (totem / mobility).
 * Requires window.MapVX (UMD bundle) and window.MAPVX_CONFIG from Unity.
 */
window.MapVxBridge = (function () {
  var sdk = null;
  var map = null;
  var mapContainer = null;
  var initPromise = null;
  var stylesLoaded = false;
  var storeLabelState = {
    parentPlaceId: null,
    markerIds: [],
    loading: null,
    labelPlaceMarkers: [], // [{place, floorId, markerId, featured, centroidApplied}]
    centroidListener: null,   // {libreMap, fn} for cleanup
    zoomListenerCleanup: null,
    zoomBaseline: null,
    // "all" mode (deep zoom) only builds markers for this floor at a time —
    // building every store in the whole mall at once was creating 300-400+
    // live DOM markers on totems, which is heavy to reposition on every
    // pan/zoom frame. Perf, not a visual change (other floors aren't shown
    // anyway until you switch to them).
    allModeFloorId: null,
  };
  var storeLogoManifest = null;
  var storeLogoManifestPromise = null;
  var placePopOverState = {
    map: null,
    placeId: null,
    floorId: null,
    place: null,
    node: null,
    listenersBound: false,
    scheduled: false,
    visible: false,
  };
  var serviceDestMarkerState = {
    markerId: null,
  };
  var routeAnimationToken = 0;
  var LOG_PREFIX = "[MapVxBridge]";
  var subPlacesCache = { key: null, data: null, loading: null };
  var parentPlaceCache = { key: null, data: null, loading: null };
  var _zoomLabelDebounceTimer = null;
  var centroidUpdateTimer = null;
  var poiCentroidCache = {};

  function clearPoiCentroidCache() {
    poiCentroidCache = {};
  }

  function poiFeatureMatchesFloor(feature, floorId) {
    if (!floorId || !feature || !feature.properties) return true;
    var floorKey = feature.properties.floor_key;
    if (floorKey == null || floorKey === "") return true;
    var target = String(floorId);
    if (String(floorKey) === target) return true;
    if (Array.isArray(floorKey)) {
      for (var i = 0; i < floorKey.length; i++) {
        if (String(floorKey[i]) === target) return true;
      }
    }
    return false;
  }

  function ingestPoiCentroidFeatures(features, floorId, result) {
    if (!features || !features.length) return;
    features.forEach(function (f) {
      if (!f || !f.geometry || f.geometry.type !== "Point") return;
      if (!f.properties || !f.properties.ref) return;
      if (floorId && !poiFeatureMatchesFloor(f, floorId)) return;
      var coords = f.geometry.coordinates;
      result[f.properties.ref] = { lat: coords[1], lng: coords[0] };
    });
  }

  function queryPOICentroids(libreMap, floorId) {
    var result = {};
    if (!libreMap) return result;
    try {
      // Prefer rendered features (respects the SDK's active per-floor filter).
      ingestPoiCentroidFeatures(
        libreMap.queryRenderedFeatures(undefined, { layers: ["indoor-poi-rank1"] }),
        floorId,
        result
      );
    } catch (e) { /* noop */ }

    // At zoom-out, rank1 POI symbols may not be in the render tree yet, so
    // queryRenderedFeatures returns nothing and anchor logos stay on the wrong
    // subPlace.position until the user zooms in. Source features are still
    // available once tiles load; filter by floor_key so multi-floor anchors
    // (same ref on several floors) only pick up the active floor's point.
    try {
      var poiLayer = libreMap.getLayer("indoor-poi-rank1");
      if (poiLayer && poiLayer.source && poiLayer.sourceLayer) {
        ingestPoiCentroidFeatures(
          libreMap.querySourceFeatures(poiLayer.source, { sourceLayer: poiLayer.sourceLayer }),
          floorId,
          result
        );
      }
    } catch (e) { /* noop */ }

    return result;
  }

  function getCentroidsForFloor(libreMap, floorId) {
    var key = String(floorId || "");
    if (!key) return {};
    if (poiCentroidCache[key]) return poiCentroidCache[key];
    poiCentroidCache[key] = queryPOICentroids(libreMap, floorId);
    return poiCentroidCache[key];
  }

  function resolveAnchorPosition(place, floorId, libreMap) {
    if (!place || !place.position) return null;
    if (libreMap && place.mapvxId && floorId) {
      var centroids = getCentroidsForFloor(libreMap, floorId);
      if (centroids[place.mapvxId]) return centroids[place.mapvxId];
    }
    return place.position;
  }

  // Manifest offsetX/offsetY are tuned in screen pixels. When applied as CSS
  // translate on the marker DOM, they stay fixed in px while the store polygon
  // grows/shrinks with zoom — logos look "corridos" at zoom-out and only align
  // after zoom-in. Baking the offset into lat/lng via project/unproject keeps
  // the logo glued to the polygon at every zoom level and screen size (55" totem,
  // BlueStacks, localhost) as long as the centroid anchor is correct.
  function applyScreenOffsetToCoordinate(libreMap, coordinate, offsetX, offsetY) {
    if (!libreMap || !coordinate || coordinate.lat == null || coordinate.lng == null) {
      return coordinate;
    }
    var ox = Number(offsetX) || 0;
    var oy = Number(offsetY) || 0;
    if (!ox && !oy) return coordinate;
    if (typeof libreMap.project !== "function" || typeof libreMap.unproject !== "function") {
      return coordinate;
    }
    try {
      var point = libreMap.project([coordinate.lng, coordinate.lat]);
      var shifted = libreMap.unproject([point.x + ox, point.y + oy]);
      return { lng: shifted.lng, lat: shifted.lat };
    } catch (e) {
      return coordinate;
    }
  }

  function resolveFeaturedMarkerCoordinate(libreMap, place, floorId, floorLabel) {
    var centroid = resolveAnchorPosition(place, floorId, libreMap);
    if (!centroid) return null;
    var treatment = getLocalStoreLogoTreatment(place, null, floorLabel);
    if (!treatment || treatment.offsetInCss) return centroid;
    return applyScreenOffsetToCoordinate(
      libreMap,
      centroid,
      treatment.offsetX,
      treatment.offsetY
    );
  }

  function syncFeaturedLogoPositions(mapInst) {
    if (!mapInst || !storeLabelState.labelPlaceMarkers.length) return;
    var libreMap = getLibreMap(mapInst);
    if (!libreMap || typeof mapInst.updateMarkerPosition !== "function") return;

    storeLabelState.labelPlaceMarkers.forEach(function (entry) {
      if (!entry.featured || !entry.markerId || !entry.place) return;
      var floorId = entry.floorId;
      var floorLabel = entry.floorLabel || getFloorDisplayLabel(floorId);
      var treatment = getLocalStoreLogoTreatment(entry.place, null, floorLabel);
      // Legacy CSS-pixel nudge (Zara) — marker stays on centroid; offset is DOM translate.
      if (treatment && treatment.offsetInCss) return;
      var centroid = resolveAnchorPosition(entry.place, floorId, libreMap);
      if (centroid) entry.anchorCentroid = centroid;
      var base = entry.anchorCentroid || centroid;
      if (!base || base.lat == null || base.lng == null) return;
      var finalPos = treatment
        ? applyScreenOffsetToCoordinate(libreMap, base, treatment.offsetX, treatment.offsetY)
        : base;
      try {
        mapInst.updateMarkerPosition(entry.markerId, [finalPos.lng, finalPos.lat]);
      } catch (e) { /* noop */ }
    });
  }
  var BRIDGE_LOAD_TIME = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();

  function shouldBridgeLog(level) {
    if (level === "error" || level === "warn") return true;
    var cfg = getConfig();
    return !!(cfg.mapvxVerboseLog || cfg.debugMapvx);
  }

  // Elapsed ms since the bridge script loaded. Every log line already covers
  // the whole init/load/floor-switch flow, so stamping them turns the
  // existing logging into a real performance timeline on the totem (no need
  // to add ad-hoc Date.now() calls all over the file to see where time goes).
  function elapsedMs() {
    var now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    return Math.round(now - BRIDGE_LOAD_TIME);
  }

  function log(level, message, data) {
    var line = LOG_PREFIX + " +" + elapsedMs() + "ms " + message;
    if (data !== undefined) {
      try { line += " " + JSON.stringify(data); } catch (e) { line += " [data]"; }
    }
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
    if (shouldBridgeLog(level) && typeof SimaBridge !== "undefined" && SimaBridge.send) {
      SimaBridge.send("mapvx_log", { level: level, message: message, data: data ? String(JSON.stringify(data)).slice(0, 500) : "" });
    }
  }

  function invalidateSubPlacesCache() {
    subPlacesCache.key = null;
    subPlacesCache.data = null;
    subPlacesCache.loading = null;
  }

  function invalidateParentPlaceCache() {
    parentPlaceCache.key = null;
    parentPlaceCache.data = null;
    parentPlaceCache.loading = null;
  }

  function getParentPlaceCached(parentPlaceId) {
    var key = String(parentPlaceId || "");
    if (!key || !sdk || typeof sdk.getPlaceDetail !== "function") {
      return Promise.resolve(null);
    }
    if (parentPlaceCache.key === key && parentPlaceCache.data) {
      return Promise.resolve(parentPlaceCache.data);
    }
    if (parentPlaceCache.key === key && parentPlaceCache.loading) {
      return parentPlaceCache.loading;
    }
    parentPlaceCache.key = key;
    parentPlaceCache.loading = sdk.getPlaceDetail(parentPlaceId)
      .then(function (place) {
        parentPlaceCache.data = place || null;
        parentPlaceCache.loading = null;
        return parentPlaceCache.data;
      })
      .catch(function (error) {
        parentPlaceCache.loading = null;
        parentPlaceCache.key = null;
        throw error;
      });
    return parentPlaceCache.loading;
  }

  async function prefetchMapCatalog(config) {
    config = config || getConfig();
    if (!isConfigured(config)) return;
    await ensureReady(config);
    await Promise.all([
      getParentPlaceCached(config.parentPlace).catch(function () { return null; }),
      getSubPlacesCached(config.parentPlace).catch(function () { return []; }),
    ]);
    log("info", "prefetchMapCatalog done", { parentPlace: config.parentPlace });
  }

  function delayMs(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function hasCatalogMapvxCoords(options) {
    if (!options) return false;
    var lat = options.lat;
    var lng = options.lng;
    return lat != null && lng != null && isFinite(Number(lat)) && isFinite(Number(lng));
  }

  function needsToiletPoiDiscovery(options) {
    if (!options) return false;
    var poiRef = options.poiRef ? String(options.poiRef).trim() : "";
    var mapvxId = options.mapvxId ? String(options.mapvxId).trim() : "";
    // Fast path only when catalog has verified coordinates (+ ref/id).
    if (hasCatalogMapvxCoords(options) && (poiRef || mapvxId)) return false;
    return !!(options.anchorLocal || options.serviceId || options.id);
  }

  function needsServicePoiDiscovery(options) {
    return needsToiletPoiDiscovery(options);
  }

  function resolveServiceType(options) {
    options = options || {};
    var raw = String(options.serviceType || options.type || "").toLowerCase().trim();
    if (raw === "elevator" || raw === "ascensor" || raw === "elevador") return "elevator";
    if (raw === "bathroom" || raw === "baño" || raw === "bano") return "bathroom";
    if (options.preferChangingTable) return "bathroom";
    return "bathroom";
  }

  function getSubPlacesCached(parentPlaceId) {
    var key = String(parentPlaceId || "");
    if (!key || !sdk || typeof sdk.getSubPlaces !== "function") {
      return Promise.resolve([]);
    }
    if (subPlacesCache.key === key && subPlacesCache.data) {
      return Promise.resolve(subPlacesCache.data);
    }
    if (subPlacesCache.key === key && subPlacesCache.loading) {
      return subPlacesCache.loading;
    }
    subPlacesCache.key = key;
    subPlacesCache.loading = sdk.getSubPlaces(parentPlaceId)
      .then(function (places) {
        subPlacesCache.data = places || [];
        subPlacesCache.loading = null;
        return subPlacesCache.data;
      })
      .catch(function (error) {
        subPlacesCache.loading = null;
        subPlacesCache.key = null;
        throw error;
      });
    return subPlacesCache.loading;
  }

  function getConfig() {
    return window.MAPVX_CONFIG || {};
  }

  function getLibreMap(mapInstance) {
    if (!mapInstance) return null;
    if (mapInstance.map && typeof mapInstance.map.getZoom === "function") {
      return mapInstance.map;
    }
    return mapInstance;
  }

  // Requerimiento de Cenco: el mapa NUNCA debe poder rotar (debe mantenerse
  // siempre "norte arriba"), tanto por gesto del usuario (dos dedos en touch,
  // clic derecho/ctrl+arrastre en mouse) como por el bearing automático que
  // MapVX aplica durante la animación de rutas ("heading-up" navigation).
  // Esto último se controla aparte vía ROUTE_ANIMATION_DEFAULTS.keepFixedBearing.
  // `config.allowMapRotation === true` es una válvula de escape por si algún
  // día se necesita revertir esto sin tocar código.
  function lockMapRotation(mapInstance, config) {
    config = config || getConfig();
    if (config.allowMapRotation === true) return;
    var libreMap = getLibreMap(mapInstance);
    if (!libreMap) return;
    try {
      if (libreMap.dragRotate && typeof libreMap.dragRotate.disable === "function") {
        libreMap.dragRotate.disable();
      }
    } catch (e) { /* noop */ }
    try {
      if (libreMap.touchZoomRotate && typeof libreMap.touchZoomRotate.disableRotation === "function") {
        libreMap.touchZoomRotate.disableRotation();
      }
    } catch (e) { /* noop */ }
    try {
      if (typeof libreMap.getBearing === "function" && libreMap.getBearing() !== 0 && typeof libreMap.setBearing === "function") {
        libreMap.setBearing(0);
      }
    } catch (e) { /* noop */ }
    log("info", "lockMapRotation applied (north-up only, per Cenco requirement)");
  }

  function getMapZoom(mapInstance) {
    if (!mapInstance) return null;
    if (typeof mapInstance.getZoom === "function") {
      return mapInstance.getZoom();
    }
    if (typeof mapInstance.getZoomLevel === "function") {
      return mapInstance.getZoomLevel();
    }
    var libreMap = getLibreMap(mapInstance);
    if (libreMap && typeof libreMap.getZoom === "function") {
      return libreMap.getZoom();
    }
    return null;
  }

  function bindMapViewListener(mapInstance, eventName, fn) {
    var libreMap = getLibreMap(mapInstance);
    if (libreMap && typeof libreMap.on === "function") {
      libreMap.on(eventName, fn);
      return function unbind() {
        try {
          if (typeof libreMap.off === "function") {
            libreMap.off(eventName, fn);
          }
        } catch (e) {}
      };
    }
    if (mapInstance && typeof mapInstance.on === "function") {
      mapInstance.on(eventName, fn);
      return function unbind() {
        try {
          if (typeof mapInstance.off === "function") {
            mapInstance.off(eventName, fn);
          }
        } catch (e) {}
      };
    }
    return null;
  }

  function detachZoomLabelListener() {
    if (_zoomLabelDebounceTimer) {
      clearTimeout(_zoomLabelDebounceTimer);
      _zoomLabelDebounceTimer = null;
    }
    if (typeof storeLabelState.zoomListenerCleanup === "function") {
      try { storeLabelState.zoomListenerCleanup(); } catch (e) {}
    }
    storeLabelState.zoomListenerCleanup = null;
    _zoomLabelListener = null;
    _zoomLabelTier = -1;
    storeLabelState.zoomBaseline = null;
  }

  function configSummary(config) {
    config = config || getConfig();
    return {
      hasApiKey: !!(config.apiKey && String(config.apiKey).length > 0),
      apiKeyLen: config.apiKey ? String(config.apiKey).length : 0,
      parentPlace: config.parentPlace || null,
      institutionId: config.institutionId || null,
      totemPlaceId: config.totemPlaceId || null,
      lang: config.lang || null,
    };
  }

  function assetsBase() {
    var base = window.MAPVX_ASSETS_BASE || "../shared/mapvx/";
    if (base.charAt(base.length - 1) !== "/") base += "/";
    return base;
  }

  function isFileProtocol() {
    return typeof location !== "undefined" && location.protocol === "file:";
  }

  // Resolve a relative asset path to an absolute URL. On Android WebView
  // (file://) some img/script loads fail unless the href is fully qualified.
  function resolveAssetUrl(relativeUrl) {
    if (!relativeUrl) return relativeUrl;
    if (/^(https?:|data:|blob:|file:)/i.test(String(relativeUrl))) return String(relativeUrl);
    try {
      var anchor = document.createElement("a");
      anchor.href = relativeUrl;
      return anchor.href;
    } catch (e) {
      return relativeUrl;
    }
  }

  function storeLogosBase(config) {
    config = config || getConfig();
    var base = config.storeLogosBase || "../shared/store-logos/";
    if (base.charAt(base.length - 1) !== "/") base += "/";
    if (isFileProtocol()) base = resolveAssetUrl(base);
    return base;
  }

  // Android WebView blocks fetch()/XHR on file:// URLs but <script src> works.
  // Injects a companion JS file that assigns the manifest to a global.
  function loadJsonViaScript(url, globalName) {
    return new Promise(function (resolve, reject) {
      if (window[globalName] != null) {
        resolve(window[globalName]);
        return;
      }
      var script = document.createElement("script");
      script.async = true;
      script.src = resolveAssetUrl(url);
      script.onload = function () {
        if (window[globalName] != null) resolve(window[globalName]);
        else reject(new Error("logo manifest jsonp loaded but global missing"));
      };
      script.onerror = function () {
        reject(new Error("logo manifest jsonp failed to load: " + url));
      };
      (document.head || document.documentElement).appendChild(script);
    });
  }

  function loadStoreLogoManifest(config) {
    if (storeLogoManifest) return Promise.resolve(storeLogoManifest);
    if (storeLogoManifestPromise) return storeLogoManifestPromise;

    var manifestBase = storeLogosBase(config);
    var manifestUrl = manifestBase + "store-logos.manifest.json";
    var manifestJsonpUrl = manifestBase + "store-logos.manifest.jsonp.js";

    function finalizeManifest(data) {
      storeLogoManifest = data && typeof data === "object" ? data : {};
      var entryCount = Object.keys(storeLogoManifest).filter(function (key) {
        return key.charAt(0) !== "_";
      }).length;
      log("info", "store logo manifest loaded", {
        entries: entryCount,
        manifestUrl: manifestUrl,
        protocol: typeof location !== "undefined" ? location.protocol : "",
      });
      if (!entryCount) {
        log("warn", "store logo manifest empty — anchor PNG logos will not resolve on this device; check OTA includes shared/store-logos/ and .jsonp.js companion", {
          manifestUrl: manifestUrl,
          jsonpUrl: manifestJsonpUrl,
        });
      }
      return storeLogoManifest;
    }

    // Totem WebView loads via file:// — skip fetch (always fails) and go straight
    // to the JSONP companion, same pattern as market-catalog.jsonp.js.
    if (isFileProtocol()) {
      storeLogoManifestPromise = loadJsonViaScript(manifestJsonpUrl, "__STORE_LOGO_MANIFEST__")
        .catch(function (err) {
          log("warn", "store logo manifest jsonp failed on file://", {
            error: String(err && err.message ? err.message : err),
            jsonpUrl: manifestJsonpUrl,
          });
          return {};
        })
        .then(finalizeManifest);
      return storeLogoManifestPromise;
    }

    storeLogoManifestPromise = fetch(manifestUrl, { cache: "no-cache" })
      .then(function (response) {
        if (!response.ok) throw new Error("store logo manifest HTTP " + response.status);
        return response.json();
      })
      .catch(function () {
        return loadJsonViaScript(manifestJsonpUrl, "__STORE_LOGO_MANIFEST__").catch(function () {
          return {};
        });
      })
      .then(finalizeManifest);

    return storeLogoManifestPromise;
  }

  // Match only when the manifest key equals the candidate or is its leading
  // word(s). Avoids "Rincón Jumbo" borrowing the "jumbo" logo, etc.
  function brandKeyMatches(candidate, manifestKey) {
    if (!candidate || !manifestKey) return false;
    if (candidate === manifestKey) return true;
    if (candidate.indexOf(manifestKey + " ") !== 0) return false;
    // Sub-brands like "Paris Deporte" must not inherit the "Paris" anchor logo.
    var rest = candidate.slice(manifestKey.length + 1);
    if (/^deporte\b/.test(rest)) return false;
    return true;
  }

  function getLocalStoreLogoEntry(place, manifest) {
    if (!place || !manifest) return null;
    var keys = [
      getStoreLogoOverrideKey(place),
      place.clientId,
      place.title,
      place.shortName,
      place.name,
    ].map(normalizeText).filter(Boolean);

    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (manifest[key]) return manifest[key];
      for (var manifestKey in manifest) {
        if (!manifestKey || manifestKey.charAt(0) === "_") continue;
        if (brandKeyMatches(key, manifestKey)) {
          return manifest[manifestKey];
        }
      }
    }
    return null;
  }

  function getLocalStoreLogoFilename(place, manifest) {
    var entry = getLocalStoreLogoEntry(place, manifest);
    if (!entry) return "";
    if (typeof entry === "string") return String(entry).trim();
    if (typeof entry === "object" && entry.file) return String(entry.file).trim();
    return "";
  }

  function getLocalStoreLogoUrl(place, config, manifest) {
    var filename = getLocalStoreLogoFilename(place, manifest || storeLogoManifest);
    if (!filename) return "";
    return resolveAssetUrl(storeLogosBase(config) + filename);
  }

  function getLocalStoreLogoTreatment(place, manifest, floorLabel) {
    var entry = getLocalStoreLogoEntry(place, manifest || storeLogoManifest);
    if (!entry || typeof entry !== "object") return null;

    // A multi-floor anchor (H&M, Falabella, Ripley...) can have a differently
    // shaped polygon on each floor, so the same fixed offset that looks right
    // on one floor can push the logo off the edge on another. `perFloor` lets
    // the manifest override offsetX/offsetY/scale/rotation for one specific
    // floor (keyed by its display label, e.g. "Nivel 2"), on top of the base
    // values below.
    var floorOverride = null;
    if (entry.perFloor && floorLabel) {
      var floorKey = normalizeText(floorLabel);
      // The exact floor label text coming from MapVX can vary ("Nivel 2",
      // "N2", "Piso 2"...), so besides a literal match also compare just the
      // floor number — much less fragile for whoever edits the manifest.
      var floorDigitsMatch = floorKey.match(/\d+/);
      var floorDigits = floorDigitsMatch ? floorDigitsMatch[0] : null;
      for (var key in entry.perFloor) {
        var normalizedKey = normalizeText(key);
        if (normalizedKey === floorKey) {
          floorOverride = entry.perFloor[key];
          break;
        }
        if (floorDigits) {
          var keyDigitsMatch = normalizedKey.match(/\d+/);
          if (keyDigitsMatch && keyDigitsMatch[0] === floorDigits) {
            floorOverride = entry.perFloor[key];
            break;
          }
        }
      }
    }
    function pick(field, fallback) {
      if (floorOverride && floorOverride[field] != null) return floorOverride[field];
      if (entry[field] != null) return entry[field];
      return fallback;
    }

    var scale = Number(pick("scale", 1));
    if (!isFinite(scale) || scale <= 0) scale = 1;
    var offsetX = Number(pick("offsetX", 0));
    if (!isFinite(offsetX)) offsetX = 0;
    var offsetY = Number(pick("offsetY", 0));
    if (!isFinite(offsetY)) offsetY = 0;
    // Fixed cosmetic tilt (deg, clockwise) so a logo can follow the angle of
    // its store's polygon shape (e.g. Ripley reads vertically on the official
    // Cencosud map). Independent of map bearing/zoom — markers are always
    // built with rotationAlignment "viewport", so without this they'd stay
    // screen-upright forever regardless of the polygon's orientation.
    var rotation = Number(pick("rotation", 0));
    if (!isFinite(rotation)) rotation = 0;
    if (!entry.backgroundColor && !entry.className && scale === 1 && offsetX === 0 && offsetY === 0 && rotation === 0 && !entry.offsetInCss) return null;
    return {
      backgroundColor: entry.backgroundColor ? String(entry.backgroundColor).trim() : "",
      className: entry.className ? String(entry.className).trim() : "",
      padded: entry.padded !== false && !!entry.backgroundColor,
      scale: scale,
      offsetX: offsetX,
      offsetY: offsetY,
      rotation: rotation,
      offsetInCss: !!pick("offsetInCss", false),
    };
  }

  function isConfigured(config) {
    config = config || getConfig();
    return !!(
      config.apiKey &&
      config.parentPlace &&
      config.institutionId
    );
  }

  function loadStylesheet() {
    if (stylesLoaded || document.querySelector("link[data-mapvx-styles]")) {
      stylesLoaded = true;
      return;
    }
    var href = assetsBase() + "styles.css";
    log("info", "loadStylesheet", { href: href });
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.setAttribute("data-mapvx-styles", "true");
    document.head.appendChild(link);
    stylesLoaded = true;
  }

  function ensureSdkLoaded() {
    if (typeof MapVX === "undefined" || !MapVX.initializeSDK) {
      throw new Error("MapVX SDK not loaded. Include ../shared/mapvx/index.js");
    }
  }

  function normalizeText(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseFloorFromLocal(local) {
    if (!local) return null;
    var m = String(local).trim().match(/^CC_([A-Za-z0-9,]+)_/i);
    if (!m) return null;
    return String(m[1]).toUpperCase();
  }

  function parseLevelsFromLocal(local) {
    var segment = parseFloorFromLocal(local);
    if (!segment) return [];
    if (segment === "PB") return [0];
    return segment.split(",").map(function (part) {
      var token = String(part || "").trim().toUpperCase();
      var nMatch = token.match(/^N(\d+)$/);
      if (nMatch) return parseInt(nMatch[1], 10);
      if (/^\d+$/.test(token)) return parseInt(token, 10);
      return null;
    }).filter(function (n) { return n != null; });
  }

  function clientIdMatchesCatalogLocal(clientId, catalogLocal) {
    var left = String(clientId || "").trim();
    var right = String(catalogLocal || "").trim();
    if (!left || !right) return false;
    if (left === right) return true;
    return left.toUpperCase() === right.toUpperCase();
  }

  function isCatalogNumericId(value) {
    return /^\d+$/.test(String(value || "").trim());
  }

  function parseLevelFromHint(hint) {
    if (!hint) return null;
    var h = normalizeText(hint);
    if (h === "pb" || h.indexOf("planta baja") >= 0) return 0;
    var nivelMatch = h.match(/nivel\s*(\d+)/);
    if (nivelMatch) return parseInt(nivelMatch[1], 10);
    var pisoMatch = h.match(/piso\s*(\d+)/);
    if (pisoMatch) return parseInt(pisoMatch[1], 10);
    var levelMatch = h.match(/level\s*(\d+)/);
    if (levelMatch) return parseInt(levelMatch[1], 10);
    var nMatch = h.match(/^n(\d+)$/);
    if (nMatch) return parseInt(nMatch[1], 10);
    if (/^-?\d+$/.test(h)) return parseInt(h, 10);
    return null;
  }

  function collectFloorHints(floorHint, localCode) {
    var hints = [];
    var seen = {};
    function add(v) {
      if (!v) return;
      var n = normalizeText(v);
      if (!n || seen[n]) return;
      seen[n] = true;
      hints.push(n);
    }
    function addLevel(level) {
      if (level == null || !isFinite(level)) return;
      if (level === 0) add("pb");
      add("n" + level);
      add(String(level));
    }

    var fromLocal = parseFloorFromLocal(localCode);
    if (fromLocal) add(fromLocal);
    parseLevelsFromLocal(localCode).forEach(addLevel);

    if (floorHint) {
      add(floorHint);
      var fromHint = parseLevelFromHint(floorHint);
      if (fromHint != null) addLevel(fromHint);
    }
    return hints;
  }

  function scoreFloorForHints(floor, hints) {
    if (!floor || !hints.length) return 0;
    var names = [floor.key, floor.name, floor.shortName]
      .filter(Boolean)
      .map(normalizeText);
    var levelStr =
      floor.level != null && floor.level !== "" ? String(floor.level) : null;
    var score = 0;

    for (var hi = 0; hi < hints.length; hi++) {
      var hint = hints[hi];
      var hintLevel = parseLevelFromHint(hint);

      for (var ni = 0; ni < names.length; ni++) {
        if (names[ni] === hint) score += 100;
      }

      if (/^n\d+$/.test(hint) && names.some(function (n) { return n === hint; })) {
        score += 90;
      }

      if (hintLevel != null && levelStr != null) {
        if (parseInt(levelStr, 10) === hintLevel) score += 80;
      }

      if ((hint === "pb" || hint.indexOf("planta baja") >= 0) && floor.level === 0) {
        score += 80;
      }

      if (/^\d+$/.test(hint) && levelStr === "-" + hint) {
        score -= 100;
      }
    }

    return score;
  }

  function pickFloorId(place, floorHint, parentPlace, localCode) {
    var parentFloors = (parentPlace && parentPlace.innerFloors) || [];
    var hints = collectFloorHints(
      floorHint,
      localCode || (place && place.clientId) || null
    );

    log("info", "pickFloorId hints", {
      floorHint: floorHint,
      localCode: localCode || (place && place.clientId) || null,
      hints: hints,
      inFloors: place && place.inFloors ? place.inFloors : [],
    });

    if (!parentFloors.length) {
      return place && place.inFloors && place.inFloors.length ? place.inFloors[0] : null;
    }

    if (place && place.inFloors && place.inFloors.length) {
      var validInFloors = place.inFloors.filter(function (key) {
        return parentFloors.some(function (f) { return f.key === key; });
      });

      if (validInFloors.length === 1) {
        return validInFloors[0];
      }

      if (validInFloors.length > 1) {
        var bestIn = null;
        var bestInScore = -1;
        for (var vi = 0; vi < validInFloors.length; vi++) {
          var pf = parentFloors.find(function (f) { return f.key === validInFloors[vi]; });
          if (!pf) continue;
          var scIn = scoreFloorForHints(pf, hints);
          if (scIn > bestInScore) {
            bestInScore = scIn;
            bestIn = validInFloors[vi];
          }
        }
        if (bestIn && bestInScore > 0) return bestIn;
      }

      if (validInFloors.length && !hints.length) {
        return validInFloors[0];
      }
    }

    if (hints.length) {
      var bestKey = null;
      var bestScore = -1;
      for (var i = 0; i < parentFloors.length; i++) {
        var sc = scoreFloorForHints(parentFloors[i], hints);
        if (sc > bestScore) {
          bestScore = sc;
          bestKey = parentFloors[i].key;
        }
      }
      if (bestKey && bestScore > 0) return bestKey;
    }

    if (place && place.inFloors && place.inFloors.length) {
      return place.inFloors[0];
    }

    return pickDefaultFloorKey(parentPlace);
  }

  function pickDefaultFloorKey(parentPlace) {
    if (!parentPlace || !parentPlace.innerFloors || !parentPlace.innerFloors.length) {
      return null;
    }
    var floors = parentPlace.innerFloors.slice().sort(function (a, b) {
      return (a.index || 0) - (b.index || 0);
    });
    var def = floors.find(function (f) { return f.defaultFloor; });
    return (def || floors[0]).key;
  }

  function fitMapToPlace(mapInstance, position, config) {
    config = config || getConfig();
    if (!position) {
      return;
    }
    var lat = position.lat;
    var lng = position.lng;
    if (lat == null || lng == null) {
      return;
    }

    var radiusMeters = config.placeFitRadiusMeters != null
      ? Number(config.placeFitRadiusMeters)
      : 140;
    var boundsCoords = expandSingleCoordinate(position, radiusMeters);

    if (boundsCoords && boundsCoords.length >= 2 && typeof mapInstance.fitCoordinates === "function") {
      var maxZoom = config.placeFitMaxZoom != null ? Number(config.placeFitMaxZoom) : 18.5;
      var padding = config.placeFitPadding != null ? Number(config.placeFitPadding) : 80;
      mapInstance.fitCoordinates(boundsCoords, {
        padding: padding,
        maxZoom: maxZoom,
        duration: config.placeFitDuration != null ? Number(config.placeFitDuration) : 0,
      });
      log("info", "fitMapToPlace fitCoordinates", {
        lat: lat,
        lng: lng,
        radiusMeters: radiusMeters,
        maxZoom: maxZoom,
        padding: padding,
      });
      return;
    }

    if (typeof mapInstance.setCenter === "function") {
      mapInstance.setCenter({ lat: lat, lng: lng });
    } else if (typeof mapInstance.fitCoordinates === "function") {
      mapInstance.fitCoordinates([{ lat: lat, lng: lng }], { duration: 0 });
    }
    log("info", "fitMapToPlace fallback center", { lat: lat, lng: lng });
  }

  function buildBoundsCoordinates(coords, paddingRatio) {
    if (!coords || coords.length < 2) return coords;

    var minLat = null;
    var minLng = null;
    var maxLat = null;
    var maxLng = null;

    coords.forEach(function (coord) {
      if (!coord || coord.lat == null || coord.lng == null) return;
      var lat = Number(coord.lat);
      var lng = Number(coord.lng);
      if (!isFinite(lat) || !isFinite(lng)) return;
      minLat = minLat === null ? lat : Math.min(minLat, lat);
      minLng = minLng === null ? lng : Math.min(minLng, lng);
      maxLat = maxLat === null ? lat : Math.max(maxLat, lat);
      maxLng = maxLng === null ? lng : Math.max(maxLng, lng);
    });

    if (minLat === null || minLng === null || maxLat === null || maxLng === null) {
      return coords;
    }

    var latSpan = Math.max(maxLat - minLat, 0.0001);
    var lngSpan = Math.max(maxLng - minLng, 0.0001);
    var padLat = latSpan * (paddingRatio != null ? paddingRatio : 0.08);
    var padLng = lngSpan * (paddingRatio != null ? paddingRatio : 0.08);

    return [
      { lng: minLng - padLng, lat: minLat - padLat },
      { lng: maxLng + padLng, lat: minLat - padLat },
      { lng: maxLng + padLng, lat: maxLat + padLat },
      { lng: minLng - padLng, lat: maxLat + padLat },
    ];
  }

  function resolveMapZoomLimits(config) {
    config = config || getConfig();
    return {
      minZoom: config.minZoom != null ? Number(config.minZoom) : null,
      maxZoom: config.maxZoom != null ? Number(config.maxZoom) : 22,
    };
  }

  function expandSingleCoordinate(position, meters) {
    if (!position || position.lat == null || position.lng == null) return null;
    var lat = Number(position.lat);
    var lng = Number(position.lng);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    var radiusMeters = meters != null ? Number(meters) : 220;
    var latDelta = radiusMeters / 111320;
    var lngScale = Math.cos(lat * Math.PI / 180);
    var lngDelta = radiusMeters / (111320 * (lngScale || 1));
    return [
      { lng: lng - lngDelta, lat: lat - latDelta },
      { lng: lng + lngDelta, lat: lat - latDelta },
      { lng: lng + lngDelta, lat: lat + latDelta },
      { lng: lng - lngDelta, lat: lat + latDelta },
    ];
  }

  function buildIndoorBoundsCoords(coords, config) {
    if (!coords || !coords.length) return null;
    var paddingRatio = config.maxBoundsPaddingRatio != null ? config.maxBoundsPaddingRatio : 0.2;
    if (coords.length >= 2) {
      return buildBoundsCoordinates(coords, paddingRatio);
    }
    return expandSingleCoordinate(coords[0], config.singlePointBoundsMeters);
  }

  function applyIndoorViewConstraints(mapInstance, config, coords) {
    if (!mapInstance || !coords || !coords.length || config.enableBoundsClamp === false) {
      return;
    }

    var boundsCoords = buildIndoorBoundsCoords(coords, config);
    if (boundsCoords && boundsCoords.length >= 2 && typeof mapInstance.setMaxBounds === "function") {
      mapInstance.setMaxBounds(boundsCoords);
      log("info", "applyIndoorViewConstraints maxBounds", {
        points: boundsCoords.length,
        paddingRatio: config.maxBoundsPaddingRatio != null ? config.maxBoundsPaddingRatio : 0.2,
      });
    }

    var zoomLimits = resolveMapZoomLimits(config);
    if (zoomLimits.maxZoom != null && typeof mapInstance.setMaxZoom === "function") {
      mapInstance.setMaxZoom(zoomLimits.maxZoom);
    }
  }

  function applyDynamicMinZoomFromFit(mapInstance, config) {
    if (!mapInstance || typeof mapInstance.setMinZoom !== "function") {
      return;
    }
    var overviewZoom = getMapZoom(mapInstance);
    if (!isFinite(overviewZoom)) return;

    var maxOut = config.maxZoomOutLevels != null ? Number(config.maxZoomOutLevels) : 1.5;
    var configuredFloor = config.minZoom != null ? Number(config.minZoom) : 15;
    var dynamicMin = overviewZoom - maxOut;
    var effectiveMin = Math.max(configuredFloor, dynamicMin);

    mapInstance.setMinZoom(effectiveMin);
    log("info", "applyDynamicMinZoomFromFit", {
      overviewZoom: overviewZoom,
      effectiveMin: effectiveMin,
      maxZoomOutLevels: maxOut,
    });
  }

  function getPlaceLogoUrl(place) {
    if (!place) return "";
    var candidates = [];
    if (place.logo) {
      if (typeof place.logo === "string") {
        candidates.push(place.logo);
      } else if (typeof place.logo === "object") {
        candidates.push(place.logo.light, place.logo.dark, place.logo.url);
      }
    }
    candidates.push(
      place.logoUrl,
      place.imageUrl,
      place.image
    );
    if (place.images && place.images.length) {
      candidates.push(place.images[0] && (place.images[0].url || place.images[0].src || place.images[0].imageUrl));
    }
    if (place.metadata) {
      candidates.push(place.metadata.logoUrl, place.metadata.imageUrl);
    }
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i]) {
        return String(candidates[i]).trim();
      }
    }
    return "";
  }

  function getStoreLogoOverrideKey(place) {
    if (!place) return "";
    return normalizeText(
      place.clientId || place.title || place.shortName || place.name || ""
    );
  }

  function isBlockedLegacyMapVxLogo(place) {
    if (!place) return false;
    var keys = [
      place.mapvxId,
      place.clientId,
      place.title,
      place.shortName,
      place.name,
    ].map(normalizeText).filter(Boolean);

    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (brandKeyMatches(key, "nike") || brandKeyMatches(key, "nike rise")) {
        return true;
      }
    }
    return false;
  }

  function getStoreLogoUrl(place, config, manifest) {
    config = config || getConfig();
    var overrides = config.storeLogoOverrides || {};
    var keys = [
      place && place.mapvxId,
      place && place.clientId,
      place && place.title,
      place && place.shortName,
      place && place.name,
      getStoreLogoOverrideKey(place),
    ];
    for (var i = 0; i < keys.length; i++) {
      var rawKey = keys[i] ? String(keys[i]).trim() : "";
      if (!rawKey) continue;
      if (overrides[rawKey]) return String(overrides[rawKey]).trim();
      var normalized = normalizeText(rawKey);
      if (overrides[normalized]) return String(overrides[normalized]).trim();
    }

    var localLogo = getLocalStoreLogoUrl(place, config, manifest);
    if (localLogo) return localLogo;

    // Explicitly block Nike legacy logos coming from MapVX remote payloads.
    if (isBlockedLegacyMapVxLogo(place)) return "";

    return getPlaceLogoUrl(place);
  }

  function getAnchorBrandStyle(place) {
    var key = normalizeText(getPlaceDisplayTitle(place));
    if (!key) return null;
    if (key.indexOf("falabella") >= 0) {
      return { kind: "text", text: "falabella.", className: "mapvx-anchor-falabella" };
    }
    if (key.indexOf("ripley") >= 0) {
      return { kind: "text", text: "RIPLEY", className: "mapvx-anchor-ripley" };
    }
    if (key.indexOf("paris") >= 0) {
      return { kind: "paris", text: "paris", subtext: "cencosud", className: "mapvx-anchor-paris" };
    }
    if (key.indexOf("casa ideas") >= 0) {
      return { kind: "text", text: "casa ideas", className: "mapvx-anchor-casa-ideas" };
    }
    if (key.indexOf("la polar") >= 0) {
      return { kind: "text", text: "La Polar", className: "mapvx-anchor-casa-ideas" };
    }
    return null;
  }

  function buildAnchorBrandElement(brandStyle) {
    if (!brandStyle) return null;
    var wrap = document.createElement("div");
    wrap.className = "mapvx-anchor-brand " + (brandStyle.className || "");

    if (brandStyle.kind === "paris") {
      var ring = document.createElement("div");
      ring.className = "mapvx-anchor-paris-ring";
      ring.textContent = brandStyle.text || "paris";
      if (brandStyle.subtext) {
        var sub = document.createElement("span");
        sub.className = "mapvx-anchor-paris-sub";
        sub.textContent = brandStyle.subtext;
        ring.appendChild(sub);
      }
      wrap.appendChild(ring);
      return wrap;
    }

    wrap.textContent = brandStyle.text || "";
    return wrap;
  }

  function buildAnchorLogoElement(place, logoUrl, logoDims, config, floorLabel) {
    config = config || getConfig();
    var width = logoDims && logoDims.width ? logoDims.width : 140;
    var height = logoDims && logoDims.height ? logoDims.height : 56;
    var wrap = document.createElement("div");
    wrap.style.width = width + "px";
    wrap.style.height = height + "px";
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.justifyContent = "center";
    wrap.style.pointerEvents = "none";

    var treatment = getLocalStoreLogoTreatment(place, null, floorLabel);
    if (floorLabel && getConfig().debugMapvx) {
      // Lets whoever is tuning offsets in the manifest see exactly what
      // string to use as a `perFloor` key for this store/floor combo.
      log("info", "anchorLogo floor treatment", {
        place: getPlaceDisplayTitle(place),
        floorLabel: floorLabel,
        offsetX: treatment ? treatment.offsetX : 0,
        offsetY: treatment ? treatment.offsetY : 0,
        rotation: treatment ? treatment.rotation : 0,
      });
    }
    if (treatment) {
      // Only draw the colored badge (background + shadow) when a backgroundColor
      // is defined. Scale-only logos stay fully transparent (no box/shadow).
      if (treatment.backgroundColor) {
        wrap.className = "mapvx-anchor-logo-backdrop" + (treatment.className ? " " + treatment.className : "");
        wrap.style.backgroundColor = treatment.backgroundColor;
      } else if (treatment.className) {
        wrap.className = treatment.className;
      }
      // Keep a stable marker box so logo size/placement remains consistent
      // across zoom changes (avoid auto-size wrapper jitter).
      wrap.style.display = "flex";
      wrap.style.width = width + "px";
      wrap.style.height = height + "px";
      if (treatment.padded) {
        wrap.style.boxSizing = "border-box";
        wrap.style.padding = Math.max(3, Math.round(height * 0.1)) + "px " + Math.max(8, Math.round(height * 0.2)) + "px";
      }
      // Cosmetic rotation only for map-baked offsets. When offsetInCss is set
      // (Zara), positional nudge stays as DOM translate like before the
      // zoom-independent coordinate bake — that brand was already tuned that way.
      var transformParts = [];
      if (treatment.offsetInCss && (treatment.offsetX || treatment.offsetY)) {
        transformParts.push(
          "translate(" + (treatment.offsetX || 0) + "px, " + (treatment.offsetY || 0) + "px)"
        );
      }
      if (treatment.rotation) {
        transformParts.push("rotate(" + treatment.rotation + "deg)");
      }
      if (transformParts.length) {
        wrap.style.transform = transformParts.join(" ");
      }
    }

    if (logoUrl) {
      var img = document.createElement("img");
      img.className = "mapvx-anchor-logo";
      img.alt = "";
      img.loading = "eager";
      img.decoding = "async";
      img.src = logoUrl;
      if (treatment) {
        // Size the logo by a target height (scaled) and let width follow the aspect ratio.
        var baseHeight = treatment.backgroundColor ? height * 0.62 : height;
        img.style.width = "auto";
        img.style.height = Math.round(baseHeight * treatment.scale) + "px";
        img.style.maxWidth = "none";
      }
      img.onerror = function () {
        log("warn", "anchor logo image failed to load", {
          place: getPlaceDisplayTitle(place),
          logoUrl: logoUrl,
        });
        if (!img.parentNode) return;
        var brand = buildAnchorBrandElement(getAnchorBrandStyle(place));
        if (brand) {
          img.parentNode.replaceChild(brand, img);
          return;
        }
        wrap.style.display = "none";
      };
      wrap.appendChild(img);
      return wrap;
    }

    return buildAnchorBrandElement(getAnchorBrandStyle(place));
  }

  async function enrichPlaceLogo(place, config) {
    if (!place || getStoreLogoUrl(place, config)) return place;
    if (!place.mapvxId || !sdk || typeof sdk.getPlaceDetail !== "function") return place;
    try {
      var detail = await sdk.getPlaceDetail(place.mapvxId);
      if (detail) {
        return Object.assign({}, place, detail);
      }
    } catch (e) {
      log("warn", "enrichPlaceLogo failed", {
        mapvxId: place.mapvxId,
        title: place.title,
        error: String(e.message || e),
      });
    }
    return place;
  }

  function getFeaturedLogoDimensions(config) {
    config = config || getConfig();
    var width = config.featuredLogoWidth != null ? Number(config.featuredLogoWidth) : 140;
    var height = config.featuredLogoHeight != null ? Number(config.featuredLogoHeight) : 56;
    // Scale logo box to the map viewport (55" totem ≈ 1080px design width).
    var designWidth = config.anchorLogoDesignWidth != null ? Number(config.anchorLogoDesignWidth) : 1080;
    var mapEl = document.getElementById("mapvx-container") || document.getElementById("map-container");
    if (mapEl && mapEl.clientWidth > 0 && isFinite(designWidth) && designWidth > 0) {
      var viewportScale = mapEl.clientWidth / designWidth;
      viewportScale = Math.max(0.7, Math.min(1.4, viewportScale));
      width = Math.round(width * viewportScale);
      height = Math.round(height * viewportScale);
    }
    return { width: width, height: height };
  }

  function getPlaceDisplayTitle(place) {
    if (!place) return "";
    var raw = String(place.title || place.shortName || place.name || place.clientId || "").trim();
    // Some MapVX place titles arrive suffixed like "Brand - mallCC".
    // Strip that noisy suffix for cleaner store labels/popovers.
    raw = raw.replace(/\s*-\s*mall\s*cc\s*$/i, "");
    raw = raw.replace(/\s*-\s*mallcc\s*$/i, "");
    return raw.trim();
  }

  function looksLikeInternalPlaceId(value) {
    var s = String(value || "").trim();
    if (!s || /\s/.test(s)) return false;
    // Pure hex tokens (Foursquare/Firebase-style).
    if (/^[0-9a-f]{16,}$/i.test(s)) return true;
    // Opaque MapVX ids: long single-token strings mixing letters and digits.
    if (s.length >= 12 && /^[a-z0-9_-]+$/i.test(s) && /\d/.test(s) && /[a-z]/i.test(s)) {
      return true;
    }
    return false;
  }

  function getPlaceDisplaySubtitle(place) {
    if (!place) return "";
    var cat = String(place.categoryName || place.category || "").trim();
    if (cat && !looksLikeInternalPlaceId(cat)) return cat;
    // Use shortDescription only if short enough to be a human label.
    var sd = String(place.shortDescription || "").trim();
    if (sd && sd.length <= 60 && !looksLikeInternalPlaceId(sd)) return sd;
    return "";
  }

  function getFloorDisplayLabel(floorId) {
    var key = String(floorId || "").trim();
    if (!key) return "";
    var floors = getMapFloors();
    for (var i = 0; i < floors.length; i++) {
      if (String(floors[i].key || "").trim() === key) {
        return String(floors[i].label || floors[i].shortName || floors[i].key || key);
      }
    }
    return key;
  }

  function getPlaceInitials(place) {
    var title = getPlaceDisplayTitle(place);
    if (!title) return "?";
    var words = title.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return "?";
    if (words.length === 1) {
      return words[0].substring(0, 2).toUpperCase();
    }
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  }

  function ensurePlacePopOverNode(mapInstance) {
    var container = mapInstance && typeof mapInstance.getCanvasContainer === "function"
      ? mapInstance.getCanvasContainer()
      : (mapInstance && typeof mapInstance.getContainer === "function"
        ? mapInstance.getContainer()
        : mapContainer);
    if (!container) return null;

    if (!placePopOverState.node || placePopOverState.node.parentNode !== container) {
      if (placePopOverState.node && placePopOverState.node.parentNode) {
        placePopOverState.node.parentNode.removeChild(placePopOverState.node);
      }

      var layer = document.createElement("div");
      layer.className = "mapvx-place-popover-layer";
      layer.setAttribute("aria-hidden", "true");
      layer.style.zIndex = "9999";

      var popover = document.createElement("div");
      popover.className = "mapvx-place-popover hidden";
      popover.setAttribute("data-mapvx-place-popover", "true");

      var card = document.createElement("div");
      card.className = "mapvx-place-popover-card";

      var arrow = document.createElement("div");
      arrow.className = "mapvx-place-popover-arrow";

      var logoWrap = document.createElement("div");
      logoWrap.className = "mapvx-place-popover-logo-wrap";
      logoWrap.setAttribute("data-mapvx-popover-logo", "true");

      var body = document.createElement("div");
      body.className = "mapvx-place-popover-body";

      var title = document.createElement("div");
      title.className = "mapvx-place-popover-title";
      title.setAttribute("data-mapvx-popover-title", "true");

      var floor = document.createElement("div");
      floor.className = "mapvx-place-popover-floor";
      floor.setAttribute("data-mapvx-popover-floor", "true");

      body.appendChild(title);
      body.appendChild(floor);
      card.appendChild(arrow);
      card.appendChild(logoWrap);
      card.appendChild(body);
      popover.appendChild(card);
      layer.appendChild(popover);
      container.appendChild(layer);
      placePopOverState.node = layer;
    }

    return placePopOverState.node;
  }

  function buildPlacePopOverContent(place, floorId) {
    var wrap = document.createElement("div");
    wrap.className = "mapvx-place-popover-content";

    var logoWrap = document.createElement("div");
    logoWrap.className = "mapvx-place-popover-logo-wrap";
    var logoUrl = getPlaceLogoUrl(place);
    var initials = getPlaceInitials(place);
    if (logoUrl) {
      var img = document.createElement("img");
      img.className = "mapvx-place-popover-logo";
      img.alt = "";
      img.loading = "lazy";
      img.src = logoUrl;
      img.onerror = function () {
        if (!img.parentNode) return;
        var fallback = document.createElement("div");
        fallback.className = "mapvx-place-popover-initials";
        fallback.textContent = initials;
        img.parentNode.replaceChild(fallback, img);
      };
      logoWrap.appendChild(img);
    } else {
      var fallbackLogo = document.createElement("div");
      fallbackLogo.className = "mapvx-place-popover-initials";
      fallbackLogo.textContent = initials;
      logoWrap.appendChild(fallbackLogo);
    }

    var body = document.createElement("div");
    body.className = "mapvx-place-popover-body";

    var title = document.createElement("div");
    title.className = "mapvx-place-popover-title";
    title.textContent = getPlaceDisplayTitle(place);

    body.appendChild(title);

    var subtitle = getPlaceDisplaySubtitle(place);
    if (subtitle) {
      var subtitleEl = document.createElement("div");
      subtitleEl.className = "mapvx-place-popover-subtitle";
      subtitleEl.textContent = subtitle;
      body.appendChild(subtitleEl);
    }

    var floorLabel = getFloorDisplayLabel(floorId || (place && place.inFloors && place.inFloors[0]));
    if (floorLabel) {
      var floor = document.createElement("div");
      floor.className = "mapvx-place-popover-floor";
      floor.textContent = floorLabel;
      body.appendChild(floor);
    }

    wrap.appendChild(logoWrap);
    wrap.appendChild(body);
    return wrap;
  }

  function renderPlacePopOverContent(place, root) {
    if (!place || !root) return;
    var titleEl = root.querySelector("[data-mapvx-popover-title]");
    var floorEl = root.querySelector("[data-mapvx-popover-floor]");
    var logoWrap = root.querySelector("[data-mapvx-popover-logo]");
    var title = getPlaceDisplayTitle(place);
    var logoUrl = getPlaceLogoUrl(place);
    var initials = getPlaceInitials(place);
    var floorLabel = getFloorDisplayLabel(placePopOverState.floorId || (place.inFloors && place.inFloors[0]));

    if (titleEl) titleEl.textContent = title;
    if (floorEl) {
      floorEl.textContent = floorLabel;
      floorEl.classList.toggle("hidden", !floorLabel);
    }
    if (logoWrap) {
      logoWrap.innerHTML = "";
      if (logoUrl) {
        var img = document.createElement("img");
        img.className = "mapvx-place-popover-logo";
        img.alt = "";
        img.loading = "lazy";
        img.src = logoUrl;
        img.onerror = function () {
          if (!img.parentNode) return;
          var fallback = document.createElement("div");
          fallback.className = "mapvx-place-popover-initials";
          fallback.textContent = initials;
          img.parentNode.replaceChild(fallback, img);
        };
        logoWrap.appendChild(img);
      } else {
        var fallback2 = document.createElement("div");
        fallback2.className = "mapvx-place-popover-initials";
        fallback2.textContent = initials;
        logoWrap.appendChild(fallback2);
      }
    }
  }

  function resolvePlaceLabelPosition(mapInstance, place, floorId) {
    if (!place || !place.position) return null;
    var libreMap = getLibreMap(mapInstance);
    var activeFloorId = floorId || (mapInstance && mapInstance.currentFloor) || null;
    if (libreMap && place.mapvxId && activeFloorId) {
      var centroids = getCentroidsForFloor(libreMap, activeFloorId);
      if (centroids[place.mapvxId]) {
        return centroids[place.mapvxId];
      }
    }
    return place.position;
  }

  function updatePlacePopOverPosition() {
    if (!placePopOverState.map || !placePopOverState.node || !placePopOverState.place) {
      return;
    }

    var root = placePopOverState.node.querySelector("[data-mapvx-place-popover]");
    if (!root) return;

    try {
      renderPlacePopOverContent(placePopOverState.place, root);
      var labelPos = resolvePlaceLabelPosition(placePopOverState.map, placePopOverState.place, placePopOverState.floorId);
      if (!labelPos || labelPos.lat == null || labelPos.lng == null) {
        root.classList.add("hidden");
        return;
      }
      var point = placePopOverState.map.project({
        lng: labelPos.lng,
        lat: labelPos.lat,
      });
      if (!point || point.x == null || point.y == null) {
        root.classList.add("hidden");
        return;
      }
      root.style.left = point.x + "px";
      root.style.top = point.y + "px";
      root.classList.remove("hidden");
    } catch (e) {
      root.classList.add("hidden");
      log("warn", "updatePlacePopOverPosition failed", { error: String(e.message || e) });
    }
  }

  function schedulePlacePopOverUpdate() {
    if (placePopOverState.scheduled) return;
    placePopOverState.scheduled = true;
    requestAnimationFrame(function () {
      placePopOverState.scheduled = false;
      updatePlacePopOverPosition();
    });
  }

  function bindPlacePopOverEvents(mapInstance) {
    if (!mapInstance || placePopOverState.listenersBound) {
      return;
    }
    placePopOverState.listenersBound = true;
    placePopOverState.map = mapInstance;
    if (typeof mapInstance.on === "function") {
      mapInstance.on("move", schedulePlacePopOverUpdate);
      mapInstance.on("zoom", schedulePlacePopOverUpdate);
      mapInstance.on("rotate", schedulePlacePopOverUpdate);
      mapInstance.on("pitch", schedulePlacePopOverUpdate);
      mapInstance.on("resize", schedulePlacePopOverUpdate);
      mapInstance.on("moveend", schedulePlacePopOverUpdate);
    }
  }

  function clearPlacePopOver() {
    hidePlacePopOver();
    placePopOverState.map = null;
    placePopOverState.placeId = null;
    placePopOverState.floorId = null;
    placePopOverState.place = null;
    placePopOverState.node = null;
    placePopOverState.listenersBound = false;
    placePopOverState.scheduled = false;
    placePopOverState.visible = false;
  }

  function hidePlacePopOver() {
    if (placePopOverState.map && typeof placePopOverState.map.removePopOver === "function" && placePopOverState.visible) {
      try {
        placePopOverState.map.removePopOver(placePopOverState.placeId);
      } catch (e) {
        log("warn", "removePopOver failed", { error: String(e.message || e) });
      }
    }
    if (placePopOverState.node && placePopOverState.node.parentNode) {
      placePopOverState.node.parentNode.removeChild(placePopOverState.node);
    }
    placePopOverState.node = null;
    placePopOverState.visible = false;
  }

  function showPlacePopOver(mapInstance, place, floorId) {
    if (!mapInstance || !place || !place.position || place.position.lat == null || place.position.lng == null) {
      clearPlacePopOver();
      return null;
    }

    if (typeof mapInstance.removePopOver === "function") {
      try {
        mapInstance.removePopOver(placePopOverState.placeId);
      } catch (e) {
        log("warn", "removePopOver before show failed", { error: String(e.message || e) });
      }
    }
    placePopOverState.map = mapInstance;
    placePopOverState.place = place;
    placePopOverState.placeId = place.mapvxId || place.clientId || getPlaceDisplayTitle(place) || null;
    placePopOverState.floorId = floorId || (place.inFloors && place.inFloors.length ? place.inFloors[0] : null);

    if (typeof mapInstance.addPopOver === "function") {
      mapInstance.addPopOver({
        placeId: placePopOverState.placeId,
        content: buildPlacePopOverContent(place, placePopOverState.floorId),
        maxWidth: "380px",
        className: "mapvx-sdk-popover",
      });
    } else {
      ensurePlacePopOverNode(mapInstance);
      bindPlacePopOverEvents(mapInstance);
      schedulePlacePopOverUpdate();
      updatePlacePopOverPosition();
    }
    placePopOverState.visible = true;

    log("info", "showPlacePopOver", {
      placeId: placePopOverState.placeId,
      floorId: placePopOverState.floorId,
      title: getPlaceDisplayTitle(place),
    });

    return placePopOverState.placeId;
  }

  function refreshPopOverFloorLabel() {
    if (!placePopOverState.visible || !placePopOverState.floorId) return;
    var label = getFloorDisplayLabel(placePopOverState.floorId);
    if (!label) return;
    var nodes = document.querySelectorAll(".mapvx-place-popover-floor");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = label;
    }
  }

  function getStoreLabelMode(config) {
    config = config || getConfig();
    var mode = config.showStoreLabels;
    if (mode === true || mode === "all") return "all";
    if (mode === "featured") return "featured";
    if (mode === "selected") return "selected";
    return "none";
  }

  function shouldRenderStoreLabels(config) {
    return getStoreLabelMode(config) !== "none";
  }

  function getStoreLabelLimit(config) {
    config = config || getConfig();
    var limit = Number(config.storeLabelMax);
    if (!isFinite(limit) || limit <= 0) {
      return 0;
    }
    return Math.floor(limit);
  }

  // Totem hardware is a Rockchip RK3566/RK3576 with a Mali-G52 GPU and 4GB RAM
  // (confirmed spec sheet) — even scoped to a single floor, a very dense
  // floor (food court, anchor level) could still create a lot of live
  // markers. Respect an explicit MAPVX_CONFIG.storeLabelMax if Unity sets
  // one; otherwise fall back to a safe default instead of "unlimited".
  var DEFAULT_ALL_MODE_LABEL_LIMIT = 60;
  function getAllModeLabelLimit(config) {
    config = config || getConfig();
    var explicit = Number(config.storeLabelMax);
    if (isFinite(explicit) && explicit > 0) return Math.floor(explicit);
    return DEFAULT_ALL_MODE_LABEL_LIMIT;
  }

  function clearStoreLabelMarkers() {
    // Detach centroid listener
    if (centroidUpdateTimer) {
      clearTimeout(centroidUpdateTimer);
      centroidUpdateTimer = null;
    }
    if (storeLabelState.centroidListener) {
      try {
        var cl = storeLabelState.centroidListener;
        cl.libreMap.off("moveend", cl.fn);
        cl.libreMap.off("zoomend", cl.fn);
        cl.libreMap.off("resize", cl.fn);
      } catch (e) {}
      storeLabelState.centroidListener = null;
    }
    storeLabelState.labelPlaceMarkers = [];
    storeLabelState.allModeFloorId = null;
    clearPoiCentroidCache();

    if (!map || !storeLabelState.markerIds.length) {
      storeLabelState.markerIds = [];
      return;
    }

    var ids = storeLabelState.markerIds.slice();
    storeLabelState.markerIds = [];
    ids.forEach(function (markerId) {
      if (!markerId || typeof map.removeMarker !== "function") {
        return;
      }
      try {
        map.removeMarker(markerId);
      } catch (e) {
        log("warn", "remove store label marker failed", {
          markerId: markerId,
          error: String(e.message || e),
        });
      }
    });
  }

  // IndoorEqual: rank1 = shops/restaurants + mixed POIs; rank2 = vending, info;
  // indoor-transportation-poi = stairs/elevators/escalators (always visible).
  // Allowlist on rank1 — exclusion missed classes and style reloads during routes
  // restored retail icons (t-shirt, cart, etc.).
  var ESSENTIAL_POI_CLASSES = [
    "information",
    "entrance",
    "telephone",
  ];
  var ESSENTIAL_POI_SUBCLASSES = [
    "toilets",
    "toilet",
    "restroom",
    "drinking_water",
    "wheelchair",
    "first_aid",
    "defibrillator",
    "changing_table",
    "reception",
    "information",
    "help_point",
    "lost_property",
  ];
  var retailPoiFilterTimer = null;
  var retailPoiFilterDelays = [200, 650, 1500, 3000];

  function shouldHideRetailPoiIcons(config) {
    config = config || getConfig();
    return config.hideRetailPoiIcons !== false;
  }

  function essentialPoiAllowFilter() {
    return [
      "any",
      ["in", ["get", "class"], ["literal", ESSENTIAL_POI_CLASSES]],
      ["in", ["get", "subclass"], ["literal", ESSENTIAL_POI_SUBCLASSES]],
    ];
  }

  function filterIsEssentialAllowlist(filter) {
    if (!filter) return false;
    var json;
    try {
      json = JSON.stringify(filter);
    } catch (e) {
      return false;
    }
    return json.indexOf('"information"') >= 0 && json.indexOf('"toilets"') >= 0;
  }

  function isRetailPoiRankLayer(layer) {
    if (!layer || layer.type !== "symbol") return false;
    if (layer.source !== "indoorequal") return false;
    if (layer["source-layer"] !== "poi") return false;
    var id = String(layer.id || "");
    return id === "indoor-poi-rank1" || id === "base-indoor-poi-rank1";
  }

  function applyRetailPoiIconFilter(mapInstance, config) {
    config = config || getConfig();
    if (!shouldHideRetailPoiIcons(config)) return;

    var libreMap = getLibreMap(mapInstance);
    if (!libreMap || typeof libreMap.getStyle !== "function") return;

    var style = libreMap.getStyle();
    var layers = (style && style.layers) || [];
    var allow = essentialPoiAllowFilter();
    var updated = [];

    layers.filter(isRetailPoiRankLayer).forEach(function (layer) {
      try {
        var current = libreMap.getFilter(layer.id);
        if (filterIsEssentialAllowlist(current)) return;
        libreMap.setFilter(layer.id, allow);
        updated.push(layer.id);
      } catch (e) {
        log("warn", "applyRetailPoiIconFilter layer failed", {
          layerId: layer.id,
          error: String(e.message || e),
        });
      }
    });

    if (updated.length) {
      log("info", "applyRetailPoiIconFilter allowlist", { layers: updated });
    }
  }

  function attachPoiFilterStyleGuard(mapInstance, config) {
    var libreMap = getLibreMap(mapInstance);
    if (!libreMap || typeof libreMap.on !== "function") return;
    if (libreMap.__mapvxPoiFilterGuard) return;
    libreMap.__mapvxPoiFilterGuard = true;
    libreMap.on("styledata", function () {
      scheduleRetailPoiIconFilter(mapInstance, config || getConfig());
    });
  }

  function scheduleRetailPoiIconFilter(mapInstance, config) {
    if (!shouldHideRetailPoiIcons(config)) return;
    if (retailPoiFilterTimer) {
      clearTimeout(retailPoiFilterTimer);
    }
    retailPoiFilterTimer = setTimeout(function () {
      retailPoiFilterTimer = null;
      applyRetailPoiIconFilter(mapInstance, config);
    }, retailPoiFilterDelays[0]);
    retailPoiFilterDelays.forEach(function (delay) {
      setTimeout(function () {
        applyRetailPoiIconFilter(mapInstance, config);
      }, delay);
    });
  }

  function queryPOICentroidsForDebug(libreMap) {
    return queryPOICentroids(libreMap, map && map.currentFloor ? map.currentFloor : null);
  }

  function applyFeaturedCentroids(mapInst, centroids, floorId) {
    if (!mapInst || !centroids || !floorId || !storeLabelState.labelPlaceMarkers.length) return;
    // Only touch markers that belong to the floor these centroids were
    // queried for — a shared mapvxId across floors must not overwrite a
    // different floor's marker with this floor's point (see queryPOICentroids).
    var toUpdate = storeLabelState.labelPlaceMarkers.filter(function (entry) {
      return entry.place && entry.place.mapvxId && entry.floorId === floorId && centroids[entry.place.mapvxId];
    });
    if (!toUpdate.length) return;

    toUpdate.forEach(function (entry) {
      var centroidPos = centroids[entry.place.mapvxId];
      // Skip if already at centroid (within ~1cm precision)
      if (entry.centroidApplied) return;

      // Remove old marker
      try {
        if (typeof mapInst.removeMarker === "function") {
          mapInst.removeMarker(entry.markerId);
        }
      } catch (e) {}
      // Remove from global list
      var idx = storeLabelState.markerIds.indexOf(entry.markerId);
      if (idx !== -1) storeLabelState.markerIds.splice(idx, 1);

      // Re-add at centroid
      var markerConfigs = buildStoreLabelMarkers(
        Object.assign({}, entry.place, { position: centroidPos }),
        entry.floorId,
        entry.featured,
        getConfig(),
        false,
        null,
        getLibreMap(mapInst)
      );
      markerConfigs.forEach(function (cfg) {
        if (cfg.floorId !== entry.floorId) return;
        try {
          var newId = mapInst.addMarker(cfg);
          if (newId) {
            storeLabelState.markerIds.push(newId);
            entry.markerId = newId;
            entry.centroidApplied = true;
            entry.anchorCentroid = centroidPos;
          }
        } catch (e) {}
      });
    });
    syncFeaturedLogoPositions(mapInst);
  }

  function attachCentroidUpdater(mapInst) {
    var libreMap = mapInst && mapInst.map;
    if (!libreMap || typeof libreMap.queryRenderedFeatures !== "function") return;
    if (!storeLabelState.labelPlaceMarkers.length) return;

    // Detach any previous listener
    if (storeLabelState.centroidListener) {
      try { storeLabelState.centroidListener.libreMap.off("moveend", storeLabelState.centroidListener.fn); } catch (e) {}
      try { storeLabelState.centroidListener.libreMap.off("zoomend", storeLabelState.centroidListener.fn); } catch (e) {}
      try { storeLabelState.centroidListener.libreMap.off("resize", storeLabelState.centroidListener.fn); } catch (e) {}
      storeLabelState.centroidListener = null;
    }

    function runUpdate() {
      if (centroidUpdateTimer) clearTimeout(centroidUpdateTimer);
      centroidUpdateTimer = setTimeout(function () {
        centroidUpdateTimer = null;
        if (map !== mapInst) return;
        var floorId = mapInst.currentFloor;
        if (!floorId) return;

        // Re-project manifest pixel offsets whenever the map zoom or viewport
        // changes so anchor logos stay on their polygons (totem 55", emulators, dev).
        syncFeaturedLogoPositions(mapInst);

        var pending = storeLabelState.labelPlaceMarkers.some(function (e) {
          return e.floorId === floorId && !e.centroidApplied;
        });
        if (pending) {
          clearPoiCentroidCache();
          var centroids = queryPOICentroids(libreMap, floorId);
          applyFeaturedCentroids(mapInst, centroids, floorId);
        }
      }, 120);
    }

    storeLabelState.centroidListener = { libreMap: libreMap, fn: runUpdate };
    libreMap.on("moveend", runUpdate);
    libreMap.on("zoomend", runUpdate);
    libreMap.on("resize", runUpdate);
    try {
      libreMap.once("idle", runUpdate);
    } catch (e) {
      setTimeout(runUpdate, 500);
    }
    runUpdate();
  }

  function storeLabelTitle(place) {
    if (!place) return "";
    return String(place.title || place.shortName || place.name || place.clientId || "").trim();
  }

  function stripMallSuffix(title) {
    return String(title || "")
      .replace(/\s*-\s*(PB|N\d+)\s*-\s*CC\s*$/i, "")
      .replace(/\s*-\s*CC\s*$/i, "")
      .trim();
  }

  function resolveStoreLabelDisplayName(place) {
    if (!place) return "";
    var localCode = place.clientId || place.local || "";
    if (typeof MarketSearch !== "undefined" && typeof MarketSearch.getBrandByLocal === "function") {
      var fromCatalog = MarketSearch.getBrandByLocal(localCode);
      if (fromCatalog) return fromCatalog;
    }
    var raw = storeLabelTitle(place);
    return stripMallSuffix(raw) || raw;
  }

  function prefetchMarketCatalogIfAvailable() {
    if (typeof MarketSearch === "undefined" || typeof MarketSearch.loadCatalog !== "function") {
      return Promise.resolve(false);
    }
    return MarketSearch.loadCatalog()
      .then(function () { return true; })
      .catch(function (error) {
        log("warn", "market catalog prefetch failed", { error: String(error.message || error) });
        return false;
      });
  }

  function getStoreLabelZoomDelta(config) {
    config = config || getConfig();
    var delta = config.storeLabelZoomDelta != null ? Number(config.storeLabelZoomDelta) : 1.2;
    if (!isFinite(delta) || delta <= 0) return 1.2;
    return delta;
  }

  function getZoomAboveBaseline(mapInstance, baselineZoom) {
    var currentZoom = getMapZoom(mapInstance);
    if (!isFinite(currentZoom) || !isFinite(baselineZoom)) return 0;
    return currentZoom - baselineZoom;
  }

  function resolveStoreLabelModeForZoom(mapInstance, config, baselineZoom) {
    config = config || getConfig();
    var configuredMode = getStoreLabelMode(config);
    if (configuredMode !== "featured") return configuredMode;

    // Baseline + moderate zoom: anchor logos only. Strong zoom in: all titles + logos.
    var zoomAbove = getZoomAboveBaseline(mapInstance, baselineZoom);
    if (zoomAbove < getStoreLabelZoomDelta(config)) return "featured";
    return "all";
  }

  function getStoreLabelZoomTier(mapInstance, config, baselineZoom) {
    var mode = resolveStoreLabelModeForZoom(mapInstance, config, baselineZoom);
    if (mode === "featured") return 0;
    if (mode === "all") return 1;
    return -1;
  }

  function evaluateStoreLabelZoom(mapInstance, selectedPlace, baselineZoom, forceFloorCheck) {
    var baseConfig = getConfig();
    if (getStoreLabelMode(baseConfig) !== "featured") return;

    var baseline = isFinite(baselineZoom) ? baselineZoom : storeLabelState.zoomBaseline;
    if (!isFinite(baseline)) {
      baseline = getMapZoom(mapInstance);
      storeLabelState.zoomBaseline = baseline;
    }

    var tier = getStoreLabelZoomTier(mapInstance, baseConfig, baseline);
    var modeForFloorCheck = forceFloorCheck ? resolveStoreLabelModeForZoom(mapInstance, baseConfig, baseline) : null;
    // "all" mode labels are floor-scoped now (perf) — force a rebuild on floor
    // change even if the zoom tier itself didn't move, so the new floor's
    // labels actually appear.
    var floorMismatch = forceFloorCheck
      && modeForFloorCheck === "all"
      && storeLabelState.allModeFloorId !== (mapInstance && mapInstance.currentFloor);
    if (tier === _zoomLabelTier && !floorMismatch) return;

    _zoomLabelTier = tier;
    var mode = modeForFloorCheck || resolveStoreLabelModeForZoom(mapInstance, baseConfig, baseline);
    var cfg = Object.assign({}, baseConfig, {
      showStoreLabels: mode,
      storeLabelMax: mode === "all" ? getAllModeLabelLimit(baseConfig) : baseConfig.storeLabelMax,
    });
    storeLabelState.parentPlaceId = null;
    log("info", "evaluateStoreLabelZoom", {
      currentZoom: getMapZoom(mapInstance),
      baselineZoom: baseline,
      zoomAbove: getZoomAboveBaseline(mapInstance, baseline),
      tier: tier,
      mode: mode,
    });
    refreshStoreLabels(mapInstance, cfg, cfg.parentPlace, selectedPlace);
    return mode;
  }

  function getStoreLabelTextProperties(featured, config) {
    config = config || getConfig();
    if (featured) {
      return {
        fontSize: config.featuredLabelFontSize || "11px",
        fontWeight: "700",
        color: "#1E1630",
        textShadow: "0 1px 2px rgba(255,255,255,0.98), 0 0 4px rgba(255,255,255,0.9)",
      };
    }
    return {
      fontSize: config.storeLabelFontSize || "10px",
      fontWeight: "600",
      color: "#FFFFFF",
      textShadow: "0 1px 3px rgba(0,0,0,0.92), 0 0 8px rgba(0,0,0,0.5), 1px 1px 0 rgba(0,0,0,0.35)",
    };
  }

  function trackLabelMarker(place, markerConfig, markerId, featured, centroidApplied) {
    storeLabelState.labelPlaceMarkers.push({
      place: place,
      floorId: markerConfig.floorId,
      floorLabel: getFloorDisplayLabel(markerConfig.floorId),
      markerId: markerId,
      featured: !!featured,
      centroidApplied: !!centroidApplied,
      anchorCentroid: markerConfig._anchorCentroid || null,
    });
  }

  function isAuxiliaryLabel(place) {
    var text = normalizeText(storeLabelTitle(place));
    if (!text) return true;
    if (place && place.hidePlace) return true;
    return /(salida|ascensor|elevador|escalera|stair|totem|toten|ba[nñ]o|wc|toilet|parking|estacionamiento|sala de lact|informacion|info point|torre|bus|taxi)/.test(text);
  }

  function manifestEntryHasLogoFile(entry) {
    if (!entry) return false;
    if (typeof entry === "string") return !!String(entry).trim();
    if (typeof entry === "object" && entry.file) return !!String(entry.file).trim();
    return false;
  }

  // Derive the anchor-brand list from store-logos.manifest.json so the map
  // never tries to show a "featured" slot for a brand we don't have a PNG for
  // (e.g. the old hardcoded Nike Rise / Cencosud entries with no local asset).
  function getManifestFeaturedTokens(manifest) {
    manifest = manifest || storeLogoManifest;
    if (!manifest) return [];
    var tokens = [];
    var seen = {};
    for (var key in manifest) {
      if (!key || key.charAt(0) === "_") continue;
      if (!manifestEntryHasLogoFile(manifest[key])) continue;
      var norm = normalizeText(key);
      if (!norm || seen[norm]) continue;
      seen[norm] = true;
      tokens.push(key);
    }
    return tokens;
  }

  // Used when store-logos.manifest.json/jsonp failed to load (common on totem
  // if OTA is stale or JSONP companion missing). Keeps anchor markers alive so
  // at least typographic fallbacks render instead of nothing.
  var FALLBACK_FEATURED_TOKENS = [
    "Falabella",
    "Ripley",
    "Paris",
    "Jumbo",
    "Casa Ideas",
    "La Polar",
    "ZARA",
    "H&M",
  ];

  function getFeaturedLabelTokens(config) {
    config = config || getConfig();
    var tokens = Array.isArray(config.storeLabelFeatured) ? config.storeLabelFeatured : [];
    if (tokens.length) return tokens;
    var fromManifest = getManifestFeaturedTokens();
    if (fromManifest.length) return fromManifest;
    return FALLBACK_FEATURED_TOKENS.slice();
  }

  function isFeaturedStore(place, config) {
    if (!place || isAuxiliaryLabel(place)) return false;
    // Primary signal: we have a local PNG (or override) for this brand.
    if (getLocalStoreLogoFilename(place, storeLogoManifest)) return true;
    var tokens = getFeaturedLabelTokens(config).map(normalizeText);
    if (!tokens.length) return false;
    var candidates = [
      place.mapvxId,
      place.clientId,
      place.title,
      place.shortName,
      place.name,
    ].map(normalizeText);

    for (var i = 0; i < candidates.length; i++) {
      if (!candidates[i]) continue;
      for (var j = 0; j < tokens.length; j++) {
        var token = tokens[j];
        if (!token) continue;
        if (brandKeyMatches(candidates[i], token)) {
          return true;
        }
      }
    }
    return false;
  }

  function storeLabelFloorIds(place, fallbackFloorId) {
    var ids = [];
    var seen = {};
    var floors = place && Array.isArray(place.inFloors) ? place.inFloors : [];

    floors.forEach(function (floorId) {
      var key = String(floorId || "").trim();
      if (!key || seen[key]) return;
      seen[key] = true;
      ids.push(key);
    });

    if (!ids.length && fallbackFloorId) {
      ids.push(String(fallbackFloorId));
    }

    return ids;
  }

  function buildStoreLabelMarkers(place, fallbackFloorId, featured, config, showAllLogos, restrictFloorId, libreMap) {
    config = config || getConfig();
    var title = resolveStoreLabelDisplayName(place);
    var position = place && place.position;
    if (!title || !position || position.lat == null || position.lng == null) {
      return [];
    }

    var floorIds = storeLabelFloorIds(place, fallbackFloorId);
    if (restrictFloorId) {
      floorIds = floorIds.filter(function (id) { return id === restrictFloorId; });
    }
    var markerBaseId = String(place.mapvxId || place.clientId || title).replace(/[^A-Za-z0-9_-]/g, "_");
    var markers = [];
    var labelTextProps = getStoreLabelTextProperties(featured, config);
    var logoDims = getFeaturedLogoDimensions(config);
    var logoUrl = (featured || showAllLogos) ? getStoreLogoUrl(place, config) : "";

    for (var i = 0; i < floorIds.length; i++) {
      var floorId = floorIds[i];
      var markerId = "store-label-" + markerBaseId + "-" + floorId.replace(/[^A-Za-z0-9_-]/g, "_");
      var floorLabel = getFloorDisplayLabel(floorId);
      var anchorCentroid = null;
      var markerPosition = position;
      if (featured) {
        anchorCentroid = resolveAnchorPosition(place, floorId, libreMap) || position;
        markerPosition = resolveFeaturedMarkerCoordinate(libreMap, place, floorId, floorLabel) || anchorCentroid;
      }
      var usedCentroid = false;
      if (featured && libreMap && place.mapvxId) {
        var cents = getCentroidsForFloor(libreMap, floorId);
        usedCentroid = !!cents[place.mapvxId];
      }
      if (featured) {
        // Rebuilt per floor (not hoisted/cloned) because `perFloor` overrides
        // in the logo manifest mean the same store's logo treatment can
        // legitimately differ from one floor to the next (see getLocalStoreLogoTreatment).
        // Always call buildAnchorLogoElement — when logoUrl is empty it falls back
        // to the typographic brand badge (Falabella, Ripley, Paris...) instead of
        // silently skipping the marker.
        var anchorElement = buildAnchorLogoElement(
          place,
          logoUrl || "",
          logoDims,
          config,
          floorLabel
        );
        if (anchorElement) {
          markers.push({
            id: markerId,
            coordinate: { lat: markerPosition.lat, lng: markerPosition.lng },
            floorId: floorId,
            text: "",
            element: anchorElement,
            iconProperties: { width: logoDims.width, height: logoDims.height },
            anchor: "center",
            rotationAlignment: "viewport",
            pitchAlignment: "viewport",
            _centroidApplied: usedCentroid,
            _anchorCentroid: anchorCentroid,
          });
        } else if (logoUrl) {
          markers.push({
            id: markerId,
            coordinate: { lat: markerPosition.lat, lng: markerPosition.lng },
            floorId: floorId,
            text: "",
            icon: logoUrl,
            textPosition: MapVX.TextPosition.top,
            iconProperties: { width: logoDims.width, height: logoDims.height },
            anchor: "center",
            rotationAlignment: "viewport",
            pitchAlignment: "viewport",
            _centroidApplied: usedCentroid,
            _anchorCentroid: anchorCentroid,
          });
        }
        continue;
      }

      markers.push({
        id: markerId,
        coordinate: { lat: position.lat, lng: position.lng },
        floorId: floorId,
        text: title,
        textPosition: MapVX.TextPosition.top,
        iconProperties: { width: 0, height: 0 },
        textProperties: labelTextProps,
        anchor: "center",
        rotationAlignment: "viewport",
        pitchAlignment: "viewport",
      });
    }

    return markers;
  }

  function findSelectedStoreLabelMarker(place, fallbackFloorId) {
    var markers = buildStoreLabelMarkers(place, fallbackFloorId, false, getConfig());
    return markers.length ? markers[0] : null;
  }

  async function refreshStoreLabels(mapInstance, config, parentPlace, selectedPlace) {
    config = config || getConfig();
    if (!mapInstance || !config || !config.parentPlace) {
      return 0;
    }

    if (!shouldRenderStoreLabels(config)) {
      clearStoreLabelMarkers();
      storeLabelState.parentPlaceId = null;
      return 0;
    }

    var mode = getStoreLabelMode(config);
    var limit = getStoreLabelLimit(config);
    var currentParentPlaceId = String(config.parentPlace);
    var floorIdForAllMode = mapInstance.currentFloor || (parentPlace && pickDefaultFloorKey(parentPlace)) || null;
    if (
      mode === "all"
      && storeLabelState.parentPlaceId === currentParentPlaceId
      && storeLabelState.allModeFloorId === floorIdForAllMode
      && storeLabelState.markerIds.length
    ) {
      return storeLabelState.markerIds.length;
    }

    if (storeLabelState.loading) {
      return storeLabelState.loading;
    }

    storeLabelState.loading = (async function () {
      if (storeLabelState.parentPlaceId !== currentParentPlaceId) {
        clearStoreLabelMarkers();
      }

      await loadStoreLogoManifest(config);
      // Catalog names are optional for labels; load in background to avoid blocking markers.
      prefetchMarketCatalogIfAvailable();

      var subPlaces = [];
      try {
        subPlaces = await getSubPlacesCached(config.parentPlace);
      } catch (e) {
        log("warn", "refreshStoreLabels getSubPlaces failed", {
          parentPlace: config.parentPlace,
          error: String(e.message || e),
        });
        return 0;
      }

      if (map !== mapInstance) {
        return 0;
      }

      clearStoreLabelMarkers();

      var currentFloorId = mapInstance.currentFloor || (parentPlace && pickDefaultFloorKey(parentPlace)) || null;
      var added = 0;
      var seen = {};

      function canAddMore() {
        return !limit || added < limit;
      }

      if (mode === "selected") {
        if (selectedPlace) {
          seen[String(selectedPlace.mapvxId || selectedPlace.clientId || storeLabelTitle(selectedPlace))] = true;
        }
      } else if (mode === "featured") {
        var selectedKey = selectedPlace ? String(selectedPlace.mapvxId || selectedPlace.clientId || storeLabelTitle(selectedPlace)) : "";
        if (selectedPlace && !isAuxiliaryLabel(selectedPlace) && selectedKey) {
          seen[selectedKey] = true;
        }

        var featuredQueue = [];
        for (var fi = 0; fi < (subPlaces || []).length; fi++) {
          var candidatePlace = subPlaces[fi];
          var candidateTitle = storeLabelTitle(candidatePlace);
          if (!candidateTitle || !candidatePlace || !candidatePlace.position || candidatePlace.position.lat == null || candidatePlace.position.lng == null) {
            continue;
          }
          if (!isFeaturedStore(candidatePlace, config)) {
            continue;
          }
          featuredQueue.push({ place: candidatePlace, title: candidateTitle });
        }

        var enrichedFeatured = await Promise.all(featuredQueue.map(function (item) {
          return enrichPlaceLogo(item.place, config).then(function (place) {
            return { place: place, title: item.title };
          });
        }));

        var libreMapForLabels = getLibreMap(mapInstance);

        for (var ef = 0; ef < enrichedFeatured.length; ef++) {
          if (!canAddMore()) break;
          var featuredEntry = enrichedFeatured[ef];
          var featuredPlace = featuredEntry.place;
          var featuredTitle = featuredEntry.title;

          var featuredKey = String(featuredPlace.mapvxId || featuredPlace.clientId || featuredTitle);
          if (seen[featuredKey]) continue;
          seen[featuredKey] = true;

          // Dedup by brand within a floor: MapVX may return several subplaces of
          // the same anchor (e.g. two "JUMBO") on one floor. Only one logo each.
          var featuredBrand = normalizeText(resolveStoreLabelDisplayName(featuredPlace) || featuredTitle);

          var featuredMarkers = buildStoreLabelMarkers(
            featuredPlace,
            currentFloorId,
            true,
            config,
            false,
            null,
            libreMapForLabels
          );
          featuredMarkers.forEach(function (markerConfig) {
            var brandFloorKey = "featbrand:" + featuredBrand + "|" + markerConfig.floorId;
            if (seen[brandFloorKey]) return;
            try {
              var markerId = mapInstance.addMarker(markerConfig);
              if (markerId) {
                seen[brandFloorKey] = true;
                storeLabelState.markerIds.push(markerId);
                trackLabelMarker(
                  featuredPlace,
                  markerConfig,
                  markerId,
                  true,
                  markerConfig._centroidApplied
                );
                added++;
              }
            } catch (e) {
              log("warn", "add featured store label marker failed", {
                title: featuredTitle,
                floorId: markerConfig.floorId,
                hasLogo: !!getStoreLogoUrl(featuredPlace, config),
                error: String(e.message || e),
              });
            }
          });
        }

        attachCentroidUpdater(mapInstance);
      } else {
        // Only build labels for the currently active floor. Building all ~400
        // stores across every floor of the mall at once (previous behavior)
        // created that many live DOM markers simultaneously, which is heavy
        // to reposition on pan/zoom for low-power totem hardware. Other
        // floors aren't visible anyway until the user switches to them —
        // see attachZoomLabelSwitcher/switchFloor for the floor-change
        // re-trigger that rebuilds this for the new floor.
        var allQueue = [];
        for (var ai = 0; ai < (subPlaces || []).length; ai++) {
          var candidate = subPlaces[ai];
          var candidateName = resolveStoreLabelDisplayName(candidate);
          if (!candidateName || !candidate || !candidate.position || candidate.position.lat == null || candidate.position.lng == null) {
            continue;
          }
          if (isAuxiliaryLabel(candidate)) {
            continue;
          }
          if (currentFloorId && storeLabelFloorIds(candidate, currentFloorId).indexOf(currentFloorId) === -1) {
            continue;
          }
          var candidateKey = String(candidate.mapvxId || candidate.clientId || candidateName);
          if (seen[candidateKey]) continue;
          seen[candidateKey] = true;
          allQueue.push({ place: candidate, title: candidateName, placeKey: candidateKey });
        }

        for (var ea = 0; ea < allQueue.length; ea++) {
          if (!canAddMore()) break;
          var allEntry = allQueue[ea];
          var place = allEntry.place;
          var title = allEntry.title;

          var markers = buildStoreLabelMarkers(
            place,
            currentFloorId,
            false,
            config,
            false,
            currentFloorId
          );
          markers.forEach(function (markerConfig) {
            try {
              var markerId = mapInstance.addMarker(markerConfig);
              if (markerId) {
                storeLabelState.markerIds.push(markerId);
                trackLabelMarker(place, markerConfig, markerId, false);
                added++;
              }
            } catch (e) {
              log("warn", "add store label marker failed", {
                title: title,
                floorId: markerConfig.floorId,
                error: String(e.message || e),
              });
            }
          });
        }

        attachCentroidUpdater(mapInstance);
      }

      storeLabelState.parentPlaceId = currentParentPlaceId;
      storeLabelState.allModeFloorId = mode === "all" ? currentFloorId : null;
      log("info", "refreshStoreLabels done", {
        mode: mode,
        parentPlace: currentParentPlaceId,
        markers: added,
        labelTracked: storeLabelState.labelPlaceMarkers.length,
        featuredWithLogo: storeLabelState.labelPlaceMarkers.filter(function (entry) {
          return entry.featured && entry.place && getStoreLogoUrl(entry.place, config);
        }).length,
      });
      return added;
    })();

    try {
      return await storeLabelState.loading;
    } finally {
      storeLabelState.loading = null;
    }
  }

  function waitForMapContainerLayout(containerEl, timeoutMs) {
    timeoutMs = timeoutMs || 3000;
    return new Promise(function (resolve) {
      var start = Date.now();
      function tick() {
        if (
          containerEl
          && containerEl.clientWidth >= 40
          && containerEl.clientHeight >= 40
        ) {
          resolve();
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          log("warn", "waitForMapContainerLayout timeout", {
            w: containerEl ? containerEl.clientWidth : 0,
            h: containerEl ? containerEl.clientHeight : 0,
          });
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      }
      tick();
    });
  }

  function registerParentPlace(mapInstance, parentPlace) {
    if (!mapInstance || !parentPlace || !mapInstance.potentialParentPlaces) {
      return;
    }
    var exists = mapInstance.potentialParentPlaces.some(function (p) {
      return p.mapvxId === parentPlace.mapvxId;
    });
    if (!exists) {
      mapInstance.potentialParentPlaces.push(parentPlace);
      log("info", "registerParentPlace", { mapvxId: parentPlace.mapvxId, title: parentPlace.title });
    }
  }

  async function fitMapToIndoorContext(mapInstance, config, parentPlace) {
    if (!mapInstance || !config) {
      return;
    }
    await waitForMapContainerLayout(mapContainer);

    var coords = [];
    if (parentPlace && parentPlace.position && parentPlace.position.lat != null) {
      coords.push(parentPlace.position);
    }

    try {
      var subPlaces = await getSubPlacesCached(config.parentPlace);
      if (subPlaces && subPlaces.length) {
        subPlaces.forEach(function (p) {
          if (p && p.position && p.position.lat != null && p.position.lng != null) {
            coords.push(p.position);
          }
        });
      }
    } catch (e) {
      log("warn", "fitMapToIndoorContext getSubPlaces failed", {
        error: String(e.message || e),
      });
    }

    if (!coords.length) {
      log("warn", "fitMapToIndoorContext no coordinates for bounds");
      return;
    }

    applyIndoorViewConstraints(mapInstance, config, coords);

    if (coords.length >= 2) {
      mapInstance.fitCoordinates(coords, { padding: 56, maxZoom: 20, duration: 0 });
      log("info", "fitMapToIndoorContext bbox", { points: coords.length });
    } else {
      fitMapToPlace(mapInstance, coords[0]);
    }

    applyDynamicMinZoomFromFit(mapInstance, config);
  }

  async function ensureIndoorMapReady(mapInstance, config) {
    if (!mapInstance || !config || !config.parentPlace) {
      return null;
    }

    await ensureReady(config);
    prefetchMarketCatalogIfAvailable();

    var parentPlace = null;
    try {
      parentPlace = await getParentPlaceCached(config.parentPlace);
    } catch (e) {
      log("warn", "ensureIndoorMapReady getPlaceDetail failed", {
        error: String(e.message || e),
        parentPlace: config.parentPlace,
      });
      return null;
    }

    if (!parentPlace) {
      return null;
    }

    registerParentPlace(mapInstance, parentPlace);

    var floorKey = pickDefaultFloorKey(parentPlace);

    await new Promise(function (resolve) {
      var settled = false;
      function done() {
        if (settled) return;
        settled = true;
        resolve();
      }
      try {
        if (typeof mapInstance.setParentPlace === "function") {
          mapInstance.setParentPlace(parentPlace, true, function () {
            log("info", "ensureIndoorMapReady style ready", {
              title: parentPlace.title,
              floorKey: floorKey,
            });
            done();
          });
          setTimeout(function () {
            log("warn", "ensureIndoorMapReady style timeout — continuing");
            done();
          }, 10000);
          return;
        }
      } catch (e) {
        log("warn", "ensureIndoorMapReady setParentPlace failed", {
          error: String(e.message || e),
        });
      }
      done();
    });

    try {
      if (floorKey && typeof mapInstance.updateParentPlaceAndFloor === "function") {
        mapInstance.updateParentPlaceAndFloor(config.parentPlace, floorKey);
        log("info", "ensureIndoorMapReady updateParentPlaceAndFloor", {
          parentPlace: config.parentPlace,
          floorId: floorKey,
          title: parentPlace.title,
        });
      } else if (floorKey && typeof mapInstance.updateFloor === "function") {
        mapInstance.updateFloor(floorKey);
        log("info", "ensureIndoorMapReady updateFloor default", { floorId: floorKey });
      }
    } catch (e) {
      log("warn", "ensureIndoorMapReady apply floor failed", {
        error: String(e.message || e),
      });
    }

    await fitMapToIndoorContext(mapInstance, config, parentPlace);
    var baselineZoom = getMapZoom(mapInstance);
    storeLabelState.zoomBaseline = baselineZoom;
    _zoomLabelTier = -1;
    attachZoomLabelSwitcher(mapInstance, null, baselineZoom);
    evaluateStoreLabelZoom(mapInstance, null, baselineZoom);
    attachPoiFilterStyleGuard(mapInstance, config);
    scheduleRetailPoiIconFilter(mapInstance, config);
    return parentPlace;
  }

  function applyPlaceFloor(mapInstance, config, floorId, parentPlace) {
    if (!floorId || !mapInstance) {
      return;
    }
    try {
      if (typeof mapInstance.updateParentPlaceAndFloor === "function" && config.parentPlace) {
        mapInstance.updateParentPlaceAndFloor(config.parentPlace, floorId);
        log("info", "updateParentPlaceAndFloor", { floorId: floorId });
      } else if (typeof mapInstance.updateFloor === "function") {
        mapInstance.updateFloor(floorId);
        log("info", "updateFloor ok", { floorId: floorId });
      }
    } catch (e) {
      log("warn", "applyPlaceFloor failed", {
        floorId: floorId,
        error: String(e.message || e),
      });
    }
  }

  async function applyPlaceFloorAndWait(mapInstance, config, floorId, parentPlace) {
    applyPlaceFloor(mapInstance, config, floorId, parentPlace);
    await delayMs(50);
  }

  async function ensureReady(config) {
    config = config || getConfig();
    log("info", "ensureReady", configSummary(config));

    if (!isConfigured(config)) {
      log("error", "config incomplete", configSummary(config));
      throw new Error("MapVX config incomplete (apiKey, parentPlace, institutionId)");
    }

    if (sdk) {
      log("info", "ensureReady: sdk already initialized");
      return sdk;
    }

    if (initPromise) return initPromise;

    initPromise = (async function () {
      ensureSdkLoaded();
      loadStylesheet();
      var lang = (config.lang || window.MALL_LOCALE || "es").toLowerCase().startsWith("en")
        ? "en"
        : "es";
      log("info", "initializeSDK", { lang: lang, parentPlace: config.parentPlace });
      sdk = MapVX.initializeSDK(config.apiKey, { lang: lang });
      log("info", "initializeSDK done");
      return sdk;
    })();

    return initPromise;
  }

  async function ensureMap(containerEl, config) {
    log("info", "ensureMap start", {
      containerId: containerEl && containerEl.id,
      containerSize: containerEl
        ? { w: containerEl.clientWidth, h: containerEl.clientHeight }
        : null,
    });

    await ensureReady(config);
    config = config || getConfig();

    if (map && mapContainer === containerEl) {
      if (!containerEl.firstChild) {
        log("warn", "ensureMap: container vacío con map ref — recreando");
        destroyMap();
      } else {
        log("info", "ensureMap: reusing existing map instance");
        await waitForMapContainerLayout(containerEl);
        try {
          var reusedLibreMap = getLibreMap(map);
          if (reusedLibreMap && typeof reusedLibreMap.resize === "function") {
            reusedLibreMap.resize();
          }
        } catch (eResize) {
          log("warn", "ensureMap reuse resize failed", { error: String(eResize.message || eResize) });
        }
        return map;
      }
    }

    if (map && typeof map.destroyMap === "function") {
      log("info", "ensureMap: destroying previous map");
      try { map.destroyMap(); } catch (e) { log("warn", "destroyMap failed", { error: String(e.message || e) }); }
    }

    mapContainer = containerEl;
    containerEl.innerHTML = "";
    await waitForMapContainerLayout(containerEl);

    await new Promise(function (resolve, reject) {
      var settled = false;
      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      }
      var timeout = setTimeout(function () {
        if (!settled) {
          log("warn", "ensureMap timeout 25s — forcing indoor setup");
          ensureIndoorMapReady(map, config).finally(finish);
        }
      }, 25000);

      try {
        var zoomLimits = resolveMapZoomLimits(config);
        var createMapOptions = {
          parentPlaceId: config.parentPlace,
          lang: (config.lang || window.MALL_LOCALE || "es").toLowerCase().startsWith("en") ? "en" : "es",
          showCompass: true,
          showZoom: true,
          navigationPosition: "top-right",
          tileCache: { enabled: true, persistToServiceWorker: false },
          onMapReady: function () {
            log("info", "onMapReady — loading Costanera indoor context");
            lockMapRotation(map, config);
            ensureIndoorMapReady(map, config).finally(finish);
          },
          onParentPlaceChange: function (parentPlaceId) {
            log("info", "onParentPlaceChange", { parentPlaceId: parentPlaceId });
          },
        };
        if (zoomLimits.maxZoom != null) {
          createMapOptions.maxZoom = zoomLimits.maxZoom;
        }
        map = sdk.createMap(containerEl, createMapOptions);
        log("info", "createMap called", {
          parentPlaceId: config.parentPlace,
          maxZoom: zoomLimits.maxZoom,
        });
      } catch (e) {
        clearTimeout(timeout);
        log("error", "createMap threw", { error: String(e.message || e) });
        reject(e);
      }
    });

    log("info", "ensureMap done");
    return map;
  }

  function findSubPlaceMatch(subPlaces, local, catalogId, name, floor) {
    if (!subPlaces || !subPlaces.length) return null;

    if (local) {
      var exactLocal = subPlaces.find(function (p) {
        return clientIdMatchesCatalogLocal(p.clientId, local);
      });
      if (exactLocal) {
        return { place: exactLocal, method: "subPlaces(local→clientId)" };
      }
    }

    if (catalogId) {
      var exactCatalog = subPlaces.find(function (p) {
        return clientIdMatchesCatalogLocal(p.clientId, catalogId)
          || String(p.mapvxId || "") === String(catalogId);
      });
      if (exactCatalog) {
        return { place: exactCatalog, method: "subPlaces(catalogId)" };
      }
    }

    if (name) {
      var targetName = normalizeText(name);
      var named = subPlaces.filter(function (p) {
        return normalizeText(p.title) === targetName;
      });
      if (named.length === 1) {
        return { place: named[0], method: "subPlaces(title)" };
      }
      if (named.length > 1) {
        var floorLevel = parseLevelFromHint(floor);
        if (floorLevel != null) {
          var byFloor = named.find(function (p) {
            var levels = parseLevelsFromLocal(p.clientId);
            return levels.indexOf(floorLevel) >= 0;
          });
          if (byFloor) {
            return { place: byFloor, method: "subPlaces(title+floor)" };
          }
        }
        if (local) {
          var suffixMatch = String(local).match(/_(\d+)\s*$/);
          if (suffixMatch) {
            var suffix = suffixMatch[1];
            var bySuffix = named.find(function (p) {
              return String(p.clientId || "").indexOf("_" + suffix) >= 0;
            });
            if (bySuffix) {
              return { place: bySuffix, method: "subPlaces(title+localSuffix)" };
            }
          }
        }
      }
    }

    return null;
  }

  var TOILET_POI_SUBCLASSES = [
    "toilets",
    "toilet",
    "restroom",
    "changing_table",
  ];

  function isToiletPoiFeature(feature) {
    if (!feature || !feature.properties) return false;
    var props = feature.properties;
    var sub = String(props.subclass || "").toLowerCase();
    var cls = String(props.class || "").toLowerCase();
    if (TOILET_POI_SUBCLASSES.indexOf(sub) >= 0) return true;
    if (cls === "toilets" || cls === "toilet" || cls === "restroom") return true;
    var name = String(props.name || props.name_en || props.name_es || "").toLowerCase();
    if (/\b(toilet|toilets|restroom|baño|banos|bano|wc|mudador|changing)\b/.test(name)) return true;
    return false;
  }

  function queryToiletPoiFeatures(libreMap) {
    var merged = [];
    var seen = {};
    if (!libreMap) return merged;

    function ingest(features) {
      if (!features || !features.length) return;
      features.forEach(function (f) {
        if (!isToiletPoiFeature(f) || !f.properties) return;
        var ref = String(f.properties.ref || f.properties.id || f.id || "").trim();
        if (!ref) return;
        var floorKey = f.properties.floor_key != null ? String(f.properties.floor_key) : "";
        var key = ref + "|" + floorKey;
        if (seen[key]) return;
        seen[key] = true;
        var coords = f.geometry && f.geometry.coordinates;
        merged.push({
          ref: ref,
          subclass: f.properties.subclass || f.properties.class || "",
          floor_key: floorKey,
          name: f.properties.name || f.properties.name_es || ref,
          lat: coords ? coords[1] : null,
          lng: coords ? coords[0] : null,
        });
      });
    }

    ["indoor-poi-rank1", "indoor-poi-rank2", "base-indoor-poi-rank1", "base-indoor-poi-rank2"].forEach(function (layerId) {
      try {
        ingest(libreMap.queryRenderedFeatures(undefined, { layers: [layerId] }));
      } catch (e) { /* noop */ }
      try {
        var layer = libreMap.getLayer(layerId);
        if (layer && layer.source) {
          ingest(libreMap.querySourceFeatures(layer.source, {
            sourceLayer: layer.sourceLayer || "poi",
          }));
        }
      } catch (e2) { /* noop */ }
    });

    // Broader scan: any indoorequal poi source features if layers above were empty.
    if (!merged.length) {
      try {
        var style = libreMap.getStyle && libreMap.getStyle();
        var layers = (style && style.layers) || [];
        layers.forEach(function (layer) {
          if (!layer || layer.source !== "indoorequal") return;
          if (layer["source-layer"] !== "poi") return;
          try {
            ingest(libreMap.querySourceFeatures(layer.source, {
              sourceLayer: "poi",
            }));
          } catch (e3) { /* noop */ }
        });
      } catch (e4) { /* noop */ }
    }

    return merged;
  }

  function waitForLibreMapIdle(libreMap, timeoutMs) {
    return new Promise(function (resolve) {
      if (!libreMap) {
        resolve();
        return;
      }
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        resolve();
      };
      var timer = setTimeout(finish, timeoutMs || 1800);
      try {
        if (typeof libreMap.loaded === "function" && libreMap.loaded()) {
          // Floor switch can still be fetching tiles; prefer idle event.
        }
        libreMap.once("idle", function () {
          clearTimeout(timer);
          finish();
        });
      } catch (e) {
        clearTimeout(timer);
        finish();
      }
    });
  }

  async function collectToiletPoisWithRetry(libreMap, floorId, maxAttempts) {
    var toilets = [];
    var attempts = Math.max(1, maxAttempts || 3);
    for (var i = 0; i < attempts; i++) {
      await waitForLibreMapIdle(libreMap, 600);
      toilets = queryToiletPoiFeatures(libreMap);
      if (toilets.length) {
        log("info", "toilet POIs ready", {
          count: toilets.length,
          attempt: i + 1,
          floorId: floorId || null,
        });
        return toilets;
      }
      await delayMs(120 + i * 120);
    }
    log("warn", "toilet POIs still empty", { floorId: floorId || null, attempts: attempts });
    return toilets;
  }

  function isElevatorPoiFeature(feature) {
    if (!feature || !feature.properties) return false;
    var props = feature.properties;
    var cls = String(props.class || props.Class || "").toLowerCase();
    var sub = String(props.subclass || props.Subtype || props.subtype || "").toLowerCase();
    var highway = String(props.highway || "").toLowerCase();
    var elevatorTag = String(props.elevator || "").toLowerCase();
    var typeTag = String(props.type || props.Type || "").toLowerCase();
    var icon = String(props.icon || props["icon-image"] || props.sprite || "").toLowerCase();
    if (cls === "elevator" || sub === "elevator" || typeTag === "elevator") return true;
    if (highway === "elevator") return true;
    if (elevatorTag === "yes" || elevatorTag === "true" || elevatorTag === "1") return true;
    if (icon.indexOf("elevator") >= 0 || icon.indexOf("ascensor") >= 0) return true;
    // Exclude escalators / stairs even if name mentions elevator shaft nearby.
    if (cls === "escalator" || sub === "escalator" || cls === "steps" || sub === "steps") return false;
    var name = String(props.name || props.name_en || props.name_es || "").toLowerCase();
    if (/\b(elevator|ascensor|elevador)\b/.test(name) && !/\b(escalator|escalera\s*mecanic)\b/.test(name)) {
      return true;
    }
    return false;
  }

  function featureCentroid(feature) {
    var g = feature && feature.geometry;
    if (!g) return null;
    if (g.type === "Point" && g.coordinates) {
      return { lng: g.coordinates[0], lat: g.coordinates[1] };
    }

    function averageCoords(list) {
      if (!list || !list.length) return null;
      var sumLng = 0;
      var sumLat = 0;
      var n = 0;
      list.forEach(function (c) {
        if (!c || c.length < 2) return;
        if (typeof c[0] !== "number" || typeof c[1] !== "number") return;
        sumLng += Number(c[0]);
        sumLat += Number(c[1]);
        n += 1;
      });
      if (!n) return null;
      return { lng: sumLng / n, lat: sumLat / n };
    }

    var coords = g.coordinates;
    if (!coords || !coords.length) return null;
    // LineString: [[lng,lat], ...]
    if (typeof coords[0][0] === "number") return averageCoords(coords);
    // Polygon / MultiLineString: [[[lng,lat], ...], ...]
    if (coords[0] && typeof coords[0][0][0] === "number") return averageCoords(coords[0]);
    // MultiPolygon: [[[[lng,lat], ...]]]
    if (coords[0] && coords[0][0] && typeof coords[0][0][0][0] === "number") {
      return averageCoords(coords[0][0]);
    }
    return null;
  }

  function sampleTransportationFeatureClasses(libreMap) {
    var samples = [];
    var seen = {};
    if (!libreMap) return samples;
    function pushProps(features) {
      (features || []).forEach(function (f) {
        if (!f || !f.properties || samples.length >= 12) return;
        var cls = String(f.properties.class || f.properties.subclass || f.properties.highway || "");
        var key = cls + "|" + String(f.properties.ref || f.id || "");
        if (seen[key]) return;
        seen[key] = true;
        samples.push({
          class: f.properties.class || null,
          subclass: f.properties.subclass || null,
          highway: f.properties.highway || null,
          elevator: f.properties.elevator || null,
          type: f.properties.type || null,
          ref: f.properties.ref || f.properties.id || null,
          floor_key: f.properties.floor_key != null ? f.properties.floor_key : null,
          geom: f.geometry ? f.geometry.type : null,
        });
      });
    }
    try {
      pushProps(libreMap.queryRenderedFeatures(undefined, {
        layers: ["indoor-transportation-poi", "base-indoor-transportation-poi"].filter(function (id) {
          try { return !!libreMap.getLayer(id); } catch (e) { return false; }
        }),
      }));
    } catch (e1) { /* noop */ }
    if (!samples.length) {
      try {
        pushProps(libreMap.queryRenderedFeatures());
      } catch (e2) { /* noop */ }
    }
    return samples;
  }

  function queryElevatorPoiFeatures(libreMap) {
    var merged = [];
    var seen = {};
    if (!libreMap) return merged;

    function ingest(features) {
      if (!features || !features.length) return;
      features.forEach(function (f) {
        if (!isElevatorPoiFeature(f) || !f.properties) return;
        var props = f.properties;
        var centroid = featureCentroid(f);
        var floorKey = props.floor_key != null
          ? String(props.floor_key)
          : (props.level != null ? String(props.level) : "");
        var ref = String(
          props.ref || props.id || props.osm_id || f.id || ""
        ).trim();
        if (!ref) {
          if (!centroid || centroid.lat == null || centroid.lng == null) return;
          ref = "elevator_" + centroid.lng.toFixed(6) + "_" + centroid.lat.toFixed(6);
        }
        var key = ref + "|" + floorKey;
        if (seen[key]) return;
        seen[key] = true;
        merged.push({
          ref: ref,
          subclass: props.subclass || props.class || props.highway || "elevator",
          class: props.class || props.highway || "elevator",
          floor_key: floorKey,
          name: props.name || props.name_es || "Ascensor",
          lat: centroid ? centroid.lat : null,
          lng: centroid ? centroid.lng : null,
        });
      });
    }

    function ingestLayerIds(layerIds) {
      (layerIds || []).forEach(function (layerId) {
        try {
          ingest(libreMap.queryRenderedFeatures(undefined, { layers: [layerId] }));
        } catch (e) { /* noop */ }
        try {
          var layer = libreMap.getLayer(layerId);
          if (layer && layer.source) {
            ingest(libreMap.querySourceFeatures(layer.source, {
              sourceLayer: layer.sourceLayer || layer["source-layer"] || "transportation",
            }));
          }
        } catch (e2) { /* noop */ }
      });
    }

    ingestLayerIds([
      "indoor-transportation-poi",
      "base-indoor-transportation-poi",
    ]);

    // Elevators may also appear as POI symbols on the poi source-layer.
    ingestLayerIds([
      "indoor-poi-rank1",
      "indoor-poi-rank2",
      "base-indoor-poi-rank1",
      "base-indoor-poi-rank2",
    ]);

    if (!merged.length) {
      try {
        var style = libreMap.getStyle && libreMap.getStyle();
        var layers = (style && style.layers) || [];
        layers.forEach(function (layer) {
          if (!layer) return;
          var sourceLayer = layer["source-layer"];
          var source = layer.source;
          // MapVX / IndoorEqual transportation + poi; also accept renamed indoor sources.
          if (sourceLayer !== "transportation" && sourceLayer !== "poi") return;
          if (source !== "indoorequal" && String(source || "").indexOf("indoor") < 0) return;
          try {
            ingest(libreMap.queryRenderedFeatures(undefined, { layers: [layer.id] }));
          } catch (e3) { /* noop */ }
          try {
            ingest(libreMap.querySourceFeatures(layer.source, {
              sourceLayer: sourceLayer,
            }));
          } catch (e4) { /* noop */ }
        });
      } catch (e5) { /* noop */ }
    }

    // Last resort: any rendered feature matching elevator properties (viewport-dependent).
    if (!merged.length) {
      try {
        ingest(libreMap.queryRenderedFeatures());
      } catch (e6) { /* noop */ }
    }

    return merged;
  }

  async function collectElevatorPoisWithRetry(libreMap, floorId, maxAttempts) {
    var elevators = [];
    var attempts = Math.max(1, maxAttempts || 6);
    for (var i = 0; i < attempts; i++) {
      await waitForLibreMapIdle(libreMap, 900);
      elevators = queryElevatorPoiFeatures(libreMap);
      if (elevators.length) {
        log("info", "elevator POIs ready", {
          count: elevators.length,
          attempt: i + 1,
          floorId: floorId || null,
        });
        return elevators;
      }
      await delayMs(250 + i * 250);
    }
    var samples = sampleTransportationFeatureClasses(libreMap);
    log("warn", "elevator POIs still empty", {
      floorId: floorId || null,
      attempts: attempts,
      sampleClasses: samples,
    });
    return elevators;
  }

  function listElevatorPoisOnMap() {
    var libreMap = map && getLibreMap(map);
    return queryElevatorPoiFeatures(libreMap);
  }

  function placeLooksLikeBathroom(place) {
    if (!place) return false;
    var title = String(place.title || place.name || place.clientId || "").toLowerCase();
    return /\b(baño|banos|bano|toilet|toilets|restroom|wc|mudador|sanitario)\b/.test(title);
  }

  function placeLooksLikeElevator(place) {
    if (!place) return false;
    var title = String(place.title || place.name || place.clientId || "").toLowerCase();
    if (/\b(escalator|escalera\s*mecanic|stairs|escaleras?\b)/.test(title) && !/\b(elevator|ascensor|elevador)\b/.test(title)) {
      return false;
    }
    return /\b(elevator|ascensor|elevador)\b/.test(title);
  }

  async function resolveElevatorPlaceViaApi(anchorPlace, floorHint) {
    if (!sdk || typeof sdk.getPlacesByInput !== "function") return null;
    var config = getConfig();
    var queries = ["ascensor", "elevator", "elevador"];
    var candidates = [];
    var seen = {};

    for (var i = 0; i < queries.length; i++) {
      try {
        var rows = await sdk.getPlacesByInput(
          queries[i],
          config.institutionId,
          config.parentPlace,
          undefined,
          undefined,
          undefined,
          undefined,
          floorHint ? String(floorHint) : undefined
        );
        (rows || []).forEach(function (place) {
          if (!place || !place.mapvxId || seen[place.mapvxId]) return;
          if (!placeLooksLikeElevator(place)) return;
          seen[place.mapvxId] = true;
          candidates.push(place);
        });
      } catch (e) {
        /* continue */
      }
    }

    if (!candidates.length) return null;

    var anchorPos = anchorPlace && anchorPlace.position ? anchorPlace.position : null;
    if (!anchorPos) return candidates[0];

    var best = null;
    var bestDist = Number.POSITIVE_INFINITY;
    candidates.forEach(function (place) {
      var dist = poiDistanceSq(anchorPos, place.position || place);
      if (dist < bestDist) {
        bestDist = dist;
        best = place;
      }
    });
    return best || candidates[0];
  }

  async function resolveBathroomPlaceViaApi(anchorPlace, floorHint, preferChangingTable) {
    if (!sdk || typeof sdk.getPlacesByInput !== "function") return null;
    var config = getConfig();
    var queries = preferChangingTable
      ? ["mudador", "changing table", "baño", "toilets"]
      : ["baño", "baños", "toilets", "toilet", "restroom"];
    var candidates = [];
    var seen = {};

    for (var i = 0; i < queries.length; i++) {
      try {
        var rows = await sdk.getPlacesByInput(
          queries[i],
          config.institutionId,
          config.parentPlace,
          undefined,
          undefined,
          undefined,
          undefined,
          floorHint ? String(floorHint) : undefined
        );
        (rows || []).forEach(function (place) {
          if (!place || !place.mapvxId || seen[place.mapvxId]) return;
          if (!placeLooksLikeBathroom(place) && !preferChangingTable) return;
          seen[place.mapvxId] = true;
          candidates.push(place);
        });
      } catch (e) {
        /* continue */
      }
    }

    if (!candidates.length) return null;

    var anchorPos = anchorPlace && anchorPlace.position ? anchorPlace.position : null;
    if (!anchorPos) return candidates[0];

    var best = null;
    var bestDist = Number.POSITIVE_INFINITY;
    candidates.forEach(function (place) {
      var dist = poiDistanceSq(anchorPos, place.position || {});
      if (dist < bestDist) {
        bestDist = dist;
        best = place;
      }
    });
    return best;
  }

  async function resolveToiletDestinationNearAnchor(anchorPlace, floorHint, preferChangingTable, attempts) {
    attempts = attempts || [];
    var libreMap = map && getLibreMap(map);
    var config = getConfig();
    var parentPlace = null;
    try {
      parentPlace = await getParentPlaceCached(config.parentPlace);
    } catch (eParent) { /* noop */ }

    var floorId = pickFloorId(
      anchorPlace,
      floorHint,
      parentPlace,
      (anchorPlace && anchorPlace.clientId) || null
    );

    var toilets = await collectToiletPoisWithRetry(libreMap, floorId, 3);
    var anchorPos = anchorPlace && anchorPlace.position ? anchorPlace.position : null;

    if (anchorPos && toilets.length) {
      var nearest = pickNearestToiletPoi(toilets, anchorPos, floorId, preferChangingTable);
      if (nearest) {
        // Prefer a real MapVX place when the POI ref resolves — routing needs a place id.
        try {
          var byRef = await sdk.getPlaceDetail(nearest.ref);
          if (byRef && byRef.mapvxId) {
            attempts.push({ method: "toilet-poi+getPlaceDetail", ref: nearest.ref });
            return {
              place: byRef,
              resolvedBy: "toilet-poi-place",
              lookupKey: byRef.mapvxId,
              toiletPoi: nearest,
              attempts: attempts,
            };
          }
        } catch (eRef) {
          attempts.push({ method: "toilet-poi-getPlaceDetail", error: String(eRef.message || eRef) });
        }

        attempts.push({ method: "nearest-toilet-poi", ref: nearest.ref });
        return {
          place: buildSyntheticServicePlace(nearest, "Baños"),
          resolvedBy: "nearest-toilet-poi",
          lookupKey: nearest.ref,
          toiletPoi: nearest,
          attempts: attempts,
        };
      }
    }

    var apiPlace = await resolveBathroomPlaceViaApi(anchorPlace, floorHint || floorId, preferChangingTable);
    if (apiPlace) {
      attempts.push({ method: "getPlacesByInput(baño)", mapvxId: apiPlace.mapvxId });
      return {
        place: apiPlace,
        resolvedBy: "api-bathroom-near-anchor",
        lookupKey: apiPlace.mapvxId,
        attempts: attempts,
      };
    }

    return null;
  }

  function poiDistanceSq(a, b) {
    if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) {
      return Number.POSITIVE_INFINITY;
    }
    var dLat = a.lat - b.lat;
    var dLng = a.lng - b.lng;
    return dLat * dLat + dLng * dLng;
  }

  function pickNearestToiletPoi(toilets, anchorPosition, floorId, preferChangingTable) {
    if (!toilets || !toilets.length) return null;

    function floorKeyLoose(value) {
      var raw = String(value == null ? "" : value).trim().toLowerCase();
      if (!raw) return "";
      if (raw === "pb" || raw.indexOf("planta") >= 0 || raw === "0") return "pb";
      var m = raw.match(/(\d+)/);
      return m ? m[1] : raw;
    }

    var targetFloor = floorKeyLoose(floorId);
    var filtered = toilets.filter(function (poi) {
      if (!targetFloor || !poi.floor_key) return true;
      return floorKeyLoose(poi.floor_key) === targetFloor;
    });
    if (!filtered.length) filtered = toilets.slice();

    var best = null;
    var bestScore = Number.POSITIVE_INFINITY;
    filtered.forEach(function (poi) {
      var dist = poiDistanceSq(anchorPosition, poi);
      var score = dist;
      // Prefer same-floor matches even when we had to fall back to all toilets.
      if (targetFloor && floorKeyLoose(poi.floor_key) === targetFloor) {
        score -= 1e-4;
      }
      if (preferChangingTable && String(poi.subclass || "").toLowerCase() === "changing_table") {
        score -= 1e-8;
      } else if (!preferChangingTable && String(poi.subclass || "").toLowerCase() === "changing_table") {
        score += 1e-6;
      }
      if (score < bestScore) {
        bestScore = score;
        best = poi;
      }
    });
    return best;
  }

  function pickNearestElevatorPoi(elevators, anchorPosition, floorId) {
    if (!elevators || !elevators.length) return null;

    function floorKeyLoose(value) {
      var raw = String(value == null ? "" : value).trim().toLowerCase();
      if (!raw) return "";
      if (raw === "pb" || raw.indexOf("planta") >= 0 || raw === "0") return "pb";
      var m = raw.match(/(\d+)/);
      return m ? m[1] : raw;
    }

    var targetFloor = floorKeyLoose(floorId);
    var filtered = elevators.filter(function (poi) {
      if (!targetFloor || !poi.floor_key) return true;
      return floorKeyLoose(poi.floor_key) === targetFloor;
    });
    if (!filtered.length) filtered = elevators.slice();

    var best = null;
    var bestScore = Number.POSITIVE_INFINITY;
    filtered.forEach(function (poi) {
      var dist = poiDistanceSq(anchorPosition, poi);
      var score = dist;
      if (targetFloor && floorKeyLoose(poi.floor_key) === targetFloor) {
        score -= 1e-4;
      }
      if (score < bestScore) {
        bestScore = score;
        best = poi;
      }
    });
    return stabilizeElevatorBankPoi(best, filtered);
  }

  /**
   * MapVX paints one icon per cabin. Prefer the bank centroid so routing lands
   * on the group (beige shafts) instead of a random cabin at the edge.
   * ~12 m ≈ 0.00011° lat; use squared threshold in poiDistanceSq units.
   */
  function stabilizeElevatorBankPoi(nearest, elevators) {
    if (!nearest || !elevators || elevators.length < 2) return nearest;
    var clusterRadiusSq = 0.00012 * 0.00012;
    var cluster = elevators.filter(function (poi) {
      return poiDistanceSq(nearest, poi) <= clusterRadiusSq;
    });
    if (cluster.length < 2) return nearest;

    var sumLat = 0;
    var sumLng = 0;
    var n = 0;
    cluster.forEach(function (poi) {
      if (poi.lat == null || poi.lng == null) return;
      sumLat += Number(poi.lat);
      sumLng += Number(poi.lng);
      n += 1;
    });
    if (n < 2) return nearest;

    return Object.assign({}, nearest, {
      lat: sumLat / n,
      lng: sumLng / n,
      bankSize: n,
      bankStabilized: true,
    });
  }

  /**
   * Elevator POI centroids sit inside the shaft (often non-walkable). Pull the
   * route target toward a walkable approach POI (ATM / landmark) so MapVX enters
   * the elevator alcove instead of stopping short or looping around.
   */
  function pullCoordsToward(from, toward, weight) {
    var w = weight == null ? 0.42 : weight;
    if (!from || from.lat == null || from.lng == null) return from;
    if (!toward || toward.lat == null || toward.lng == null) return from;
    return {
      lat: Number(from.lat) * (1 - w) + Number(toward.lat) * w,
      lng: Number(from.lng) * (1 - w) + Number(toward.lng) * w,
    };
  }

  function biasElevatorPoiTowardAnchor(elevatorPoi, anchorPos, weight) {
    if (!elevatorPoi || !anchorPos) return elevatorPoi;
    var pulled = pullCoordsToward(elevatorPoi, anchorPos, weight == null ? 0.42 : weight);
    if (!pulled || pulled.lat == null) return elevatorPoi;
    return Object.assign({}, elevatorPoi, {
      lat: pulled.lat,
      lng: pulled.lng,
      corridorBiased: true,
    });
  }

  async function resolveRouteApproachPlace(options, seedPos, floorHint, attempts) {
    options = options || {};
    attempts = attempts || [];
    var config = getConfig();
    var local = options.routeApproachLocal ? String(options.routeApproachLocal).trim() : "";
    var query = options.routeApproachQuery ? String(options.routeApproachQuery).trim() : "";
    if (!local && !query) return null;

    // ~45 m — approach must be the ATM next to THIS bank, not another floor wing.
    var maxDistSq = 0.0004 * 0.0004;
    var candidates = [];

    if (local) {
      try {
        var byLocal = await sdk.getPlaceDetail(local);
        if (byLocal && byLocal.position) candidates.push(byLocal);
      } catch (eLocal) {
        attempts.push({ method: "route-approach-local", error: String(eLocal.message || eLocal) });
      }
    }

    if (query && sdk && typeof sdk.getPlacesByInput === "function") {
      var queries = [query];
      if (/cajero/i.test(query)) {
        queries.push("Cajero", "ATM", "cajero automatico");
      }
      var seen = {};
      for (var i = 0; i < queries.length; i++) {
        try {
          var rows = await sdk.getPlacesByInput(
            queries[i],
            config.institutionId,
            config.parentPlace,
            undefined,
            undefined,
            undefined,
            undefined,
            floorHint ? String(floorHint) : undefined
          );
          (rows || []).forEach(function (place) {
            if (!place || !place.mapvxId || seen[place.mapvxId]) return;
            if (!place.position || place.position.lat == null) return;
            seen[place.mapvxId] = true;
            candidates.push(place);
          });
          if (candidates.length) break;
        } catch (eQuery) {
          attempts.push({
            method: "route-approach-query",
            query: queries[i],
            error: String(eQuery.message || eQuery),
          });
        }
      }
    }

    if (!candidates.length) return null;

    var best = null;
    var bestDist = Number.POSITIVE_INFINITY;
    candidates.forEach(function (place) {
      var dist = seedPos ? poiDistanceSq(seedPos, place.position) : 0;
      if (dist < bestDist) {
        bestDist = dist;
        best = place;
      }
    });

    if (!best) return null;
    if (seedPos && bestDist > maxDistSq) {
      attempts.push({
        method: "route-approach-too-far",
        mapvxId: best.mapvxId || null,
        distSq: bestDist,
      });
      return null;
    }

    attempts.push({
      method: "route-approach",
      mapvxId: best.mapvxId || null,
      title: best.title || query || local || null,
    });
    return best;
  }

  /**
   * Catalog lat/lng identify the bank; on the active floor, re-snap to a local
   * elevator POI and route toward a walkable approach (ATM / landmark).
   * Marker stays on the elevator; routing may end at the approach POI.
   */
  async function refineElevatorCatalogForRouting(options, seed, attempts) {
    attempts = attempts || [];
    options = options || {};
    var config = getConfig();
    var anchorLocal = options.anchorLocal ? String(options.anchorLocal).trim() : "";
    var floorHint = options.floor;
    var refined = {
      ref: seed && seed.ref ? seed.ref : (options.mapvxId || options.poiRef || ""),
      lat: seed && seed.lat != null ? Number(seed.lat) : null,
      lng: seed && seed.lng != null ? Number(seed.lng) : null,
      name: (seed && seed.name) || "Ascensor",
    };
    if (refined.lat == null || refined.lng == null) return refined;

    var seedPos = { lat: refined.lat, lng: refined.lng };
    var anchorPlace = null;
    if (anchorLocal) {
      try {
        anchorPlace = await sdk.getPlaceDetail(anchorLocal);
      } catch (eAnchor) {
        attempts.push({ method: "refine-elevator-anchor", error: String(eAnchor.message || eAnchor) });
      }
    }

    var parentPlace = null;
    try {
      parentPlace = await getParentPlaceCached(config.parentPlace);
    } catch (eParent) { /* noop */ }

    var floorId = pickFloorId(
      anchorPlace || null,
      floorHint,
      parentPlace,
      anchorLocal || null
    );
    if (anchorPlace && anchorPlace.inFloors && anchorPlace.inFloors.length) {
      floorId = anchorPlace.inFloors[0] || floorId;
    }

    if (map && floorId) {
      await applyPlaceFloorAndWait(map, config, floorId, parentPlace);
      scheduleRetailPoiIconFilter(map, config);
    }
    if (map) {
      fitMapToPlace(map, seedPos, config);
      await waitForLibreMapIdle(getLibreMap(map), 1200);
      await delayMs(200);
    }

    var elevators = await collectElevatorPoisWithRetry(getLibreMap(map), floorId, 5);
    if (elevators.length) {
      var picked = pickNearestElevatorPoi(elevators, seedPos, floorId);
      if (picked && picked.lat != null && picked.lng != null) {
        refined.ref = picked.ref || refined.ref;
        refined.lat = picked.lat;
        refined.lng = picked.lng;
        refined.floor_key = picked.floor_key || floorId || "";
        refined.bankSize = picked.bankSize || 1;
        attempts.push({
          method: "refine-elevator-floor-poi",
          ref: refined.ref,
          bankSize: refined.bankSize,
        });
      }
    }

    // Keep the Ascensor pin on the shaft; routing may use a walkable approach.
    refined.markerLat = refined.lat;
    refined.markerLng = refined.lng;

    var approachPlace = await resolveRouteApproachPlace(
      options,
      { lat: refined.lat, lng: refined.lng },
      floorHint || floorId,
      attempts
    );
    if (approachPlace && approachPlace.position) {
      var weight = options.routeApproachWeight != null ? Number(options.routeApproachWeight) : 1;
      if (!isFinite(weight)) weight = 1;
      if (weight >= 0.99) {
        refined.lat = Number(approachPlace.position.lat);
        refined.lng = Number(approachPlace.position.lng);
        refined.corridorBiased = true;
        refined.approachUsed = true;
      } else {
        refined = biasElevatorPoiTowardAnchor(refined, approachPlace.position, weight);
        refined.markerLat = refined.markerLat;
        refined.markerLng = refined.markerLng;
        refined.approachUsed = true;
      }
      attempts.push({
        method: "refine-elevator-route-approach",
        weight: weight,
        toward: approachPlace.title || options.routeApproachQuery || options.routeApproachLocal || null,
      });
      return refined;
    }

    // Soft fallback toward store landmark (avoid overshooting into the shop).
    var pullTarget = anchorPlace && anchorPlace.position ? anchorPlace.position : null;
    if (pullTarget) {
      refined = biasElevatorPoiTowardAnchor(refined, pullTarget, 0.22);
      attempts.push({
        method: "refine-elevator-corridor-bias",
        weight: 0.22,
        toward: anchorLocal || null,
      });
    }

    return refined;
  }

  async function resolveElevatorDestinationNearAnchor(anchorPlace, floorHint, attempts) {
    attempts = attempts || [];
    var libreMap = map && getLibreMap(map);
    var config = getConfig();
    var parentPlace = null;
    try {
      parentPlace = await getParentPlaceCached(config.parentPlace);
    } catch (eParent) { /* noop */ }

    var floorId = pickFloorId(
      anchorPlace,
      floorHint,
      parentPlace,
      (anchorPlace && anchorPlace.clientId) || null
    );

    // Prefer the anchor's own floor when catalog floors[0] is a multi-bank default (e.g. PB).
    if (anchorPlace && anchorPlace.inFloors && anchorPlace.inFloors.length) {
      floorId = anchorPlace.inFloors[0] || floorId;
    }

    if (floorId) {
      await applyPlaceFloorAndWait(map, config, floorId, parentPlace);
      scheduleRetailPoiIconFilter(map, config);
    }
    if (anchorPlace && anchorPlace.position) {
      // querySourceFeatures / queryRenderedFeatures only see loaded viewport tiles.
      fitMapToPlace(map, anchorPlace.position, config);
      await waitForLibreMapIdle(getLibreMap(map), 1200);
      await delayMs(200);
    }

    libreMap = getLibreMap(map) || libreMap;
    var elevators = await collectElevatorPoisWithRetry(libreMap, floorId, 6);
    var anchorPos = anchorPlace && anchorPlace.position ? anchorPlace.position : null;

    if (!elevators.length) {
      attempts.push({
        method: "elevator-poi-query",
        empty: true,
        floorId: floorId || null,
        anchorLocal: (anchorPlace && anchorPlace.clientId) || null,
        sampleClasses: sampleTransportationFeatureClasses(libreMap),
      });
      // API fallback (same idea as bathrooms) when vector tiles yield nothing.
      var apiElevator = await resolveElevatorPlaceViaApi(anchorPlace, floorId || floorHint);
      if (apiElevator) {
        attempts.push({ method: "getPlacesByInput(elevator)", mapvxId: apiElevator.mapvxId });
        return {
          place: apiElevator,
          resolvedBy: "api-elevator",
          lookupKey: apiElevator.mapvxId,
          attempts: attempts,
        };
      }
      return null;
    }

    var nearest = pickNearestElevatorPoi(elevators, anchorPos || elevators[0], floorId);
    if (!nearest) {
      attempts.push({ method: "pickNearestElevatorPoi", empty: true, count: elevators.length });
      return null;
    }

    // Shaft centroids are often non-walkable; bias toward the store corridor.
    if (anchorPos) {
      nearest = biasElevatorPoiTowardAnchor(nearest, anchorPos);
      attempts.push({ method: "elevator-corridor-bias", weight: 0.42 });
    }

    try {
      var byRef = await sdk.getPlaceDetail(nearest.ref);
      if (byRef && byRef.mapvxId) {
        // Keep biased / bank-centroid coords for routing (not the raw place center).
        if (nearest.lat != null && nearest.lng != null) {
          byRef.position = { lat: nearest.lat, lng: nearest.lng };
        }
        attempts.push({
          method: "elevator-poi+getPlaceDetail",
          ref: nearest.ref,
          bankSize: nearest.bankSize || 1,
          corridorBiased: !!nearest.corridorBiased,
        });
        return {
          place: byRef,
          resolvedBy: "elevator-poi-place",
          lookupKey: byRef.mapvxId,
          elevatorPoi: nearest,
          attempts: attempts,
        };
      }
    } catch (eRef) {
      attempts.push({ method: "elevator-poi-getPlaceDetail", error: String(eRef.message || eRef) });
    }

    attempts.push({
      method: "nearest-elevator-poi",
      ref: nearest.ref,
      bankSize: nearest.bankSize || 1,
    });
    return {
      place: buildSyntheticServicePlace(nearest, "Ascensor"),
      resolvedBy: "nearest-elevator-poi",
      lookupKey: nearest.ref,
      elevatorPoi: nearest,
      attempts: attempts,
    };
  }

  function buildSyntheticServicePlace(poi, title) {
    return {
      mapvxId: poi.ref,
      clientId: poi.ref,
      title: title || poi.name || "Baños",
      position: poi.lat != null && poi.lng != null ? { lat: poi.lat, lng: poi.lng } : null,
      inFloors: poi.floor_key ? [poi.floor_key] : [],
    };
  }

  async function resolveServiceDestination(options) {
    options = options || {};
    var serviceType = resolveServiceType(options);
    var poiRef = options.poiRef ? String(options.poiRef).trim() : "";
    var mapvxId = options.mapvxId ? String(options.mapvxId).trim() : "";
    var anchorLocal = options.anchorLocal ? String(options.anchorLocal).trim() : "";
    var floorHint = options.floor;
    var defaultName = serviceType === "elevator" ? "Ascensor" : "Baños";
    var name = options.name || defaultName;
    var preferChangingTable = !!options.preferChangingTable;
    var attempts = [];

    var explicitId = mapvxId || poiRef;
    if (explicitId && hasCatalogMapvxCoords(options)) {
      // Phase 2: catalog lat/lng identify the bank (poiRef can collide across banks).
      // For elevators, refine on the active floor and bias toward the landmark so
      // routing approaches from the corridor (not the long loop around the shaft).
      var elevPoi = {
        ref: explicitId,
        lat: Number(options.lat),
        lng: Number(options.lng),
        name: name,
      };
      if (serviceType === "elevator") {
        try {
          elevPoi = await refineElevatorCatalogForRouting(options, elevPoi, attempts);
        } catch (eRefine) {
          attempts.push({
            method: "refine-elevator-catalog",
            error: String(eRefine.message || eRefine),
          });
        }
      }

      var catalogPlace = buildSyntheticServicePlace(
        {
          ref: elevPoi.ref || explicitId,
          lat: elevPoi.lat,
          lng: elevPoi.lng,
          name: name,
          floor_key: elevPoi.floor_key || "",
        },
        name
      );
      try {
        var byRefCoords = await sdk.getPlaceDetail(explicitId);
        if (byRefCoords && byRefCoords.mapvxId) {
          catalogPlace.mapvxId = byRefCoords.mapvxId;
          catalogPlace.clientId = byRefCoords.clientId || byRefCoords.mapvxId;
          if (byRefCoords.title) catalogPlace.title = name || byRefCoords.title;
          catalogPlace.inFloors = byRefCoords.inFloors || catalogPlace.inFloors;
        }
      } catch (eRefCoords) {
        attempts.push({ method: "getPlaceDetail(poiRef)", error: String(eRefCoords.message || eRefCoords) });
      }
      // Pin on the elevator shaft; route target may be the walkable approach (ATM).
      if (elevPoi.markerLat != null && elevPoi.markerLng != null) {
        catalogPlace.position = { lat: elevPoi.markerLat, lng: elevPoi.markerLng };
      } else if (elevPoi.lat != null && elevPoi.lng != null) {
        catalogPlace.position = { lat: elevPoi.lat, lng: elevPoi.lng };
      }

      attempts.push({
        method: "catalog-coords",
        explicitId: explicitId,
        corridorBiased: !!elevPoi.corridorBiased,
        approachUsed: !!elevPoi.approachUsed,
      });
      return {
        place: catalogPlace,
        resolvedBy: "catalog-coords",
        lookupKey: explicitId,
        elevatorPoi: serviceType === "elevator" ? elevPoi : null,
        toiletPoi: serviceType === "bathroom"
          ? { ref: explicitId, lat: Number(options.lat), lng: Number(options.lng) }
          : null,
        attempts: attempts,
      };
    }

    if (explicitId) {
      attempts.push({
        method: "catalog-poiRef-incomplete",
        skipped: true,
        reason: "poiRef without lat/lng — using dynamic " + serviceType + " discovery",
        explicitId: explicitId,
      });
    }

    var anchorPlace = null;
    if (anchorLocal) {
      try {
        anchorPlace = await sdk.getPlaceDetail(anchorLocal);
      } catch (eAnchor) {
        attempts.push({ method: "getPlaceDetail(anchor)", error: String(eAnchor.message || eAnchor) });
      }
    }

    if (!anchorPlace && name) {
      try {
        var inputResults = await sdk.getPlacesByInput(
          String(name),
          getConfig().institutionId,
          getConfig().parentPlace,
          undefined,
          undefined,
          undefined,
          undefined,
          floorHint ? String(floorHint) : undefined
        );
        if (inputResults && inputResults.length) {
          anchorPlace = inputResults[0];
        }
      } catch (eInput) {
        attempts.push({ method: "getPlacesByInput(service)", error: String(eInput.message || eInput) });
      }
    }

    // Anchor store is ONLY a proximity hint — never the route destination.
    if (anchorPlace) {
      if (serviceType === "elevator") {
        var elevatorResolved = await resolveElevatorDestinationNearAnchor(
          anchorPlace,
          floorHint,
          attempts
        );
        if (elevatorResolved && elevatorResolved.place) {
          if (elevatorResolved.place.title == null || elevatorResolved.place.title === "") {
            elevatorResolved.place.title = name;
          }
          log("info", "resolved elevator destination", {
            resolvedBy: elevatorResolved.resolvedBy,
            lookupKey: elevatorResolved.lookupKey,
            anchorLocal: anchorLocal || null,
            mapvxId: elevatorResolved.place.mapvxId || null,
          });
          return elevatorResolved;
        }
        attempts.push({
          method: "anchor-as-destination",
          skipped: true,
          reason: "anchor store must not be elevator route target",
          anchorLocal: anchorLocal || null,
        });
      } else {
        var toiletResolved = await resolveToiletDestinationNearAnchor(
          anchorPlace,
          floorHint,
          preferChangingTable,
          attempts
        );
        if (toiletResolved && toiletResolved.place) {
          if (toiletResolved.place.title == null || toiletResolved.place.title === "") {
            toiletResolved.place.title = name;
          }
          log("info", "resolved bathroom destination", {
            resolvedBy: toiletResolved.resolvedBy,
            lookupKey: toiletResolved.lookupKey,
            anchorLocal: anchorLocal || null,
            mapvxId: toiletResolved.place.mapvxId || null,
          });
          return toiletResolved;
        }
        attempts.push({
          method: "anchor-as-destination",
          skipped: true,
          reason: "anchor store must not be bathroom route target",
          anchorLocal: anchorLocal || null,
        });
      }
    }

    if (serviceType !== "elevator") {
      // Last chance without a resolved store anchor: API bathroom search on floor.
      var apiOnly = await resolveBathroomPlaceViaApi(null, floorHint, preferChangingTable);
      if (apiOnly) {
        attempts.push({ method: "getPlacesByInput(baño-floor-only)", mapvxId: apiOnly.mapvxId });
        return {
          place: apiOnly,
          resolvedBy: "api-bathroom-floor",
          lookupKey: apiOnly.mapvxId,
          attempts: attempts,
        };
      }
    } else {
      var apiElevatorOnly = await resolveElevatorPlaceViaApi(null, floorHint);
      if (apiElevatorOnly) {
        attempts.push({ method: "getPlacesByInput(elevator-floor-only)", mapvxId: apiElevatorOnly.mapvxId });
        return {
          place: apiElevatorOnly,
          resolvedBy: "api-elevator-floor",
          lookupKey: apiElevatorOnly.mapvxId,
          attempts: attempts,
        };
      }
    }

    var err = new Error(
      serviceType === "elevator"
        ? "No se encontró el icono de ascensor en el mapa. Espera a que cargue el piso e inténtalo de nuevo."
        : "No se encontró el icono de baño en el mapa. Espera a que cargue el piso e inténtalo de nuevo."
    );
    err.attempts = attempts;
    throw err;
  }

  function clearServiceDestinationMarker() {
    if (!serviceDestMarkerState.markerId || !map) {
      serviceDestMarkerState.markerId = null;
      return;
    }
    try {
      if (typeof map.removeMarker === "function") {
        map.removeMarker(serviceDestMarkerState.markerId);
      }
    } catch (e) { /* noop */ }
    serviceDestMarkerState.markerId = null;
  }

  function buildServiceDestinationElement(serviceType, title) {
    var isElevator = serviceType === "elevator";
    var wrap = document.createElement("div");
    wrap.className = "mapvx-service-dest-marker" + (isElevator ? " is-elevator" : " is-bathroom");
    wrap.setAttribute("role", "img");
    wrap.setAttribute("aria-label", title || (isElevator ? "Ascensor" : "Baños"));

    var badge = document.createElement("div");
    badge.className = "mapvx-service-dest-badge";
    if (isElevator) {
      // Classic elevator glyph (cab + up/down) — clearer than MapVX entrance arrows.
      badge.innerHTML =
        '<svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">' +
        '<rect x="7" y="5" width="14" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>' +
        '<path d="M14 8l3.2 4.2H10.8zM14 20l-3.2-4.2h6.4z" fill="currentColor"/>' +
        "</svg>";
    } else {
      badge.textContent = "🚻";
    }
    wrap.appendChild(badge);

    var label = document.createElement("div");
    label.className = "mapvx-service-dest-label";
    label.textContent = isElevator ? "Ascensor" : "Baños";
    wrap.appendChild(label);
    return wrap;
  }

  function showServiceDestinationMarker(mapInstance, place, floorId, serviceType, title) {
    clearServiceDestinationMarker();
    if (!mapInstance || !place || !place.position) return null;
    if (place.position.lat == null || place.position.lng == null) return null;
    if (typeof mapInstance.addMarker !== "function") return null;

    try {
      var markerId = mapInstance.addMarker({
        id: "service-dest-" + String(Date.now()),
        coordinate: { lat: place.position.lat, lng: place.position.lng },
        floorId: floorId || undefined,
        text: "",
        element: buildServiceDestinationElement(serviceType, title),
        iconProperties: { width: 56, height: 64 },
        anchor: "bottom",
        rotationAlignment: "viewport",
        pitchAlignment: "viewport",
      });
      if (markerId) {
        serviceDestMarkerState.markerId = markerId;
        log("info", "service destination marker", {
          markerId: markerId,
          serviceType: serviceType || null,
          lat: place.position.lat,
          lng: place.position.lng,
        });
      }
      return markerId || null;
    } catch (e) {
      log("warn", "service destination marker failed", { error: String(e.message || e) });
      return null;
    }
  }

  async function showServicePlace(containerEl, options) {
    options = options || {};
    log("info", "showServicePlace start", options);
    var config = getConfig();
    await ensureReady(config);
    var parentPromise = getParentPlaceCached(config.parentPlace).catch(function () { return null; });
    await ensureMap(containerEl, config);
    var parentPlace = await parentPromise;

    if (parentPlace) {
      registerParentPlace(map, parentPlace);
    }

    var preFloorId = pickFloorId(
      null,
      options.floor,
      parentPlace,
      options.anchorLocal || options.local || null
    );
    if (preFloorId && needsServicePoiDiscovery(options)) {
      await applyPlaceFloorAndWait(map, config, preFloorId, parentPlace);
      scheduleRetailPoiIconFilter(map, config);
      await waitForLibreMapIdle(getLibreMap(map), 700);
    } else if (preFloorId) {
      await applyPlaceFloorAndWait(map, config, preFloorId, parentPlace);
      scheduleRetailPoiIconFilter(map, config);
    }

    var resolved = await resolveServiceDestination(options);
    var place = resolved.place;
    var mapvxId = place.mapvxId;
    var serviceType = resolveServiceType(options);

    var floorId = pickFloorId(
      place,
      options.floor,
      parentPlace,
      options.anchorLocal || options.local || resolved.lookupKey || null
    );
    log("info", "showServicePlace floor picked", { floorHint: options.floor, floorId: floorId });

    await applyPlaceFloorAndWait(map, config, floorId, parentPlace);
    scheduleRetailPoiIconFilter(map, config);

    if (typeof map.clearColoredPlaces === "function") map.clearColoredPlaces();
    if (typeof map.setPlacesAsSelected === "function" && mapvxId) {
      map.setPlacesAsSelected([mapvxId], "#5B2D8E");
      log("info", "setPlacesAsSelected service", { mapvxId: mapvxId });
    }

    await waitForMapContainerLayout(containerEl);
    if (place.position) {
      await delayMs(50);
      fitMapToPlace(map, place.position, config);
      await delayMs(80);
    } else if (parentPlace) {
      await fitMapToIndoorContext(map, config, parentPlace);
    }

    var displayTitle = getPlaceDisplayTitle(place) || options.name || (serviceType === "elevator" ? "Ascensor" : "Baños");
    if (serviceType === "elevator" && place && !place.title) {
      place.title = displayTitle;
    }
    showPlacePopOver(map, place, floorId);
    showServiceDestinationMarker(map, place, floorId, serviceType, displayTitle);

    var result = {
      mapvxId: mapvxId,
      clientId: place.clientId || null,
      local: options.anchorLocal || null,
      catalogId: options.serviceId || options.id || null,
      lookupKey: resolved.lookupKey || options.serviceId || null,
      title: displayTitle,
      resolvedBy: resolved.resolvedBy,
      attempts: resolved.attempts || [],
      floorId: floorId,
      selectedPlace: place,
      toiletPoi: resolved.toiletPoi || null,
      elevatorPoi: resolved.elevatorPoi || null,
      serviceType: serviceType,
    };
    log("info", "showServicePlace success", result);
    await finalizeMapSession(result, options);
    refreshPopOverFloorLabel();
    return result;
  }

  async function showServiceRouteTo(containerEl, options) {
    log("info", "showServiceRouteTo start", options);
    var result = await showServicePlace(containerEl, options);
    if (!hasRouteOrigin()) {
      result.routeSkipped = "no originPlaceId configured";
      log("warn", "service route skipped", { reason: result.routeSkipped });
      return result;
    }
    try {
      await drawRouteToTarget();
      result.routeStarted = true;
      result.routeActive = true;
      log("info", "service route animation started");
    } catch (e) {
      result.routeError = String(e.message || e);
      log("error", "showServiceRouteTo route failed", { error: result.routeError });
    }
    return result;
  }

  async function resolvePlace(options, nameArg, floorArg) {
    if (typeof options === "string" || options == null) {
      options = {
        id: options,
        name: nameArg,
        floor: floorArg,
      };
    }
    options = options || {};
    var local = options.local ? String(options.local).trim() : "";
    var catalogId = options.catalogId
      ? String(options.catalogId).trim()
      : (options.id && isCatalogNumericId(options.id) ? String(options.id).trim() : "");
    var name = options.name;
    var floor = options.floor;
    var strictLocal = options.strictLocal !== false && !!local;
    var attempts = [];
    log("info", "resolvePlace start", {
      local: local,
      catalogId: catalogId,
      name: name,
      floor: floor,
      strictLocal: strictLocal,
    });

    if (local) {
      try {
        log("info", "try getPlaceDetail", { key: local, label: "local(clientId)" });
        var byLocal = await sdk.getPlaceDetail(local);
        if (byLocal && (!byLocal.clientId || clientIdMatchesCatalogLocal(byLocal.clientId, local))) {
          log("info", "resolved by getPlaceDetail", {
            source: "local(clientId)",
            mapvxId: byLocal.mapvxId,
            clientId: byLocal.clientId,
            title: byLocal.title,
          });
          return {
            place: byLocal,
            resolvedBy: "getPlaceDetail(local)",
            lookupKey: local,
            attempts: attempts,
          };
        }
        if (byLocal) {
          log("warn", "getPlaceDetail(local) clientId mismatch", {
            requested: local,
            clientId: byLocal.clientId,
            title: byLocal.title,
          });
        }
      } catch (e) {
        var errLocal = String(e.message || e);
        attempts.push({ method: "getPlaceDetail(local)", error: errLocal });
        log("warn", "getPlaceDetail(local) failed", { error: errLocal });
      }
    }

    try {
      log("info", "try getSubPlaces", { parentPlace: getConfig().parentPlace });
      var subPlaces = await getSubPlacesCached(getConfig().parentPlace);
      log("info", "getSubPlaces count", { count: subPlaces ? subPlaces.length : 0 });
      var subMatch = findSubPlaceMatch(subPlaces, local, catalogId, name, floor);
      if (subMatch) {
        log("info", "resolved by " + subMatch.method, {
          mapvxId: subMatch.place.mapvxId,
          clientId: subMatch.place.clientId,
          title: subMatch.place.title,
        });
        return {
          place: subMatch.place,
          resolvedBy: subMatch.method,
          lookupKey: local || catalogId || null,
          attempts: attempts,
        };
      }
      log("warn", "no match in subPlaces", { local: local, catalogId: catalogId, name: name, floor: floor });
    } catch (e) {
      var err2 = String(e.message || e);
      attempts.push({ method: "getSubPlaces", error: err2 });
      log("warn", "getSubPlaces failed", { error: err2 });
    }

    if (!strictLocal && name) {
      try {
        var floorParam = floor ? String(floor) : undefined;
        log("info", "try getPlacesByInput", { name: name, floor: floorParam });
        var results = await sdk.getPlacesByInput(
          String(name),
          getConfig().institutionId,
          getConfig().parentPlace,
          undefined,
          undefined,
          undefined,
          undefined,
          floorParam
        );
        log("info", "getPlacesByInput count", { count: results ? results.length : 0 });
        if (results && results.length) {
          log("info", "resolved by getPlacesByInput", {
            mapvxId: results[0].mapvxId,
            clientId: results[0].clientId,
            title: results[0].title,
          });
          return {
            place: results[0],
            resolvedBy: "getPlacesByInput",
            candidates: results.length,
            attempts: attempts,
          };
        }
      } catch (e) {
        var err3 = String(e.message || e);
        attempts.push({ method: "getPlacesByInput", error: err3 });
        log("warn", "getPlacesByInput failed", { error: err3 });
      }
    } else if (strictLocal && name) {
      log("warn", "skipping getPlacesByInput because strictLocal is enabled", { local: local });
    }

    log("error", "resolvePlace failed", {
      local: local,
      catalogId: catalogId,
      name: name,
      attempts: attempts,
    });
    var err = new Error(
      "No se encontró el local en MapVX"
      + (local ? " (local=" + local + ")" : "")
      + (catalogId ? " (id=" + catalogId + ")" : "")
      + (name ? " (name=" + name + ")" : "")
    );
    err.attempts = attempts;
    throw err;
  }

  function isServiceMapRequest(options) {
    options = options || {};
    return (
      options.poiType === "service"
      || !!options.serviceId
      || !!options.anchorLocal
      || !!options.poiRef
    );
  }

  async function matchServiceCatalogEntry(entry, containerEl) {
    if (!entry) throw new Error("service entry required");
    var config = getConfig();
    await ensureMap(containerEl || mapContainer, config);

    var stores = entry.anchorStores || [];
    var floorKeyLoose = function (value) {
      var raw = String(value == null ? "" : value).trim().toLowerCase();
      if (!raw) return "";
      if (raw === "pb" || raw.indexOf("planta") >= 0 || raw === "0") return "pb";
      var m = raw.match(/(\d+)/);
      return m ? m[1] : raw;
    };

    // Elevator banks list PB first — prefer primary store's floor for matching.
    var floorHint = "";
    if (entry.type === "elevator") {
      for (var pi = 0; pi < stores.length; pi++) {
        if (stores[pi].role === "primary" && stores[pi].floors && stores[pi].floors[0]) {
          floorHint = String(stores[pi].floors[0]);
          break;
        }
      }
    }
    if (!floorHint && entry.floors && entry.floors.length) {
      floorHint = entry.floors[0];
    }

    var anchorLocal = "";
    var targetFloor = floorKeyLoose(floorHint);
    var pool = stores;
    if (targetFloor) {
      var onFloor = stores.filter(function (store) {
        if (!store.floors || !store.floors.length) return false;
        return store.floors.some(function (f) {
          return floorKeyLoose(f) === targetFloor;
        });
      });
      if (onFloor.length) pool = onFloor;
    }
    for (var i = 0; i < pool.length; i++) {
      if (pool[i].role === "primary" && pool[i].local) {
        anchorLocal = String(pool[i].local);
        break;
      }
    }
    if (!anchorLocal) {
      for (var j = 0; j < pool.length; j++) {
        if (pool[j].local) {
          anchorLocal = String(pool[j].local);
          break;
        }
      }
    }
    if (!anchorLocal) {
      for (var k = 0; k < stores.length; k++) {
        if (stores[k].local) {
          anchorLocal = String(stores[k].local);
          break;
        }
      }
    }

    var mapvx = entry.mapvx || {};
    var resolveOpts = {
      serviceId: entry.id,
      serviceType: entry.type || "bathroom",
      name: entry.name,
      floor: floorHint,
      anchorLocal: anchorLocal,
      poiRef: mapvx.poiRef,
      mapvxId: mapvx.mapvxId,
      lat: mapvx.lat,
      lng: mapvx.lng,
      preferChangingTable: !!(entry.features && entry.features.mudador),
    };

    var parentPlace = await getParentPlaceCached(config.parentPlace).catch(function () { return null; });
    if (parentPlace) {
      registerParentPlace(map, parentPlace);
    }

    var preFloorId = pickFloorId(
      null,
      floorHint,
      parentPlace,
      anchorLocal || null
    );
    if (preFloorId && needsServicePoiDiscovery(resolveOpts)) {
      await applyPlaceFloorAndWait(map, config, preFloorId, parentPlace);
      scheduleRetailPoiIconFilter(map, config);
      await waitForLibreMapIdle(getLibreMap(map), 700);
    }

    return resolveServiceDestination(resolveOpts);
  }

  async function showPlace(containerEl, options) {
    options = options || {};
    if (isServiceMapRequest(options)) {
      return showServicePlace(containerEl, options);
    }
    log("info", "showPlace start", options);
    var config = getConfig();
    await ensureReady(config);
    var resolvePromise = resolvePlace({
      local: options.local,
      catalogId: options.catalogId || (options.id && /^\d+$/.test(String(options.id)) ? options.id : ""),
      id: options.id,
      name: options.name,
      floor: options.floor,
      strictLocal: options.strictLocal,
    });
    var parentPromise = getParentPlaceCached(config.parentPlace).catch(function () { return null; });
    await ensureMap(containerEl, config);
    var resolved = await resolvePromise;
    var parentPlace = await parentPromise;
    var place = resolved.place;
    if (options.strictLocal !== false && options.local) {
      if (!clientIdMatchesCatalogLocal(place.clientId, options.local)) {
        var mismatchErr = new Error(
          "MapVX devolvió otro local (clientId="
          + (place.clientId || "?")
          + ", esperado="
          + options.local
          + ")"
        );
        mismatchErr.attempts = resolved.attempts || [];
        throw mismatchErr;
      }
    }
    var mapvxId = place.mapvxId;

    if (parentPlace) {
      registerParentPlace(map, parentPlace);
    }

    var floorId = pickFloorId(
      place,
      options.floor,
      parentPlace,
      options.local || resolved.lookupKey || null
    );
    log("info", "floor picked", {
      floorHint: options.floor,
      local: options.local,
      floorId: floorId,
    });

    await applyPlaceFloorAndWait(map, config, floorId, parentPlace);
    scheduleRetailPoiIconFilter(map, config);

    if (typeof map.clearColoredPlaces === "function") map.clearColoredPlaces();
    if (typeof map.setPlacesAsSelected === "function") {
      map.setPlacesAsSelected([mapvxId], "#5B2D8E");
      log("info", "setPlacesAsSelected", { mapvxId: mapvxId });
    }

    await waitForMapContainerLayout(containerEl);
    if (!place.position) {
      log("warn", "no position to fit", { mapvxId: mapvxId });
      if (parentPlace) {
        await fitMapToIndoorContext(map, config, parentPlace);
      }
    } else {
      await delayMs(50);
      fitMapToPlace(map, place.position, config);
      await delayMs(80);
    }

    var baselineZoom = getMapZoom(map);
    storeLabelState.zoomBaseline = baselineZoom;
    _zoomLabelTier = -1;
    storeLabelState.parentPlaceId = null;
    attachZoomLabelSwitcher(map, place, baselineZoom);
    evaluateStoreLabelZoom(map, place, baselineZoom);
    showPlacePopOver(map, place, floorId);

    var result = {
      mapvxId: mapvxId,
      clientId: place.clientId || null,
      local: options.local || null,
      catalogId: options.id || null,
      lookupKey: resolved.lookupKey || options.local || options.id || null,
      title: getPlaceDisplayTitle(place),
      resolvedBy: resolved.resolvedBy,
      candidates: resolved.candidates || 1,
      attempts: resolved.attempts || [],
      floorId: floorId,
      selectedPlace: place,
    };
    log("info", "showPlace success", result);
    await finalizeMapSession(result, options);
    refreshPopOverFloorLabel();
    return result;
  }

  async function showRouteTo(containerEl, options) {
    options = options || {};
    if (isServiceMapRequest(options)) {
      return showServiceRouteTo(containerEl, options);
    }
    log("info", "showRouteTo start", options);
    var result = await showPlace(containerEl, options);

    if (!hasRouteOrigin()) {
      result.routeSkipped = "no originPlaceId configured";
      log("warn", "route skipped", { reason: result.routeSkipped });
      return result;
    }

    try {
      await drawRouteToTarget();
      result.routeStarted = true;
      result.routeActive = true;
      log("info", "route animation started");
    } catch (e) {
      result.routeError = String(e.message || e);
      log("error", "showRouteTo route failed", { error: result.routeError });
    }

    return result;
  }

  var lastMapSession = null;

  // Route animation tuning. MapVX's default (stepTime: 3, minimumSpeed: 40,
  // changeFloorTime: 0) draws routes too fast for low-power totems and jumps
  // straight into the next floor's render while still moving, causing visible
  // stutter ("tirones"). These defaults slow the pace down and add a short
  // pause on floor changes (stairs/escalators) so the new floor has time to
  // render before the route continues. Values are overridable via
  // MAPVX_CONFIG so they can be tuned per device without code changes.
  //
  // keepFixedBearing: true because Cenco requires the map to never rotate.
  // MapVX's own default is `false`, which makes the camera swing its bearing
  // to "face" the direction of travel during step-by-step route playback
  // (heading-up navigation, like a car GPS) — that rotates the whole map
  // away from north-up. Forcing this to `true` keeps the camera bearing
  // fixed at 0 for the entire route animation.
  var ROUTE_ANIMATION_DEFAULTS = {
    stepTime: 4.5,
    minimumSpeed: 25,
    changeFloorTime: 1.4,
    iconRotationTime: 0.35,
    keepFixedBearing: true,
  };

  function numOr(value, fallback) {
    var n = Number(value);
    return value != null && isFinite(n) ? n : fallback;
  }

  function getRouteAnimationConfig(config) {
    config = config || getConfig();
    return {
      stepTime: numOr(config.routeStepTime, ROUTE_ANIMATION_DEFAULTS.stepTime),
      minimumSpeed: numOr(config.routeMinimumSpeed, ROUTE_ANIMATION_DEFAULTS.minimumSpeed),
      changeFloorTime: numOr(config.routeChangeFloorTime, ROUTE_ANIMATION_DEFAULTS.changeFloorTime),
      iconRotationTime: numOr(config.routeIconRotationTime, ROUTE_ANIMATION_DEFAULTS.iconRotationTime),
      keepFixedBearing: config.routeKeepFixedBearing != null
        ? !!config.routeKeepFixedBearing
        : ROUTE_ANIMATION_DEFAULTS.keepFixedBearing,
    };
  }

  function hasRouteOrigin(config) {
    config = config || getConfig();
    return !!(config.totemPlaceId || config.originPlaceId);
  }

  function floorDisplayLabel(floor) {
    if (!floor) return "?";
    if (floor.shortName) return String(floor.shortName);
    if (floor.name) return String(floor.name);
    if (floor.level === 0) return "PB";
    if (floor.level != null && floor.level !== "") return String(floor.level);
    return floor.key ? String(floor.key) : "?";
  }

  var _zoomLabelListener = null;
  var _zoomLabelTier = -1;

  function attachZoomLabelSwitcher(mapInstance, selectedPlace, baselineZoom) {
    detachZoomLabelListener();

    if (!mapInstance) return;

    var baseConfig = getConfig();
    if (getStoreLabelMode(baseConfig) !== "featured") return;

    storeLabelState.zoomBaseline = isFinite(baselineZoom) ? baselineZoom : getMapZoom(mapInstance);

    _zoomLabelListener = function () {
      if (_zoomLabelDebounceTimer) clearTimeout(_zoomLabelDebounceTimer);
      _zoomLabelDebounceTimer = setTimeout(function () {
        _zoomLabelDebounceTimer = null;
        evaluateStoreLabelZoom(mapInstance, selectedPlace, storeLabelState.zoomBaseline);
      }, 120);
    };

    // Only zoomend: binding "zoom" fires many times per pinch and retriggers label rebuilds.
    var unbindZoomEnd = bindMapViewListener(mapInstance, "zoomend", _zoomLabelListener);
    storeLabelState.zoomListenerCleanup = function () {
      if (typeof unbindZoomEnd === "function") unbindZoomEnd();
    };

    if (!unbindZoomEnd) {
      log("warn", "attachZoomLabelSwitcher could not bind map zoom listeners");
    }

    evaluateStoreLabelZoom(mapInstance, selectedPlace, storeLabelState.zoomBaseline);
  }

  async function loadFloorsForParent(config) {
    config = config || getConfig();
    if (!config.parentPlace) return [];
    try {
      var parent = await getParentPlaceCached(config.parentPlace);
      var inner = (parent && parent.innerFloors) ? parent.innerFloors.slice() : [];
      inner.sort(function (a, b) { return (a.index || 0) - (b.index || 0); });
      return inner.map(function (f) {
        return {
          key: f.key,
          label: floorDisplayLabel(f),
          level: f.level,
          defaultFloor: !!f.defaultFloor,
        };
      });
    } catch (e) {
      log("warn", "loadFloorsForParent failed", { error: String(e.message || e) });
      return [];
    }
  }

  async function finalizeMapSession(result, options) {
    var config = getConfig();
    var floors = await loadFloorsForParent(config);
    lastMapSession = {
      result: result,
      options: options || {},
      floorId: result.floorId || null,
      floors: floors,
      routeActive: !!result.routeStarted,
    };
    return lastMapSession;
  }

  function getMapSession() {
    return lastMapSession;
  }

  function getMapViewState() {
    if (!map) return null;
    var center = null;
    try {
      if (typeof map.getCenter === "function") {
        center = map.getCenter();
      }
    } catch (e) {
      center = null;
    }
    return {
      zoom: getMapZoom(map),
      center: center ? { lat: center.lat, lng: center.lng } : null,
      bearing: typeof map.getBearing === "function" ? map.getBearing() : null,
      pitch: typeof map.getPitch === "function" ? map.getPitch() : null,
    };
  }

  function getMapFloors() {
    return lastMapSession && lastMapSession.floors ? lastMapSession.floors.slice() : [];
  }

  async function switchFloor(floorKey) {
    if (!map || !floorKey) return false;
    var config = getConfig();
    applyPlaceFloor(map, config, floorKey, null);

    if (lastMapSession && lastMapSession.result && lastMapSession.result.mapvxId) {
      if (typeof map.clearColoredPlaces === "function") map.clearColoredPlaces();
      if (typeof map.setPlacesAsSelected === "function") {
        map.setPlacesAsSelected([lastMapSession.result.mapvxId], "#5B2D8E");
      }
    }

    if (lastMapSession) {
      lastMapSession.floorId = floorKey;
    }

    var selectedPlace = lastMapSession && lastMapSession.result
      ? lastMapSession.result.selectedPlace
      : null;
    evaluateStoreLabelZoom(map, selectedPlace, storeLabelState.zoomBaseline, true);
    scheduleRetailPoiIconFilter(map, config);
    // Anchor logos (Falabella, Ripley, H&M, Jumbo...) reuse the same
    // place.position across every floor they occupy, since MapVX only
    // exposes one point per place — re-arm the centroid correction so THIS
    // floor's anchors get centered on their own polygon, not the floor
    // where the marker happened to be created.
    attachCentroidUpdater(map);

    if (selectedPlace) {
      showPlacePopOver(map, selectedPlace, floorKey);
    }

    log("info", "switchFloor", { floorKey: floorKey });
    return true;
  }

  async function resolveMapvxPlaceId(idOrClientId) {
    if (!idOrClientId) return null;
    var raw = String(idOrClientId).trim();
    if (!raw) return null;
    if (raw.charAt(0) === "-") return raw;
    try {
      var detail = await sdk.getPlaceDetail(raw);
      if (detail && detail.mapvxId) {
        log("info", "resolveMapvxPlaceId", {
          input: raw,
          mapvxId: detail.mapvxId,
          title: detail.title,
        });
        return detail.mapvxId;
      }
    } catch (e) {
      log("warn", "resolveMapvxPlaceId failed", {
        input: raw,
        error: String(e.message || e),
      });
    }
    return raw;
  }

  function buildRouteFinalLocation(result, config) {
    if (!result) return null;
    var resolvedBy = String(result.resolvedBy || "");
    var toilet = result.toiletPoi || null;
    var elevator = result.elevatorPoi || null;
    var servicePoi = toilet || elevator;
    var place = result.selectedPlace || null;
    var preferCoords = (
      resolvedBy === "nearest-toilet-poi"
      || resolvedBy === "nearest-elevator-poi"
      || resolvedBy === "catalog-coords"
      || resolvedBy === "catalog-poiRef"
      || !!servicePoi
    );

    var lat = null;
    var lng = null;
    var floorId = result.floorId || null;
    if (servicePoi && servicePoi.lat != null && servicePoi.lng != null) {
      lat = servicePoi.lat;
      lng = servicePoi.lng;
      if (servicePoi.floor_key) floorId = servicePoi.floor_key;
    } else if (place && place.position && place.position.lat != null && place.position.lng != null) {
      lat = place.position.lat;
      lng = place.position.lng;
    }

    // IndoorEqual toilet refs often are not routable place ids — prefer coordinates.
    if (preferCoords && lat != null && lng != null) {
      return {
        lat: lat,
        lng: lng,
        floorId: floorId || undefined,
        placeId: config.parentPlace || undefined,
      };
    }

    if (result.mapvxId) {
      return { id: result.mapvxId };
    }

    if (lat != null && lng != null) {
      return {
        lat: lat,
        lng: lng,
        floorId: floorId || undefined,
        placeId: config.parentPlace || undefined,
      };
    }

    return null;
  }

  async function drawRouteToTarget() {
    if (!map) throw new Error("Mapa no inicializado");
    if (!lastMapSession || !lastMapSession.result) {
      throw new Error("Sin destino en el mapa");
    }

    var config = getConfig();
    var originRaw = config.totemPlaceId || config.originPlaceId;
    if (!originRaw) {
      throw new Error("Sin totemPlaceId — configura mapvxTotemPlaceId en CencomallApiConfig");
    }

    if (typeof map.startAnimateRoute !== "function") {
      throw new Error("startAnimateRoute no disponible");
    }

    var originId = await resolveMapvxPlaceId(originRaw);
    var result = lastMapSession.result;
    var finalLocation = buildRouteFinalLocation(result, config);
    if (!finalLocation) {
      throw new Error("Sin destino en el mapa");
    }

    var destId = finalLocation.id || null;
    var destClient = result.clientId || (lastMapSession.options && lastMapSession.options.local);

    if (
      destId
      && (
        originId === destId
        || (destClient && String(originRaw).trim() === String(destClient).trim())
      )
    ) {
      throw new Error(
        "totemPlaceId apunta a la misma tienda que el destino — usa el placeId MapVX del tótem físico"
      );
    }

    var lang = (config.lang || window.MALL_LOCALE || "es").toLowerCase().startsWith("en")
      ? "en"
      : "es";

    var routeAnimCfg = getRouteAnimationConfig(config);
    log("info", "drawRouteToTarget", {
      from: originId,
      to: finalLocation,
      originRaw: originRaw,
      resolvedBy: result.resolvedBy || null,
      animation: routeAnimCfg,
    });
    hidePlacePopOver();
    scheduleRetailPoiIconFilter(map, config);
    routeAnimationToken += 1;
    var currentToken = routeAnimationToken;

    try {
      await map.startAnimateRoute(
        {
          initialLocation: { id: originId },
          finalLocation: finalLocation,
          language: lang,
        },
        {
          polylineWidth: 5,
          aheadPathStyle: { type: "Solid", color: "#E4007C" },
          behindPathStyle: { type: "Solid", color: "#E4007C" },
        },
        {
          stepTime: routeAnimCfg.stepTime,
          minimumSpeed: routeAnimCfg.minimumSpeed,
          changeFloorTime: routeAnimCfg.changeFloorTime,
          iconRotationTime: routeAnimCfg.iconRotationTime,
          keepFixedBearing: routeAnimCfg.keepFixedBearing,
          callBack: function (payload) {
            if (currentToken !== routeAnimationToken) {
              return;
            }
            scheduleRetailPoiIconFilter(map, config);
            if (payload && payload.isFinished) {
              if (lastMapSession && lastMapSession.result && lastMapSession.result.selectedPlace) {
                showPlacePopOver(map, lastMapSession.result.selectedPlace, lastMapSession.floorId);
              }
            }
          }
        }
      );
    } catch (e) {
      if (lastMapSession && lastMapSession.result && lastMapSession.result.selectedPlace) {
        showPlacePopOver(map, lastMapSession.result.selectedPlace, lastMapSession.floorId);
      }
      var msg = String(e.message || e);
      if (msg.indexOf("Failed to start animating") >= 0 || msg.indexOf("Failed to add route") >= 0) {
        throw new Error(
          "No se pudo calcular la ruta. Verifica mapvxTotemPlaceId (placeId del tótem en MapVX, no clientId de tienda)."
        );
      }
      throw e;
    }

    lastMapSession.routeActive = true;
    return true;
  }

  function clearActiveRoute() {
    routeAnimationToken += 1;
    if (map && typeof map.removeAllRoutes === "function") {
      try { map.removeAllRoutes(); } catch (e) {
        log("warn", "removeAllRoutes failed", { error: String(e.message || e) });
      }
    } else if (map && typeof map.stopAnimateRoute === "function") {
      try { map.stopAnimateRoute(); } catch (e) {
        log("warn", "stopAnimateRoute failed", { error: String(e.message || e) });
      }
    }
    if (lastMapSession) {
      lastMapSession.routeActive = false;
      if (lastMapSession.result) {
        lastMapSession.result.routeActive = false;
        lastMapSession.result.routeStarted = false;
      }
    }
    if (lastMapSession && lastMapSession.result && lastMapSession.result.selectedPlace) {
      showPlacePopOver(map, lastMapSession.result.selectedPlace, lastMapSession.floorId);
    }
    log("info", "clearActiveRoute");
  }

  async function toggleRouteToTarget() {
    if (lastMapSession && lastMapSession.routeActive) {
      clearActiveRoute();
      return { active: false };
    }
    await drawRouteToTarget();
    return { active: true };
  }

  function hasLiveMap() {
    return !!(map && mapContainer);
  }

  function notifyMapContainerShown(containerEl) {
    if (!map || !containerEl) return;
    mapContainer = containerEl;
    try {
      var libreMap = getLibreMap(map);
      if (libreMap && typeof libreMap.resize === "function") {
        libreMap.resize();
      }
    } catch (e) {
      log("warn", "notifyMapContainerShown resize failed", { error: String(e.message || e) });
    }
  }

  function suspendMap() {
    log("info", "suspendMap (keep instance)");
    routeAnimationToken += 1;
    if (map && typeof map.removeAllRoutes === "function") {
      try { map.removeAllRoutes(); } catch (e) { /* noop */ }
    }
    clearPlacePopOver();
    clearServiceDestinationMarker();
    if (map && typeof map.clearColoredPlaces === "function") {
      try { map.clearColoredPlaces(); } catch (e) { /* noop */ }
    }
    if (lastMapSession) {
      lastMapSession.routeActive = false;
      if (lastMapSession.result) {
        lastMapSession.result.routeActive = false;
        lastMapSession.result.routeStarted = false;
      }
    }
  }

  function destroyMap() {
    log("info", "destroyMap");
    clearServiceDestinationMarker();
    lastMapSession = null;
    detachZoomLabelListener();
    clearStoreLabelMarkers();
    clearPlacePopOver();
    storeLabelState.parentPlaceId = null;
    if (map && typeof map.destroyMap === "function") {
      try { map.destroyMap(); } catch (e) { log("warn", "destroyMap error", { error: String(e.message || e) }); }
    }
    map = null;
    mapContainer = null;
  }

  function reset() {
    log("info", "reset");
    destroyMap();
    sdk = null;
    initPromise = null;
    storeLabelState.loading = null;
    invalidateSubPlacesCache();
    invalidateParentPlaceCache();
  }

  return {
    isConfigured: isConfigured,
    configSummary: configSummary,
    log: log,
    ensureReady: ensureReady,
    ensureMap: ensureMap,
    prefetchMapCatalog: prefetchMapCatalog,
    hasLiveMap: hasLiveMap,
    suspendMap: suspendMap,
    notifyMapContainerShown: notifyMapContainerShown,
    resolvePlace: resolvePlace,
    resolveServiceDestination: resolveServiceDestination,
    matchServiceCatalogEntry: matchServiceCatalogEntry,
    queryToiletPoiFeatures: queryToiletPoiFeatures,
    queryElevatorPoiFeatures: queryElevatorPoiFeatures,
    listElevatorPoisOnMap: listElevatorPoisOnMap,
    showServicePlace: showServicePlace,
    showServiceRouteTo: showServiceRouteTo,
    showPlace: showPlace,
    showRouteTo: showRouteTo,
    hasRouteOrigin: hasRouteOrigin,
    getMapSession: getMapSession,
    getMapViewState: getMapViewState,
    getMapFloors: getMapFloors,
    switchFloor: switchFloor,
    drawRouteToTarget: drawRouteToTarget,
    clearActiveRoute: clearActiveRoute,
    toggleRouteToTarget: toggleRouteToTarget,
    showPlacePopOver: showPlacePopOver,
    clearPlacePopOver: clearPlacePopOver,
    destroyMap: destroyMap,
    reset: reset,
    _debugPoiLayers: function () {
      var libreMap = map && getLibreMap(map);
      if (!libreMap) return { error: "no map" };
      var style = libreMap.getStyle();
      var layers = (style && style.layers) || [];
      return {
        retailFilterEnabled: shouldHideRetailPoiIcons(getConfig()),
        poiSymbolLayers: layers
          .filter(function (layer) {
            return layer.source === "indoorequal" && layer["source-layer"] === "poi";
          })
          .map(function (layer) {
            var filter = null;
            var visibility = null;
            try { filter = libreMap.getFilter(layer.id); } catch (e) {}
            try { visibility = libreMap.getLayoutProperty(layer.id, "visibility"); } catch (e) {}
            return {
              id: layer.id,
              visibility: visibility,
              filter: filter,
              hasIcon: !!(layer.layout && layer.layout["icon-image"]),
            };
          }),
      };
    },
    _debugCentroids: function () {
      var libreMap = map && map.map;
      if (!libreMap) return { error: "no map" };
      var poiLayer = libreMap.getLayer("indoor-poi-rank1");
      var sourceFeatures = [];
      var renderedFeatures = [];
      try {
        if (poiLayer && poiLayer.source && poiLayer.sourceLayer) {
          sourceFeatures = libreMap.querySourceFeatures(poiLayer.source, { sourceLayer: poiLayer.sourceLayer });
        }
        renderedFeatures = libreMap.queryRenderedFeatures(undefined, { layers: ["indoor-poi-rank1"] });
      } catch (e) {}
      return {
        layer: poiLayer ? { source: poiLayer.source, sourceLayer: poiLayer.sourceLayer } : null,
        sourceCount: sourceFeatures.length,
        renderedCount: renderedFeatures.length,
        featuredTracked: storeLabelState.labelPlaceMarkers.length,
        featuredApplied: storeLabelState.labelPlaceMarkers.filter(function(e){ return e.centroidApplied; }).length,
        centroids: queryPOICentroidsForDebug(libreMap),
        featuredPlaces: storeLabelState.labelPlaceMarkers.map(function(e){
          return { title: e.place && (e.place.title || e.place.name), mapvxId: e.place && e.place.mapvxId, floorId: e.floorId, applied: e.centroidApplied };
        }),
      };
    },
    _debugStoreLogos: function () {
      var cfg = getConfig();
      return {
        storeLogosBase: storeLogosBase(cfg),
        manifestLoaded: !!storeLogoManifest,
        manifestEntries: storeLogoManifest
          ? Object.keys(storeLogoManifest).filter(function (key) { return key.charAt(0) !== "_"; })
          : [],
        featuredPlaces: (storeLabelState.labelPlaceMarkers || []).map(function (entry) {
          var place = entry.place || {};
          return {
            title: place.title || place.name || place.clientId,
            mapvxId: place.mapvxId,
            apiLogo: getPlaceLogoUrl(place),
            resolvedLogo: getStoreLogoUrl(place, cfg),
            brandFallback: !!getAnchorBrandStyle(place),
            floorId: entry.floorId,
            markerId: entry.markerId,
          };
        }),
      };
    },
    _refreshStoreLabels: function (mode, mapResult) {
      if (!map) return;
      // "all" mode is floor-scoped (see refreshStoreLabels) and capped by
      // getAllModeLabelLimit — not truly unlimited, to protect the totem's
      // Mali-G52 GPU / 4GB RAM on dense floors.
      var cfg = Object.assign({}, getConfig(), {
        showStoreLabels: mode,
        storeLabelMax: mode === "all" ? getAllModeLabelLimit(getConfig()) : getConfig().storeLabelMax,
      });
      storeLabelState.parentPlaceId = null;
      storeLabelState.loading = null;
      var place = mapResult && mapResult.selectedPlace;
      refreshStoreLabels(map, cfg, cfg.parentPlace, place);
    },
  };
})();
