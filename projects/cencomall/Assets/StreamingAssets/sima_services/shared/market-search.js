/**
 * Client-side store search over market-catalog.json (Cenco Costanera API Market).
 */
window.MarketSearch = (function () {
  var catalog = null;
  var loadPromise = null;
  var indexed = null;
  var localBrandIndex = null;

  function catalogBase() {
    var base = window.MARKET_CATALOG_BASE || "../data/";
    if (base.charAt(base.length - 1) !== "/") base += "/";
    return base;
  }

  function catalogUrl() {
    return catalogBase() + (window.MARKET_CATALOG_FILE || "market-catalog.json");
  }

  function catalogJsonpUrl() {
    return catalogBase() + (window.MARKET_CATALOG_JSONP_FILE || "market-catalog.jsonp.js");
  }

  // Android WebView blocks fetch()/XHR on file:// URLs ("URL scheme file is
  // not supported"), but <script src> works. This injects a companion JS file
  // that assigns the catalog array to a global, so local loads keep working.
  function loadJsonViaScript(url, globalName) {
    return new Promise(function (resolve, reject) {
      if (window[globalName] != null) {
        resolve(window[globalName]);
        return;
      }
      var script = document.createElement("script");
      script.async = true;
      script.src = url;
      script.onload = function () {
        if (window[globalName] != null) resolve(window[globalName]);
        else reject(new Error("catalog jsonp loaded but global missing: " + globalName));
      };
      script.onerror = function () {
        reject(new Error("catalog jsonp failed to load: " + url));
      };
      (document.head || document.documentElement).appendChild(script);
    });
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

  // Token matching skips long descriptions to avoid city-name noise
  // (e.g. "paris" in "parisino", "falabella" in travel copy).
  function buildTokenBlob(entry) {
    return normalizeText([
      entry.id,
      entry.local,
      entry.name,
      entry.brand,
      entry.marketName,
      entry.category,
      entry.keywords,
    ].join(" "));
  }

  function buildIndex(entries) {
    return entries.map(function (entry) {
      return {
        entry: entry,
        blob: buildSearchBlob(entry),
        tokenBlob: buildTokenBlob(entry),
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

  // Word-aware match to avoid substring false positives
  // (e.g. "puma" must not match "espumante" / "espumador").
  // Returns exactPts if some word equals the term, prefixPts if some word
  // starts with the term (min length 3), otherwise 0.
  function wordScore(text, term, exactPts, prefixPts) {
    if (!text || !term) return 0;
    var words = text.split(" ");
    var prefixHit = 0;
    for (var i = 0; i < words.length; i++) {
      var word = words[i];
      if (!word) continue;
      if (word === term) return exactPts;
      if (term.length >= 3 && word.indexOf(term) === 0) {
        var rest = word.slice(term.length);
        // Allow short suffixes only (plural / light inflection), not "paris" → "parisino".
        if (!rest || rest.length <= 2) prefixHit = prefixPts;
      }
    }
    return prefixHit;
  }

  function brandContainsToken(brandNorm, token) {
    return wordScore(brandNorm, token, 1, 1) > 0;
  }

  function parseKeywordList(rawKeywords) {
    return String(rawKeywords || "")
      .split(",")
      .map(function (keyword) {
        return normalizeText(keyword);
      })
      .filter(Boolean);
  }

  function isSneakerIntentToken(token) {
    var t = normalizeText(token);
    if (!t) return false;
    return (
      t === "zapatillas" ||
      t === "zapatilla" ||
      t === "sneakers" ||
      t === "sneaker" ||
      t === "calzado" ||
      t === "nike" ||
      t === "adidas" ||
      t === "puma" ||
      t === "reebok" ||
      t === "converse" ||
      t === "vans" ||
      t === "asics" ||
      t === "fila" ||
      t === "newbalance" ||
      t === "new" ||
      t === "balance" ||
      t === "skechers" ||
      t === "jordan" ||
      t === "umbro"
    );
  }

  function entryHasSneakerContext(entry, keywordList) {
    var categoryNorm = normalizeText(entry && entry.category);
    var categoryMatch =
      categoryNorm.indexOf("calzado") >= 0 ||
      categoryNorm.indexOf("deportes") >= 0 ||
      categoryNorm.indexOf("outdoor") >= 0;
    if (categoryMatch) return true;

    var kwBlob = (keywordList || []).join(" ");
    return (
      kwBlob.indexOf("zapatilla") >= 0 ||
      kwBlob.indexOf("sneaker") >= 0 ||
      kwBlob.indexOf("running") >= 0 ||
      kwBlob.indexOf("trekking") >= 0 ||
      kwBlob.indexOf("futbol") >= 0 ||
      kwBlob.indexOf("basket") >= 0 ||
      kwBlob.indexOf("deporte") >= 0
    );
  }

  function parseCategoryList(rawCategories) {
    var seen = {};
    var list = [];
    String(rawCategories || "")
      .split(",")
      .forEach(function (part) {
        var name = String(part || "").trim();
        if (!name) return;
        var key = normalizeText(name);
        if (!key || seen[key]) return;
        seen[key] = true;
        list.push({ key: key, name: name });
      });
    return list;
  }

  function entryMatchesCategory(entry, categoryKey) {
    if (!entry || !categoryKey) return false;
    return parseCategoryList(entry.category).some(function (cat) {
      return cat.key === categoryKey;
    });
  }

  function scoreEntry(indexedEntry, queryNorm, tokens) {
    var entry = indexedEntry.entry;
    var blob = indexedEntry.blob;
    var tokenBlob = indexedEntry.tokenBlob || blob;
    var score = 0;

    if (!queryNorm) return 0;

    if (entry.available === false) score -= 60;

    var queryCompact = queryNorm.replace(/ /g, "");
    var localNorm = normalizeText(entry.local);
    if (localNorm && localNorm === queryNorm) score += 1200;
    if (entry.id && normalizeText(entry.id) === queryNorm) score += 1100;

    var brandNorm = normalizeText(entry.brand || entry.name);
    var brandCompact = brandNorm.replace(/ /g, "");

    var brandScore = 0;
    if (brandNorm === queryNorm) brandScore = 1000;
    else if (brandCompact && brandCompact === queryCompact) brandScore = 950;
    else if (brandNorm && brandNorm.indexOf(queryNorm + " ") === 0) brandScore = 850;
    else if (
      brandCompact &&
      queryCompact.length >= 3 &&
      brandCompact.indexOf(queryCompact) === 0
    ) brandScore = 780;
    else if (queryNorm.indexOf(brandNorm + " ") === 0) brandScore = 700;

    if (brandScore >= 700) return score + brandScore + 200;

    var keywordList = parseKeywordList(entry.keywords);
    var sneakerIntentQuery = tokens.some(isSneakerIntentToken);
    var sneakerContextEntry = entryHasSneakerContext(entry, keywordList);

    if (queryNorm.indexOf(" ") >= 0 && blob.indexOf(queryNorm) >= 0) score += 300;

    if (!tokens.length) return score;

    var matchedTokens = 0;
    tokens.forEach(function (token) {
      if (!token) return;
      var best = 0;

      if (localNorm && localNorm === token) best = Math.max(best, 400);
      else best = Math.max(best, wordScore(localNorm, token, 400, 300));

      if (brandNorm === token) best = Math.max(best, 350);
      else best = Math.max(best, wordScore(brandNorm, token, 320, 220));

      var keywordHit = 0;
      var sneakerReferralHit = false;
      keywordList.forEach(function (keyword) {
        var hit = wordScore(keyword, token, 280, 180);
        if (hit <= 0) return;
        // Multimarca resellers list many brand names in keywords (Block, etc.).
        if (keywordList.length > 12 && !brandContainsToken(brandNorm, token)) {
          if (!(sneakerIntentQuery && sneakerContextEntry)) return;
          sneakerReferralHit = true;
        }
        if (brandContainsToken(brandNorm, token) || keyword === brandNorm) {
          keywordHit = Math.max(keywordHit, hit);
        } else if (keywordList.length <= 12) {
          keywordHit = Math.max(keywordHit, hit);
        } else if (sneakerReferralHit) {
          keywordHit = Math.max(keywordHit, hit + 140);
        }
      });
      best = Math.max(best, keywordHit);

      best = Math.max(best, wordScore(tokenBlob, token, 120, 80));

      if (best > 0) {
        score += best;
        matchedTokens += 1;
      }
    });

    if (matchedTokens < tokens.length) return 0;
    score += 80 * tokens.length;
    return score;
  }

  function isDirectBrandQueryMatch(brandNorm, token, queryNorm, queryCompact) {
    var brandCompact = brandNorm.replace(/ /g, "");
    return (
      brandNorm === queryNorm ||
      brandNorm === token ||
      brandCompact === queryCompact
    );
  }

  function applyRelevanceFilter(matches, queryNorm, tokens) {
    if (!matches.length || tokens.length !== 1) return matches;

    var token = tokens[0];
    if (!token || token.length < 3) return matches;

    var queryCompact = queryNorm.replace(/ /g, "");
    var brandHits = matches.filter(function (match) {
      var brandNorm = normalizeText(match.entry.brand || match.entry.name);
      return isDirectBrandQueryMatch(brandNorm, token, queryNorm, queryCompact);
    });

    if (!brandHits.length || brandHits[0].score < 900) return matches;

    var topBrandScore = brandHits[0].score;
    var threshold = Math.max(420, topBrandScore * 0.38);

    return matches.filter(function (match) {
      if (match.score >= threshold) return true;
      var brandNorm = normalizeText(match.entry.brand || match.entry.name);
      if (isDirectBrandQueryMatch(brandNorm, token, queryNorm, queryCompact)) return true;
      return brandContainsToken(brandNorm, token) && brandNorm.split(" ").length <= 4;
    });
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
      .catch(function () {
        // file:// (Android WebView) blocks fetch — use the <script> companion.
        return loadJsonViaScript(catalogJsonpUrl(), "__MARKET_CATALOG__");
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

    matches = applyRelevanceFilter(matches, queryNorm, tokens);

    var grouped = groupByBrand(matches);
    var results = grouped
      .map(toResultCard)
      .filter(Boolean)
      .slice(0, limit);

    if (!results.length && options.allowRelated !== false) {
      var related = searchRelated(query, { limit: limit });
      if (related.results && related.results.length) {
        related.exactTotalMatches = matches.length;
        return related;
      }
    }

    return {
      query: query,
      results: results,
      totalMatches: matches.length,
      catalogLoaded: true,
      catalogSize: catalog ? catalog.length : 0,
    };
  }

  function levenshteinWithin(a, b, maxDistance) {
    if (a === b) return 0;
    if (!a || !b) return Math.max(a ? a.length : 0, b ? b.length : 0);

    var lenA = a.length;
    var lenB = b.length;
    if (Math.abs(lenA - lenB) > maxDistance) return null;

    var prev = new Array(lenB + 1);
    var curr = new Array(lenB + 1);
    for (var j = 0; j <= lenB; j++) prev[j] = j;

    for (var i = 1; i <= lenA; i++) {
      curr[0] = i;
      var rowMin = curr[0];
      var ai = a.charAt(i - 1);
      for (j = 1; j <= lenB; j++) {
        var cost = ai === b.charAt(j - 1) ? 0 : 1;
        var del = prev[j] + 1;
        var ins = curr[j - 1] + 1;
        var sub = prev[j - 1] + cost;
        var val = Math.min(del, ins, sub);
        curr[j] = val;
        if (val < rowMin) rowMin = val;
      }
      if (rowMin > maxDistance) return null;
      var tmp = prev;
      prev = curr;
      curr = tmp;
    }

    return prev[lenB] <= maxDistance ? prev[lenB] : null;
  }

  function scoreRelatedEntry(indexedEntry, queryNorm, tokens) {
    var entry = indexedEntry.entry;
    if (!entry) return 0;
    if (entry.available === false) return 0;

    var score = 0;
    var hasBrandSignal = false;
    var queryCompact = queryNorm.replace(/ /g, "");
    if (!queryCompact) return 0;

    var brandNorm = normalizeText(entry.brand || entry.name);
    var brandCompact = brandNorm.replace(/ /g, "");
    if (!brandCompact) return 0;

    if (brandCompact.indexOf(queryCompact) >= 0 || queryCompact.indexOf(brandCompact) >= 0) {
      score = Math.max(score, 460 - Math.min(120, Math.abs(brandCompact.length - queryCompact.length) * 8));
      hasBrandSignal = true;
    }

    var maxBrandDistance = queryCompact.length <= 5 ? 1 : (queryCompact.length <= 10 ? 2 : 3);
    var brandDistance = levenshteinWithin(brandCompact, queryCompact, maxBrandDistance);
    if (brandDistance != null) {
      score = Math.max(score, 440 - brandDistance * 90);
      hasBrandSignal = true;
    }

    var brandWords = brandNorm.split(" ").filter(Boolean);
    var keywordWords = parseKeywordList(entry.keywords)
      .join(" ")
      .split(" ")
      .filter(Boolean);
    var matchedTokens = 0;

    tokens.forEach(function (token) {
      if (!token || token.length < 3) return;
      var best = 0;
      var brandBest = 0;
      var keywordBest = 0;

      brandWords.forEach(function (word) {
        if (word === token) brandBest = Math.max(brandBest, 250);
        else if (word.indexOf(token) === 0 || token.indexOf(word) === 0) brandBest = Math.max(brandBest, 210);
        else {
          var d = levenshteinWithin(word, token, token.length <= 4 ? 1 : 2);
          if (d != null) brandBest = Math.max(brandBest, 170 - d * 40);
        }
      });

      keywordWords.forEach(function (word) {
        if (word === token) keywordBest = Math.max(keywordBest, 160);
        else if (word.indexOf(token) === 0 || token.indexOf(word) === 0) keywordBest = Math.max(keywordBest, 130);
        else {
          var d = levenshteinWithin(word, token, 1);
          if (d != null) keywordBest = Math.max(keywordBest, 105 - d * 30);
        }
      });

      best = Math.max(brandBest, keywordBest);
      if (best > 0) {
        score += best;
        matchedTokens += 1;
      }
      if (brandBest > 0) hasBrandSignal = true;
    });

    if (tokens.length > 1 && matchedTokens === 0) return 0;
    if (!hasBrandSignal) return 0;
    if (score < 160) return 0;
    return score;
  }

  function searchRelated(query, options) {
    options = options || {};
    var limit = options.limit != null ? Number(options.limit) : 10;
    if (!isFinite(limit) || limit <= 0) limit = 10;

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
      var score = scoreRelatedEntry(indexedEntry, queryNorm, tokens);
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
      resultType: "related",
      isFallbackRelated: true,
    };
  }

  function isReady() {
    return !!(catalog && indexed);
  }

  function getCatalogSize() {
    return catalog ? catalog.length : 0;
  }

  function listCategories() {
    if (!catalog || !catalog.length) {
      return { categories: [], catalogLoaded: false, catalogSize: 0 };
    }

    var bucket = {};
    catalog.forEach(function (entry) {
      if (entry.available === false) return;
      var seen = {};
      parseCategoryList(entry.category).forEach(function (cat) {
        if (seen[cat.key]) return;
        seen[cat.key] = true;
        if (!bucket[cat.key]) {
          bucket[cat.key] = { key: cat.key, names: {}, storeCount: 0 };
        }
        bucket[cat.key].storeCount += 1;
        bucket[cat.key].names[cat.name] = (bucket[cat.key].names[cat.name] || 0) + 1;
      });
    });

    var categories = Object.keys(bucket).map(function (key) {
      var item = bucket[key];
      var displayName = Object.keys(item.names).sort(function (a, b) {
        return item.names[b] - item.names[a];
      })[0];
      return {
        key: key,
        name: displayName,
        storeCount: item.storeCount,
      };
    }).sort(function (a, b) {
      return a.name.localeCompare(b.name, "es");
    });

    return {
      categories: categories,
      catalogLoaded: true,
      catalogSize: catalog.length,
    };
  }

  function searchByCategory(category, options) {
    options = options || {};
    var limit = options.limit != null ? Number(options.limit) : 200;
    if (!isFinite(limit) || limit <= 0) limit = 200;

    var categoryName = String(category || "").trim();
    var categoryKey = normalizeText(categoryName);
    if (!categoryKey) {
      return {
        query: categoryName,
        category: categoryName,
        results: [],
        totalMatches: 0,
        catalogLoaded: !!indexed,
        catalogSize: catalog ? catalog.length : 0,
      };
    }

    if (!indexed || !indexed.length) {
      return {
        query: categoryName,
        category: categoryName,
        results: [],
        totalMatches: 0,
        catalogLoaded: false,
        catalogSize: 0,
      };
    }

    var matches = [];
    indexed.forEach(function (indexedEntry) {
      var entry = indexedEntry.entry;
      if (entry.available === false) return;
      if (entryMatchesCategory(entry, categoryKey)) {
        matches.push({ entry: entry, score: 100 });
      }
    });

    matches.sort(function (a, b) {
      return String(a.entry.name).localeCompare(String(b.entry.name), "es");
    });

    var grouped = groupByBrand(matches);
    var results = grouped
      .map(toResultCard)
      .filter(Boolean)
      .slice(0, limit);

    return {
      query: categoryName,
      category: categoryName,
      results: results,
      totalMatches: matches.length,
      catalogLoaded: true,
      catalogSize: catalog.length,
    };
  }

  return {
    loadCatalog: loadCatalog,
    search: search,
    searchRelated: searchRelated,
    listCategories: listCategories,
    searchByCategory: searchByCategory,
    isReady: isReady,
    getCatalogSize: getCatalogSize,
    getBrandByLocal: getBrandByLocal,
    normalizeText: normalizeText,
    catalogUrl: catalogUrl,
  };
})();
