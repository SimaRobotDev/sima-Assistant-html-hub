(function () {
  function syncMapvxConfigToIframe(cfg, targetOrigin) {
    var iframe = document.getElementById("mapvx-frame");
    if (!iframe || !iframe.contentWindow) return false;

    try {
      iframe.contentWindow.MAPVX_CONFIG = Object.assign({}, cfg || {});
    } catch (e) {
      // Cross-origin iframe can still receive the config via postMessage.
    }

    iframe.contentWindow.postMessage({ type: "MAPVX_CONFIG", payload: cfg || {} }, targetOrigin || "*");
    return true;
  }

  function insertMapvxIframe(opts) {
    opts = opts || {};
    var existing = document.getElementById("mapvx-frame");
    if (existing) return existing;

    var iframe = document.createElement("iframe");
    iframe.id = "mapvx-frame";
    iframe.src = opts.src || "../mapvx-embed/index.html";
    iframe.title = opts.title || "Mapa interactivo";
    iframe.style.width = opts.width || "100%";
    iframe.style.height = opts.height || "400px";
    iframe.style.border = "none";
    iframe.loading = opts.loading || "lazy";
    iframe.sandbox = opts.sandbox || "allow-scripts allow-same-origin";

    var container = opts.container ? document.querySelector(opts.container) : null;
    (container || document.body).appendChild(iframe);
    return iframe;
  }

  function bootstrapMapvxIframe(cfg, opts) {
    opts = opts || {};
    var iframe = insertMapvxIframe(opts);
    if (!iframe) return false;

    var targetOrigin = opts.targetOrigin || "*";
    var sendConfig = function () {
      syncMapvxConfigToIframe(cfg, targetOrigin);
    };

    if (iframe.contentWindow && iframe.contentDocument && iframe.contentDocument.readyState === "complete") {
      sendConfig();
    } else {
      iframe.addEventListener("load", sendConfig, { once: true });
    }

    return iframe;
  }

  function sendToMapVX(type, payload, targetOrigin) {
    var iframe = document.getElementById("mapvx-frame");
    if (!iframe || !iframe.contentWindow) return false;
    iframe.contentWindow.postMessage({ type: type, payload: payload }, targetOrigin || "*");
    return true;
  }

  window.addEventListener("message", function (ev) {
    var data = ev.data || {};
    if (data.type === "MAPVX_STORE_SELECTED") {
      window.dispatchEvent(new CustomEvent("mapvx-store-selected", { detail: data.payload }));
    }
  });

  window.MapvxEmbedHelper = {
    bootstrapMapvxIframe: bootstrapMapvxIframe,
    insertMapvxIframe: insertMapvxIframe,
    syncMapvxConfigToIframe: syncMapvxConfigToIframe,
    sendToMapVX: sendToMapVX
  };
})();