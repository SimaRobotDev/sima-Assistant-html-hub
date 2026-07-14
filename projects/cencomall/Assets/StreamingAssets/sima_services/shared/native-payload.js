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
    open_store_navigation: "market_search",
    open_navigation: "market_search",
    open_search: "market_search",
    store_navigation: "market_search",
    navigation_search: "market_search",
    stt_result: "market_search",
    speech_result: "market_search",
    speech_recognized: "market_search",
    voice_input: "market_search",
    voice_transcript: "market_search",
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

  function looksLikeTtsResponse(text) {
    var value = String(text || "").trim();
    if (!value) return true;
    if (value.length > 120) return true;
    return /^(te muestro|te llevo|aqui tienes|aquí tienes|claro|perfecto|encontre|encontré|encontrei|voy a|sure|here you|i found|vou te|i'll show|let me show)/i.test(value);
  }

  function pickQueryString(value) {
    if (typeof value !== "string") return "";
    var text = value.trim();
    if (!text || looksLikeTtsResponse(text)) return "";
    return text;
  }

  function extractSearchQuery(data) {
    if (!data || typeof data !== "object") return "";
    if (data.args && typeof data.args === "object" && !Array.isArray(data.args)) {
      var fromArgs = extractSearchQuery(data.args);
      if (fromArgs) return fromArgs;
    }
    if (data.parameters && typeof data.parameters === "object" && !Array.isArray(data.parameters)) {
      var fromParams = extractSearchQuery(data.parameters);
      if (fromParams) return fromParams;
    }

    var direct = String(
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
      || data.transcription
      || data.utterance
      || data.spokenText
      || data.spoken_text
      || data.speechText
      || data.speech_text
      || data.recognition
      || data.recognitionResult
      || data.recognition_result
      || data.speechResult
      || data.speech_result
      || data.userInput
      || data.user_input
      || data.input
      || data.term
      || data.keyword
      || data.value
      || data.stt
      || data.content
      || data.body
      || (typeof data.extra === "string" ? data.extra : "")
      || ""
    ).trim();

    if (direct) return direct;

    return (
      pickQueryString(data.result)
      || pickQueryString(data.message)
      || ""
    );
  }

  function normalize(data) {
    var parsed = tryParseJson(data);
    if (parsed == null) return null;

    if (Array.isArray(parsed)) {
      if (parsed.length === 1 && parsed[0] && typeof parsed[0] === "object") {
        parsed = parsed[0];
      } else {
        return parsed;
      }
    }

    if (typeof parsed !== "object") {
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

    if (out.args != null) {
      var args = tryParseJson(out.args);
      if (args && typeof args === "object" && !Array.isArray(args)) {
        out = mergeObjects(args, out);
      }
    }

    if (out.parameters != null) {
      var parameters = tryParseJson(out.parameters);
      if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) {
        out = mergeObjects(parameters, out);
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
