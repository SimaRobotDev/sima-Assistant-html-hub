/**
 * Client-side store search over market-catalog.json (Cenco Costanera API Market).
 */
window.MarketSearch = (function () {
  var catalog = null;
  var loadPromise = null;
  var indexed = null;
  var localBrandIndex = null;

  function catalogUrl() {
    var base = window.MARKET_CATALOG_BASE || "../data/";
    if (base.charAt(base.length - 1) !== "/") base += "/";
    return base + (window.MARKET_CATALOG_FILE || "market-catalog.json");
  }

  function normalizeText(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenizeQuery(query) {
    var normalized = normalizeText(query);
    if (!normalized) return [];
    return normalized.split(" ").filter(function (token) {
      return token.length > 0;
    });
  }

  function formatFloorFromLevels(levels) {
    if (!levels || !levels.length) return "";
    var level = String(levels[0] || "").trim();
    if (!level) return "";
    if (/^pb$/i.test(level)) return "Planta Baja";
    if (/^\d+$/.test(level)) return "Nivel " + level;
    return level;
  }

  function isAvailable(item) {
    if (!item) return true;
    var renovation = item.renovation;
    return renovation !== 1 && renovation !== "1" && renovation !== true;
  }

  function mapCatalogEntry(item) {
    var brand = String(item.brand_name || "").trim();
    var marketName = String(item.market_name || "").trim();
    return {
      id: String(item.id != null ? item.id : ""),
      name: brand || marketName || "Tienda",
      brand: brand || marketName,
      marketName: marketName,
      floor: formatFloorFromLevels(item.market_levels),
      category: String(
        item.brand_categories
        || (item.brand_level1_categories && item.brand_level1_categories[0])
        || ""
      ).trim(),
      local: String(item.local || "").trim(),
      logoUrl: String(item.brand_logo || "").trim(),
      brand_logo: String(item.brand_logo || "").trim(),
      description: String(item.brand_description || "").trim(),
      keywords: String(item.keywords || "").trim(),
      mall: String(item.mall || "").trim(),
      available: isAvailable(item),
      schedules: item.market_schedules || [],
      website: String(item.brand_website || "").trim(),
      source: "market-catalog",
    };
  }

  function buildSearchBlob(entry) {
    return normalizeText([
      entry.id,
      entry.local,
      entry.name,
      entry.brand,
      entry.marketName,
      entry.category,
      entry.keywords,
      entry.description,
    ].join(" "));
  }

  function buildIndex(entries) {
    return entries.map(function (entry) {
      return {
        entry: entry,
        blob: buildSearchBlob(entry),
        brandKey: normalizeText(entry.brand || entry.name),
      };
    });
  }

  function buildLocalBrandIndex(entries) {
    var index = {};
    (entries || []).forEach(function (entry) {
      var local = String(entry.local || "").trim().toUpperCase();
      var brand = String(entry.brand || entry.name || "").trim();
      if (!local || !brand) return;
      index[local] = brand;
    });
    return index;
  }

  function getBrandByLocal(localCode) {
    if (!localCode) return "";
    if (!localBrandIndex) return "";
    var key = String(localCode).trim().toUpperCase();
    return localBrandIndex[key] || "";
  }

  function scoreEntry(indexedEntry, queryNorm, tokens) {
    var entry = indexedEntry.entry;
    var blob = indexedEntry.blob;
    var score = 0;

    if (!queryNorm) return 0;

    if (entry.local && normalizeText(entry.local) === queryNorm) score += 1200;
    if (entry.id && normalizeText(entry.id) === queryNorm) score += 1100;

    var brandNorm = normalizeText(entry.brand || entry.name);
    if (brandNorm === queryNorm) score += 1000;
    if (brandNorm && brandNorm.indexOf(queryNorm) === 0) score += 850;
    if (brandNorm && queryNorm.indexOf(brandNorm) === 0) score += 800;

    var keywordList = normalizeText(entry.keywords).split(",").map(function (k) {
      return k.trim();
    }).filter(Boolean);

    keywordList.forEach(function (keyword) {
      if (keyword === queryNorm) score += 750;
      else if (keyword.indexOf(queryNorm) === 0) score += 650;
      else if (keyword.indexOf(queryNorm) >= 0) score += 500;
    });

    if (blob.indexOf(queryNorm) >= 0) score += 300;

    if (!tokens.length) return score;

    var matchedTokens = 0;
    tokens.forEach(function (token) {
      if (!token) return;
      if (entry.local && normalizeText(entry.local).indexOf(token) >= 0) {
        score += 400;
        matchedTokens += 1;
        return;
      }
      if (brandNorm === token) {
        score += 350;
        matchedTokens += 1;
        return;
      }
      if (keywordList.some(function (keyword) {
        return keyword === token || keyword.indexOf(token) >= 0;
      })) {
        score += 280;
        matchedTokens += 1;
        return;
      }
      if (blob.indexOf(token) >= 0) {
        score += 120;
        matchedTokens += 1;
      }
    });

    if (matchedTokens < tokens.length) return 0;
    if (matchedTokens === tokens.length) score += 80 * tokens.length;
    return score;
  }

  function groupByBrand(matches) {
    var groups = {};
    var order = [];

    matches.forEach(function (match) {
      var key = normalizeText(match.entry.brand || match.entry.name) || match.entry.id || match.entry.local;
      if (!groups[key]) {
        groups[key] = {
          entries: [],
          score: 0,
        };
        order.push(key);
      }
      groups[key].entries.push(match.entry);
      groups[key].score = Math.max(groups[key].score, match.score);
    });

    return order.map(function (key) {
      return groups[key];
    }).sort(function (a, b) {
      return b.score - a.score;
    });
  }

  function toResultCard(group) {
    var entries = group.entries;
    if (!entries.length) return null;

    if (entries.length === 1) {
      return entries[0];
    }

    var head = entries[0];
    return {
      isGroup: true,
      id: head.id,
      name: head.brand || head.name,
      brand: head.brand || head.name,
      category: head.category,
      logoUrl: head.logoUrl,
      brand_logo: head.brand_logo,
      description: head.description,
      keywords: head.keywords,
      available: entries.some(function (e) { return e.available !== false; }),
      locationCount: entries.length,
      locations: entries.map(function (entry) {
        return {
          id: entry.id,
          name: entry.marketName || entry.name,
          floor: entry.floor,
          local: entry.local,
          available: entry.available,
          category: entry.category,
          logoUrl: entry.logoUrl,
          brand_logo: entry.brand_logo,
        };
      }),
      _searchScore: group.score,
    };
  }

  function loadCatalog() {
    if (catalog) return Promise.resolve(catalog);
    if (loadPromise) return loadPromise;

    loadPromise = fetch(catalogUrl(), { cache: "no-cache" })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("market catalog HTTP " + response.status);
        }
        return response.json();
      })
      .then(function (data) {
        if (!Array.isArray(data)) {
          throw new Error("market catalog must be an array");
        }
        catalog = data.map(mapCatalogEntry);
        indexed = buildIndex(catalog);
        localBrandIndex = buildLocalBrandIndex(catalog);
        return catalog;
      })
      .catch(function (error) {
        loadPromise = null;
        throw error;
      });

    return loadPromise;
  }

  function search(query, options) {
    options = options || {};
    var limit = options.limit != null ? Number(options.limit) : 30;
    if (!isFinite(limit) || limit <= 0) limit = 30;

    if (!indexed || !indexed.length) {
      return { query: query, results: [], totalMatches: 0, catalogLoaded: false };
    }

    var queryNorm = normalizeText(query);
    var tokens = tokenizeQuery(query);
    if (!queryNorm) {
      return { query: query, results: [], totalMatches: 0, catalogLoaded: true };
    }

    var matches = [];
    indexed.forEach(function (indexedEntry) {
      var score = scoreEntry(indexedEntry, queryNorm, tokens);
      if (score > 0) {
        matches.push({ entry: indexedEntry.entry, score: score });
      }
    });

    matches.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.entry.name).localeCompare(String(b.entry.name), "es");
    });

    var grouped = groupByBrand(matches);
    var results = grouped
      .map(toResultCard)
      .filter(Boolean)
      .slice(0, limit);

    return {
      query: query,
      results: results,
      totalMatches: matches.length,
      catalogLoaded: true,
      catalogSize: catalog ? catalog.length : 0,
    };
  }

  function isReady() {
    return !!(catalog && indexed);
  }

  function getCatalogSize() {
    return catalog ? catalog.length : 0;
  }

  return {
    loadCatalog: loadCatalog,
    search: search,
    isReady: isReady,
    getCatalogSize: getCatalogSize,
    getBrandByLocal: getBrandByLocal,
    normalizeText: normalizeText,
    catalogUrl: catalogUrl,
  };
})();
