(function (global) {
  var MIC_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/>' +
    "</svg>";

  function renderQr(containerId, url, size) {
    var el = document.getElementById(containerId);
    if (!el || !url || typeof QRCode === "undefined") return;
    el.innerHTML = "";
    new QRCode(el, {
      text: url,
      width: size || 128,
      height: size || 128,
      colorDark: "#1a1a1a",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M,
    });
  }

  function mountTalkBar() {
    if (document.getElementById("talkBar")) return;

    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "talkBar";
    btn.className = "talk-bar";
    btn.setAttribute("aria-label", "Haz tu consulta aquí");
    btn.innerHTML =
      '<span class="talk-bar-icon">' +
      MIC_SVG +
      '</span><span class="talk-bar-label">Haz tu consulta aquí</span>';

    btn.addEventListener("click", function () {
      if (global.SimaBridge) {
        global.SimaBridge.start_stt();
      }
    });

    document.body.appendChild(btn);
  }

  function initFragmentPage(options) {
    options = options || {};
    var screenName = options.screenName || "fragment";
    var welcomeText = options.welcomeText || "";

    mountTalkBar();

    if (global.SimaBridge) {
      global.SimaBridge.ready(screenName);
      global.SimaBridge.setMicVisible(true);
      if (welcomeText) {
        global.SimaBridge.speak(welcomeText);
      }
    }
  }

  global.SimaFragment = {
    renderQr: renderQr,
    mountTalkBar: mountTalkBar,
    initFragmentPage: initFragmentPage,
  };
})(window);

