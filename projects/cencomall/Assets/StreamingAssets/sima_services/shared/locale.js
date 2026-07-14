(function(global) {
  function resolveLocale(raw) {
    const value = String(raw || "es").toLowerCase().trim();
    if (value.startsWith("en")) return "en";
    if (value.startsWith("pt")) return "pt";
    return "es";
  }

  function readLocaleFromPage() {
    const params = new URLSearchParams(window.location.search);
    return resolveLocale(window.MALL_LOCALE || params.get("locale") || "es");
  }

  function pickPack(packs, locale) {
    const order = locale === "pt"
      ? ["pt", "en", "es"]
      : locale === "en"
        ? ["en", "es"]
        : ["es", "en"];
    for (let i = 0; i < order.length; i++) {
      const pack = packs[order[i]];
      if (pack) return pack;
    }
    return packs.es || packs.en || {};
  }

  function t(packs, key, locale) {
    const pack = pickPack(packs, resolveLocale(locale || readLocaleFromPage()));
    const value = pack[key];
    if (typeof value === "function") return value();
    if (value !== undefined && value !== null) return value;
    const fallback = packs.es && packs.es[key];
    return typeof fallback === "function" ? fallback() : (fallback || key);
  }

  function extractLocaleFromPayload(data) {
    if (!data || typeof data !== "object") return null;
    if (data.language != null && String(data.language).trim()) return data.language;
    if (data.locale != null && String(data.locale).trim()) return data.locale;
    if (data.lang != null && String(data.lang).trim()) return data.lang;
    return null;
  }

  function setLocale(raw) {
    var next = resolveLocale(raw);
    var prev = resolveLocale(window.MALL_LOCALE || readLocaleFromPage());
    window.MALL_LOCALE = next;
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.lang = next;
    }
    if (typeof global.onSimaLocaleChange === "function") {
      try { global.onSimaLocaleChange(next, prev); } catch (e) { /* noop */ }
    }
    try {
      if (typeof global.CustomEvent === "function") {
        global.dispatchEvent(new global.CustomEvent("sima:localechange", {
          detail: { locale: next, previous: prev },
        }));
      }
    } catch (e2) { /* noop */ }
    return next;
  }

  function isLocaleCommand(data) {
    if (!data || typeof data !== "object") return false;
    var type = String(data.type || data.command || "").toLowerCase();
    return type === "set_locale" || type === "locale_change" || type === "language_change";
  }

  function bindPageLocale(applyFn) {
    if (typeof applyFn !== "function") return;
    global.onSimaLocaleChange = applyFn;
    global.handleUnityCommand = function (command, data) {
      var cmd = String(command || "").toLowerCase();
      if (cmd === "set_locale" || cmd === "locale_change" || cmd === "language_change") {
        setLocale(extractLocaleFromPayload(data) || "es");
      }
    };
  }

  function bootstrapLocale() {
    var initial = readLocaleFromPage();
    window.MALL_LOCALE = initial;
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.lang = initial;
    }
    return initial;
  }

  global.SimaLocale = {
    resolveLocale: resolveLocale,
    readLocaleFromPage: readLocaleFromPage,
    pickPack: pickPack,
    t: t,
    extractLocaleFromPayload: extractLocaleFromPayload,
    setLocale: setLocale,
    isLocaleCommand: isLocaleCommand,
    bindPageLocale: bindPageLocale,
    bootstrapLocale: bootstrapLocale,
  };

  bootstrapLocale();
})(window);
