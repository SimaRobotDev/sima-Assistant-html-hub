/* Totem UX guard — the assistant HTMLs are full-screen kiosk screens. The user
 * must never be able to scale/zoom the PAGE itself (pinch, double-tap,
 * Ctrl+wheel, Ctrl +/-): on a touch-only totem a half-zoomed layout has no way
 * back and looks broken.
 *
 * This only locks *page* zoom. Map screens keep their own in-canvas zoom: the
 * MapLibre / MapVX gesture handlers live on the map element and are untouched —
 * the Ctrl+wheel guard below even bails out when the pointer is over a map so
 * desktop testing of the map still works.
 *
 * Loaded on every entry HTML right after shared/bridge.js.
 */
(function () {
  "use strict";

  // 1. Force a non-scalable viewport even where the page <meta> forgot to say so.
  try {
    var vp = document.querySelector('meta[name="viewport"]');
    if (!vp) {
      vp = document.createElement("meta");
      vp.setAttribute("name", "viewport");
      (document.head || document.documentElement).appendChild(vp);
    }
    var content = vp.getAttribute("content") || "width=device-width, initial-scale=1.0";
    content = content.replace(/\s*,\s*(user-scalable|maximum-scale|minimum-scale)\s*=\s*[^,]+/gi, "");
    content += ", maximum-scale=1, minimum-scale=1, user-scalable=no";
    vp.setAttribute("content", content);
  } catch (e) { /* non-fatal */ }

  // 2. iOS / iPadOS WKWebView ignores user-scalable=no — block its proprietary
  //    pinch-gesture events explicitly. No-op on Android WebView.
  ["gesturestart", "gesturechange", "gestureend"].forEach(function (evt) {
    document.addEventListener(evt, function (e) { e.preventDefault(); }, { passive: false });
  });

  // 3. Desktop trackpad pinch and Ctrl+wheel = browser zoom. Block just that
  //    combo (plain scroll is left alone). Skip it over a map canvas so the
  //    map's own Ctrl+wheel zoom keeps working.
  window.addEventListener("wheel", function (e) {
    if (!e.ctrlKey) return;
    var t = e.target;
    if (t && t.closest && t.closest(
      ".maplibregl-map, canvas, map-view-with-modal, route-view-totems, #mapvx-container, #mapvx-wc-stage"
    )) return;
    e.preventDefault();
  }, { passive: false });

  // 4. Ctrl/Cmd +/-/0 keyboard zoom (maintenance keyboards).
  window.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) &&
        (e.key === "+" || e.key === "-" || e.key === "=" || e.key === "0")) {
      e.preventDefault();
    }
  }, { passive: false });
})();
