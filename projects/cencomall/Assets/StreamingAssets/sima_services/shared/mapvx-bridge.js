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
  };
  var placePopOverState = {
    map: null,
    placeId: null,
    floorId: null,
    place: null,
    node: null,
    listenersBound: false,
    scheduled: false,
  };
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

  function fitMapToPlace(mapInstance, position) {
    if (!position) {
      return;
    }
    var lat = position.lat;
    var lng = position.lng;
    if (lat == null || lng == null) {
      return;
    }
    if (typeof mapInstance.setCenter === "function") {
      mapInstance.setCenter({ lat: lat, lng: lng });
    } else if (typeof mapInstance.fitCoordinates === "function") {
      mapInstance.fitCoordinates([{ lat: lat, lng: lng }], { duration: 0 });
    }
    log("info", "fitMapToPlace", { lat: lat, lng: lng, method: typeof mapInstance.setCenter === "function" ? "setCenter" : "fitCoordinates" });
  }

  function getPlaceLogoUrl(place) {
    if (!place) return "";
    var candidates = [
      place.logo,
      place.logoUrl,
      place.imageUrl,
      place.image,
    ];
    if (place.images && place.images.length) {
      candidates.push(place.images[0] && (place.images[0].url || place.images[0].src || place.images[0].imageUrl));
    }
    if (place.metadata) {
      candidates.push(place.metadata.logoUrl, place.metadata.imageUrl);
    }
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i]) {
        return String(candidates[i]);
      }
    }
    return "";
  }

  function getPlaceDisplayTitle(place) {
    if (!place) return "";
    return String(place.title || place.shortName || place.name || place.clientId || "").trim();
  }

  function getPlaceDisplaySubtitle(place) {
    if (!place) return "";
    var parts = [];
    if (place.category) parts.push(String(place.category));
    if (place.shortDescription) parts.push(String(place.shortDescription));
    else if (place.description) parts.push(String(place.description));
    return parts.filter(Boolean).join(" · ");
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

      var subtitle = document.createElement("div");
      subtitle.className = "mapvx-place-popover-subtitle";
      subtitle.setAttribute("data-mapvx-popover-subtitle", "true");

      body.appendChild(title);
      body.appendChild(subtitle);
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

  function buildPlacePopOverContent(place) {
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

    wrap.appendChild(logoWrap);
    wrap.appendChild(body);
    return wrap;
  }

  function renderPlacePopOverContent(place, root) {
    if (!place || !root) return;
    var titleEl = root.querySelector("[data-mapvx-popover-title]");
    var subtitleEl = root.querySelector("[data-mapvx-popover-subtitle]");
    var logoWrap = root.querySelector("[data-mapvx-popover-logo]");
    var title = getPlaceDisplayTitle(place);
    var subtitle = getPlaceDisplaySubtitle(place);
    var logoUrl = getPlaceLogoUrl(place);
    var initials = getPlaceInitials(place);

    if (titleEl) titleEl.textContent = title;
    if (subtitleEl) {
      subtitleEl.textContent = subtitle;
      subtitleEl.classList.toggle("hidden", !subtitle);
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

  function updatePlacePopOverPosition() {
    if (!placePopOverState.map || !placePopOverState.node || !placePopOverState.place) {
      return;
    }

    var root = placePopOverState.node.querySelector("[data-mapvx-place-popover]");
    if (!root) return;

    try {
      renderPlacePopOverContent(placePopOverState.place, root);
      var point = placePopOverState.map.project({
        lng: placePopOverState.place.position.lng,
        lat: placePopOverState.place.position.lat,
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
    if (placePopOverState.map && typeof placePopOverState.map.removePopOver === "function") {
      try {
        placePopOverState.map.removePopOver(placePopOverState.placeId);
      } catch (e) {
        log("warn", "removePopOver failed", { error: String(e.message || e) });
      }
    }
    placePopOverState.map = null;
    placePopOverState.placeId = null;
    placePopOverState.floorId = null;
    placePopOverState.place = null;
    placePopOverState.node = null;
    placePopOverState.listenersBound = false;
    placePopOverState.scheduled = false;
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
        content: buildPlacePopOverContent(place),
        maxWidth: "280px",
        className: "mapvx-sdk-popover",
      });
    } else {
      ensurePlacePopOverNode(mapInstance);
      bindPlacePopOverEvents(mapInstance);
      schedulePlacePopOverUpdate();
      updatePlacePopOverPosition();
    }

    log("info", "showPlacePopOver", {
      placeId: placePopOverState.placeId,
      floorId: placePopOverState.floorId,
      title: getPlaceDisplayTitle(place),
    });

    return placePopOverState.placeId;
  }

  function getStoreLabelMode(config) {
    config = config || getConfig();
    var mode = config.showStoreLabels;
    if (mode === true || mode === "all") return "all";
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

  function storeLabelTitle(place) {
    if (!place) return "";
    return String(place.title || place.shortName || place.name || place.clientId || "").trim();
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
      "Nike Rise",
      "ZARA",
      "H&M",
      "Mango",
      "Levi's",
      "Ripley",
      "Falabella",
      "Steve Madden",
      "BIMBA",
      "Aldo",
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
        if (candidates[i] === token || candidates[i].indexOf(token) >= 0 || token.indexOf(candidates[i]) >= 0) {
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

  function buildStoreLabelMarkers(place, fallbackFloorId) {
    var title = storeLabelTitle(place);
    var position = place && place.position;
    if (!title || !position || position.lat == null || position.lng == null) {
      return [];
    }

    var floorIds = storeLabelFloorIds(place, fallbackFloorId);
    var markerBaseId = String(place.mapvxId || place.clientId || title).replace(/[^A-Za-z0-9_-]/g, "_");
    var labelText = title;
    var markers = [];

    for (var i = 0; i < floorIds.length; i++) {
      var floorId = floorIds[i];
      var markerId = "store-label-" + markerBaseId + "-" + floorId.replace(/[^A-Za-z0-9_-]/g, "_");
      markers.push({
        id: markerId,
        coordinate: { lat: position.lat, lng: position.lng },
        floorId: floorId,
        text: labelText,
        textPosition: MapVX.TextPosition.right,
        iconProperties: { width: 10, height: 10 },
        textProperties: {
          fontSize: "12px",
          fontWeight: "700",
          color: "#1E1630",
          textShadow: "0 1px 3px rgba(255,255,255,0.95)",
        },
        anchor: "center",
        rotationAlignment: "viewport",
      });
    }

    return markers;
  }

  function findSelectedStoreLabelMarker(place, fallbackFloorId) {
    var markers = buildStoreLabelMarkers(place, fallbackFloorId);
    return markers.length ? markers[0] : null;
  }

  async function refreshStoreLabels(mapInstance, config, parentPlace, selectedPlace) {
    config = config || getConfig();
    if (!mapInstance || !config || !config.parentPlace || !shouldRenderStoreLabels(config)) {
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

      var subPlaces = [];
      try {
        subPlaces = await sdk.getSubPlaces(config.parentPlace);
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
        var selectedMarker = selectedPlace ? findSelectedStoreLabelMarker(selectedPlace, currentFloorId) : null;
        if (selectedMarker && canAddMore()) {
          try {
            var selectedMarkerId = mapInstance.addMarker(selectedMarker);
            if (selectedMarkerId) {
              storeLabelState.markerIds.push(selectedMarkerId);
              added++;
            }
          } catch (e) {
            log("warn", "add selected store label marker failed", {
              title: storeLabelTitle(selectedPlace),
              floorId: selectedMarker.floorId,
              error: String(e.message || e),
            });
          }
        }
      } else if (mode === "featured") {
        var selectedKey = selectedPlace ? String(selectedPlace.mapvxId || selectedPlace.clientId || storeLabelTitle(selectedPlace)) : "";
        if (selectedPlace && !isAuxiliaryLabel(selectedPlace) && canAddMore()) {
          var selectedFeaturedMarker = findSelectedStoreLabelMarker(selectedPlace, currentFloorId);
          if (selectedFeaturedMarker) {
            try {
              var selectedFeaturedMarkerId = mapInstance.addMarker(selectedFeaturedMarker);
              if (selectedFeaturedMarkerId) {
                storeLabelState.markerIds.push(selectedFeaturedMarkerId);
                added++;
              }
            } catch (e) {
              log("warn", "add featured selected store label marker failed", {
                title: storeLabelTitle(selectedPlace),
                floorId: selectedFeaturedMarker.floorId,
                error: String(e.message || e),
              });
            }
          }
          if (selectedKey) {
            seen[selectedKey] = true;
          }
        }

        (subPlaces || []).forEach(function (place) {
          if (!canAddMore()) return;
          var title = storeLabelTitle(place);
          if (!title || !place || !place.position || place.position.lat == null || place.position.lng == null) {
            return;
          }
          if (!isFeaturedStore(place, config)) {
            return;
          }

          var placeKey = String(place.mapvxId || place.clientId || title);
          if (seen[placeKey]) return;
          seen[placeKey] = true;

          var markers = buildStoreLabelMarkers(place, currentFloorId);
          markers.forEach(function (markerConfig) {
            try {
              var markerId = mapInstance.addMarker(markerConfig);
              if (markerId) {
                storeLabelState.markerIds.push(markerId);
                added++;
              }
            } catch (e) {
              log("warn", "add featured store label marker failed", {
                title: title,
                floorId: markerConfig.floorId,
                error: String(e.message || e),
              });
            }
          });
        });
      } else {
        (subPlaces || []).forEach(function (place) {
          if (!canAddMore()) return;
          var title = storeLabelTitle(place);
          if (!title || !place || !place.position || place.position.lat == null || place.position.lng == null) {
            return;
          }
          if (isAuxiliaryLabel(place)) {
            return;
          }

          var placeKey = String(place.mapvxId || place.clientId || title);
          if (seen[placeKey]) return;
          seen[placeKey] = true;

          var markers = buildStoreLabelMarkers(place, currentFloorId);
          markers.forEach(function (markerConfig) {
            try {
              var markerId = mapInstance.addMarker(markerConfig);
              if (markerId) {
                storeLabelState.markerIds.push(markerId);
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
        });
      }

      storeLabelState.parentPlaceId = currentParentPlaceId;
      log("info", "refreshStoreLabels done", {
        parentPlace: currentParentPlaceId,
        markers: added,
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

    await ensureReady(config);

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
    await refreshStoreLabels(mapInstance, config, parentPlace);
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
        map = sdk.createMap(containerEl, {
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
    await refreshStoreLabels(map, config, parentPlace, place);

    if (typeof map.clearColoredPlaces === "function") map.clearColoredPlaces();
    if (typeof map.setPlacesAsSelected === "function") {
      map.setPlacesAsSelected([mapvxId], "#5B2D8E");
      log("info", "setPlacesAsSelected", { mapvxId: mapvxId });
    }
    showPlacePopOver(map, place, floorId);

    await waitForMapContainerLayout(containerEl);
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
      selectedPlace: place,
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

    if (lastMapSession && lastMapSession.result && lastMapSession.result.mapvxId) {
      if (typeof map.clearColoredPlaces === "function") map.clearColoredPlaces();
      if (typeof map.setPlacesAsSelected === "function") {
        map.setPlacesAsSelected([lastMapSession.result.mapvxId], "#5B2D8E");
      }
    }

    if (lastMapSession) {
      lastMapSession.floorId = floorKey;
    }

    if (lastMapSession && lastMapSession.result && lastMapSession.result.selectedPlace) {
      await refreshStoreLabels(map, config, null, lastMapSession.result.selectedPlace);
      showPlacePopOver(map, lastMapSession.result.selectedPlace, floorKey);
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
    getMapFloors: getMapFloors,
    switchFloor: switchFloor,
    drawRouteToTarget: drawRouteToTarget,
    clearActiveRoute: clearActiveRoute,
    toggleRouteToTarget: toggleRouteToTarget,
    showPlacePopOver: showPlacePopOver,
    clearPlacePopOver: clearPlacePopOver,
    destroyMap: destroyMap,
    reset: reset,
  };
})();
