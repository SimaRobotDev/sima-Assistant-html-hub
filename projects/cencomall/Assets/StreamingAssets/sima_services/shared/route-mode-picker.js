/**
 * "Ver ruta" / "Ruta accesible" picker.
 *
 * Two buttons docked inside the store / service detail card (floated to the right of its
 * text, so the description wraps around them and is never covered). The visitor chooses
 * the route type BEFORE the route exists; afterwards the pair stays: the active one is
 * filled, tapping the other switches the route, tapping the active one removes it.
 *
 * Replaces the old floating "Ruta accesible" button (mapvx-accessible-route.js). The
 * component's own walking/accessible switch lives in <route-options>, which never
 * registers in our pages (the 2nd bundle throws on define("custom-map")), so the
 * control is ours. See shared/mapvx-wc/README.md.
 *
 * The page owns the engines; this module owns the UI and the state machine:
 *
 *   var picker = RouteModePicker.create({
 *     dock: { panel: detailPanelEl, body: ".store-detail-body" },   // re-docks after each re-render
 *     start: function (mode, ctx) { ... },   // draw a route; call ctx.bind(routeEl) (or picker.adopt)
 *                                            // with the <route-view-totems> element if there is one;
 *                                            // reject to report a failure
 *     clear: function () { ... },            // remove the route (back to the place map)
 *     onStartFailed: function (mode, detail) {},  // optional: undo a half-drawn route after a failed start
 *     canSwitchInPlace: function (from, to) { return true; },  // WC route element: updateComponent
 *     isAvailable: function (mode) { return true; },           // false => button dimmed + notice
 *     log: fn, onChange: fn(mode)
 *   });
 *   picker.adopt(mode, routeEl)   // a route the PAGE started (native payload, ?route=1…)
 *   picker.reset()                // the route is gone (soft: ignored while one is being drawn)
 *   picker.setVisible(bool)
 *
 * mode is "walk" | "accessible". Accessible routes are only ever on request: nothing here
 * starts one on its own, and every new route element starts in the mode that was picked.
 */
