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

  global.SimaLocale = {
    resolveLocale: resolveLocale,
    readLocaleFromPage: readLocaleFromPage,
    pickPack: pickPack,
    t: t
  };
})(window);
