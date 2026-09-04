/**
 * MapVX Web Components runtime (shared by store-map, mobility, store-map-web).
 *
 * Wraps <map-view-with-modal> + lazy <route-view-totems> with the camera/POI
 * workarounds validated in store-map-web. Callers that need a legacy fallback
 * should catch showPlace/showRoute rejections and call MapVxBridge instead.
 */
(function (global) {
  "use strict";

  var CONFIG_STORAGE_KEY = "cencomall_mapvx_test_config";
  var DEFAULT_PARENT_PLACE = "-N19VjzEVIj2RDKu7i4r";
  var PLACE_TIMEOUT_MS = 6000;
  // <route-view-totems> boots a SECOND maplibre instance (its own map + style +
  // place resolution) on top of the place map that is already live. On totem
  // hardware (Rockchip RK3566 / Mali-G52 / 4GB) that cold boot regularly runs
  // past 15s — store-map-web hit exactly this and only became reliable at 60s.
  // A short timeout here doesn't "fail fast", it silently demotes every route
  // to the legacy renderer, which is what happened on the totems after the
  // mapEngine="auto" rollout. Keep this generous; callers show a loading state.
  var ROUTE_TIMEOUT_MS = 60000;
  // How long after the route map is up we wait for the route to actually start
  // drawing before declaring it stalled and telling the caller to fall back.
  // Generous enough for a slow totem to resolve both places and compute a
  // multi-floor path, short enough that nobody stands there watching a loader.
  var ROUTE_STALL_MS = 25000;
  var ZOOM_MIN = 17.3;
  var ZOOM_MAX = 19;
  var DESIRED_PITCH = 0;
  var HIDDEN_ICON_SOURCE_LAYERS = ["poi", "transportation"];
  var FLAT_LAYER_IDS = [
    "indoor-polygon-room-color-light",
    "indoor-polygon-room-back",
    "indoor-polygon-room",
    "indoor-polygon-room-front",
    "indoor-polygon-area-indoor",
    "indoor-hover",
  ];
  var WC_THEME_STYLE =
    "--mvx-primary-color:#5B2D8E;" +
    "--mvx-surface-color:#ffffff;" +
    "--mvx-on-surface-color:#3D1D5C;" +
    "--mvx-border-color:#5B2D8E;" +
    "--mvx-border-width:0px;" +
    "--mvx-radius:12px;" +
    "--mvx-shadow:0 6px 16px rgba(0,0,0,0.18);";

  var state = {
    initialized: false,
    placeMount: null,
    routeMount: null,
    placeEl: null,
    placeView: null,
    routeView: null,
    mapReadyFired: false,
    mallBounds: null,
    placeTimeoutId: null,
    routeTimeoutId: null,
    routeStallId: null,
    routeBundlePromise: null,
    warmupPromise: null,
    diag: [],
    lastPlaceId: "",
    routeActive: false,
    visible: false,
    callbacks: {
      onReady: null,
      onError: null,
      onTitle: null,
      onRouteReady: null,
      onRouteClosed: null,
      // Fires once the route's walking animation reaches the destination
      // (route-view-totems "routeAnimationFinish"). Used by the services flow
      // to show the generic arrival popup. No-op for callers that don't set it.
      onArrival: null,
      onRouteStalled: null,
      log: null,
    },
    // When set ({ name, category, iconHtml }), the vendor's place/destination
    // popup is rewritten to this generic label — so a bathroom placeId that
    // resolves to one derivation ("Baño Niños - Mudadores") still reads
    // "Baños". null = leave the vendor popup untouched.
    genericLabel: null,
    labelObservers: [],
    labelRetryId: null,
  };

  function log(line) {
    if (typeof state.callbacks.log === "function") {
      try { state.callbacks.log(line); } catch (e) { /* noop */ }
    }
    try {
      if (global.SimaBridge && typeof global.SimaBridge.log === "function") {
        global.SimaBridge.log("[mapvx-wc] " + line);
      }
    } catch (e2) { /* noop */ }
  }

  // Small ring buffer of route outcomes. The totems have no reachable console,
  // so when a route silently demotes to legacy this is the only record of why
  // and how long it took. Readable as MapVxWcRuntime.getDiag() / window.__mvxDiag.
  function diag(kind, data) {
    try {
      var entry = { at: new Date().toISOString(), kind: kind };
      if (data) {
        for (var k in data) {
          if (Object.prototype.hasOwnProperty.call(data, k)) entry[k] = data[k];
        }
      }
      state.diag.push(entry);
      if (state.diag.length > 20) state.diag.shift();
      global.__mvxDiag = state.diag;
      log("diag " + JSON.stringify(entry));
    } catch (e) { /* noop */ }
  }

  function text(value) {
    return value == null ? "" : String(value).trim();
  }

  function loadStoredConfig() {
    try {
      var raw = global.sessionStorage && global.sessionStorage.getItem(CONFIG_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function readConfig() {
    var stored = loadStoredConfig() || {};
    var injected = global.MAPVX_CONFIG || {};
    return Object.assign(
      {
        apiKey: "",
        parentPlace: DEFAULT_PARENT_PLACE,
        totemPlaceId: "",
        lang: "es",
      },
      stored,
      injected
    );
  }

  function normalizeMapEngine(raw) {
    raw = text(raw).toLowerCase();
    return (raw === "legacy" || raw === "wc" || raw === "auto") ? raw : "";
  }

  function readMapEngine(search) {
    // 1. URL param (local testing / a per-open query the host appends).
    var fromUrl = "";
    try {
      var params = new URLSearchParams(search || global.location.search || "");
      fromUrl = normalizeMapEngine(params.get("mapEngine") || params.get("map_engine"));
    } catch (e) { /* noop */ }
    if (fromUrl) return fromUrl;
    // 2. Injected config — the native host can set window.MAPVX_CONFIG.mapEngine
    //    from a remote flag, no URL manipulation needed.
    try {
      var fromCfg = normalizeMapEngine(global.MAPVX_CONFIG && global.MAPVX_CONFIG.mapEngine);
      if (fromCfg) return fromCfg;
    } catch (e2) { /* noop */ }
    // Default: "auto" — try the Web Component, fall back to legacy on any
    // failure (bad tiles, unresolved id, missing origin, bundle down). The
    // bathroom / SAC / cowork WC path is validated; elevators + unverified ids
    // carry a placeIdNote and stay on legacy regardless. Pin a totem back to
    // the old renderer with ?mapEngine=legacy or MAPVX_CONFIG.mapEngine="legacy"
    // — no OTA needed.
    return "auto";
  }

  function isAvailable() {
    if (global.__mvxBundleFailed) return false;
    if (typeof customElements === "undefined") return false;
    return !!customElements.get("map-view-with-modal");
  }

  function hasRouteOrigin() {
    return !!text(readConfig().totemPlaceId);
  }

  function getLiveMap(hostEl) {
    var customMap = hostEl && hostEl.shadowRoot && hostEl.shadowRoot.querySelector("custom-map");
    return customMap && customMap.lzMap && customMap.lzMap.map;
  }

  function hideGenericPoiIcons(hostEl) {
    try {
      var libreMap = getLiveMap(hostEl);
      if (!libreMap || typeof libreMap.setLayoutProperty !== "function") return;
      var layers = (libreMap.getStyle().layers || []).filter(function (layer) {
        return (
          layer.type === "symbol" &&
          layer.source === "indoorequal" &&
          HIDDEN_ICON_SOURCE_LAYERS.indexOf(layer["source-layer"]) !== -1 &&
          layer.id !== "indoor-poi-tree"
        );
      });
      layers.forEach(function (layer) {
        libreMap.setLayoutProperty(layer.id, "visibility", "none");
      });
      if (layers.length) {
        log("hideGenericPoiIcons: hid " + layers.map(function (l) { return l.id; }).join(", "));
      }
    } catch (e) {
      log("hideGenericPoiIcons failed: " + (e && e.message ? e.message : e));
    }
  }

  function flattenBuildings(libreMap) {
    if (!libreMap || libreMap.__mvxFlattened) return;
    var style = libreMap.getStyle();
    var layerIds = {};
    ((style && style.layers) || []).forEach(function (layer) {
      layerIds[layer.id] = true;
    });
    var flattened = 0;
    FLAT_LAYER_IDS.forEach(function (id) {
      if (!layerIds[id]) return;
      try {
        libreMap.setPaintProperty(id, "fill-extrusion-height", 0);
        flattened += 1;
      } catch (e) { /* skip */ }
    });
    if (flattened) {
      libreMap.__mvxFlattened = true;
      log("flattenBuildings: flattened " + flattened + " layers");
    }
  }

  function applyCameraConstraints(hostEl) {
    try {
      var libreMap = getLiveMap(hostEl);
      if (!libreMap || typeof libreMap.setMaxZoom !== "function") return;

      if (!state.mallBounds) {
        var bounds = libreMap.getBounds();
        var pad = 0.0006;
        var sw = bounds.getSouthWest();
        var ne = bounds.getNorthEast();
        state.mallBounds = [
          [sw.lng - pad, sw.lat - pad],
          [ne.lng + pad, ne.lat + pad],
        ];
        libreMap.setMaxBounds(state.mallBounds);
        log("applyCameraConstraints: mallBounds captured");
      }

      flattenBuildings(libreMap);

      ["dragRotate", "keyboard"].forEach(function (handler) {
        try {
          if (libreMap[handler] && libreMap[handler].disable) libreMap[handler].disable();
        } catch (e) { /* noop */ }
      });
      try {
        if (libreMap.touchZoomRotate && libreMap.touchZoomRotate.disableRotation) {
          libreMap.touchZoomRotate.disableRotation();
        }
      } catch (e2) { /* noop */ }
      ["dragPan", "scrollZoom", "boxZoom", "doubleClickZoom"].forEach(function (handler) {
        try {
          if (libreMap[handler] && libreMap[handler].enable) libreMap[handler].enable();
        } catch (e3) { /* noop */ }
      });

      libreMap.setMinZoom(ZOOM_MIN);
      libreMap.setMaxZoom(ZOOM_MAX);
      if (libreMap.getZoom() < ZOOM_MIN || libreMap.getZoom() > ZOOM_MAX) {
        libreMap.setZoom(Math.min(Math.max(libreMap.getZoom(), ZOOM_MIN), ZOOM_MAX));
      }
      libreMap.setPitch(DESIRED_PITCH);
      libreMap.setBearing(0);

      if (!libreMap.__mvxCameraGuard) {
        libreMap.__mvxCameraGuard = true;
        var correctingPitch = false;
        libreMap.on("pitch", function () {
          if (correctingPitch || Math.abs(libreMap.getPitch() - DESIRED_PITCH) < 0.5) return;
          correctingPitch = true;
          requestAnimationFrame(function () {
            libreMap.setPitch(DESIRED_PITCH);
            correctingPitch = false;
          });
        });
        var correctingBearing = false;
        libreMap.on("rotate", function () {
          if (correctingBearing || Math.abs(libreMap.getBearing()) < 0.5) return;
          correctingBearing = true;
          requestAnimationFrame(function () {
            libreMap.setBearing(0);
            correctingBearing = false;
          });
        });
      }
    } catch (e) {
      log("applyCameraConstraints failed: " + (e && e.message ? e.message : e));
    }
  }

  function findDeepShadow(root, selector, depth) {
    if (!root || depth > 8) return null;
    var scope = root.shadowRoot || root;
    var hit = scope.querySelector && scope.querySelector(selector);
    if (hit) return hit;
    var children = scope.children || [];
    for (var i = 0; i < children.length; i++) {
      var found = findDeepShadow(children[i], selector, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function clearGenericLabel() {
    if (state.labelRetryId) { clearInterval(state.labelRetryId); state.labelRetryId = null; }
    state.labelObservers.forEach(function (o) { try { o.disconnect(); } catch (e) {} });
    state.labelObservers = [];
  }

  // UNSUPPORTED WORKAROUND — @mapvx/web-components renders the place /
  // destination popup (.popup-name / .popup-category / .popup-logo) from the
  // resolved POI, deep in <custom-map>'s shadow DOM, with no prop to override
  // it. Services point their placeId at one derivation of a shared structure
  // (a bathroom's changing-table POI, say), so the vendor popup would read
  // "Baño Niños - Mudadores". Rewrite it in place to a generic label. A
  // MutationObserver on the popup's own root keeps it applied across the
  // re-renders the vendor does on floor change / marker update.
  function applyGenericLabel(hostEl) {
    // Always start clean — a previous call's observer/retry closes over the
    // OLD label and would fight this one (seen with showPlace "quiet update":
    // no mapReady, so only setGenericLabel re-applies, and the stale observer
    // kept re-asserting the previous service's name).
    clearGenericLabel();
    var label = state.genericLabel;
    if (!label || !hostEl) return;

    function rewrite() {
      var nameEl = findDeepShadow(hostEl, ".popup-name", 0);
      if (!nameEl) return false;
      if (label.name && text(nameEl.textContent) !== label.name && text(nameEl.textContent) !== "Cargando...") {
        nameEl.textContent = label.name;
      }
      var catEl = findDeepShadow(hostEl, ".popup-category", 0);
      if (catEl) {
        if (label.category) { catEl.textContent = label.category; catEl.style.display = ""; }
        else { catEl.style.display = "none"; }
      }
      if (label.iconHtml) {
        var logoEl = findDeepShadow(hostEl, ".popup-logo", 0);
        // Replace the vendor logo, OR our own replacement if the label changed.
        if (logoEl && logoEl.dataset.mvxGeneric !== label.name) {
          var repl = document.createElement("div");
          repl.className = logoEl.className;
          repl.dataset.mvxGeneric = label.name;
          repl.innerHTML = label.iconHtml;
          try { logoEl.replaceWith(repl); } catch (e) { /* older DOM */ }
        }
      }
      // Observe the popup's own shadow root so vendor re-renders get re-fixed.
      var root = nameEl.getRootNode && nameEl.getRootNode();
      if (root && !state.labelObservers.length) {
        try {
          var obs = new MutationObserver(function () { rewrite(); });
          obs.observe(root, { childList: true, subtree: true, characterData: true });
          state.labelObservers.push(obs);
        } catch (e2) { /* noop */ }
      }
      return true;
    }

    // The popup lands a beat after mapReady / routeAnimationStart — retry until
    // it exists, then stop (the observer takes over).
    rewrite();
    var tries = 0;
    state.labelRetryId = setInterval(function () {
      tries += 1;
      if (rewrite() || tries >= 20) {
        clearInterval(state.labelRetryId);
        state.labelRetryId = null;
      }
    }, 300);
  }

  function resolveTitle(hostEl, fallbackId, attempt) {
    attempt = attempt || 0;
    var nameEl = findDeepShadow(hostEl, ".popup-name", 0);
    var name = nameEl && text(nameEl.textContent);
    if (name && name !== "Cargando...") {
      if (typeof state.callbacks.onTitle === "function") {
        try { state.callbacks.onTitle(name); } catch (e) { /* noop */ }
      }
      return;
    }
    if (attempt < 8) {
      setTimeout(function () {
        resolveTitle(hostEl, fallbackId, attempt + 1);
      }, 300);
      return;
    }
    if (fallbackId && typeof state.callbacks.onTitle === "function") {
      try { state.callbacks.onTitle(fallbackId); } catch (e2) { /* noop */ }
    }
  }

  function ensurePlaceElement() {
    if (state.placeEl && state.placeEl.isConnected) return state.placeEl;
    if (!state.placeMount) throw new Error("MapVxWcRuntime not initialized (missing placeMount)");

    var existing = state.placeMount.querySelector("map-view-with-modal");
    if (existing) {
      state.placeEl = existing;
      return existing;
    }

    var el = document.createElement("map-view-with-modal");
    el.id = "mvx-place";
    el.setAttribute("compact-mode", "");
    el.setAttribute("zoom-size", "small");
    el.setAttribute("style", WC_THEME_STYLE);
    el.showFloorSelector = false;
    state.placeMount.appendChild(el);
    state.placeEl = el;
    wirePlaceElement(el);
    return el;
  }

  function wirePlaceElement(mapEl) {
    if (mapEl.__mvxWired) return;
    mapEl.__mvxWired = true;

    mapEl.addEventListener("mapReady", function () {
      state.mapReadyFired = true;
      if (state.placeTimeoutId) {
        clearTimeout(state.placeTimeoutId);
        state.placeTimeoutId = null;
      }
      hideGenericPoiIcons(mapEl);
      resolveTitle(mapEl, state.lastPlaceId);
      applyGenericLabel(mapEl);
      if (typeof state.callbacks.onReady === "function") {
        try {
          state.callbacks.onReady({
            placeId: state.lastPlaceId,
            route: false,
            engine: "wc",
          });
        } catch (e) { /* noop */ }
      }
      log("map-view-with-modal: mapReady");
    });

    mapEl.addEventListener("cameraInitialized", function () {
      applyCameraConstraints(mapEl);
      log("map-view-with-modal: cameraInitialized");
    });

    mapEl.addEventListener("floorChange", function () {
      hideGenericPoiIcons(mapEl);
      applyCameraConstraints(mapEl);
      applyGenericLabel(mapEl);
    });
  }

  function scriptBase() {
    var scripts = document.getElementsByTagName("script");
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].src || "";
      if (/mapvx-wc-runtime\.js/i.test(src)) {
        try {
          return new URL(src.replace(/mapvx-wc-runtime\.js.*$/i, ""), document.baseURI).href;
        } catch (e) {
          return src.replace(/mapvx-wc-runtime\.js.*$/i, "");
        }
      }
    }
    try {
      return new URL("../shared/", document.baseURI).href;
    } catch (e2) {
      return "../shared/";
    }
  }

  function ensureRouteBundle() {
    if (typeof customElements !== "undefined" && customElements.get("route-view-totems")) {
      return Promise.resolve(true);
    }
    if (state.routeBundlePromise) return state.routeBundlePromise;

    state.routeBundlePromise = new Promise(function (resolve, reject) {
      // A page-level preload tag (data-mvx-route-bundle="1") is the common case
      // in mobility / store-map. If it is still in flight, wait on it. If it
      // already finished WITHOUT defining the element (a throw mid-bundle can
      // abort it), fall through and inject a fresh copy — returning here left
      // the promise unsettled forever, hanging every caller.
      // A page-level preload tag (data-mvx-route-bundle="1") is the common case
      // in mobility / store-map. While the document is still loading, that tag
      // may be in flight — wait on it. Once the document is complete the tag has
      // finished for good, so if the element still isn't defined (a throw
      // mid-bundle can abort it) fall through and inject a fresh copy. The old
      // code returned in that state, leaving the promise unsettled forever and
      // hanging every caller of showRoute().
      var existing = document.querySelector('script[data-mvx-route-bundle="1"]');
      if (existing && document.readyState !== "complete") {
        existing.addEventListener("load", function () {
          if (customElements.get("route-view-totems")) resolve(true);
          else reject(new Error("route-view-totems not defined after load"));
        });
        existing.addEventListener("error", function () {
          reject(new Error("failed to load route-view-totems.js"));
        });
        // Already finished loading before we attached listeners.
        if (customElements.get("route-view-totems")) resolve(true);
        return;
      }

      var script = document.createElement("script");
      script.src = scriptBase() + "mapvx-wc/route-view-totems.js";
      script.async = true;
      script.setAttribute("data-mvx-route-bundle", "1");
      script.onload = function () {
        if (typeof customElements !== "undefined" && customElements.get("route-view-totems")) {
          resolve(true);
          return;
        }
        reject(new Error("route-view-totems not defined after load"));
      };
      script.onerror = function () {
        reject(new Error("failed to load route-view-totems.js"));
      };
      (document.head || document.documentElement).appendChild(script);
    }).catch(function (error) {
      state.routeBundlePromise = null;
      throw error;
    });

    return state.routeBundlePromise;
  }

  function setActiveView(mode) {
    if (state.placeView) {
      state.placeView.classList.toggle("hidden", mode === "route");
    }
    if (state.routeView) {
      state.routeView.classList.toggle("hidden", mode !== "route");
    }
    if (state.placeMount && !state.placeView) {
      state.placeMount.classList.toggle("hidden", mode === "route");
    }
    if (state.routeMount && !state.routeView) {
      state.routeMount.classList.toggle("hidden", mode !== "route");
    }
  }

  function showWcShell(mode) {
    state.visible = true;
    var stage = document.getElementById("mapvx-wc-stage");
    if (stage) {
      stage.classList.remove("hidden");
      stage.classList.remove("preload-mount");
    }
    if (mode === "route") {
      setActiveView("route");
      return;
    }
    setActiveView("place");
    if (state.placeMount) {
      state.placeMount.classList.remove("hidden");
    }
  }

  function hideWcShell() {
    state.visible = false;
    if (state.placeView) state.placeView.classList.add("hidden");
    if (state.routeView) state.routeView.classList.add("hidden");
    var stage = document.getElementById("mapvx-wc-stage");
    if (stage) stage.classList.add("hidden");
  }

  /** Keep the WebGL map alive off-screen (same idea as mobility preload-mount). */
  function parkWcShell() {
    state.visible = false;
    closeRoute();
    var stage = document.getElementById("mapvx-wc-stage");
    if (stage) {
      stage.classList.add("preload-mount");
      stage.classList.remove("hidden");
    }
    if (state.placeView) state.placeView.classList.remove("hidden");
    if (state.routeView) state.routeView.classList.add("hidden");
  }

  function resizeLiveMap() {
    try {
      var host = state.placeEl;
      if (!host) return;
      var libreMap = getLiveMap(host);
      if (libreMap && typeof libreMap.resize === "function") {
        libreMap.resize();
      }
      // Some MapVX builds expose resize on the custom-map host.
      var customMap = host.shadowRoot && host.shadowRoot.querySelector("custom-map");
      if (customMap && typeof customMap.resize === "function") customMap.resize();
    } catch (e) { /* noop */ }
  }

  function notifyShown() {
    showWcShell("place");
    // Double rAF: wait until layout is visible before resizing WebGL.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        resizeLiveMap();
        applyCameraConstraints(state.placeEl);
        hideGenericPoiIcons(state.placeEl);
      });
    });
  }

  function hasLiveMap() {
    return !!(state.mapReadyFired && state.placeEl && state.placeEl.isConnected);
  }

  function applyCredentials(mapEl, cfg) {
    mapEl.setAttribute("apiKey", cfg.apiKey || "");
    mapEl.setAttribute("parentPlaceId", cfg.parentPlace || cfg.parentPlaceId || "");
    mapEl.setAttribute("locale", cfg.lang || "es");
    mapEl.showFloorSelector = false;
  }

  /**
   * Warm the WC map once (credentials + optional seed place) so later
   * showPlace() hits the quiet-update path instead of a cold mapReady.
   */
  function warmup(options) {
    options = options || {};
    if (state.warmupPromise) return state.warmupPromise;
    if (!state.initialized) {
      return Promise.reject(new Error("MapVxWcRuntime not initialized"));
    }
    if (!isAvailable()) {
      return Promise.reject(new Error("mapvx-wc bundle missing"));
    }

    var cfg = readConfig();
    if (!text(cfg.apiKey)) {
      return Promise.reject(new Error("missing MapVX apiKey"));
    }

    if (hasLiveMap()) {
      state.warmupPromise = Promise.resolve({ warm: true, reused: true });
      return state.warmupPromise;
    }

    state.warmupPromise = new Promise(function (resolve) {
      var mapEl;
      try {
        mapEl = ensurePlaceElement();
      } catch (error) {
        state.warmupPromise = null;
        resolve({ warm: false, error: String(error && (error.message || error)) });
        return;
      }

      // Keep the map in a parked (invisible but laid-out) shell so WebGL stays alive.
      parkWcShell();
      applyCredentials(mapEl, cfg);

      var seed = text(options.placeId || cfg.totemPlaceId || state.lastPlaceId || "");
      if (seed) {
        mapEl.setAttribute("placeId", seed);
        state.lastPlaceId = seed;
      }

      if (state.mapReadyFired) {
        resizeLiveMap();
        resolve({ warm: true, reused: true, placeId: seed || null });
        return;
      }

      var settled = false;
      var timeoutMs = options.timeoutMs != null ? Number(options.timeoutMs) : 12000;
      function done(payload) {
        if (settled) return;
        settled = true;
        resolve(payload);
      }

      var onReady = function () {
        mapEl.removeEventListener("mapReady", onReady);
        hideGenericPoiIcons(mapEl);
        applyCameraConstraints(mapEl);
        resizeLiveMap();
        log("warmup mapReady");
        done({ warm: true, placeId: seed || null });
      };
      mapEl.addEventListener("mapReady", onReady);
      setTimeout(function () {
        mapEl.removeEventListener("mapReady", onReady);
        // Soft-fail: keep the element; next showPlace may still win.
        log("warmup timeout — keeping parked instance");
        done({ warm: state.mapReadyFired, timedOut: true, placeId: seed || null });
      }, timeoutMs);
    }).catch(function (error) {
      state.warmupPromise = null;
      throw error;
    });

    return state.warmupPromise;
  }

  function clearPlaceTimeout() {
    if (state.placeTimeoutId) {
      clearTimeout(state.placeTimeoutId);
      state.placeTimeoutId = null;
    }
  }

  function clearRouteTimeout() {
    if (state.routeTimeoutId) {
      clearTimeout(state.routeTimeoutId);
      state.routeTimeoutId = null;
    }
  }

  // Deliberately separate from clearRouteTimeout(): succeed() clears the route
  // timeout as soon as the map is up, but the stall watchdog has to keep
  // running past that point — it exists precisely to catch a route that never
  // draws after a successful mapReady.
  function clearStallWatchdog() {
    if (state.routeStallId) {
      clearTimeout(state.routeStallId);
      state.routeStallId = null;
    }
  }

  function init(options) {
    options = options || {};
    state.placeMount = typeof options.placeMount === "string"
      ? document.querySelector(options.placeMount)
      : options.placeMount;
    state.routeMount = typeof options.routeMount === "string"
      ? document.querySelector(options.routeMount)
      : options.routeMount;
    state.placeView = typeof options.placeView === "string"
      ? document.querySelector(options.placeView)
      : (options.placeView || null);
    state.routeView = typeof options.routeView === "string"
      ? document.querySelector(options.routeView)
      : (options.routeView || null);

    state.callbacks.onReady = options.onReady || null;
    state.callbacks.onError = options.onError || null;
    state.callbacks.onTitle = options.onTitle || null;
    state.callbacks.onRouteReady = options.onRouteReady || null;
    state.callbacks.onRouteClosed = options.onRouteClosed || null;
    state.callbacks.onArrival = options.onArrival || null;
    state.callbacks.onRouteStalled = options.onRouteStalled || null;
    state.callbacks.log = options.log || null;

    if (!state.placeMount) {
      throw new Error("MapVxWcRuntime.init requires placeMount");
    }

    state.initialized = true;
    if (isAvailable()) {
      ensurePlaceElement();
    }
    return true;
  }

  function showPlace(placeId, options) {
    options = options || {};
    var timeoutMs = options.timeoutMs != null ? Number(options.timeoutMs) : PLACE_TIMEOUT_MS;
    var cfg = readConfig();
    var id = text(placeId);

    return new Promise(function (resolve, reject) {
      if (!state.initialized) {
        reject(new Error("MapVxWcRuntime not initialized"));
        return;
      }
      if (!id) {
        reject(new Error("missing placeId"));
        return;
      }
      if (!isAvailable()) {
        reject(new Error("mapvx-wc bundle missing"));
        return;
      }
      if (!text(cfg.apiKey)) {
        reject(new Error("missing MapVX apiKey"));
        return;
      }

      showWcShell("place");
      setActiveView("place");
      state.lastPlaceId = id;
      state.routeActive = false;

      var mapEl;
      try {
        mapEl = ensurePlaceElement();
      } catch (error) {
        reject(error);
        return;
      }

      clearPlaceTimeout();

      var settled = false;
      function succeed(payload) {
        if (settled) return;
        settled = true;
        clearPlaceTimeout();
        resolve(payload || { placeId: id, engine: "wc", route: false });
      }
      function fail(reason) {
        if (settled) return;
        settled = true;
        clearPlaceTimeout();
        var err = reason instanceof Error ? reason : new Error(String(reason || "wc showPlace failed"));
        if (typeof state.callbacks.onError === "function") {
          try { state.callbacks.onError(err); } catch (e) { /* noop */ }
        }
        reject(err);
      }

      // mapReady only fires once per component lifecycle — only wait on first load.
      if (state.mapReadyFired) {
        applyCredentials(mapEl, cfg);
        mapEl.setAttribute("placeId", id);
        notifyShown();
        resolveTitle(mapEl, id);
        log("showPlace quiet update " + id);
        succeed({ placeId: id, engine: "wc", route: false, quiet: true, cached: true });
        return;
      }

      var onReadyOnce = function (payload) {
        mapEl.removeEventListener("mapReady", onReadyListener);
        succeed(payload || { placeId: id, engine: "wc", route: false });
      };
      var onReadyListener = function () {
        onReadyOnce({ placeId: id, engine: "wc", route: false });
      };
      mapEl.addEventListener("mapReady", onReadyListener);

      state.placeTimeoutId = setTimeout(function () {
        mapEl.removeEventListener("mapReady", onReadyListener);
        fail(new Error("wc mapReady timeout"));
      }, timeoutMs);

      applyCredentials(mapEl, cfg);
      mapEl.setAttribute("placeId", id);
      log("showPlace " + JSON.stringify({ placeId: id, parentPlace: cfg.parentPlace || cfg.parentPlaceId }));
    });
  }

  function closeRoute() {
    clearRouteTimeout();
    clearStallWatchdog();
    // Drop the route popup's observer, but keep state.genericLabel and re-apply
    // it to the place popup we're flipping back to (still the same service).
    clearGenericLabel();
    state.routeActive = false;
    if (state.routeMount) state.routeMount.innerHTML = "";
    setActiveView("place");
    if (state.genericLabel && state.placeEl) applyGenericLabel(state.placeEl);
    if (typeof state.callbacks.onRouteClosed === "function") {
      try { state.callbacks.onRouteClosed(); } catch (e) { /* noop */ }
    }
  }

  function applyRouteCredentials(routeEl, cfg, origin, dest) {
    // Match store-map-web attribute order exactly (destination before origin).
    // Also assign Lit properties so custom destinationId accessor runs.
    routeEl.setAttribute("apiKey", cfg.apiKey || "");
    routeEl.setAttribute("parentPlaceId", cfg.parentPlace || cfg.parentPlaceId || "");
    routeEl.setAttribute("locale", cfg.lang || "es");
    routeEl.setAttribute("destinationId", dest);
    routeEl.setAttribute("originId", origin);
    try {
      routeEl.apiKey = cfg.apiKey || "";
      routeEl.parentPlaceId = cfg.parentPlace || cfg.parentPlaceId || "";
      routeEl.locale = cfg.lang || "es";
      routeEl.originId = origin;
      routeEl.destinationId = dest;
    } catch (e) { /* older hosts */ }
  }

  // REMOVED: forceRouteDraw() / sdkController.setOriginAndDestination().
  // Reaching into the controller to re-set origin+destination on a live
  // route-view-totems instance wedges it permanently — the component keeps
  // showing its loader with no error event and no route, forever. store-map-web
  // documented this and never calls it; the only supported nudge is dispatching
  // the component's own "generateRoute" event, which its handler turns into
  // loadRoute(originId, destinationId) using the context it already resolved.
  // Do not reintroduce this.

  function showRoute(destinationId, options) {
    options = options || {};
    var timeoutMs = options.timeoutMs != null ? Number(options.timeoutMs) : ROUTE_TIMEOUT_MS;
    var cfg = readConfig();
    var dest = text(destinationId || state.lastPlaceId);
    var origin = text(options.originId || cfg.totemPlaceId);
    var startedAt = Date.now();

    return ensureRouteBundle().then(function () {
      return new Promise(function (resolve, reject) {
        if (!state.routeMount) {
          reject(new Error("MapVxWcRuntime missing routeMount"));
          return;
        }
        if (!dest) {
          reject(new Error("missing destinationId"));
          return;
        }
        if (!origin) {
          reject(new Error("missing totemPlaceId/originId"));
          return;
        }
        if (!text(cfg.apiKey)) {
          reject(new Error("missing MapVX apiKey"));
          return;
        }
        if (typeof customElements === "undefined" || !customElements.get("route-view-totems")) {
          reject(new Error("route-view-totems not available"));
          return;
        }

        // Tear down any previous route instance WITHOUT flipping back to place
        // (closeRoute would fight the view switch below).
        clearRouteTimeout();
        clearStallWatchdog();
        state.routeActive = false;
        state.routeMount.innerHTML = "";
        state.lastPlaceId = dest;

        showWcShell("route");
        setActiveView("route");

        var routeEl = document.createElement("route-view-totems");
        routeEl.id = "mvx-route";
        routeEl.setAttribute(
          "style",
          "--mvx-primary-color:#5B2D8E; --mvx-surface-color:#ffffff; --mvx-on-surface-color:#3D1D5C;"
        );

        var settled = false;
        var ignoringBack = true;
        function succeed(payload) {
          if (settled) return;
          if (!routeEl.isConnected) {
            fail(new Error("route element disconnected before ready"));
            return;
          }
          settled = true;
          ignoringBack = false;
          stopGenerate();
          clearRouteTimeout();
          // Re-assert route shell — callers must not see place underneath.
          showWcShell("route");
          setActiveView("route");
          state.routeActive = true;
          diag("route-ok", {
            dest: dest,
            origin: origin,
            ms: Date.now() - startedAt,
            animated: !!(payload && payload.animated),
          });
          if (typeof state.callbacks.onRouteReady === "function") {
            try { state.callbacks.onRouteReady(payload); } catch (e) { /* noop */ }
          }
          resolve(payload);
        }
        function fail(reason) {
          if (settled) return;
          settled = true;
          ignoringBack = false;
          stopGenerate();
          clearRouteTimeout();
          clearStallWatchdog();
          state.routeActive = false;
          setActiveView("place");
          var err = reason instanceof Error ? reason : new Error(String(reason || "wc showRoute failed"));
          diag("route-fail", {
            dest: dest,
            origin: origin,
            ms: Date.now() - startedAt,
            budgetMs: timeoutMs,
            reason: err.message,
          });
          if (typeof state.callbacks.onError === "function") {
            try { state.callbacks.onError(err); } catch (e) { /* noop */ }
          }
          reject(err);
        }

        // route-view-totems only computes a route in response to its own
        // "generateRoute" CustomEvent (the totem UI's "Generar ruta" button
        // dispatches it on tap). We drive it headlessly, so dispatch it
        // ourselves — and retry, because origin/destination resolution is an
        // async place fetch that can still be pending right after mapReady.
        // Same approach store-map-web/index.html proved reliable for
        // multi-floor routes (verified live 2026-09-03).
        var genKicks = 0;
        var genTimer = null;
        function kickGenerate() {
          genKicks += 1;
          try {
            routeEl.dispatchEvent(new CustomEvent("generateRoute", {
              detail: { accessible: false },
              bubbles: true,
              composed: true,
            }));
          } catch (e) { /* noop */ }
          // Deliberately NOT calling forceRouteDraw/setOriginAndDestination
          // here. store-map-web established (and this runtime regressed) that
          // re-setting origin/destination on a LIVE route-view-totems instance
          // after its first resolution hangs the component forever with no
          // error event. Kicking it 6x every 500ms did exactly that: the first
          // kick resolved, the rest poisoned the instance — which is why totem
          // service routes sat loading for minutes while store-map-web (which
          // only ever dispatches the event) routes in ~20s.
          if (genKicks >= 6 && genTimer) { clearInterval(genTimer); genTimer = null; }
        }
        function stopGenerate() {
          if (genTimer) { clearInterval(genTimer); genTimer = null; }
        }

        // Stall watchdog. showRoute() resolves shortly after mapReady (the map
        // is up and the route is computing), so the promise's own timeout can
        // no longer protect anyone. If the component then never starts drawing
        // — an id it can't route, a wedged instance — nothing used to notice
        // and the visitor just watched a loader indefinitely. Report it so the
        // caller can hand the route to the legacy renderer.
        var animStarted = false;
        function armStallWatchdog() {
          clearStallWatchdog();
          state.routeStallId = setTimeout(function () {
            state.routeStallId = null;
            if (animStarted || !routeEl.isConnected) return;
            stopGenerate();
            diag("route-stalled", {
              dest: dest,
              origin: origin,
              ms: Date.now() - startedAt,
              afterMs: ROUTE_STALL_MS,
            });
            log("route-view-totems: no route drawn after " + ROUTE_STALL_MS + "ms");
            if (typeof state.callbacks.onRouteStalled === "function") {
              try {
                state.callbacks.onRouteStalled({ placeId: dest, originId: origin, engine: "wc" });
              } catch (e) { /* noop */ }
            }
          }, ROUTE_STALL_MS);
        }

        routeEl.addEventListener("mapReady", function () {
          hideGenericPoiIcons(routeEl);
          var libreMap = getLiveMap(routeEl);
          if (libreMap) flattenBuildings(libreMap);
          applyGenericLabel(routeEl);
          log("route-view-totems: mapReady — requesting route");
          kickGenerate();
          genTimer = setInterval(kickGenerate, 500);
          armStallWatchdog();
          setTimeout(function () {
            succeed({
              placeId: dest,
              originId: origin,
              route: true,
              engine: "wc",
            });
          }, 600);
        });
        // The bundle actually dispatches "startRouteAnimation" and
        // "routeAnimationFinished" (verified by scanning the vendored IIFE for
        // its CustomEvent names). We were listening for "routeAnimationStart" /
        // "routeAnimationFinish", which never fire — so the generateRoute
        // retries were never stopped early and the arrival card never showed.
        // Both spellings are wired so a vendor rename in either direction works.
        function onAnimationStart() {
          animStarted = true;
          clearStallWatchdog();
          stopGenerate();
          applyGenericLabel(routeEl);
          log("route-view-totems: route animation start");
          diag("route-animating", { dest: dest, ms: Date.now() - startedAt });
          succeed({
            placeId: dest,
            originId: origin,
            route: true,
            engine: "wc",
            animated: true,
          });
        }
        function onAnimationFinish() {
          log("route-view-totems: route animation finish");
          if (typeof state.callbacks.onArrival === "function") {
            try {
              state.callbacks.onArrival({ placeId: dest, originId: origin, engine: "wc" });
            } catch (e) { /* noop */ }
          }
        }
        routeEl.addEventListener("startRouteAnimation", onAnimationStart);
        routeEl.addEventListener("routeAnimationStart", onAnimationStart);
        routeEl.addEventListener("routeAnimationFinished", onAnimationFinish);
        routeEl.addEventListener("routeAnimationFinish", onAnimationFinish);
        routeEl.addEventListener("back", function () {
          // Ignore spurious back during mount/init (seen on some MapVX builds).
          if (ignoringBack || !settled) {
            log("route-view-totems: ignoring early back");
            return;
          }
          closeRoute();
        });

        state.routeMount.appendChild(routeEl);
        // Sync credentials immediately after append — same as store-map-web.
        applyRouteCredentials(routeEl, cfg, origin, dest);
        log("showRoute " + JSON.stringify({ destinationId: dest, originId: origin }));

        clearRouteTimeout();
        state.routeTimeoutId = setTimeout(function () {
          // No forceRouteDraw retry here either — see kickGenerate(). If the
          // component hasn't reached mapReady by now it isn't coming, and
          // poking origin/destination would only wedge it further.
          if (!settled) fail(new Error("wc route timeout"));
        }, Math.max(4000, timeoutMs));
      });
    }).catch(function (bundleErr) {
      // ensureRouteBundle() rejected — fail() never ran, so record it here too.
      if (!state.diag.length || state.diag[state.diag.length - 1].kind !== "route-fail") {
        diag("route-fail", {
          dest: dest,
          origin: origin,
          ms: Date.now() - startedAt,
          budgetMs: timeoutMs,
          reason: String(bundleErr && (bundleErr.message || bundleErr)),
        });
      }
      throw bundleErr;
    });
  }

  /** Soft hide: keep the place map instance warm for the next open. */
  function hide() {
    clearPlaceTimeout();
    clearRouteTimeout();
    closeRoute();
    if (hasLiveMap()) parkWcShell();
    else hideWcShell();
    state.routeActive = false;
  }

  /** @deprecated use hide() — kept so callers that teardown on engine switch don't destroy the cache. */
  function teardown() {
    hide();
  }

  /** Hard reset — only when leaving the page or recovering from a corrupt instance. */
  function destroy() {
    clearPlaceTimeout();
    clearRouteTimeout();
    closeRoute();
    hideWcShell();
    if (state.placeEl && state.placeEl.parentNode) {
      try { state.placeEl.parentNode.removeChild(state.placeEl); } catch (e) { /* noop */ }
    }
    state.placeEl = null;
    state.mapReadyFired = false;
    state.mallBounds = null;
    state.warmupPromise = null;
    state.lastPlaceId = "";
    state.routeActive = false;
    state.visible = false;
    state.genericLabel = null;
    clearGenericLabel();
  }

  function isRouteActive() {
    return !!state.routeActive;
  }

  function getLastPlaceId() {
    return state.lastPlaceId;
  }

  // Rewrite the vendor place/destination popup to a generic label for the
  // current place + route. Pass null to restore the vendor's own popup.
  // { name, category?, iconHtml? }
  function setGenericLabel(label) {
    if (!label || !label.name) {
      state.genericLabel = null;
      clearGenericLabel();
      return;
    }
    state.genericLabel = {
      name: text(label.name),
      category: label.category ? text(label.category) : "",
      iconHtml: label.iconHtml || "",
    };
    if (state.routeActive && state.routeMount) {
      var routeEl = state.routeMount.querySelector("route-view-totems");
      if (routeEl) applyGenericLabel(routeEl);
    } else if (state.placeEl) {
      applyGenericLabel(state.placeEl);
    }
  }

  global.MapVxWcRuntime = {
    CONFIG_STORAGE_KEY: CONFIG_STORAGE_KEY,
    closeRoute: closeRoute,
    destroy: destroy,
    ensureRouteBundle: ensureRouteBundle,
    getLastPlaceId: getLastPlaceId,
    hasLiveMap: hasLiveMap,
    hasRouteOrigin: hasRouteOrigin,
    getDiag: function () { return state.diag.slice(); },
    hide: hide,
    init: init,
    isAvailable: isAvailable,
    isRouteActive: isRouteActive,
    notifyShown: notifyShown,
    readConfig: readConfig,
    readMapEngine: readMapEngine,
    setGenericLabel: setGenericLabel,
    showPlace: showPlace,
    showRoute: showRoute,
    teardown: teardown,
    warmup: warmup,
  };
})(window);
