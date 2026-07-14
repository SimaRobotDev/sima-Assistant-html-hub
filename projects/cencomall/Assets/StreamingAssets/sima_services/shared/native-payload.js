/**
 * Normalizes messages from React Native / Unity before page handlers run.
 */
window.SimaNativePayload = (function () {
  var SEARCH_TYPES = {
    market_search: true,
    promotion_search: true,
    services_search: true,
    parking_info: true,
  };

  var TYPE_ALIASES = {
    search_store: "market_search",
    store_search: "market_search",
    search: "market_search",
    voice_search: "market_search",
    marketsearch: "market_search",
    search_promotion: "promotion_search",
    search_promotions: "promotion_search",
    search_service: "services_search",
    search_services: "services_search",
    parking: "parking_info",
  };

  function tryParseJson(value) {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch (e) {
      return value;
    }
  }

  function mergeObjects(base, extra) {
    var out = {};
    var k;
    if (base && typeof base === "object") {
      for (k in base) {
        if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
      }
    }
    if (extra && typeof extra === "object") {
      for (k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
      }
    }
    return out;
  }

  function normalizeType(raw) {
    var type = String(raw || "").toLowerCase().trim();
    if (!type) return "";
    if (TYPE_ALIASES[type]) return TYPE_ALIASES[type];
    return type;
  }

  function extractSearchQuery(data) {
    if (!data || typeof data !== "object") return "";
    return String(
      data.query
      || data.text
      || data.q
      || data.search
      || data.searchQuery
      || data.search_query
      || data.searchText
      || data.search_text
      || data.voiceText
      || data.voice_text
      || data.transcript
      || data.utterance
      || data.spokenText
      || data.spoken_text
      || data.input
      || data.term
      || data.keyword
      || ""
    ).trim();
  }

  function normalize(data) {
    var parsed = tryParseJson(data);
    if (parsed == null) return null;
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return parsed;
    }

    var out = mergeObjects({}, parsed);

    if (out.data && typeof out.data === "object" && !Array.isArray(out.data)) {
      out = mergeObjects(out.data, out);
    }

    if (out.payload != null) {
      var payload = tryParseJson(out.payload);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        out = mergeObjects(payload, out);
      }
    }

    if (out.extra != null) {
      var extra = tryParseJson(out.extra);
      if (extra && typeof extra === "object" && !Array.isArray(extra)) {
        out = mergeObjects(extra, out);
      } else if (typeof extra === "string" && extra.trim()) {
        out.extraText = extra.trim();
      }
    }

    if (out.message && typeof out.message === "object" && !Array.isArray(out.message)) {
      out = mergeObjects(out.message, out);
    }

    if (!out.type && out.command) out.type = out.command;
    if (!out.type && out.action) out.type = out.action;
    if (!out.type && out.intent) out.type = out.intent;

    out.type = normalizeType(out.type);

    var query = extractSearchQuery(out);
    if (!query && out.extraText) query = out.extraText;

    if (!out.type && query) {
      out.type = "market_search";
    }

    if (query) {
      out.query = query;
      if (!out.text) out.text = query;
    }

    return out;
  }

  function isSearchPayload(data) {
    if (!data || typeof data !== "object") return false;
    var type = normalizeType(data.type);
    if (SEARCH_TYPES[type]) return true;
    return !!extractSearchQuery(data);
  }

  return {
    normalize: normalize,
    extractSearchQuery: extractSearchQuery,
    isSearchPayload: isSearchPayload,
  };
})();
