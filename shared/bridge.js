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

    var encoded = encodeURIComponent(JSON.stringify(message));
    var url = "uniwebview://message?data=" + encoded;
    var sent = false;

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

    if (typeof global.handleUnityData === "function") {
      try {
        global.handleUnityData(data);
      } catch (error) {
        if (global.console && global.console.error) {
          global.console.error("handleUnityData failed", error);
        }
      }
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
})(window);

