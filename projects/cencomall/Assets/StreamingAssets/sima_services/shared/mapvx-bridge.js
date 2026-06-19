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
  var indoorLabelMarkerIds = [];
  var lastIndoorContext = null;
  var lastIndoorContextKey = "";
  var LOG_PREFIX = "[MapVxBridge]";

  function log(level, message, data) {
    var line = LOG_PREFIX + " " + message;
    if (data !== undefined) {
      try { line += " " + JSON.stringify(data); } catch (e) { line += " [data]"; }
    }
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
    if (typeof SimaBridge !== "undefined" && SimaBridge.send) {
      SimaBridge.send("mapvx_log", { level: level, message: message, data: data ? String(JSON.stringify(data)).slice(0, 500) : "" });
    }
  }

  function getConfig() {
    return window.MAPVX_CONFIG || {};
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

  function getPlacePosition(place) {
    if (!place || !place.position) return null;
    if (place.position.lat == null || place.position.lng == null) return null;
    return {
      lat: Number(place.position.lat),
      lng: Number(place.position.lng),
    };
  }

  function getPlaceFloorId(place) {
    if (!place) return null;
    if (place.floorId) return String(place.floorId);
    if (place.currentFloorId) return String(place.currentFloorId);
    if (place.inFloors && place.inFloors.length) return String(place.inFloors[0]);
    return null;
  }

  function indoorContextKey(config) {
    config = config || getConfig();
    return [
      config.parentPlace || "",
      config.institutionId || "",
      config.lang || "",
      config.showStoreLabels === false ? "no-labels" : "labels",
    ].join("|");
  }

  function collectIndoorCoordinates(parentPlace, subPlaces) {
    var coords = [];
    var seen = {};
    function addPoint(place) {
      var pos = getPlacePosition(place);
      if (!pos) return;
      var key = pos.lat.toFixed(6) + "," + pos.lng.toFixed(6);
      if (seen[key]) return;
      seen[key] = true;
      coords.push(pos);
    }

    addPoint(parentPlace);
    (subPlaces || []).forEach(addPoint);
    return coords;
  }

  function computeIndoorView(coords) {
    if (!coords || coords.length === 0) {
      return {};
    }
    if (coords.length === 1) {
      return {
        center: coords[0],
        zoom: 18,
        minZoom: 16,
      };
    }

    var minLat = coords[0].lat;
    var maxLat = coords[0].lat;
    var minLng = coords[0].lng;
    var maxLng = coords[0].lng;
    for (var i = 1; i < coords.length; i++) {
      minLat = Math.min(minLat, coords[i].lat);
      maxLat = Math.max(maxLat, coords[i].lat);
      minLng = Math.min(minLng, coords[i].lng);
      maxLng = Math.max(maxLng, coords[i].lng);
    }

    var latPad = Math.max((maxLat - minLat) * 0.18, 0.00018);
    var lngPad = Math.max((maxLng - minLng) * 0.18, 0.00018);
    var bounds = [
      { lat: minLat - latPad, lng: minLng - lngPad },
      { lat: maxLat + latPad, lng: maxLng + lngPad },
    ];

    return {
      center: {
        lat: (minLat + maxLat) / 2,
        lng: (minLng + maxLng) / 2,
      },
      maxBounds: bounds,
      zoom: 18,
      minZoom: 16,
    };
  }

  async function getIndoorContext(config, refresh) {
    config = config || getConfig();
    var key = indoorContextKey(config);
    if (!refresh && lastIndoorContext && lastIndoorContextKey === key) {
      return lastIndoorContext;
    }

    if (!config || !config.parentPlace) {
      return null;
    }

    await ensureReady(config);

    var parentPlace = null;
    var subPlaces = [];

    try {
      parentPlace = await sdk.getPlaceDetail(config.parentPlace);
    } catch (e) {
      log("warn", "getIndoorContext getPlaceDetail failed", {
        error: String(e.message || e),
        parentPlace: config.parentPlace,
      });
    }

    try {
      subPlaces = await sdk.getSubPlaces(config.parentPlace);
    } catch (e) {
      log("warn", "getIndoorContext getSubPlaces failed", {
        error: String(e.message || e),
        parentPlace: config.parentPlace,
      });
    }

    var coords = collectIndoorCoordinates(parentPlace, subPlaces);
    var view = computeIndoorView(coords);
    lastIndoorContext = {
      parentPlace: parentPlace,
      subPlaces: subPlaces || [],
      coordinates: coords,
      view: view,
      configKey: key,
    };
    lastIndoorContextKey = key;
    return lastIndoorContext;
  }

  function clearIndoorLabelMarkers() {
    if (!map || !indoorLabelMarkerIds.length || typeof map.removeMarker !== "function") {
      indoorLabelMarkerIds = [];
      return;
    }
    indoorLabelMarkerIds.forEach(function (markerId) {
      try { map.removeMarker(markerId); } catch (e) { /* noop */ }
    });
    indoorLabelMarkerIds = [];
  }

  function formatIndoorLabelText(place) {
    if (!place) return "";
    return place.title || place.name || place.clientId || place.mapvxId || "";
  }

  function addIndoorLabelMarker(place, options) {
    options = options || {};
    if (!map || typeof map.addMarker !== "function") return;
    var position = getPlacePosition(place);
    if (!position) return;

    var markerId = options.markerId || ("indoor-label-" + String(place.mapvxId || place.clientId || formatIndoorLabelText(place) || Math.random()).replace(/[^a-zA-Z0-9_-]/g, "_"));
    var text = formatIndoorLabelText(place);
    var selected = !!options.selected;
    var markerConfig = {
      id: markerId,
      coordinate: position,
      floorId: options.floorId || getPlaceFloorId(place) || "",
      text: text,
      textPosition: 3,
      iconProperties: {
        width: selected ? 18 : 12,
        height: selected ? 18 : 12,
      },
      textProperties: {
        fontSize: selected ? "14px" : "12px",
        color: selected ? "#3D1D5C" : "#1E1630",
        fontWeight: selected ? "800" : "700",
        textShadow: "0 1px 2px rgba(255,255,255,0.95)",
      },
    };

    if (typeof options.onClick === "function") {
      markerConfig.onClick = function () {
        options.onClick(place);
      };
    }

    try {
      map.addMarker(markerConfig);
      indoorLabelMarkerIds.push(markerId);
    } catch (e) {
      log("warn", "addIndoorLabelMarker failed", {
        error: String(e.message || e),
        title: text,
      });
    }
  }

  function renderIndoorLabelMarkers(places, options) {
    options = options || {};
    clearIndoorLabelMarkers();
    if (!options.enabled) {
      return;
    }
    if (!map || typeof map.addMarker !== "function") {
      return;
    }

    var selectedId = options.selectedPlaceId ? String(options.selectedPlaceId) : "";
    var currentFloorId = options.currentFloorId ? String(options.currentFloorId) : "";
    var visiblePlaces = (places || []).filter(function (place) {
      var position = getPlacePosition(place);
      if (!position) return false;
      if (!currentFloorId) return true;
      var placeFloorId = getPlaceFloorId(place);
      return !placeFloorId || String(placeFloorId) === currentFloorId;
    });

    visiblePlaces.forEach(function (place) {
      var placeId = String(place.mapvxId || place.clientId || formatIndoorLabelText(place) || "");
      var selected = selectedId && (placeId === selectedId || String(place.clientId || "") === selectedId);
      addIndoorLabelMarker(place, {
        markerId: "indoor-label-" + placeId.replace(/[^a-zA-Z0-9_-]/g, "_"),
        selected: selected,
        floorId: currentFloorId || getPlaceFloorId(place) || "",
        onClick: options.onClick,
      });
    });
  }

  function fitMapToPlace(mapInstance, position) {
    if (!position || typeof mapInstance.fitCoordinates !== "function") {
      return;
    }
    var lat = position.lat;
    var lng = position.lng;
    if (lat == null || lng == null) {
      return;
    }
    // fitCoordinates con 1 punto solo hace setCenter sin zoom → vista mundo.
    var delta = 0.00035;
    mapInstance.fitCoordinates(
      [
        { lat: lat - delta, lng: lng - delta },
        { lat: lat + delta, lng: lng + delta },
      ],
      { padding: 60, maxZoom: 20, duration: 0 }
    );
    log("info", "fitMapToPlace", { lat: lat, lng: lng });
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
      var subPlaces = await sdk.getSubPlaces(config.parentPlace);
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

    if (coords.length >= 2) {
      mapInstance.fitCoordinates(coords, { padding: 56, maxZoom: 20, duration: 0 });
      log("info", "fitMapToIndoorContext bbox", { points: coords.length });
      return;
    }
    if (coords.length === 1) {
      fitMapToPlace(mapInstance, coords[0]);
    }
  }

  async function ensureIndoorMapReady(mapInstance, config) {
    if (!mapInstance || !config || !config.parentPlace) {
      return null;
    }

    var indoorContext = await getIndoorContext(config);
    if (!indoorContext || !indoorContext.parentPlace) {
      return null;
    }

    var parentPlace = indoorContext.parentPlace;
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

    try {
      if (indoorContext.view && indoorContext.view.maxBounds && typeof mapInstance.setMaxBounds === "function") {
        mapInstance.setMaxBounds(indoorContext.view.maxBounds);
        log("info", "ensureIndoorMapReady setMaxBounds", { points: indoorContext.coordinates.length });
      }
      if (indoorContext.view && indoorContext.view.minZoom != null && typeof mapInstance.setMinZoom === "function") {
        mapInstance.setMinZoom(indoorContext.view.minZoom);
      }
    } catch (e) {
      log("warn", "ensureIndoorMapReady bounds failed", {
        error: String(e.message || e),
      });
    }

    if (config.showStoreLabels !== false) {
      renderIndoorLabelMarkers(indoorContext.subPlaces, {
        enabled: true,
        currentFloorId: floorKey,
      });
    }

    await fitMapToIndoorContext(mapInstance, config, parentPlace);
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

    var indoorContext = null;
    try {
      indoorContext = await getIndoorContext(config);
    } catch (e) {
      log("warn", "ensureMap indoor context failed", { error: String(e.message || e) });
    }

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
        map = sdk.createMap(containerEl, {
          parentPlaceId: config.parentPlace,
          center: indoorContext && indoorContext.view ? indoorContext.view.center : undefined,
          zoom: indoorContext && indoorContext.view ? indoorContext.view.zoom : undefined,
          minZoom: indoorContext && indoorContext.view ? indoorContext.view.minZoom : undefined,
          maxBounds: indoorContext && indoorContext.view ? indoorContext.view.maxBounds : undefined,
          lang: (config.lang || window.MALL_LOCALE || "es").toLowerCase().startsWith("en") ? "en" : "es",
          enableHover: true,
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
        });
        log("info", "createMap called", { parentPlaceId: config.parentPlace });
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
      var subPlaces = await sdk.getSubPlaces(getConfig().parentPlace);
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

    try {
      var context = await getIndoorContext(config);
      if (context && config.showStoreLabels !== false) {
        renderIndoorLabelMarkers(context.subPlaces, {
          enabled: true,
          selectedPlaceId: mapvxId,
          currentFloorId: floorId,
          onClick: function (place) {
            showPlace(containerEl, {
              local: place.clientId || "",
              id: place.mapvxId || place.clientId || "",
              name: place.title || "",
              floor: getPlaceFloorId(place) || "",
            }).catch(function (e) {
              log("warn", "label click failed", { error: String(e.message || e) });
            });
          },
        });
      }
    } catch (e) {
      log("warn", "showPlace render labels failed", { error: String(e.message || e) });
    }

    await waitForMapContainerLayout(containerEl);
    fitMapToPlace(map, place.position);
    if (!place.position) {
      log("warn", "no position to fit", { mapvxId: mapvxId });
      if (parentPlace) {
        await fitMapToIndoorContext(map, config, parentPlace);
      }
    } else {
      await new Promise(function (r) { setTimeout(r, 250); });
      fitMapToPlace(map, place.position);
    }

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
    };
    log("info", "showPlace success", result);
    await finalizeMapSession(result, options);
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

  function getMapFloors() {
    return lastMapSession && lastMapSession.floors ? lastMapSession.floors.slice() : [];
  }

  async function switchFloor(floorKey) {
    if (!map || !floorKey) return false;
    var config = getConfig();
    applyPlaceFloor(map, config, floorKey, null);

    if (lastMapSession) {
      lastMapSession.floorId = floorKey;
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

    log("info", "drawRouteToTarget", { from: originId, to: destId, originRaw: originRaw });

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
        }
      );
    } catch (e) {
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
    if (map && typeof map.stopAnimateRoute === "function") {
      try { map.stopAnimateRoute(); } catch (e) {
        log("warn", "stopAnimateRoute failed", { error: String(e.message || e) });
      }
    }
    if (lastMapSession) {
      lastMapSession.routeActive = false;
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
    clearIndoorLabelMarkers();
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
    lastIndoorContext = null;
    lastIndoorContextKey = "";
  }

  return {
    isConfigured: isConfigured,
    configSummary: configSummary,
    log: log,
    ensureReady: ensureReady,
    ensureMap: ensureMap,
    getIndoorContext: getIndoorContext,
    resolvePlace: resolvePlace,
    showPlace: showPlace,
    showRouteTo: showRouteTo,
    hasRouteOrigin: hasRouteOrigin,
    getMapSession: getMapSession,
    getMapFloors: getMapFloors,
    switchFloor: switchFloor,
    drawRouteToTarget: drawRouteToTarget,
    clearActiveRoute: clearActiveRoute,
    toggleRouteToTarget: toggleRouteToTarget,
    destroyMap: destroyMap,
    reset: reset,
  };
})();
