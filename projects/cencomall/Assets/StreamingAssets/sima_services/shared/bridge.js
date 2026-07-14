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
      return JSON.parse(raw);
    } catch (error) {
      return raw;
    }
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
      payload: payload || {},
    };

    bridge.__lastMessage = message;
    var serialized = JSON.stringify(message);
    var sent = false;

    // React Native WebView (react-native-webview)
    try {
      if (global.ReactNativeWebView && typeof global.ReactNativeWebView.postMessage === "function") {
        global.ReactNativeWebView.postMessage(serialized);
        sent = true;
      }
    } catch (error) {
      sent = false;
    }

    if (sent) return true;

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
      }
    } catch (error) {
      sent = false;
    }

    if (!sent) {
      try {
        global.location.href = url;
        sent = true;
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
    return bridge.send("web_ready", { screen: safeString(screenName) });
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

  bridge.start_stt = function () {
    return bridge.send("start_stt", {});
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

  bridge.onUnityData = function (raw) {
    var data = tryParse(raw);

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
      if (!event || event.data == null || event.data === "") return;
      try {
        bridge.onNativeData(event.data);
      } catch (error) {
        if (global.console && global.console.error) {
          global.console.error("SimaBridge native message failed", error);
        }
      }
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

