var MAPVX_TEST_CONFIG_KEY = "cencomall_mapvx_test_config";

function applyMapvxConfig(cfg) {
  window.MAPVX_CONFIG = Object.assign(window.MAPVX_CONFIG || {}, cfg || {});
  var widget = document.getElementById("mapvx-widget");
  var status = document.getElementById("mapvx-config-status");
  var json = document.getElementById("mapvx-config-json");
  var stored = Object.assign({
    apiKey: "",
    parentPlace: "",
    institutionId: "",
    totemPlaceId: "",
    lang: "es",
    showStoreLabels: "featured",
    storeLabelMax: 0,
    storeLabelZoomDelta: 1.2
  }, window.MAPVX_CONFIG);

  try {
    sessionStorage.setItem(MAPVX_TEST_CONFIG_KEY, JSON.stringify(stored));
  } catch (e) {}

  if (status) status.textContent = window.MAPVX_CONFIG.apiKey ? "Config received" : "Config received, waiting for apiKey";
  if (json) json.textContent = JSON.stringify(window.MAPVX_CONFIG, null, 2);

  var frame = document.getElementById("mapvx-map-frame");
  if (frame && frame.contentWindow) {
    try {
      frame.contentWindow.location.reload();
    } catch (e) {
      frame.src = frame.src;
    }
  }

  if (!widget) return;

  if (typeof widget.init === "function") {
    try { widget.init(window.MAPVX_CONFIG); } catch (e) {}
    return;
  }

  Object.keys(window.MAPVX_CONFIG).forEach(function (key) {
    widget.setAttribute(key, window.MAPVX_CONFIG[key]);
  });
}

window.addEventListener("message", function (ev) {
  var data = ev.data || {};
  if (data.type === "MAPVX_CONFIG") {
    applyMapvxConfig(data.payload);
    return;
  }

  if (data.type === "PING") {
    if (ev.source && ev.source.postMessage) ev.source.postMessage({ type: "PONG" }, ev.origin || "*");
    return;
  }

  if (data.type === "MAPVX_NAVIGATE_TO_STORE") {
    var widget = document.getElementById("mapvx-widget");
    if (widget && typeof widget.navigateTo === "function") {
      widget.navigateTo(data.payload && data.payload.storeId);
    }
  }
});

(function forwardWidgetEvents() {
  var widget = document.getElementById("mapvx-widget");
  if (!widget || !widget.addEventListener) return;

  widget.addEventListener("store-selected", function (event) {
    window.parent.postMessage({ type: "MAPVX_STORE_SELECTED", payload: event.detail }, "*");
  });
})();

if (window.MAPVX_CONFIG) {
  applyMapvxConfig(window.MAPVX_CONFIG);
}

window.addEventListener("DOMContentLoaded", function () {
  var frame = document.getElementById("mapvx-map-frame");
  if (!frame) return;
  try {
    var raw = sessionStorage.getItem(MAPVX_TEST_CONFIG_KEY);
    if (raw) {
      window.MAPVX_CONFIG = Object.assign(window.MAPVX_CONFIG || {}, JSON.parse(raw));
    }
  } catch (e) {}
  if (window.MAPVX_CONFIG && frame.contentWindow) {
    applyMapvxConfig(window.MAPVX_CONFIG);
  }
});