(function (global) {
  "use strict";

  var PACK = {
    es: {
      walk: "Ver ruta",
      accessible: "Ruta accesible",
      pending: "Calculando…",
      groupLabel: "Tipo de ruta",
      unavailable: "No hay una ruta accesible disponible.",
      failed: "No se pudo calcular la ruta accesible.",
      failedWalk: "No se pudo calcular la ruta.",
      failedBack: "No se pudo cambiar de ruta.",
      unsupported: "La ruta accesible no está disponible para este lugar.",
    },
    en: {
      walk: "Show route",
      accessible: "Accessible route",
      pending: "Calculating…",
      groupLabel: "Route type",
      unavailable: "No accessible route is available.",
      failed: "The accessible route could not be calculated.",
      failedWalk: "The route could not be calculated.",
      failedBack: "The route could not be changed.",
      unsupported: "The accessible route is not available for this place.",
    },
    pt: {
      walk: "Ver rota",
      accessible: "Rota acessível",
      pending: "Calculando…",
      groupLabel: "Tipo de rota",
      unavailable: "Não há rota acessível disponível.",
      failed: "Não foi possível calcular a rota acessível.",
      failedWalk: "Não foi possível calcular a rota.",
      failedBack: "Não foi possível mudar de rota.",
      unsupported: "A rota acessível não está disponível para este local.",
    },
  };

  // Figma icons (24x24). The fill is `currentColor` so the active (filled) state can invert it.
  var ICONS = {
    walk:
      '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
      '<path d="M11.5858 2.58579C11.9609 2.21071 12.4696 2 13 2C13.5304 2 14.0391 2.21071 14.4142 2.58579C14.7893 2.96086 15 3.46957 15 4C15 4.53043 14.7893 5.03914 14.4142 5.41421C14.0391 5.78929 13.5304 6 13 6C12.4696 6 11.9609 5.78929 11.5858 5.41421C11.2107 5.03914 11 4.53043 11 4C11 3.46957 11.2107 2.96086 11.5858 2.58579Z" fill-rule="evenodd" clip-rule="evenodd" fill="currentColor"/>' +
      '<path d="M10.6 16.2001C11.0418 16.5314 11.1314 17.1582 10.8 17.6001L7.8 21.6001C7.46863 22.0419 6.84183 22.1314 6.4 21.8001C5.95817 21.4687 5.86863 20.8419 6.2 20.4001L9.2 16.4001C9.53137 15.9582 10.1582 15.8687 10.6 16.2001Z" fill-rule="evenodd" clip-rule="evenodd" fill="currentColor"/>' +
      '<path d="M12.1644 7.01364C12.7092 7.10444 13.0772 7.61966 12.9864 8.16443L12.071 13.6568L14.7071 16.2929C14.7831 16.3689 14.8464 16.4567 14.8944 16.5528L16.8944 20.5528C17.1414 21.0468 16.9412 21.6475 16.4472 21.8945C15.9532 22.1414 15.3526 21.9412 15.1056 21.4472L13.1781 17.5924L10.2929 14.7071C10.0645 14.4788 9.96051 14.1542 10.0136 13.8356L11.0136 7.83563C11.1044 7.29086 11.6196 6.92285 12.1644 7.01364Z" fill-rule="evenodd" clip-rule="evenodd" fill="currentColor"/>' +
      '<path d="M11.7575 7.02988C12.0982 6.94468 12.4587 7.04453 12.7071 7.29291L15.5402 10.126L18.3162 11.0513C18.8402 11.226 19.1233 11.7923 18.9487 12.3162C18.774 12.8402 18.2077 13.1234 17.6838 12.9487L14.6838 11.9487C14.5365 11.8996 14.4027 11.8169 14.2929 11.7071L11.6932 9.10749L8.6176 9.8764L6.83205 12.5547C6.5257 13.0142 5.90483 13.1384 5.4453 12.8321C4.98577 12.5257 4.8616 11.9049 5.16795 11.4453L7.16795 8.44532C7.30594 8.23834 7.51613 8.09021 7.75746 8.02988L11.7575 7.02988Z" fill-rule="evenodd" clip-rule="evenodd" fill="currentColor"/>' +
      "</svg>",
    accessible:
      '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
      '<path d="M8.87868 2.87868C9.44129 2.31607 10.2044 2 11 2C11.7956 2 12.5587 2.31607 13.1213 2.87868C13.6839 3.44129 14 4.20435 14 5C14 5.79565 13.6839 6.55871 13.1213 7.12132C12.5587 7.68393 11.7956 8 11 8C10.2044 8 9.44129 7.68393 8.87868 7.12132C8.31607 6.55871 8 5.79565 8 5C8 4.20435 8.31607 3.44129 8.87868 2.87868ZM11 4C10.7348 4 10.4804 4.10536 10.2929 4.29289C10.1054 4.48043 10 4.73478 10 5C10 5.26522 10.1054 5.51957 10.2929 5.70711C10.4804 5.89464 10.7348 6 11 6C11.2652 6 11.5196 5.89464 11.7071 5.70711C11.8946 5.51957 12 5.26522 12 5C12 4.73478 11.8946 4.48043 11.7071 4.29289C11.5196 4.10536 11.2652 4 11 4Z" fill-rule="evenodd" clip-rule="evenodd" fill="currentColor"/>' +
      '<path d="M11 6C11.5523 6 12 6.44772 12 7V14H15C15.3038 14 15.5911 14.1381 15.7809 14.3753L19.7809 19.3753C20.1259 19.8066 20.056 20.4359 19.6247 20.7809C19.1934 21.1259 18.5641 21.056 18.2191 20.6247L14.5194 16H11C10.4477 16 10 15.5523 10 15V7C10 6.44772 10.4477 6 11 6Z" fill-rule="evenodd" clip-rule="evenodd" fill="currentColor"/>' +
      '<path d="M10 11C10 10.4477 10.4477 10 11 10H16C16.5523 10 17 10.4477 17 11C17 11.5523 16.5523 12 16 12H11C10.4477 12 10 11.5523 10 11Z" fill-rule="evenodd" clip-rule="evenodd" fill="currentColor"/>' +
      '<path d="M7.92392 11.1174C8.13523 11.6277 7.89288 12.2126 7.38262 12.4239C6.80942 12.6613 6.29929 13.0288 5.89256 13.4973C5.48584 13.9658 5.19366 14.5224 5.03914 15.1233C4.88462 15.7242 4.87198 16.3527 5.00223 16.9593C5.13248 17.5659 5.40204 18.1339 5.78961 18.6183C6.17718 19.1028 6.67213 19.4905 7.23533 19.7507C7.79853 20.0109 8.41454 20.1366 9.03467 20.1177C9.6548 20.0988 10.262 19.936 10.8084 19.642C11.3547 19.3481 11.8252 18.931 12.1826 18.4239C12.5008 17.9725 13.1247 17.8645 13.5761 18.1826C14.0275 18.5008 14.1356 19.1247 13.8174 19.5761C13.2813 20.3368 12.5756 20.9623 11.756 21.4033C10.9365 21.8442 10.0256 22.0885 9.09546 22.1168C8.16527 22.1451 7.24125 21.9566 6.39645 21.5663C5.55165 21.1759 4.80923 20.5944 4.22787 19.8677C3.64652 19.141 3.24217 18.2891 3.0468 17.3792C2.85143 16.4693 2.87038 15.5265 3.10217 14.6252C3.33395 13.7239 3.77221 12.8888 4.3823 12.1861C4.99239 11.4834 5.75759 10.9322 6.61739 10.5761C7.12765 10.3648 7.7126 10.6071 7.92392 11.1174Z" fill-rule="evenodd" clip-rule="evenodd" fill="currentColor"/>' +
      "</svg>",
  };

  var MODES = ["walk", "accessible"];
  // The route is a network call; a slow totem connection can sit on it.
  var START_TIMEOUT_MS = 90000;
  var SWITCH_TIMEOUT_MS = 25000;
  var NOTE_MS = 4500;
  var STYLE_ID = "rmp-style";

  var CSS = [
    ".rmp-group{float:right;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;",
    "width:clamp(232px,34%,300px);margin:0 0 10px 14px;",
    "font-family:var(--cb-font-body,system-ui,sans-serif);}",
    ".rmp-group[hidden]{display:none;}",
    ".rmp-btn{display:flex;align-items:center;justify-content:flex-start;gap:10px;box-sizing:border-box;width:100%;",
    "min-height:52px;padding:8px 18px 8px 14px;border-radius:999px;",
    "border:2px solid var(--rmp-purple,#584E80);background:#fff;color:var(--rmp-purple,#584E80);",
    "font-family:inherit;font-weight:700;font-size:16px;line-height:1.1;text-align:left;cursor:pointer;",
    "box-shadow:0 2px 8px rgba(88,78,128,0.18);-webkit-tap-highlight-color:transparent;",
    "touch-action:manipulation;user-select:none;-webkit-user-select:none;}",
    ".rmp-btn svg{flex:0 0 auto;width:28px;height:28px;}",
    ".rmp-btn span{min-width:0;}",
    ".rmp-btn[aria-pressed=\"true\"]{background:var(--rmp-purple,#584E80);color:#fff;}",
    ".rmp-btn:disabled{cursor:progress;}",
    ".rmp-btn.rmp-busy{opacity:0.8;}",
    ".rmp-btn.rmp-unavailable{opacity:0.5;box-shadow:none;}",
    ".rmp-note{pointer-events:none;padding:8px 12px;border-radius:12px;background:rgba(30,22,48,0.92);",
    "color:#fff;font-size:13px;line-height:1.35;}",
    ".rmp-note:empty{display:none;}",
    "@media (max-width:520px){.rmp-group{float:none;width:100%;margin:10px 0 0;flex-direction:row;flex-wrap:wrap;}",
    ".rmp-btn{flex:1 1 150px;width:auto;}.rmp-note{flex:1 0 100%;}}",
  ].join("");

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
    var pack = PACK[currentLocale()] || PACK.es;
    return pack[key] != null ? pack[key] : (PACK.es[key] || key);
  }

  function ensureStyle() {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function create(opts) {
    opts = opts || {};
    var log = typeof opts.log === "function" ? opts.log : function () {};
    ensureStyle();

    // mode: what is on screen ("walk" | "accessible" | null). pending: the mode being drawn.
    // phase: "start" | "switch" | "restore" | "clear" | null. locked: an action is in flight
    // (survives reset() so a click can't start a second one).
    var s = { mode: null, pending: null, phase: null, restoreTo: null, visible: true, locked: false, done: null };
    var routeEl = null;
    var unbinders = [];
    var timer = null;
    var noteTimer = null;
    var destroyed = false;
    var observer = null;

    var group = document.createElement("div");
    group.className = "rmp-group";
    group.setAttribute("role", "group");
    var buttons = {};
    MODES.forEach(function (mode) {
      var node = document.createElement("button");
      node.type = "button";
      node.className = "rmp-btn";
      node.setAttribute("data-mode", mode);
      node.innerHTML = ICONS[mode] + "<span></span>";
      var label = node.lastChild;
      node.addEventListener("click", function () { select(mode); });
      buttons[mode] = { node: node, label: label };
      group.appendChild(node);
    });
    var note = document.createElement("div");
    note.className = "rmp-note";
    note.setAttribute("role", "status");
    note.setAttribute("aria-live", "polite");
    group.appendChild(note);

    function isAvailable(mode) {
      if (typeof opts.isAvailable !== "function") return true;
      try { return !!opts.isAvailable(mode); } catch (e) { return true; }
    }

    function render() {
      if (destroyed) return;
      group.hidden = !s.visible;
      group.setAttribute("aria-label", tr("groupLabel"));
      var busy = s.locked || !!s.pending;
      MODES.forEach(function (mode) {
        var b = buttons[mode];
        var pendingHere = s.pending === mode && s.phase !== "restore";
        b.label.textContent = pendingHere ? tr("pending") : tr(mode);
        b.node.setAttribute("aria-pressed", s.mode === mode ? "true" : "false");
        b.node.disabled = busy;
        var unavailable = !isAvailable(mode);
        b.node.setAttribute("aria-disabled", unavailable ? "true" : "false");
        b.node.classList.toggle("rmp-unavailable", unavailable);
        b.node.classList.toggle("rmp-busy", pendingHere);
      });
    }

    function clearTimer() {
      if (timer) { clearTimeout(timer); timer = null; }
    }
    function armTimer(ms, fn) {
      clearTimer();
      timer = setTimeout(function () { timer = null; fn(); }, ms);
    }
    function showNote(key) {
      if (destroyed) return;
      note.textContent = tr(key);
      if (noteTimer) clearTimeout(noteTimer);
      noteTimer = setTimeout(function () { note.textContent = ""; noteTimer = null; }, NOTE_MS);
    }
    function hideNote() {
      if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
      note.textContent = "";
    }
    function takeDone() {
      var d = s.done;
      s.done = null;
      return d || function () {};
    }

    // ---- route element signals ("startRouteAnimation" is what the bundle really dispatches;
    // "routeAnimationStart" is wired too in case of a vendor rename)
    function onDrawn() {
      if (destroyed || !s.pending) return;
      if (s.phase === "restore") return finishRestore();
      finishActive(s.pending);
    }
    function onError(ev) {
      if (destroyed || !s.pending) return;
      var detail = ev && ev.detail;
      if (s.phase === "start") return failStart(s.pending, detail);
      if (s.phase === "switch") return failSwitch(detail);
      if (s.phase === "restore") return finishRestore();
    }
    var sawLoading = false;
    function onLoading(ev) {
      if (destroyed || !s.pending || s.phase === "start") return;
      var loading = !!(ev && ev.detail && ev.detail.loading);
      if (loading) sawLoading = true;
      else if (sawLoading) onDrawn();
    }
    function bindRoute(el) {
      unbind();
      routeEl = el;
      sawLoading = false;
      [["startRouteAnimation", onDrawn], ["routeAnimationStart", onDrawn], ["mvxError", onError], ["mvxLoadingChange", onLoading]].forEach(function (pair) {
        el.addEventListener(pair[0], pair[1]);
        unbinders.push(function () { el.removeEventListener(pair[0], pair[1]); });
      });
    }
    function unbind() {
      unbinders.forEach(function (fn) { try { fn(); } catch (e) { /* noop */ } });
      unbinders = [];
      routeEl = null;
    }

    function finishActive(mode) {
      clearTimer();
      s.pending = null;
      s.phase = null;
      s.restoreTo = null;
      s.mode = mode;
      render();
      log("route-mode: " + mode);
      if (typeof opts.onChange === "function") { try { opts.onChange(mode); } catch (e) { /* noop */ } }
      takeDone()();
    }
    function finishRestore() {
      clearTimer();
      s.pending = null;
      s.phase = null;
      render();
      takeDone()();
    }

    // ---- start a route in `mode` (nothing on screen yet)
    function failStart(mode, detail) {
      if (s.pending !== mode || s.phase !== "start") return;
      var code = detail && (detail.code || (detail.detail && detail.detail.code));
      log("route-mode: start failed " + JSON.stringify({ mode: mode, code: code || "", message: detail && detail.message || "" }));
      clearTimer();
      unbind();
      var restore = s.restoreTo;
      var done = takeDone();
      s.pending = null;
      s.phase = null;
      s.restoreTo = null;
      s.mode = null;
      showNote(mode === "accessible" ? (code === "ROUTE_NOT_FOUND" ? "unavailable" : "failed") : "failedWalk");
      render();
      // Let the page undo a half-drawn route (e.g. drop the "Cargando ruta…" view and its timers).
      if (typeof opts.onStartFailed === "function") {
        try { opts.onStartFailed(mode, detail); } catch (e) { /* noop */ }
      }
      if (restore) {
        // Put the visitor back on the route they had (silently: the notice above stays).
        doStart(restore, null).then(done, done);
      } else {
        done();
      }
    }
    function doStart(mode, restoreTo) {
      return new Promise(function (resolve) {
        s.pending = mode;
        s.phase = "start";
        s.restoreTo = restoreTo;
        s.done = resolve;
        render();
        var bound = false;
        var ctx = { bind: function (el) { bound = true; bindRoute(el); } };
        var p;
        try { p = Promise.resolve(opts.start(mode, ctx)); } catch (e) { p = Promise.reject(e); }
        p.then(function () {
          if (s.pending !== mode || s.phase !== "start") return; // already settled by an event / reset
          if (!bound && !routeEl) { finishActive(mode); return; } // no route element: drawn when start() resolved
          armTimer(START_TIMEOUT_MS, function () {
            log("route-mode: no draw signal in " + START_TIMEOUT_MS + "ms (" + mode + ")");
            finishActive(mode);
          });
        }, function (e) { failStart(mode, e); });
      });
    }

    // ---- switch the route on screen, in place (updateComponent) — WC route element only
    function requestInPlace(mode) {
      var res = routeEl.updateComponent({ accessibleRoute: mode === "accessible" });
      if (res && typeof res.then === "function") {
        res.then(function (r) {
          if (r && r.success === false) { s.phase === "restore" ? finishRestore() : failSwitch({ code: "UPDATE_FAILED", message: r.error }); }
        }, function (e) {
          s.phase === "restore" ? finishRestore() : failSwitch({ code: "EXCEPTION", message: String(e && e.message || e) });
        });
      }
    }
    function failSwitch(detail) {
      if (s.phase !== "switch") return;
      var code = detail && detail.code;
      var attempted = s.pending;
      log("route-mode: switch failed " + JSON.stringify({ mode: attempted, code: code || "" }));
      clearTimer();
      showNote(attempted === "accessible" ? (code === "ROUTE_NOT_FOUND" ? "unavailable" : "failed") : "failedBack");
      // The component keeps the mode it was asked for even when no route came back, and
      // ignores a repeat request for a mode it thinks is already active: put it back in the
      // mode still on screen so the next tap really re-requests.
      s.phase = "restore";
      s.pending = s.mode;
      sawLoading = false;
      render();
      armTimer(SWITCH_TIMEOUT_MS, function () { finishRestore(); });
      try { requestInPlace(s.mode); } catch (e) { finishRestore(); }
    }
    function doSwitchInPlace(mode) {
      return new Promise(function (resolve) {
        s.pending = mode;
        s.phase = "switch";
        s.done = resolve;
        sawLoading = false;
        render();
        armTimer(SWITCH_TIMEOUT_MS, function () {
          // No redraw signal in time: the reload is most likely done (or silently ignored).
          log("route-mode: no redraw signal in " + SWITCH_TIMEOUT_MS + "ms (" + mode + ")");
          finishActive(mode);
        });
        try { requestInPlace(mode); } catch (e) { failSwitch({ code: "EXCEPTION", message: String(e && e.message || e) }); }
      });
    }

    function doClear() {
      s.phase = "clear";
      render();
      var p;
      try { p = Promise.resolve(opts.clear ? opts.clear() : null); } catch (e) { p = Promise.reject(e); }
      return p.then(null, function (e) { log("route-mode: clear failed " + (e && e.message || e)); }).then(function () {
        clearTimer();
        unbind();
        s.mode = null;
        s.pending = null;
        s.phase = null;
        s.restoreTo = null;
      });
    }

    function canInPlace(from, to) {
      if (!routeEl || !routeEl.isConnected || typeof routeEl.updateComponent !== "function") return false;
      if (typeof opts.canSwitchInPlace !== "function") return true;
      try { return !!opts.canSwitchInPlace(from, to, routeEl); } catch (e) { return false; }
    }

    function orchestrate(mode) {
      s.locked = true;
      hideNote();
      var work;
      if (s.mode === mode) {
        work = doClear();
      } else if (s.mode === null) {
        work = doStart(mode, null);
      } else if (canInPlace(s.mode, mode)) {
        work = doSwitchInPlace(mode);
      } else {
        var prev = s.mode;
        work = doClear().then(function () { return doStart(mode, prev); });
      }
      return work.then(function () { s.locked = false; render(); }, function () { s.locked = false; render(); });
    }

    function select(mode) {
      if (destroyed || s.locked || s.pending) return Promise.resolve();
      if (!isAvailable(mode)) { showNote("unsupported"); return Promise.resolve(); }
      return orchestrate(mode);
    }

    // A route the PAGE started (native payload, ?route=1, auto-route…): follow it.
    function adopt(mode, el) {
      if (destroyed || !el) return;
      if (s.pending && s.phase === "start" && !routeEl) { bindRoute(el); return; } // picker-started: same as ctx.bind
      unbind();
      s.mode = null;
      s.pending = mode;
      s.phase = "start";
      s.restoreTo = null;
      s.done = null;
      bindRoute(el);
      armTimer(START_TIMEOUT_MS, function () { finishActive(mode); });
      render();
    }

    // The route is gone. Soft by default: ignored while a route is being drawn, because the
    // page's own "map reset" calls land in the middle of our start/clear sequences.
    function reset(force) {
      if (destroyed) return;
      if (!force && s.pending) return;
      clearTimer();
      unbind();
      var done = takeDone();
      s.mode = null;
      s.pending = null;
      s.phase = null;
      s.restoreTo = null;
      render();
      done();
    }

    // Mark what is on screen when no route element is involved (legacy engine).
    function setActive(mode) {
      if (destroyed || s.pending) return;
      s.mode = mode || null;
      render();
    }

    function dockInto(body) {
      if (!body) return;
      if (group.parentNode !== body || body.firstChild !== group) body.insertBefore(group, body.firstChild);
    }

    function onLocale() { render(); }
    if (global.addEventListener) global.addEventListener("sima:localechange", onLocale);

    if (opts.dock && opts.dock.panel) {
      var panel = opts.dock.panel;
      var selector = opts.dock.body || ".store-detail-body";
      var place = function () { dockInto(panel.querySelector(selector)); };
      place();
      if (typeof MutationObserver === "function") {
        observer = new MutationObserver(place);
        observer.observe(panel, { childList: true, subtree: true });
      }
    }
    render();

    function destroy() {
      if (destroyed) return;
      reset(true);
      destroyed = true;
      if (observer) observer.disconnect();
      if (noteTimer) clearTimeout(noteTimer);
      if (global.removeEventListener) global.removeEventListener("sima:localechange", onLocale);
      if (group.parentNode) group.parentNode.removeChild(group);
    }

    return {
      element: group,
      select: select,
      adopt: adopt,
      reset: reset,
      setActive: setActive,
      setVisible: function (visible) { s.visible = !!visible; render(); },
      refresh: render,
      dockInto: dockInto,
      getMode: function () { return s.mode; },
      getPending: function () { return s.pending; },
      notify: showNote,
      isBusy: function () { return s.locked || !!s.pending; },
      destroy: destroy,
    };
  }

  global.RouteModePicker = { create: create, PACK: PACK, ICONS: ICONS };
})(typeof window !== "undefined" ? window : this);
