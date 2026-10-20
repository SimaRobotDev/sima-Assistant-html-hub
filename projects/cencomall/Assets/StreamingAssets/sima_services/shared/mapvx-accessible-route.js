/**
 * "Ruta accesible" button for a <route-view-totems> element (MapVX Web Components).
 *
 * Why this exists: the component ships its own walking / accessible switch, but it
 * lives in <route-options>, which never registers in our pages (map-view-with-modal.js
 * loads first, then route-view-totems.js throws on the duplicate define("custom-map")
 * before reaching it — same on 0.3.0 and 0.13.0). So the built-in switch is not on
 * screen and we draw our own control. See shared/mapvx-wc/README.md.
 *
 * Behaviour: accessible route is OFF by default and only on request. The button shows
 * once the first (walking) route starts drawing; tapping it asks the component for the
 * accessible route (elevators over stairs and escalators) and tapping again goes back.
 * It is created per route element, so every new route starts as a walking route.
 *
 * Usage:
 *   var ctl = MapVxAccessibleRoute.attach(routeEl, { container: stageEl, log: fn });
 *   ctl.destroy();   // when the route view closes
 *
 * The container must be a positioned element; the button is placed top-right of it.
 */
(function (global) {
  "use strict";

  var PACK = {
    es: {
      label: "Ruta accesible",
      labelOn: "Ruta accesible · activa",
      pending: "Calculando…",
      unavailable: "No hay una ruta accesible disponible.",
      failed: "No se pudo calcular la ruta accesible.",
      failedWalking: "No se pudo volver a la ruta normal.",
      hintOn: "Toca para volver a la ruta normal",
      hintOff: "Ruta por ascensores, sin escaleras",
    },
    en: {
      label: "Accessible route",
      labelOn: "Accessible route · on",
      pending: "Calculating…",
      unavailable: "No accessible route is available.",
      failed: "The accessible route could not be calculated.",
      failedWalking: "Could not go back to the regular route.",
      hintOn: "Tap to go back to the regular route",
      hintOff: "Route by elevators, no stairs",
    },
    pt: {
      label: "Rota acessível",
      labelOn: "Rota acessível · ativa",
      pending: "Calculando…",
      unavailable: "Não há rota acessível disponível.",
      failed: "Não foi possível calcular a rota acessível.",
      failedWalking: "Não foi possível voltar à rota normal.",
      hintOn: "Toque para voltar à rota normal",
      hintOff: "Rota por elevadores, sem escadas",
    },
  };

  // How long to wait for the component to redraw before giving up on a signal. The
  // route reload is a network call; the component can sit on a slow totem connection.
  var PENDING_TIMEOUT_MS = 25000;
  var TOAST_MS = 4500;
  var STYLE_ID = "mvx-acc-style";

  var CSS = [
    ".mvx-acc-wrap{position:absolute;top:10px;right:10px;z-index:var(--mvx-acc-z,30);",
    "display:flex;flex-direction:column;align-items:flex-end;gap:6px;pointer-events:none;",
    "font-family:var(--cb-font-body,system-ui,sans-serif);}",
    ".mvx-acc-wrap.mvx-acc-hidden{display:none;}",
    ".mvx-acc-btn{pointer-events:auto;display:inline-flex;align-items:center;gap:8px;",
    "min-height:48px;max-width:min(320px,calc(100vw - 40px));padding:10px 18px;border-radius:999px;",
    "border:2px solid var(--cm-purple-dark,#582c83);background:#fff;color:var(--cm-purple-dark,#582c83);",
    "font-family:inherit;font-weight:700;font-size:15px;line-height:1.15;cursor:pointer;",
    "box-shadow:0 4px 14px rgba(61,29,92,0.22);-webkit-tap-highlight-color:transparent;",
    "touch-action:manipulation;user-select:none;-webkit-user-select:none;}",
    ".mvx-acc-btn[aria-pressed=\"true\"]{background:var(--cm-purple-dark,#582c83);color:#fff;}",
    ".mvx-acc-btn:disabled{opacity:0.75;cursor:progress;}",
    ".mvx-acc-btn svg{flex:0 0 auto;width:22px;height:22px;fill:currentColor;}",
    ".mvx-acc-toast{pointer-events:none;max-width:260px;padding:8px 12px;border-radius:12px;",
    "background:rgba(30,22,48,0.92);color:#fff;font-size:13px;line-height:1.35;text-align:right;}",
    ".mvx-acc-toast:empty{display:none;}"
  ].join("");

  // Material "accessibility" glyph (person, arms out).
  var ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M12 2c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2zm9 7h-6v13h-2v-6h-2v6H9V9H3V7h18v2z"/></svg>';

  function currentLocale() {
    try {
      if (global.SimaLocale && global.SimaLocale.readLocaleFromPage) {
        return global.SimaLocale.resolveLocale(global.MALL_LOCALE || global.SimaLocale.readLocaleFromPage());
      }
    } catch (e) { /* noop */ }
    var raw = String(global.MALL_LOCALE || "es").toLowerCase();
    return raw.indexOf("en") === 0 ? "en" : raw.indexOf("pt") === 0 ? "pt" : "es";
  }

  function tr(key) {
    var locale = currentLocale();
    var pack = PACK[locale] || PACK.es;
    return pack[key] != null ? pack[key] : (PACK.es[key] || key);
  }

  function ensureStyle() {
    if (!document.getElementById(STYLE_ID)) {
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
  }

  // Ask the component to switch route type. updateComponent() is MapVX's documented
  // entry point (>= 0.13.0): with only `accessibleRoute` it re-requests the route on
  // screen. On older bundles fall back to the event the built-in switch dispatches.
  function requestMode(routeEl, accessible) {
    if (typeof routeEl.updateComponent === "function") {
      return routeEl.updateComponent({ accessibleRoute: accessible });
    }
    routeEl.dispatchEvent(new CustomEvent("accessibilityChange", {
      detail: accessible,
      bubbles: true,
      composed: true,
    }));
    return null;
  }

  function attach(routeEl, opts) {
    opts = opts || {};
    var container = opts.container;
    var log = typeof opts.log === "function" ? opts.log : function () {};
    if (!routeEl || !container || typeof document === "undefined") return null;

    if (routeEl.__mvxAccessible && routeEl.__mvxAccessible.destroy) routeEl.__mvxAccessible.destroy();
    ensureStyle();

    var s = { on: false, shown: false, pending: false, restore: false, target: false, sawLoading: false };
    var timer = null;
    var toastTimer = null;
    var destroyed = false;

    var wrap = document.createElement("div");
    wrap.className = "mvx-acc-wrap mvx-acc-hidden";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mvx-acc-btn";
    var toast = document.createElement("div");
    toast.className = "mvx-acc-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    wrap.appendChild(btn);
    wrap.appendChild(toast);
    container.appendChild(wrap);

    function render() {
      if (destroyed) return;
      var showPending = s.pending && !s.restore;
      var text = showPending ? tr("pending") : (s.on ? tr("labelOn") : tr("label"));
      btn.innerHTML = ICON + "<span></span>";
      btn.lastChild.textContent = text;
      btn.disabled = s.pending;
      btn.setAttribute("aria-pressed", s.on ? "true" : "false");
      btn.setAttribute("aria-busy", s.pending ? "true" : "false");
      btn.title = s.on ? tr("hintOn") : tr("hintOff");
      wrap.classList.toggle("mvx-acc-hidden", !s.shown);
    }

    function showToast(key) {
      if (destroyed) return;
      toast.textContent = tr(key);
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toast.textContent = ""; toastTimer = null; }, TOAST_MS);
    }

    function clearTimer() {
      if (timer) { clearTimeout(timer); timer = null; }
    }

    // Start a request for `mode`. `restore` = put the component back in the mode the
    // button already shows (after a failed request), not a user action.
    function begin(mode, restore) {
      s.pending = true;
      s.restore = !!restore;
      s.target = mode;
      s.sawLoading = false;
      render();
      clearTimer();
      timer = setTimeout(function () {
        timer = null;
        // No redraw signal in time. The reload is most likely done (or silently
        // ignored); don't leave the button stuck — keep what was asked for.
        log("accessible-route: no redraw signal within " + PENDING_TIMEOUT_MS + "ms (mode=" + mode + ")");
        finish(true, null);
      }, PENDING_TIMEOUT_MS);
      var res;
      try {
        res = requestMode(routeEl, mode);
      } catch (e) {
        finish(false, { code: "EXCEPTION", message: String(e && e.message || e) });
        return;
      }
      if (res && typeof res.then === "function") {
        res.then(function (r) {
          if (r && r.success === false) finish(false, { code: "UPDATE_FAILED", message: r.error });
        }, function (e) {
          finish(false, { code: "EXCEPTION", message: String(e && e.message || e) });
        });
      }
    }

    function finish(ok, detail) {
      if (destroyed || !s.pending) return;
      clearTimer();
      s.pending = false;
      if (s.restore) {
        // Back in the previous mode — the UI already shows it.
        s.restore = false;
        render();
        return;
      }
      if (ok) {
        s.on = s.target;
        render();
        log("accessible-route: " + (s.on ? "on" : "off"));
        if (typeof opts.onChange === "function") {
          try { opts.onChange(s.on); } catch (e2) { /* noop */ }
        }
        return;
      }
      log("accessible-route: request failed " + JSON.stringify(detail || {}));
      // Wording follows what was asked: "no accessible route" only makes sense when the
      // visitor asked for one; failing to go back to the walking route is a plain failure.
      showToast(!s.target ? "failedWalking" : (detail && detail.code === "ROUTE_NOT_FOUND" ? "unavailable" : "failed"));
      // The component keeps the mode it was asked for even when no route came back,
      // and ignores a repeat request for a mode it thinks is already active. Put it
      // back in the mode still on screen so the next tap really re-requests.
      begin(s.on, true);
    }

    function onRouteDrawn() {
      if (destroyed) return;
      if (!s.shown) { s.shown = true; render(); }
      if (s.pending) finish(true, null);
    }
    function onError(ev) {
      if (s.pending) finish(false, ev && ev.detail);
    }
    function onLoading(ev) {
      if (!s.pending) return;
      var loading = !!(ev && ev.detail && ev.detail.loading);
      if (loading) s.sawLoading = true;
      else if (s.sawLoading) finish(true, null);
    }
    function onClick() {
      if (destroyed || !s.shown || s.pending) return;
      if (!routeEl.isConnected) { destroy(); return; }
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
      toast.textContent = "";
      begin(!s.on, false);
    }
    function onLocale() { render(); }

    // "startRouteAnimation" is what the bundle really dispatches (verified in the
    // IIFE); "routeAnimationStart" is wired too in case of a vendor rename.
    routeEl.addEventListener("startRouteAnimation", onRouteDrawn);
    routeEl.addEventListener("routeAnimationStart", onRouteDrawn);
    routeEl.addEventListener("mvxError", onError);
    routeEl.addEventListener("mvxLoadingChange", onLoading);
    btn.addEventListener("click", onClick);
    global.addEventListener("sima:localechange", onLocale);
    render();

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimer();
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
      routeEl.removeEventListener("startRouteAnimation", onRouteDrawn);
      routeEl.removeEventListener("routeAnimationStart", onRouteDrawn);
      routeEl.removeEventListener("mvxError", onError);
      routeEl.removeEventListener("mvxLoadingChange", onLoading);
      btn.removeEventListener("click", onClick);
      global.removeEventListener("sima:localechange", onLocale);
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      if (routeEl.__mvxAccessible === api) routeEl.__mvxAccessible = null;
    }

    var api = {
      destroy: destroy,
      // Test / debug hooks.
      isOn: function () { return s.on; },
      isShown: function () { return s.shown; },
      isPending: function () { return s.pending; },
      element: wrap,
    };
    routeEl.__mvxAccessible = api;
    return api;
  }

  global.MapVxAccessibleRoute = { attach: attach, PACK: PACK };
})(typeof window !== "undefined" ? window : this);
