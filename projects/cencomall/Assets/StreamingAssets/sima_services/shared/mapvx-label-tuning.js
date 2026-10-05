/**
 * Store-name labels on the MapVX maps — shared by store-map-web (its own page
 * script) and mobility (via mapvx-wc-runtime.js).
 *
 * UNSUPPORTED WORKAROUND, same family as hideGenericPoiIcons / flattenBuildings:
 * the web components expose no prop for label zoom or size, so this reaches the
 * raw MapLibre instance (host -> <custom-map> -> lzMap.map) and tunes ONE style
 * layer. It can silently stop working if MapVX renames the layer.
 *
 * Why this layer: the grey names around a store ("Noa Joyas", "Zara", "H&M"…)
 * are the MapVX style layer `indoor-poi` (text only, source-layer `poi`: ~350
 * "shop", ~120 "grocery", ~110 "clothing_store"… points with names). Verified
 * 2026-10-05 on MapVX's own map: switching that layer off removes every store
 * name. MapVX ships it as `minzoom: 19`, `text-size: 12`, `text-padding: 2` and
 * `text-allow-overlap: false` (MapLibre hides a label that would collide).
 *
 * Problem: our pages cap the zoom at 19 (ZOOM_MAX), so the names existed ONLY at
 * the closest zoom and vanished as soon as the visitor zoomed out. Fix:
 *  - show them across the whole allowed zoom range (minZoom = the pages' ZOOM_MIN);
 *  - make the text size ADAPTIVE: small when zoomed out, so many names fit side by
 *    side without hiding each other, growing to MapVX's own 12px at the closest
 *    zoom (so the close-up view is exactly as before);
 *  - tighter padding and earlier line-wrapping when zoomed out.
 * Collisions are still resolved by MapLibre (no label is ever drawn on top of
 * another one); a smaller size just lets more of them survive.
 *
 * To tune: edit CONFIG below. sizeStops are [zoom, CSS px] pairs, linearly
 * interpolated; keep the last one at 12 to leave the closest zoom unchanged.
 */
(function (root) {
  "use strict";

  var LABEL_LAYER_ID = "indoor-poi";

  var CONFIG = {
    // First zoom at which store names show. Keep equal to the pages' ZOOM_MIN
    // (17.3): zooming out is limited to that, so names are visible at EVERY zoom.
    minZoom: 17.3,
    // [zoom, text size in CSS px]
    sizeStops: [[17.3, 8], [18.2, 10], [19, 12]],
    // text-padding (px around each label used for collision): tighter = more fit.
    padding: 1,
    // [zoom, ems] before a long name wraps onto a second line (narrower footprint).
    maxWidthStops: [[17.3, 8], [19, 10]]
  };

  function interpolate(stops) {
    var expr = ["interpolate", ["linear"], ["zoom"]];
    for (var i = 0; i < stops.length; i++) expr.push(stops[i][0], stops[i][1]);
    return expr;
  }

  function same(a, b) {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
  }

  // Applies the configuration to a live MapLibre map. Idempotent: only touches a
  // property when it differs, so calling it again (or from a style event) is cheap
  // and cannot loop. Returns true when the label layer exists.
  function apply(map, log) {
    if (!map || typeof map.getLayer !== "function") return false;
    var layer = map.getLayer(LABEL_LAYER_ID);
    if (!layer) return false;
    var changed = [];

    // Visible: hideGenericPoiIcons hides every symbol layer of source-layer "poi",
    // which also catches this TEXT layer. The names are wanted, so it is re-shown
    // (the generic icon badges stay hidden — those are other layers).
    if (map.getLayoutProperty(LABEL_LAYER_ID, "visibility") === "none") {
      map.setLayoutProperty(LABEL_LAYER_ID, "visibility", "visible");
      changed.push("visibility");
    }

    var minZoom = CONFIG.minZoom;
    if (typeof layer.minzoom !== "number" || Math.abs(layer.minzoom - minZoom) > 1e-6) {
      map.setLayerZoomRange(LABEL_LAYER_ID, minZoom, typeof layer.maxzoom === "number" ? layer.maxzoom : 24);
      changed.push("minzoom");
    }

    var size = interpolate(CONFIG.sizeStops);
    if (!same(map.getLayoutProperty(LABEL_LAYER_ID, "text-size"), size)) {
      map.setLayoutProperty(LABEL_LAYER_ID, "text-size", size);
      changed.push("text-size");
    }
    if (map.getLayoutProperty(LABEL_LAYER_ID, "text-padding") !== CONFIG.padding) {
      map.setLayoutProperty(LABEL_LAYER_ID, "text-padding", CONFIG.padding);
      changed.push("text-padding");
    }
    var maxWidth = interpolate(CONFIG.maxWidthStops);
    if (!same(map.getLayoutProperty(LABEL_LAYER_ID, "text-max-width"), maxWidth)) {
      map.setLayoutProperty(LABEL_LAYER_ID, "text-max-width", maxWidth);
      changed.push("text-max-width");
    }

    if (changed.length && typeof log === "function") {
      log("MapVxLabels: tuned " + LABEL_LAYER_ID + " (" + changed.join(", ") + ")");
    }
    return true;
  }

  // Tunes the map and keeps it tuned: the SDK can rebuild or re-filter layers on
  // floor changes, and the hide helpers may run after us, so a style-change
  // listener re-applies (a no-op unless something was reset).
  function tune(map, log) {
    try {
      if (!map || typeof map.on !== "function") return false;
      var ok = apply(map, log);
      if (!map.__mvxLabelWatch) {
        map.__mvxLabelWatch = true;
        var busy = false;
        map.on("styledata", function () {
          if (busy) return;
          busy = true;
          try { apply(map, log); } catch (e) { /* style mid-reload: next event retries */ }
          busy = false;
        });
      }
      return ok;
    } catch (e) {
      if (typeof log === "function") {
        log("MapVxLabels failed (MapVX internals likely changed): " + (e && e.message ? e.message : e));
      }
      return false;
    }
  }

  root.MapVxLabels = { tune: tune, apply: apply, CONFIG: CONFIG, LAYER_ID: LABEL_LAYER_ID };
})(typeof window !== "undefined" ? window : this);
