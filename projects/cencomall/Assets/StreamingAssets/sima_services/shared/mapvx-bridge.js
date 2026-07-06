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
  var routeAnimationToken = 0;
  var LOG_PREFIX = "[MapVxBridge]";
  var subPlacesCache = { key: null, data: null, loading: null };
  var _zoomLabelDebounceTimer = null;
  var centroidUpdateTimer = null;

  function shouldBridgeLog(level) {
    if (level === "error" || level === "warn") return true;
    var cfg = getConfig();
    return !!(cfg.mapvxVerboseLog || cfg.debugMapvx);
  }

  function log(level, message, data) {
    var line = LOG_PREFIX + " " + message;
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

  function storeLogosBase(config) {
    config = config || getConfig();
    var base = config.storeLogosBase || "../shared/store-logos/";
    if (base.charAt(base.length - 1) !== "/") base += "/";
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
      script.src = url;
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
    storeLogoManifestPromise = fetch(manifestUrl, { cache: "no-cache" })
      .then(function (response) {
        if (!response.ok) throw new Error("store logo manifest HTTP " + response.status);
        return response.json();
      })
      .catch(function () {
        // file:// (Android WebView) blocks fetch — use the <script> companion.
        return loadJsonViaScript(manifestJsonpUrl, "__STORE_LOGO_MANIFEST__").catch(function () {
          return {};
        });
      })
      .then(function (data) {
        storeLogoManifest = data && typeof data === "object" ? data : {};
        log("info", "store logo manifest loaded", {
          entries: Object.keys(storeLogoManifest).filter(function (key) {
            return key.charAt(0) !== "_";
          }).length,
          manifestUrl: manifestUrl,
        });
        return storeLogoManifest;
      });

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
    return storeLogosBase(config) + filename;
  }

  function getLocalStoreLogoTreatment(place, manifest) {
    var entry = getLocalStoreLogoEntry(place, manifest || storeLogoManifest);
    if (!entry || typeof entry !== "object") return null;
    var scale = Number(entry.scale);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    var offsetX = Number(entry.offsetX);
    if (!isFinite(offsetX)) offsetX = 0;
    var offsetY = Number(entry.offsetY);
    if (!isFinite(offsetY)) offsetY = 0;
    if (!entry.backgroundColor && !entry.className && scale === 1 && offsetX === 0 && offsetY === 0) return null;
    return {
      backgroundColor: entry.backgroundColor ? String(entry.backgroundColor).trim() : "",
      className: entry.className ? String(entry.className).trim() : "",
      padded: entry.padded !== false && !!entry.backgroundColor,
      scale: scale,
      offsetX: offsetX,
      offsetY: offsetY,
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
    var m = String(local).trim().match(/^CC_([A-Za-z]+\d*|\d+|PB)_/i);
    if (!m) return null;
    return String(m[1]).toUpperCase();
  }

  function parseLevelFromHint(hint) {
    if (!hint) return null;
    var h = normalizeText(hint);
    if (h === "pb" || h.indexOf("planta baja") >= 0) return 0;
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
    var fromLocal = parseFloorFromLocal(localCode);
    if (fromLocal) add(fromLocal);
    if (floorHint) add(floorHint);
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

  function buildAnchorLogoElement(place, logoUrl, logoDims, config) {
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

    var treatment = getLocalStoreLogoTreatment(place);
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
      // Fine-tune logo placement (px): +X right / -X left, +Y down / -Y up.
      if (treatment.offsetX || treatment.offsetY) {
        wrap.style.transform = "translate(" + (treatment.offsetX || 0) + "px, " + (treatment.offsetY || 0) + "px)";
      }
    }

    if (logoUrl) {
      var img = document.createElement("img");
      img.className = "mapvx-anchor-logo";
      img.alt = "";
      img.loading = "lazy";
      img.src = logoUrl;
      if (treatment) {
        // Size the logo by a target height (scaled) and let width follow the aspect ratio.
        var baseHeight = treatment.backgroundColor ? height * 0.62 : height;
        img.style.width = "auto";
        img.style.height = Math.round(baseHeight * treatment.scale) + "px";
        img.style.maxWidth = "none";
      }
      img.onerror = function () {
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
    return {
      width: config.featuredLogoWidth != null ? Number(config.featuredLogoWidth) : 140,
      height: config.featuredLogoHeight != null ? Number(config.featuredLogoHeight) : 56,
    };
  }

  function getPlaceDisplayTitle(place) {
    if (!place) return "";
    return String(place.title || place.shortName || place.name || place.clientId || "").trim();
  }

  function getPlaceDisplaySubtitle(place) {
    if (!place) return "";
    // Skip Foursquare/Firebase hex IDs (24+ hex chars)
    var cat = String(place.categoryName || place.category || "").trim();
    if (cat && /^[0-9a-f]{16,}$/i.test(cat)) cat = "";
    if (cat) return cat;
    // Use shortDescription only if short enough to be a label
    var sd = String(place.shortDescription || "").trim();
    if (sd && sd.length <= 60) return sd;
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

  function resolvePlaceLabelPosition(mapInstance, place) {
    if (!place || !place.position) return null;
    var libreMap = getLibreMap(mapInstance);
    if (libreMap && place.mapvxId) {
      var centroids = queryPOICentroids(libreMap);
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
      var labelPos = resolvePlaceLabelPosition(placePopOverState.map, placePopOverState.place);
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
        maxWidth: "224px",
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
      } catch (e) {}
      storeLabelState.centroidListener = null;
    }
    storeLabelState.labelPlaceMarkers = [];

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

  // IndoorEqual: rank1 = shops/restaurants + most POIs; rank2 = vending, info, etc.
  var RETAIL_FOOD_POI_CLASSES = [
    "shop",
    "clothing_store",
    "grocery",
    "cafe",
    "fast_food",
    "bar",
    "beer",
    "alcohol_shop",
    "attraction",
    "art_gallery",
    "music",
    "lodging",
    "park",
    "stadium",
    "swimming",
    "hospital",
    "school",
    "college",
    "library",
    "office",
    "laundry",
    "car",
    "fuel",
    "harbor",
    "bus",
    "golf",
    "cemetery",
    "castle",
    "campsite",
    "town_hall",
  ];
  var retailPoiFilterTimer = null;

  function shouldHideRetailPoiIcons(config) {
    config = config || getConfig();
    return config.hideRetailPoiIcons !== false;
  }

  function retailPoiExclusionFilter() {
    return ["!", ["in", ["get", "class"], ["literal", RETAIL_FOOD_POI_CLASSES]]];
  }

  function mergeMapFilter(existing, extra) {
    if (!extra) return existing;
    if (!existing) return extra;
    if (Array.isArray(existing) && existing[0] === "all") {
      return existing.concat([extra]);
    }
    return ["all", existing, extra];
  }

  function filterIncludesRetailExclusion(filter) {
    if (!filter) return false;
    var json;
    try {
      json = JSON.stringify(filter);
    } catch (e) {
      return false;
    }
    return json.indexOf('"clothing_store"') >= 0 && json.indexOf('"fast_food"') >= 0;
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
    var exclusion = retailPoiExclusionFilter();
    var updated = [];

    layers.filter(isRetailPoiRankLayer).forEach(function (layer) {
      try {
        var current = libreMap.getFilter(layer.id);
        if (filterIncludesRetailExclusion(current)) return;
        var next = mergeMapFilter(current, exclusion);
        libreMap.setFilter(layer.id, next);
        updated.push(layer.id);
      } catch (e) {
        log("warn", "applyRetailPoiIconFilter layer failed", {
          layerId: layer.id,
          error: String(e.message || e),
        });
      }
    });

    if (updated.length) {
      log("info", "applyRetailPoiIconFilter", { layers: updated });
    }
  }

  function scheduleRetailPoiIconFilter(mapInstance, config) {
    if (!shouldHideRetailPoiIcons(config)) return;
    if (retailPoiFilterTimer) {
      clearTimeout(retailPoiFilterTimer);
    }
    retailPoiFilterTimer = setTimeout(function () {
      retailPoiFilterTimer = null;
      applyRetailPoiIconFilter(mapInstance, config);
    }, 200);
    setTimeout(function () {
      applyRetailPoiIconFilter(mapInstance, config);
    }, 650);
  }

  function queryPOICentroids(libreMap) {
    var result = {};
    try {
      // querySourceFeatures reads all loaded tiles, not just the viewport
      var poiLayer = libreMap.getLayer("indoor-poi-rank1");
      var features = [];
      if (poiLayer && poiLayer.source && poiLayer.sourceLayer) {
        features = libreMap.querySourceFeatures(poiLayer.source, {
          sourceLayer: poiLayer.sourceLayer,
        });
      }
      // Fallback to rendered features if source query returned nothing
      if (!features.length) {
        features = libreMap.queryRenderedFeatures(undefined, { layers: ["indoor-poi-rank1"] });
      }
      features.forEach(function (f) {
        if (f.geometry.type !== "Point") return;
        var coords = f.geometry.coordinates;
        var pos = { lat: coords[1], lng: coords[0] };
        if (f.properties && f.properties.ref) {
          result[f.properties.ref] = pos;
        }
      });
    } catch (e) {}
    return result;
  }

  function applyFeaturedCentroids(mapInst, centroids) {
    if (!mapInst || !centroids || !storeLabelState.labelPlaceMarkers.length) return;
    var toUpdate = storeLabelState.labelPlaceMarkers.filter(function (entry) {
      return entry.place && entry.place.mapvxId && centroids[entry.place.mapvxId];
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
        getConfig()
      );
      markerConfigs.forEach(function (cfg) {
        if (cfg.floorId !== entry.floorId) return;
        try {
          var newId = mapInst.addMarker(cfg);
          if (newId) {
            storeLabelState.markerIds.push(newId);
            entry.markerId = newId;
            entry.centroidApplied = true;
          }
        } catch (e) {}
      });
    });
  }

  function attachCentroidUpdater(mapInst) {
    var libreMap = mapInst && mapInst.map;
    if (!libreMap || typeof libreMap.queryRenderedFeatures !== "function") return;
    if (!storeLabelState.labelPlaceMarkers.length) return;

    // Detach any previous listener
    if (storeLabelState.centroidListener) {
      try { storeLabelState.centroidListener.libreMap.off("moveend", storeLabelState.centroidListener.fn); } catch (e) {}
      storeLabelState.centroidListener = null;
    }

    function runUpdate() {
      if (centroidUpdateTimer) clearTimeout(centroidUpdateTimer);
      centroidUpdateTimer = setTimeout(function () {
        centroidUpdateTimer = null;
        if (map !== mapInst) return;
        var centroids = queryPOICentroids(libreMap);
        applyFeaturedCentroids(mapInst, centroids);
        // Once all featured places have centroids, remove the listener
        var remaining = storeLabelState.labelPlaceMarkers.filter(function (e) { return !e.centroidApplied; });
        if (!remaining.length && storeLabelState.centroidListener) {
          try { libreMap.off("moveend", storeLabelState.centroidListener.fn); } catch (e) {}
          storeLabelState.centroidListener = null;
        }
      }, 150);
    }

    storeLabelState.centroidListener = { libreMap: libreMap, fn: runUpdate };
    libreMap.on("moveend", runUpdate);
    // Wait for map to be fully idle (all tiles loaded) before first query
    try {
      libreMap.once("idle", runUpdate);
    } catch (e) {
      setTimeout(runUpdate, 500);
    }
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

  function evaluateStoreLabelZoom(mapInstance, selectedPlace, baselineZoom) {
    var baseConfig = getConfig();
    if (getStoreLabelMode(baseConfig) !== "featured") return;

    var baseline = isFinite(baselineZoom) ? baselineZoom : storeLabelState.zoomBaseline;
    if (!isFinite(baseline)) {
      baseline = getMapZoom(mapInstance);
      storeLabelState.zoomBaseline = baseline;
    }

    var tier = getStoreLabelZoomTier(mapInstance, baseConfig, baseline);
    if (tier === _zoomLabelTier) return;

    _zoomLabelTier = tier;
    var mode = resolveStoreLabelModeForZoom(mapInstance, baseConfig, baseline);
    var cfg = Object.assign({}, baseConfig, {
      showStoreLabels: mode,
      storeLabelMax: mode === "all" ? 0 : baseConfig.storeLabelMax,
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

  function trackLabelMarker(place, markerConfig, markerId, featured) {
    storeLabelState.labelPlaceMarkers.push({
      place: place,
      floorId: markerConfig.floorId,
      markerId: markerId,
      featured: !!featured,
      centroidApplied: false,
    });
  }

  function isAuxiliaryLabel(place) {
    var text = normalizeText(storeLabelTitle(place));
    if (!text) return true;
    if (place && place.hidePlace) return true;
    return /(salida|ascensor|elevador|escalera|stair|totem|toten|ba[nñ]o|wc|toilet|parking|estacionamiento|sala de lact|informacion|info point|torre|bus|taxi)/.test(text);
  }

  function getFeaturedLabelTokens(config) {
    config = config || getConfig();
    var tokens = Array.isArray(config.storeLabelFeatured) ? config.storeLabelFeatured : [];
    if (tokens.length) return tokens;
    return [
      "Falabella",
      "Ripley",
      "Paris",
      "Jumbo",
      "Casa Ideas",
      "La Polar",
      "Nike Rise",
      "ZARA",
      "H&M",
      "Cencosud",
    ];
  }

  function isFeaturedStore(place, config) {
    if (!place || isAuxiliaryLabel(place)) return false;
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

  function buildStoreLabelMarkers(place, fallbackFloorId, featured, config, showAllLogos) {
    config = config || getConfig();
    var title = resolveStoreLabelDisplayName(place);
    var position = place && place.position;
    if (!title || !position || position.lat == null || position.lng == null) {
      return [];
    }

    var floorIds = storeLabelFloorIds(place, fallbackFloorId);
    var markerBaseId = String(place.mapvxId || place.clientId || title).replace(/[^A-Za-z0-9_-]/g, "_");
    var markers = [];
    var labelTextProps = getStoreLabelTextProperties(featured, config);
    var logoDims = getFeaturedLogoDimensions(config);
    var logoUrl = (featured || showAllLogos) ? getStoreLogoUrl(place, config) : "";
    var anchorElement = logoUrl
      ? buildAnchorLogoElement(place, logoUrl, logoDims, config)
      : null;

    for (var i = 0; i < floorIds.length; i++) {
      var floorId = floorIds[i];
      var markerId = "store-label-" + markerBaseId + "-" + floorId.replace(/[^A-Za-z0-9_-]/g, "_");
      if (featured) {
        if (anchorElement) {
          markers.push({
            id: markerId,
            coordinate: { lat: position.lat, lng: position.lng },
            floorId: floorId,
            text: "",
            element: anchorElement.cloneNode(true),
            iconProperties: { width: logoDims.width, height: logoDims.height },
            anchor: "center",
            rotationAlignment: "viewport",
            pitchAlignment: "viewport",
          });
        } else if (logoUrl) {
          markers.push({
            id: markerId,
            coordinate: { lat: position.lat, lng: position.lng },
            floorId: floorId,
            text: "",
            icon: logoUrl,
            textPosition: MapVX.TextPosition.top,
            iconProperties: { width: logoDims.width, height: logoDims.height },
            anchor: "center",
            rotationAlignment: "viewport",
            pitchAlignment: "viewport",
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
    if (mode === "all" && storeLabelState.parentPlaceId === currentParentPlaceId && storeLabelState.markerIds.length) {
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

          var featuredMarkers = buildStoreLabelMarkers(featuredPlace, currentFloorId, true, config);
          featuredMarkers.forEach(function (markerConfig) {
            var brandFloorKey = "featbrand:" + featuredBrand + "|" + markerConfig.floorId;
            if (seen[brandFloorKey]) return;
            try {
              var markerId = mapInstance.addMarker(markerConfig);
              if (markerId) {
                seen[brandFloorKey] = true;
                storeLabelState.markerIds.push(markerId);
                trackLabelMarker(featuredPlace, markerConfig, markerId, true);
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
            false
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
      parentPlace = await sdk.getPlaceDetail(config.parentPlace);
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
    await new Promise(function (r) { setTimeout(r, 200); });
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
    var catalogId = options.id ? String(options.id).trim() : "";
    var name = options.name;
    var floor = options.floor;
    var attempts = [];
    log("info", "resolvePlace start", {
      local: local,
      catalogId: catalogId,
      name: name,
      floor: floor,
    });

    var lookupKeys = [];
    if (local) lookupKeys.push({ key: local, label: "local(clientId)" });
    if (catalogId && catalogId !== local) {
      lookupKeys.push({ key: catalogId, label: "catalogId" });
    }

    for (var i = 0; i < lookupKeys.length; i++) {
      var lookup = lookupKeys[i];
      try {
        log("info", "try getPlaceDetail", lookup);
        var byId = await sdk.getPlaceDetail(lookup.key);
        if (byId) {
          log("info", "resolved by getPlaceDetail", {
            source: lookup.label,
            mapvxId: byId.mapvxId,
            clientId: byId.clientId,
            title: byId.title,
          });
          return {
            place: byId,
            resolvedBy: "getPlaceDetail(" + lookup.label + ")",
            lookupKey: lookup.key,
            attempts: attempts,
          };
        }
      } catch (e) {
        var errLookup = String(e.message || e);
        attempts.push({ method: "getPlaceDetail(" + lookup.label + ")", error: errLookup });
        log("warn", "getPlaceDetail failed", { source: lookup.label, error: errLookup });
      }
    }

    try {
      log("info", "try getSubPlaces", { parentPlace: getConfig().parentPlace });
      var subPlaces = await getSubPlacesCached(getConfig().parentPlace);
      log("info", "getSubPlaces count", { count: subPlaces ? subPlaces.length : 0 });
      if (subPlaces && subPlaces.length) {
        var match = subPlaces.find(function (p) {
          if (local && p.clientId === local) return true;
          if (catalogId && (p.clientId === catalogId || p.mapvxId === catalogId)) {
            return true;
          }
          return name && normalizeText(p.title) === normalizeText(name);
        });
        if (match) {
          var method = local && match.clientId === local
            ? "subPlaces(local→clientId)"
            : catalogId && match.clientId === catalogId
              ? "subPlaces(catalogId→clientId)"
              : catalogId && match.mapvxId === catalogId
                ? "subPlaces(catalogId→mapvxId)"
                : "subPlaces(title)";
          log("info", "resolved by " + method, {
            mapvxId: match.mapvxId,
            clientId: match.clientId,
            title: match.title,
          });
          return { place: match, resolvedBy: method, attempts: attempts };
        }
        log("warn", "no match in subPlaces", { local: local, catalogId: catalogId, name: name });
      }
    } catch (e) {
      var err2 = String(e.message || e);
      attempts.push({ method: "getSubPlaces", error: err2 });
      log("warn", "getSubPlaces failed", { error: err2 });
    }

    if (name) {
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

  async function showPlace(containerEl, options) {
    options = options || {};
    log("info", "showPlace start", options);
    var config = getConfig();
    await ensureMap(containerEl, config);

    var resolved = await resolvePlace({
      local: options.local,
      id: options.id,
      name: options.name,
      floor: options.floor,
    });
    var place = resolved.place;
    var mapvxId = place.mapvxId;

    var parentPlace = null;
    try {
      parentPlace = await sdk.getPlaceDetail(config.parentPlace);
    } catch (e) {
      log("warn", "getPlaceDetail(parentPlace) failed", { error: String(e.message || e) });
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

    if (parentPlace) {
      registerParentPlace(map, parentPlace);
    }
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
      await new Promise(function (r) { setTimeout(r, 250); });
      fitMapToPlace(map, place.position, config);
      await new Promise(function (r) { setTimeout(r, 450); });
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
      title: place.title,
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
  var ROUTE_ANIMATION_DEFAULTS = {
    stepTime: 4.5,
    minimumSpeed: 25,
    changeFloorTime: 1.4,
    iconRotationTime: 0.35,
    keepFixedBearing: false,
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
      var parent = await sdk.getPlaceDetail(config.parentPlace);
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
    evaluateStoreLabelZoom(map, selectedPlace, storeLabelState.zoomBaseline);
    scheduleRetailPoiIconFilter(map, config);

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

  async function drawRouteToTarget() {
    if (!map) throw new Error("Mapa no inicializado");
    if (!lastMapSession || !lastMapSession.result || !lastMapSession.result.mapvxId) {
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
    var destId = lastMapSession.result.mapvxId;
    var destClient = lastMapSession.result.clientId || lastMapSession.options.local;

    if (
      originId === destId
      || (destClient && String(originRaw).trim() === String(destClient).trim())
    ) {
      throw new Error(
        "totemPlaceId apunta a la misma tienda que el destino — usa el placeId MapVX del tótem físico"
      );
    }

    var lang = (config.lang || window.MALL_LOCALE || "es").toLowerCase().startsWith("en")
      ? "en"
      : "es";

    var routeAnimCfg = getRouteAnimationConfig(config);
    log("info", "drawRouteToTarget", { from: originId, to: destId, originRaw: originRaw, animation: routeAnimCfg });
    hidePlacePopOver();
    routeAnimationToken += 1;
    var currentToken = routeAnimationToken;

    try {
      await map.startAnimateRoute(
        {
          initialLocation: { id: originId },
          finalLocation: { id: destId },
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

  function destroyMap() {
    log("info", "destroyMap");
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
  }

  return {
    isConfigured: isConfigured,
    configSummary: configSummary,
    log: log,
    ensureReady: ensureReady,
    ensureMap: ensureMap,
    resolvePlace: resolvePlace,
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
        centroids: queryPOICentroids(libreMap),
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
      // storeLabelMax 0 = unlimited, so SDK creates markers for all floors and
      // only renders those matching the active floor
      var cfg = Object.assign({}, getConfig(), {
        showStoreLabels: mode,
        storeLabelMax: mode === "all" ? 0 : getConfig().storeLabelMax,
      });
      storeLabelState.parentPlaceId = null;
      storeLabelState.loading = null;
      var place = mapResult && mapResult.selectedPlace;
      refreshStoreLabels(map, cfg, cfg.parentPlace, place);
    },
  };
})();
