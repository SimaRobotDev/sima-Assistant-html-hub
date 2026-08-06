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

  var QUERY_STOP_WORDS = {
    a: true,
    an: true,
    the: true,
    to: true,
    for: true,
    of: true,
    in: true,
    on: true,
    at: true,
    is: true,
    are: true,
    me: true,
    my: true,
    i: true,
    im: true,
    want: true,
    need: true,
    find: true,
    show: true,
    search: true,
    look: true,
    where: true,
    please: true,
    de: true,
    del: true,
    la: true,
    el: true,
    los: true,
    las: true,
    un: true,
    una: true,
    unos: true,
    unas: true,
    y: true,
    o: true,
    en: true,
    por: true,
    para: true,
    con: true,
    que: true,
    quiero: true,
    necesito: true,
    buscar: true,
    busca: true,
    busco: true,
    donde: true,
    esta: true,
    estan: true,
    hay: true,
    tienda: true,
    local: true,
    comprar: true,
    dame: true,
    muestrame: true,
    muestra: true,
  };

  function tokenizeQuery(query) {
    var normalized = normalizeText(query);
    if (!normalized) return [];
    return normalized.split(" ").filter(function (token) {
      if (!token || token.length < 1) return false;
      if (QUERY_STOP_WORDS[token]) return false;
      return true;
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
    var brand = String(item.brand_name || item.brand || item.name || "").trim();
    var marketName = String(item.market_name || item.marketName || "").trim();
    var categories = String(
      item.brand_categories
      || item.category
      || (item.brand_level1_categories && item.brand_level1_categories[0])
      || ""
    ).trim();
    var subCats = Array.isArray(item.brand_sub_categories)
      ? item.brand_sub_categories.map(function (c) { return String(c || "").trim(); }).filter(Boolean)
      : [];
    if (subCats.length) {
      categories = [categories].concat(subCats).filter(Boolean).join(",");
    }
    return {
      id: String(item.id != null ? item.id : ""),
      name: brand || marketName || "Tienda",
      brand: brand || marketName,
      marketName: marketName,
      floor: formatFloorFromLevels(item.market_levels || item.floor),
      category: categories,
      local: String(item.local || "").trim(),
      logoUrl: String(item.brand_logo || item.logoUrl || item.logo || "").trim(),
      brand_logo: String(item.brand_logo || item.logoUrl || item.logo || "").trim(),
      // Slim OTA omits photos/schedules/description; keep empty defaults for UI.
      market_photos: Array.isArray(item.market_photos)
        ? item.market_photos.map(function (url) { return String(url || "").trim(); }).filter(Boolean)
        : [],
      description: String(item.brand_description || item.description || "").trim(),
      descriptionLocales: {
        es: String(item.brand_description || item.description || "").trim(),
        en: String(item.brand_description_en || item.brand_description_en_us || "").trim(),
        pt: String(item.brand_description_pt || item.brand_description_pt_br || "").trim(),
      },
      keywords: String(item.keywords || "").trim(),
      mall: String(item.mall || "").trim(),
      available: isAvailable(item),
      schedules: item.market_schedules || item.schedules || [],
      website: String(item.brand_website || item.website || "").trim(),
      source: "market-catalog",
    };
  }

  // Phrase blob intentionally excludes description (do not rank by description).
  function buildSearchBlob(entry) {
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

  function buildCategoryBlob(entry) {
    return normalizeText(entry.category || "");
  }

  function buildIndex(entries) {
    return entries.map(function (entry) {
      return {
        entry: entry,
        blob: buildSearchBlob(entry),
        tokenBlob: buildTokenBlob(entry),
        categoryBlob: buildCategoryBlob(entry),
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
  // Also allows light Spanish inflection both ways (deportivo ↔ deportivos).
  function stripLightInflection(token) {
    var t = String(token || "");
    if (t.length < 5) return t;
    if (t.slice(-2) === "es" && t.length >= 6) return t.slice(0, -2);
    if (t.slice(-1) === "s") return t.slice(0, -1);
    return t;
  }

  function wordsInflectMatch(word, term) {
    if (!word || !term) return false;
    if (word === term) return true;
    if (term.length >= 3 && word.indexOf(term) === 0) {
      var rest = word.slice(term.length);
      if (!rest || rest.length <= 2) return true;
    }
    if (word.length >= 3 && term.indexOf(word) === 0) {
      var restTerm = term.slice(word.length);
      if (!restTerm || restTerm.length <= 2) return true;
    }
    var stemWord = stripLightInflection(word);
    var stemTerm = stripLightInflection(term);
    return !!(stemWord && stemTerm && stemWord.length >= 4 && stemWord === stemTerm);
  }

  function wordScore(text, term, exactPts, prefixPts) {
    if (!text || !term) return 0;
    var words = text.split(" ");
    var softHit = 0;
    for (var i = 0; i < words.length; i++) {
      var word = words[i];
      if (!word) continue;
      if (word === term) return exactPts;
      if (wordsInflectMatch(word, term)) {
        softHit = Math.max(softHit, prefixPts);
      }
    }
    return softHit;
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

  function tokenVariants(token) {
    var t = normalizeText(token);
    if (!t) return [];
    var out = [t];
    var seen = {};
    seen[t] = true;
    function add(v) {
      var n = normalizeText(v);
      if (!n || seen[n]) return;
      seen[n] = true;
      out.push(n);
    }

    add(stripLightInflection(t));
    if (t === "zapatos" || t === "zapato") {
      // Do not auto-expand to sneakers when paired with "formales" — handled in scoreEntry.
      add("zapatillas");
      add("zapatilla");
      add("calzado");
    } else if (t === "zapatillas" || t === "zapatilla") {
      add("zapatos");
      add("zapato");
      add("calzado");
    } else if (t === "calzado" || t === "calzados") {
      add("zapatillas");
      add("zapatos");
    } else if (t === "deportivos" || t === "deportivo" || t === "deportiva" || t === "deportivas") {
      add("deporte");
      add("deportes");
    } else if (t === "ropa" || t === "vestimenta" || t === "indumentaria") {
      add("vestuario");
      add("moda");
    } else if (t === "vestuario") {
      add("ropa");
      add("moda");
    } else if (t === "mujer" || t === "mujeres" || t === "dama" || t === "damas") {
      add("mujer");
      add("dama");
      add("women");
    } else if (t === "hombre" || t === "hombres" || t === "caballero" || t === "caballeros") {
      add("hombre");
      add("caballero");
      add("men");
    } else if (t === "formales" || t === "formal" || t === "vestir") {
      add("formal");
      add("formales");
      add("vestir");
      add("office");
      add("elegante");
    } else if (t === "original" || t === "originals" || t === "originales" || t === "originale") {
      add("original");
      add("originals");
      add("originales");
    }
    return out;
  }

  function isProductOnlyToken(token) {
    var t = normalizeText(token);
    return (
      t === "zapatillas" ||
      t === "zapatilla" ||
      t === "zapatos" ||
      t === "zapato" ||
      t === "calzado" ||
      t === "calzados" ||
      t === "shoes" ||
      t === "shoe" ||
      t === "sneakers" ||
      t === "sneaker" ||
      t === "tenis" ||
      t === "ropa" ||
      t === "vestuario" ||
      t === "moda"
    );
  }

  function isFormalFootwearToken(token) {
    var t = normalizeText(token);
    return t === "formales" || t === "formal" || t === "vestir" || t === "office" || t === "elegante";
  }

  function queryHasFormalFootwearIntent(tokens) {
    if (!tokens || !tokens.length) return false;
    var hasShoe = tokens.some(function (token) {
      var t = normalizeText(token);
      return t === "zapatos" || t === "zapato" || t === "calzado" || t === "calzados" || t === "shoes" || t === "shoe";
    });
    return hasShoe && tokens.some(isFormalFootwearToken);
  }

  function entryHasFormalFootwearContext(entry, keywordList) {
    var blob = normalizeText([
      entry && entry.category,
      entry && entry.keywords,
      (keywordList || []).join(" "),
    ].join(" "));
    return (
      blob.indexOf("formal") >= 0 ||
      blob.indexOf("vestir") >= 0 ||
      blob.indexOf("elegante") >= 0 ||
      blob.indexOf("office") >= 0 ||
      blob.indexOf("oxford") >= 0 ||
      blob.indexOf("mocasin") >= 0 ||
      blob.indexOf("taco") >= 0
    );
  }

  function isFootwearIntentToken(token) {
    var t = normalizeText(token);
    if (!t) return false;
    return (
      t === "zapatillas" ||
      t === "zapatilla" ||
      t === "zapatos" ||
      t === "zapato" ||
      t === "sneakers" ||
      t === "sneaker" ||
      t === "calzado" ||
      t === "calzados" ||
      t === "shoes" ||
      t === "shoe" ||
      t === "tenis" ||
      t === "nike" ||
      t === "adidas" ||
      t === "puma" ||
      t === "reebok" ||
      t === "converse" ||
      t === "vans" ||
      t === "asics" ||
      t === "fila" ||
      t === "skechers" ||
      t === "jordan" ||
      t === "umbro"
    );
  }

  function isSportModifierToken(token) {
    var t = normalizeText(token);
    return (
      t === "deportivos" ||
      t === "deportivo" ||
      t === "deportiva" ||
      t === "deportivas" ||
      t === "deporte" ||
      t === "deportes" ||
      t === "sport" ||
      t === "sports" ||
      t === "running" ||
      t === "training" ||
      t === "trekking"
    );
  }

  // Legacy alias used by sneaker-referral scoring.
  function isSneakerIntentToken(token) {
    return isFootwearIntentToken(token) || isSportModifierToken(token);
  }

  function queryHasFootwearIntent(tokens, queryNorm) {
    var list = tokens || [];
    var hasShoe = list.some(isFootwearIntentToken);
    if (hasShoe) return true;
    var q = normalizeText(queryNorm);
    return (
      q.indexOf("zapat") >= 0 ||
      q.indexOf("calzado") >= 0 ||
      q.indexOf("sneaker") >= 0
    );
  }

  function entryHasSneakerContext(entry, keywordList) {
    var categoryNorm = normalizeText(entry && entry.category);
    var brandNorm = normalizeText(entry && entry.brand);
    // Treat well-known footwear brands as sneaker context even if keywords/categories are sparse
    if (brandNorm && (brandNorm.indexOf("adidas") >= 0 || brandNorm.indexOf("nike") >= 0 || brandNorm.indexOf("puma") >= 0 || brandNorm.indexOf("vans") >= 0 || brandNorm.indexOf("converse") >= 0 || brandNorm.indexOf("reebok") >= 0)) return true;
    var categoryMatch =
      categoryNorm.indexOf("calzado") >= 0 ||
      categoryNorm.indexOf("deportes") >= 0 ||
      categoryNorm.indexOf("outdoor") >= 0;
    if (categoryMatch) return true;

    var kwBlob = (keywordList || []).join(" ");
    return (
      kwBlob.indexOf("zapatilla") >= 0 ||
      kwBlob.indexOf("zapatos") >= 0 ||
      kwBlob.indexOf("zapato") >= 0 ||
      kwBlob.indexOf("calzado") >= 0 ||
      kwBlob.indexOf("sneaker") >= 0 ||
      kwBlob.indexOf("running") >= 0 ||
      kwBlob.indexOf("trekking") >= 0 ||
      kwBlob.indexOf("futbol") >= 0 ||
      kwBlob.indexOf("basket") >= 0
    );
  }

  function entryIsOffTopicForFootwear(entry) {
    var categoryNorm = normalizeText(entry && entry.category);
    if (!categoryNorm) return false;
    if (categoryNorm.indexOf("optica") >= 0) return true;
    if (categoryNorm.indexOf("farmacia") >= 0) return true;
    if (categoryNorm.indexOf("suplement") >= 0) return true;
    if (categoryNorm.indexOf("gimnasio") >= 0 && categoryNorm.indexOf("calzado") < 0) return true;
    if (categoryNorm.indexOf("salud") >= 0 && categoryNorm.indexOf("calzado") < 0 && categoryNorm.indexOf("deportes") < 0) {
      return true;
    }
    return false;
  }

  // "deportivos" alone must not surface optics ("lentes deportivos") or nutrition.
  function entryIsOffTopicForSportModifier(entry) {
    var categoryNorm = normalizeText(entry && entry.category);
    if (!categoryNorm) return true;
    if (categoryNorm.indexOf("optica") >= 0) return true;
    if (categoryNorm.indexOf("farmacia") >= 0) return true;
    if (categoryNorm.indexOf("suplement") >= 0) return true;
    if (categoryNorm.indexOf("salud") >= 0 && categoryNorm.indexOf("gimnasio") < 0 && categoryNorm.indexOf("deportes") < 0) {
      return true;
    }
    return !(
      categoryNorm.indexOf("deportes") >= 0 ||
      categoryNorm.indexOf("outdoor") >= 0 ||
      categoryNorm.indexOf("calzado") >= 0 ||
      categoryNorm.indexOf("gimnasio") >= 0 ||
      categoryNorm.indexOf("vestuario") >= 0
    );
  }

  function isAmbiguousSportOnlyQuery(tokens) {
    if (!tokens || tokens.length !== 1) return false;
    return isSportModifierToken(tokens[0]);
  }

  function scoreTokenAgainstText(text, token, exactPts, prefixPts) {
    var variants = tokenVariants(token);
    var best = 0;
    for (var i = 0; i < variants.length; i++) {
      best = Math.max(best, wordScore(text, variants[i], exactPts, prefixPts));
      if (best >= exactPts) return best;
    }
    // If no good match, try a lightweight fuzzy match (small edit distance)
    if (best <= 0 && token && token.length >= 3 && text) {
      // compute fuzzy score against individual words in text
      var words = text.split(" ");
      for (var j = 0; j < words.length; j++) {
        var w = words[j];
        if (!w) continue;
        var d = levenshteinDistance(w, token);
        if (d === 0) return exactPts; // shouldn't happen, but safe
        if (d === 1 && token.length >= 3) return Math.max(best, Math.floor(exactPts * 0.45));
        if (d === 2 && token.length >= 5) best = Math.max(best, Math.floor(exactPts * 0.25));
      }
    }
    return best;
  }

  // Lightweight Levenshtein distance for short tokens (optimized)
  function levenshteinDistance(a, b) {
    if (a === b) return 0;
    if (!a || !b) return Math.max(a ? a.length : 0, b ? b.length : 0);
    var la = a.length;
    var lb = b.length;
    if (Math.abs(la - lb) > 2) return Math.abs(la - lb);
    var v0 = new Array(lb + 1);
    var v1 = new Array(lb + 1);
    for (var i = 0; i <= lb; i++) v0[i] = i;
    for (var i = 0; i < la; i++) {
      v1[0] = i + 1;
      var ai = a.charCodeAt(i);
      for (var j = 0; j < lb; j++) {
        var cost = ai === b.charCodeAt(j) ? 0 : 1;
        var deletion = v0[j + 1] + 1;
        var insertion = v1[j] + 1;
        var substitution = v0[j] + cost;
        v1[j + 1] = Math.min(deletion, insertion, substitution);
      }
      var tmp = v0; v0 = v1; v1 = tmp;
    }
    return v0[lb];
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
    var categoryBlob = indexedEntry.categoryBlob || buildCategoryBlob(entry);
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

    // Exact / strong brand wins over keyword soup and category hits.
    if (brandScore >= 700) return score + brandScore + 200;

    var keywordList = parseKeywordList(entry.keywords);
    var sneakerIntentQuery = tokens.some(isSneakerIntentToken);
    var footwearIntent = queryHasFootwearIntent(tokens, queryNorm);
    var formalFootwearIntent = queryHasFormalFootwearIntent(tokens);
    var sportOnlyQuery = isAmbiguousSportOnlyQuery(tokens);
    var sneakerContextEntry = entryHasSneakerContext(entry, keywordList);
    var formalContextEntry = entryHasFormalFootwearContext(entry, keywordList);

    if (footwearIntent && entryIsOffTopicForFootwear(entry) && !sneakerContextEntry) {
      return 0;
    }
    if (sportOnlyQuery && entryIsOffTopicForSportModifier(entry)) {
      return 0;
    }
    // "zapatos formales" should not surface pure sneaker sports shops without formal signal.
    if (formalFootwearIntent && sneakerContextEntry && !formalContextEntry) {
      var categoryNorm = normalizeText(entry.category);
      if (
        categoryNorm.indexOf("deportes") >= 0 &&
        categoryNorm.indexOf("calzado") < 0 &&
        categoryNorm.indexOf("vestuario") < 0
      ) {
        return 0;
      }
    }

    if (queryNorm.indexOf(" ") >= 0 && blob.indexOf(queryNorm) >= 0) score += 300;

    if (!tokens.length) return score;

    var matchedTokens = 0;
    var matchedViaShoeSynonym = false;
    var brandAnchored = false;
    var keywordSoup = keywordList.length > 12;
    tokens.forEach(function (token) {
      if (!token) return;
      var best = 0;
      var matchLayer = ""; // brand | keyword | category | blob
      var variants = tokenVariants(token);

      // Hierarchy: brand > keyword > category > generic blob.
      variants.forEach(function (variant) {
        if (localNorm && localNorm === variant) {
          best = Math.max(best, 400);
          matchLayer = "brand";
        } else {
          var localHit = wordScore(localNorm, variant, 400, 300);
          if (localHit > best) {
            best = localHit;
            matchLayer = "brand";
          }
        }

        if (brandNorm === variant) {
          best = Math.max(best, 350);
          matchLayer = "brand";
        } else {
          var brandHit = wordScore(brandNorm, variant, 320, 220);
          if (brandHit > best) {
            best = brandHit;
            matchLayer = "brand";
          }
        }
      });
      if (scoreTokenAgainstText(brandNorm, token, 1, 1) > 0 && !isProductOnlyToken(token)) {
        brandAnchored = true;
      }

      var keywordHit = 0;
      var sneakerReferralHit = false;
      keywordList.forEach(function (keyword) {
        var hit = 0;
        variants.forEach(function (variant) {
          hit = Math.max(hit, wordScore(keyword, variant, 280, 180));
        });
        if (hit <= 0) return;
        // Multimarca resellers list many brand names in keywords (Block, etc.).
        if (keywordSoup && !brandContainsToken(brandNorm, token)) {
          if (!(sneakerIntentQuery && sneakerContextEntry)) return;
          sneakerReferralHit = true;
        }
        if (brandContainsToken(brandNorm, token) || keyword === brandNorm) {
          keywordHit = Math.max(keywordHit, hit);
        } else if (!keywordSoup) {
          keywordHit = Math.max(keywordHit, hit);
        } else if (sneakerReferralHit) {
          keywordHit = Math.max(keywordHit, hit + 140);
        }
      });
      if (keywordHit > best) {
        best = keywordHit;
        matchLayer = "keyword";
      }

      var categoryHit = scoreTokenAgainstText(categoryBlob, token, 160, 100);
      if (categoryHit > best) {
        best = categoryHit;
        matchLayer = "category";
      }

      var blobHit = scoreTokenAgainstText(tokenBlob, token, 90, 60);
      if (blobHit > best) {
        best = blobHit;
        matchLayer = matchLayer || "blob";
      }

      // Keyword-soup penalty: generic blob/category hits without brand/keyword layer.
      if (keywordSoup && matchLayer === "blob") {
        best = Math.floor(best * 0.35);
      }

      if (best > 0) {
        score += best;
        matchedTokens += 1;
        if (isFootwearIntentToken(token) && variants.length > 1 && wordScore(tokenBlob, token, 1, 1) <= 0) {
          matchedViaShoeSynonym = true;
        }
      }
    });

    if (matchedTokens < tokens.length) {
      // "nike zapatillas": brand anchor + footwear intent is enough.
      if (brandAnchored && footwearIntent && matchedTokens > 0 && (sneakerContextEntry || brandAnchored)) {
        score += 180;
      } else if (footwearIntent && matchedTokens > 0 && sneakerContextEntry) {
        // Footwear phrases like "zapatos deportivos": allow match if shoe + sport
        // signals are both present even when catalog uses "zapatillas"/"deportivo".
        var hasShoeToken = tokens.some(isFootwearIntentToken);
        var hasSportToken = tokens.some(isSportModifierToken);
        if (!(hasShoeToken && hasSportToken && matchedViaShoeSynonym)) {
          return 0;
        }
      } else {
        return 0;
      }
    }

    if (footwearIntent && sneakerContextEntry) score += 120;
    if (formalFootwearIntent && formalContextEntry) score += 140;
    if (footwearIntent && entryIsOffTopicForFootwear(entry)) return 0;
    if (sportOnlyQuery && entryIsOffTopicForSportModifier(entry)) return 0;

    score += 80 * Math.max(matchedTokens, 1);

    // Brand store must outrank keyword-soup resellers for "marca + producto".
    if (brandAnchored && matchedTokens >= tokens.length && tokens.length > 1) {
      score += 420;
    } else if (!brandAnchored && keywordSoup) {
      score = Math.max(0, score - 220);
    }

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

  function scoreEntryRelaxed(indexedEntry, queryNorm, tokens) {
    var strict = scoreEntry(indexedEntry, queryNorm, tokens);
    if (strict > 0) return strict;
    if (!tokens || tokens.length <= 1) return 0;

    var best = 0;
    tokens.forEach(function (token) {
      if (!token || token.length < 3) return;
      var single = scoreEntry(indexedEntry, token, [token]);
      if (single > best) best = single;
    });

    if (best >= 680) return best - 40;
    return 0;
  }

  function brandLineMatchesQuery(entry, queryNorm, tokens) {
    if (!entry) return false;
    var brandNorm = normalizeText(entry.brand || entry.name);
    if (!brandNorm || !queryNorm) return false;
    var brandCompact = brandNorm.replace(/ /g, "");
    var queryCompact = queryNorm.replace(/ /g, "");
    if (brandNorm === queryNorm || brandCompact === queryCompact) return true;
    if (queryCompact.length >= 6 && (
      brandCompact.indexOf(queryCompact) === 0 ||
      queryCompact.indexOf(brandCompact) === 0
    )) return true;
    // All non-product tokens appear in the brand (adidas + original → Adidas Originals).
    var brandTokens = (tokens || []).filter(function (token) {
      return token && !isProductOnlyToken(token) && !isSportModifierToken(token) && !isFormalFootwearToken(token);
    });
    if (!brandTokens.length) return false;
    return brandTokens.every(function (token) {
      return scoreTokenAgainstText(brandNorm, token, 1, 1) > 0;
    });
  }

  function applyRelevanceFilter(matches, queryNorm, tokens) {
    if (!matches.length) return matches;

    if (queryHasFootwearIntent(tokens, queryNorm)) {
      var footwearMatches = matches.filter(function (match) {
        if (entryIsOffTopicForFootwear(match.entry)) return false;
        if (entryHasSneakerContext(match.entry, parseKeywordList(match.entry.keywords))) return true;
        // Keep brand-line stores even when "adidas"/"nike" mark the query as footwear
        // intent (e.g. "Adidas Originals" for "adidas original").
        return brandLineMatchesQuery(match.entry, queryNorm, tokens);
      });
      if (footwearMatches.length) return footwearMatches;
    }

    if (isAmbiguousSportOnlyQuery(tokens)) {
      var sportMatches = matches.filter(function (match) {
        return !entryIsOffTopicForSportModifier(match.entry);
      });
      if (sportMatches.length) return sportMatches;
      return [];
    }

    if (tokens.length !== 1) return matches;

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
      var single = Object.assign({}, entries[0]);
      single._searchScore = group.score;
      return single;
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
      market_photos: head.market_photos,
      description: head.description,
      descriptionLocales: head.descriptionLocales,
      keywords: head.keywords,
      schedule: head.schedule,
      schedules: head.schedules,
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
          market_photos: entry.market_photos,
          schedule: entry.schedule,
          schedules: entry.schedules,
        };
      }),
      _searchScore: group.score,
    };
  }

  function setCatalog(items, options) {
    options = options || {};
    if (!Array.isArray(items)) {
      throw new Error("MarketSearch.setCatalog expects an array");
    }

    var dropped = 0;
    var mapped = [];
    items.forEach(function (item) {
      var entry = mapCatalogEntry(item || {});
      if (!entry.id || !entry.local) {
        dropped += 1;
        return;
      }
      mapped.push(entry);
    });

    if (!mapped.length && items.length) {
      throw new Error("MarketSearch.setCatalog: no items with both id and local");
    }

    catalog = mapped;
    indexed = buildIndex(catalog);
    localBrandIndex = buildLocalBrandIndex(catalog);
    loadPromise = Promise.resolve(catalog);

    if (dropped && options.silent !== true) {
      try {
        console.warn("[MarketSearch] setCatalog dropped " + dropped + " items missing id/local");
      } catch (e) { /* noop */ }
    }

    return {
      catalogSize: catalog.length,
      dropped: dropped,
    };
  }

  function flattenBridgeResults(results, limit) {
    var out = [];
    var max = Math.max(1, Number(limit) || 8);
    (results || []).forEach(function (result) {
      if (!result || out.length >= max) return;
      if (result.isGroup && Array.isArray(result.locations) && result.locations.length) {
        result.locations.forEach(function (loc) {
          if (out.length >= max) return;
          var local = String((loc && loc.local) || result.local || "").trim();
          var id = (loc && loc.id != null && loc.id !== "") ? loc.id : result.id;
          if (!local && (id == null || id === "")) return;
          out.push({
            id: id,
            local: local,
            name: String((loc && loc.name) || result.name || result.brand || "").trim(),
            floor: String((loc && loc.floor) || result.floor || "").trim() || undefined,
            score: result._searchScore,
          });
        });
        return;
      }
      var localSingle = String(result.local || "").trim();
      if (!localSingle && (result.id == null || result.id === "")) return;
      out.push({
        id: result.id,
        local: localSingle,
        name: String(result.name || result.brand || "").trim(),
        floor: String(result.floor || "").trim() || undefined,
        score: result._searchScore,
      });
    });
    return out;
  }

  function toBridgeSearchPayload(searchResult, options) {
    options = options || {};
    var topN = options.topN != null ? Number(options.topN) : 8;
    if (!isFinite(topN) || topN <= 0) topN = 8;
    var query = String((searchResult && (searchResult.query || searchResult.searchQuery)) || options.query || "").trim();
    var results = flattenBridgeResults((searchResult && searchResult.results) || [], topN);
    return {
      type: "market_search_results",
      query: query,
      seq: options.seq,
      totalMatches: Number((searchResult && searchResult.totalMatches) || 0) || 0,
      results: results,
    };
  }

  function logSearchDebug(query, tokens, matches, results) {
    var top5 = (matches || []).slice(0, 5).map(function (m) {
      return {
        name: (m.entry && (m.entry.brand || m.entry.name)) || "",
        id: m.entry && m.entry.id,
        local: m.entry && m.entry.local,
        score: m.score,
      };
    });
    var payload = {
      q: String(query || ""),
      tokens: tokens || [],
      totalMatches: (matches && matches.length) || 0,
      top5: top5,
      returned: (results && results.length) || 0,
    };
    try {
      console.log("[MarketSearch]", payload);
    } catch (e) { /* noop */ }
    try {
      if (typeof window !== "undefined" && window.SimaBridge && typeof window.SimaBridge.log === "function") {
        window.SimaBridge.log(
          "market_search_debug q=" + payload.q +
          " tokens=" + payload.tokens.join("+") +
          " total=" + payload.totalMatches +
          " top=" + top5.map(function (t) {
            return (t.name || "?") + ":" + t.score + ":" + (t.local || "-");
          }).join("|")
        );
      }
    } catch (e2) { /* noop */ }
    return payload;
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

  function findExact(criteria) {
    if (!catalog || !catalog.length) return null;
    criteria = criteria || {};
    var local = String(criteria.local || criteria.clientId || "").trim().toUpperCase();
    var id = String(criteria.id || criteria.catalogId || "").trim();
    var name = normalizeText(criteria.name || criteria.brand || "");
    var floor = normalizeText(criteria.floor || criteria.location || "");

    if (local) {
      var byLocal = catalog.find(function (entry) {
        return String(entry.local || "").trim().toUpperCase() === local;
      });
      if (byLocal) return byLocal;
    }
    if (id) {
      var byId = catalog.find(function (entry) {
        return String(entry.id || "").trim() === id;
      });
      if (byId) return byId;
    }
    if (!name) return null;

    var named = catalog.filter(function (entry) {
      return normalizeText(entry.brand || entry.name || "") === name;
    });
    if (!named.length) return null;
    if (!floor || named.length === 1) return named[0];
    return named.find(function (entry) {
      return normalizeText(entry.floor || "").indexOf(floor) !== -1
        || floor.indexOf(normalizeText(entry.floor || "")) !== -1;
    }) || named[0];
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

    var scoreFn = options.relaxed ? scoreEntryRelaxed : scoreEntry;
    var matches = [];
    indexed.forEach(function (indexedEntry) {
      var score = scoreFn(indexedEntry, queryNorm, tokens);
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

    logSearchDebug(query, tokens, matches, results);

    // Prefer exact multi-token matches; avoid vague "related" fallbacks for
    // product intents (e.g. shoes) where unrelated categories pollute results.
    if (!results.length && options.allowRelated !== false) {
      var relatedTokens = tokenizeQuery(query);
      if (queryHasFootwearIntent(relatedTokens, normalizeText(query))) {
        return {
          query: query,
          results: [],
          totalMatches: 0,
          catalogLoaded: true,
          catalogSize: catalog ? catalog.length : 0,
        };
      }
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

  var GENERIC_VOICE_TOKENS = {
    shoes: true,
    shoe: true,
    food: true,
    pharmacy: true,
    restaurant: true,
    clothes: true,
    clothing: true,
    store: true,
    shop: true,
    zapatillas: true,
    zapatilla: true,
    zapatos: true,
    zapato: true,
    calzado: true,
    deportivos: true,
    deportivo: true,
    deportiva: true,
    deportivas: true,
  };

  function isWeakVoiceFallbackToken(token) {
    var t = normalizeText(token);
    if (!t || t.length < 3) return true;
    if (GENERIC_VOICE_TOKENS[t]) return true;
    if (typeof window !== "undefined" && window.MarketQueryI18n && window.MarketQueryI18n.isWeakSoloToken) {
      return window.MarketQueryI18n.isWeakSoloToken(t);
    }
    return false;
  }

  function searchVoice(query, options) {
    options = options || {};
    var seen = {};
    var attempts = [];
    function addAttempt(value) {
      var text = String(value || "").trim();
      var key = normalizeText(text);
      if (!text || seen[key]) return;
      if (!key.includes(" ") && isWeakVoiceFallbackToken(key)) return;
      seen[key] = true;
      attempts.push(text);
    }

    addAttempt(query);
    if (typeof window !== "undefined" && window.MarketQueryI18n) {
      if (window.MarketQueryI18n.prepareVoiceQuery) {
        addAttempt(window.MarketQueryI18n.prepareVoiceQuery(query));
      }
      if (window.MarketQueryI18n.expandForCatalogSearch) {
        addAttempt(window.MarketQueryI18n.expandForCatalogSearch(query));
      }
    }

    tokenizeQuery(query)
      .filter(function (token) {
        return !isWeakVoiceFallbackToken(token);
      })
      .sort(function (a, b) { return b.length - a.length; })
      .forEach(addAttempt);

    var lastResult = null;
    for (var i = 0; i < attempts.length; i++) {
      var attempt = attempts[i];
      var result = search(attempt, options);
      lastResult = result;
      if (result.results && result.results.length) {
        result.searchMode = attempt === String(query || "").trim() ? "voice-exact" : "voice-token";
        if (attempt !== String(query || "").trim()) result.voiceFallbackQuery = attempt;
        return result;
      }
    }

    if (tokenizeQuery(query).length > 1) {
      var relaxed = search(query, {
        limit: options.limit,
        allowRelated: false,
        relaxed: true,
      });
      if (relaxed.results && relaxed.results.length) {
        // Drop off-topic footwear noise even in relaxed mode.
        if (queryHasFootwearIntent(tokenizeQuery(query), normalizeText(query))) {
          relaxed.results = relaxed.results.filter(function (entry) {
            return entryHasSneakerContext(entry, parseKeywordList(entry.keywords));
          });
        }
        if (relaxed.results.length) {
          relaxed.searchMode = "voice-relaxed";
          return relaxed;
        }
      }
    }

    if (lastResult) {
      lastResult.searchMode = "voice-empty";
      return lastResult;
    }

    return search(query, options);
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
        // Guard prefix matches with a minimum word length so stray short
        // tokens (e.g. the "s" left behind by "Chili's" -> "chili s") don't
        // falsely match as a prefix of every query that starts with the
        // same letter (e.g. "satrbucks").
        else if (word.length >= 3 && (word.indexOf(token) === 0 || token.indexOf(word) === 0)) brandBest = Math.max(brandBest, 210);
        else if (word.length >= 3) {
          var d = levenshteinWithin(word, token, token.length <= 4 ? 1 : 2);
          if (d != null) brandBest = Math.max(brandBest, 170 - d * 40);
        }
      });

      keywordWords.forEach(function (word) {
        if (word === token) keywordBest = Math.max(keywordBest, 160);
        else if (word.length >= 3 && (word.indexOf(token) === 0 || token.indexOf(word) === 0)) keywordBest = Math.max(keywordBest, 130);
        else if (word.length >= 3) {
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
    setCatalog: setCatalog,
    search: search,
    searchVoice: searchVoice,
    searchRelated: searchRelated,
    listCategories: listCategories,
    searchByCategory: searchByCategory,
    findExact: findExact,
    isReady: isReady,
    getCatalogSize: getCatalogSize,
    getBrandByLocal: getBrandByLocal,
    normalizeText: normalizeText,
    catalogUrl: catalogUrl,
    toBridgeSearchPayload: toBridgeSearchPayload,
    flattenBridgeResults: flattenBridgeResults,
  };
})();
