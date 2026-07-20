window.SimaBridge = window.SimaBridge || {};

(function (global) {
  var bridge = global.SimaBridge;

  function safeString(value) {
    if (value === undefined || value === null) return "";
    return String(value);
  }

  function tryParse(raw) {
    if (typeof raw !== "string") return raw;
    try {
      var parsed = JSON.parse(raw);
      if (typeof parsed === "string") {
        try {
          return JSON.parse(parsed);
        } catch (nestedError) {
          return parsed;
        }
      }
      return parsed;
    } catch (error) {
      return raw;
    }
  }

  function isReactNativeHost() {
    return !!(
      global.ReactNativeWebView
      && typeof global.ReactNativeWebView.postMessage === "function"
    );
  }

  function isLegacyWebViewHost() {
    try {
      if (global.SIMA_FORCE_UNIWEBVIEW === true) return true;
      return String(global.location && global.location.protocol || "") === "file:";
    } catch (error) {
      return false;
    }
  }

  function canReachNativeHost() {
    return isReactNativeHost() || isLegacyWebViewHost();
  }

  function extractMessageEventData(event) {
    if (!event) return null;
    if (event.data != null && event.data !== "") return event.data;
    if (event.nativeEvent && event.nativeEvent.data != null && event.nativeEvent.data !== "") {
      return event.nativeEvent.data;
    }
    return null;
  }

  function hideNode(node, visible) {
    if (!node) return;
    if (node.classList && node.classList.toggle) {
      node.classList.toggle("talk-hidden", !visible);
    }
    if (node.style) {
      node.style.display = visible ? "" : "none";
    }
  }

  function sendMessage(type, payload) {
    var message = {
      type: type,
      command: type,
      payload: payload || {},
    };

    bridge.__lastMessage = message;
    bridge.__lastSendChannel = "none";
    var serialized = JSON.stringify(message);
    var sent = false;

    // React Native WebView (react-native-webview)
    try {
      if (global.ReactNativeWebView && typeof global.ReactNativeWebView.postMessage === "function") {
        global.ReactNativeWebView.postMessage(serialized);
        sent = true;
        bridge.__lastSendChannel = "react-native";
      }
    } catch (error) {
      sent = false;
    }

    if (sent) return true;

    if (!isLegacyWebViewHost()) {
      if (global.console && global.console.warn) {
        global.console.warn("SimaBridge: no native host for message type=" + type);
      }
      return false;
    }

    // Legacy UniWebView / Unity iframe channel
    var encoded = encodeURIComponent(serialized);
    var url = "uniwebview://message?data=" + encoded;

    try {
      if (global.document && global.document.body && global.document.createElement) {
        var iframe = global.document.createElement("iframe");
        iframe.style.display = "none";
        iframe.setAttribute("aria-hidden", "true");
        iframe.src = url;
        global.document.body.appendChild(iframe);
        global.setTimeout(function () {
          try {
            if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
          } catch (ignore) {}
        }, 120);
        sent = true;
        bridge.__lastSendChannel = "uniwebview";
      }
    } catch (error) {
      sent = false;
    }

    if (!sent) {
      try {
        global.location.href = url;
        sent = true;
        bridge.__lastSendChannel = "location";
      } catch (fallbackError) {
        if (global.console && global.console.error) {
          global.console.error("SimaBridge send failed", fallbackError);
        }
      }
    }

    return sent;
  }

  bridge.send = function (type, payload) {
    return sendMessage(type, payload);
  };

  bridge.ready = function (screenName) {
    return bridge.send("web_ready", {
      screen: safeString(screenName),
      host: isReactNativeHost() ? "react-native" : "legacy",
    });
  };

  bridge.log = function (text) {
    return bridge.send("web_log", { message: safeString(text) });
  };

  bridge.requestClose = function () {
    return bridge.send("close_webview", {});
  };

  bridge.speak = function (text) {
    return bridge.send("avatar_speak", { text: safeString(text) });
  };

  bridge.animate = function (state) {
    return bridge.send("avatar_anim", { state: safeString(state) });
  };

  bridge.start_stt = function (payload) {
    return bridge.send("start_stt", payload || {});
  };

  bridge.startSTT = function () {
    return bridge.start_stt();
  };

  bridge.loadUrl = function (url, speakText) {
    return bridge.send("load_url", {
      url: safeString(url),
      text: safeString(speakText),
    });
  };

  bridge.setMicVisible = function (visible) {
    var shouldShow = !!visible;
    var selectors = [
      "#talkBar",
      "#micBar",
      ".talk-bar-inline",
      "[data-sima-mic]",
    ];
    var nodes = [];
    var i;

    if (global.document && global.document.querySelectorAll) {
      for (i = 0; i < selectors.length; i++) {
        var found = global.document.querySelectorAll(selectors[i]);
        if (found && found.length) {
          for (var j = 0; j < found.length; j++) nodes.push(found[j]);
        }
      }
    }

    for (i = 0; i < nodes.length; i++) {
      hideNode(nodes[i], shouldShow);
    }
  };

  bridge.isReactNativeHost = isReactNativeHost;
  bridge.isLegacyWebViewHost = isLegacyWebViewHost;
  bridge.canReachNativeHost = canReachNativeHost;
  bridge.getLastSendChannel = function () {
    return bridge.__lastSendChannel || "none";
  };

  bridge.pushNativeSearch = function (queryOrPayload) {
    return bridge.onNativeData(queryOrPayload);
  };

  global.receiveNativeSearch = function (queryOrPayload) {
    return bridge.pushNativeSearch(queryOrPayload);
  };

  global.pushNativeSearch = global.receiveNativeSearch;

  bridge.onUnityData = function (raw) {
    var data = tryParse(raw);

    // RN bridge envelope echo: { type, payload: { ... } }
    if (data && typeof data === "object" && data.payload != null && typeof data.payload !== "object") {
      data.payload = tryParse(data.payload);
    }

    if (global.SimaNativePayload && global.SimaNativePayload.normalize) {
      data = global.SimaNativePayload.normalize(data);
    }

    var deferredLocale = null;

    if (global.SimaLocale && data && typeof data === "object") {
      if (global.SimaLocale.isLocaleCommand && global.SimaLocale.isLocaleCommand(data)) {
        global.SimaLocale.setLocale(
          global.SimaLocale.extractLocaleFromPayload(data) || "es"
        );
      } else if (global.SimaLocale.extractLocaleFromPayload) {
        var localeHint = global.SimaLocale.extractLocaleFromPayload(data);
        if (localeHint != null) {
          var isSearch = global.SimaNativePayload
            && global.SimaNativePayload.isSearchPayload
            && global.SimaNativePayload.isSearchPayload(data);
          if (isSearch) {
            global.SimaLocale.setLocale(localeHint);
            deferredLocale = null;
          } else {
            global.SimaLocale.setLocale(localeHint);
          }
        }
      }
    }

    if (typeof global.handleUnityData === "function") {
      try {
        global.handleUnityData(data);
      } catch (error) {
        if (global.console && global.console.error) {
          global.console.error("handleUnityData failed", error);
        }
      }
    }

    if (deferredLocale != null && global.SimaLocale && global.SimaLocale.setLocale) {
      global.SimaLocale.setLocale(deferredLocale);
    }

    if (typeof global.handleUnityCommand === "function") {
      try {
        if (data && typeof data.command !== "undefined") {
          global.handleUnityCommand(data.command, data);
        } else if (data && typeof data.type === "string") {
          global.handleUnityCommand(data.type, data);
        }
      } catch (commandError) {
        if (global.console && global.console.error) {
          global.console.error("handleUnityCommand failed", commandError);
        }
      }
    }

    return data;
  };

  // Alias for React Native / native hosts (onUnityData name is legacy from Unity).
  bridge.onNativeData = bridge.onUnityData;
  bridge.receiveNativeMessage = bridge.onUnityData;

  function bindNativeMessageListener() {
    if (global.__simaNativeMessageBound) return;
    global.__simaNativeMessageBound = true;
    function onMessage(event) {
      var raw = extractMessageEventData(event);
      if (raw == null || raw === "") return;
      if (typeof raw === "object") {
        try {
          raw = JSON.stringify(raw);
        } catch (stringifyError) {
          return;
        }
      }
      try {
        bridge.onNativeData(raw);
      } catch (error) {
        if (global.console && global.console.error) {
          global.console.error("SimaBridge native message failed", error);
        }
      }
    }
    if (typeof global.window !== "undefined" && typeof global.window.addEventListener === "function") {
      global.window.addEventListener("message", onMessage);
    }
    if (global.document && typeof global.document.addEventListener === "function") {
      global.document.addEventListener("message", onMessage);
    }
    if (typeof global.addEventListener === "function") {
      global.addEventListener("message", onMessage);
    }
  }

  bindNativeMessageListener();
})(window);

