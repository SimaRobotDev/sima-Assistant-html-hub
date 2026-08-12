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
  var ROUTE_TIMEOUT_MS = 15000;
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
    routeBundlePromise: null,
    warmupPromise: null,
    lastPlaceId: "",
    routeActive: false,
    visible: false,
    callbacks: {
      onReady: null,
      onError: null,
      onTitle: null,
      onRouteReady: null,
      onRouteClosed: null,
      log: null,
    },
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

  function readMapEngine(search) {
    var raw = "";
    try {
      var params = new URLSearchParams(search || global.location.search || "");
      raw = text(params.get("mapEngine") || params.get("map_engine")).toLowerCase();
    } catch (e) { /* noop */ }
    if (raw === "legacy" || raw === "wc" || raw === "auto") return raw;
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
    });
  }

  function scriptBase() {
    var scripts = document.getElementsByTagName("script");
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].src || "";
      if (/mapvx-wc-runtime\.js/i.test(src)) {
        return src.replace(/mapvx-wc-runtime\.js.*$/i, "");
      }
    }
    return "../shared/";
  }

  function ensureRouteBundle() {
    if (typeof customElements !== "undefined" && customElements.get("route-view-totems")) {
      return Promise.resolve(true);
    }
    if (state.routeBundlePromise) return state.routeBundlePromise;

    state.routeBundlePromise = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = scriptBase() + "mapvx-wc/route-view-totems.js";
      script.async = true;
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

  function showWcShell() {
    state.visible = true;
    if (state.placeView) state.placeView.classList.remove("hidden");
    if (state.routeView) state.routeView.classList.add("hidden");
    if (state.placeMount) {
      state.placeMount.classList.remove("hidden");
      if (state.placeMount.parentElement) {
        state.placeMount.parentElement.classList.remove("hidden");
        state.placeMount.parentElement.classList.remove("preload-mount");
      }
    }
    var stage = document.getElementById("mapvx-wc-stage");
    if (stage) {
      stage.classList.remove("hidden");
      stage.classList.remove("preload-mount");
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
    showWcShell();
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

      showWcShell();
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
    state.routeActive = false;
    if (state.routeMount) state.routeMount.innerHTML = "";
    setActiveView("place");
    if (typeof state.callbacks.onRouteClosed === "function") {
      try { state.callbacks.onRouteClosed(); } catch (e) { /* noop */ }
    }
  }

  function showRoute(destinationId, options) {
    options = options || {};
    var timeoutMs = options.timeoutMs != null ? Number(options.timeoutMs) : ROUTE_TIMEOUT_MS;
    var cfg = readConfig();
    var dest = text(destinationId || state.lastPlaceId);
    var origin = text(options.originId || cfg.totemPlaceId);

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

        showWcShell();
        setActiveView("route");
        state.routeMount.innerHTML = "";

        var routeEl = document.createElement("route-view-totems");
        routeEl.id = "mvx-route";
        routeEl.setAttribute(
          "style",
          "--mvx-primary-color:#5B2D8E; --mvx-surface-color:#ffffff; --mvx-on-surface-color:#3D1D5C;"
        );
        state.routeMount.appendChild(routeEl);

        var settled = false;
        function succeed(payload) {
          if (settled) return;
          settled = true;
          clearRouteTimeout();
          state.routeActive = true;
          resolve(payload);
        }
        function fail(reason) {
          if (settled) return;
          settled = true;
          clearRouteTimeout();
          var err = reason instanceof Error ? reason : new Error(String(reason || "wc showRoute failed"));
          if (typeof state.callbacks.onError === "function") {
            try { state.callbacks.onError(err); } catch (e) { /* noop */ }
          }
          reject(err);
        }

        routeEl.addEventListener("mapReady", function () {
          hideGenericPoiIcons(routeEl);
          var libreMap = getLiveMap(routeEl);
          if (libreMap) flattenBuildings(libreMap);
          if (typeof state.callbacks.onRouteReady === "function") {
            try {
              state.callbacks.onRouteReady({
                placeId: dest,
                originId: origin,
                route: true,
                engine: "wc",
              });
            } catch (e) { /* noop */ }
          }
          log("route-view-totems: mapReady");
          succeed({ placeId: dest, originId: origin, route: true, engine: "wc" });
        });
        routeEl.addEventListener("back", function () {
          closeRoute();
        });

        clearRouteTimeout();
        state.routeTimeoutId = setTimeout(function () {
          fail(new Error("wc route timeout"));
        }, timeoutMs);

        routeEl.setAttribute("apiKey", cfg.apiKey || "");
        routeEl.setAttribute("parentPlaceId", cfg.parentPlace || cfg.parentPlaceId || "");
        routeEl.setAttribute("locale", cfg.lang || "es");
        routeEl.setAttribute("destinationId", dest);
        routeEl.setAttribute("originId", origin);
        log("showRoute " + JSON.stringify({ destinationId: dest, originId: origin }));
      });
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
  }

  function isRouteActive() {
    return !!state.routeActive;
  }

  function getLastPlaceId() {
    return state.lastPlaceId;
  }

  global.MapVxWcRuntime = {
    CONFIG_STORAGE_KEY: CONFIG_STORAGE_KEY,
    closeRoute: closeRoute,
    destroy: destroy,
    ensureRouteBundle: ensureRouteBundle,
    getLastPlaceId: getLastPlaceId,
    hasLiveMap: hasLiveMap,
    hasRouteOrigin: hasRouteOrigin,
    hide: hide,
    init: init,
    isAvailable: isAvailable,
    isRouteActive: isRouteActive,
    notifyShown: notifyShown,
    readConfig: readConfig,
    readMapEngine: readMapEngine,
    showPlace: showPlace,
    showRoute: showRoute,
    teardown: teardown,
    warmup: warmup,
  };
})(window);
