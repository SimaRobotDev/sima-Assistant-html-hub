/**
 * Mall infrastructure services catalog (bathrooms + elevators).
 */
window.ServicesCatalog = (function () {
  var catalog = null;
  var loadPromise = null;
  var byId = null;

  function catalogBase() {
    var base = window.SERVICES_CATALOG_BASE || "../data/";
    if (base.charAt(base.length - 1) !== "/") base += "/";
    return base;
  }

  function catalogUrl() {
    return catalogBase() + (window.SERVICES_CATALOG_FILE || "services-catalog.json");
  }

  function catalogJsonpUrl() {
    return catalogBase() + (window.SERVICES_CATALOG_JSONP_FILE || "services-catalog.jsonp.js");
  }

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
        else reject(new Error("services jsonp loaded but global missing: " + globalName));
      };
      script.onerror = function () {
        reject(new Error("services jsonp failed: " + url));
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

  function buildIndex(data) {
    byId = {};
    var list = (data && data.services) || [];
    list.forEach(function (entry) {
      if (entry && entry.id) byId[entry.id] = entry;
    });
  }

  function parseFloorFromQuery(query) {
    var n = normalizeText(query);
    if (!n) return null;
    if (/\b(pb|planta baja|planta\s*baja)\b/.test(n)) return "PB";
    var m = n.match(/\b(?:nivel|piso|floor|level)\s*(\d+)\b/);
    if (m) return m[1];
    if (/\bn\s*(\d+)\b/.test(n)) return n.match(/\bn\s*(\d+)\b/)[1];
    return null;
  }

  function wantsMudador(query) {
    return /\b(mudador|mudadores|cambiador|changing|pañal|panal|bebe|bebé|lactancia)\b/.test(
      normalizeText(query)
    );
  }

  function looksLikeBathroomQuery(query) {
    var n = normalizeText(query);
    if (!n) return false;
    if (wantsMudador(n)) return true;
    return /\b(bano|banos|wc|restroom|toilet|servicio\s*sanitario|sanitario)\b/.test(n);
  }

  function looksLikeElevatorQuery(query) {
    var n = normalizeText(query);
    if (!n) return false;
    return /\b(ascensor|ascensores|elevador|elevadores|elevator|elevators)\b/.test(n);
  }

  function looksLikeServicesQuery(query) {
    return looksLikeBathroomQuery(query) || looksLikeElevatorQuery(query);
  }

  function entryType(entry) {
    return String((entry && entry.type) || "bathroom").toLowerCase();
  }

  function primaryAnchor(entry, preferFloor) {
    var stores = (entry && entry.anchorStores) || [];
    var floorKey = normalizeFloorKey(preferFloor || "");

    function matchesFloor(store) {
      if (!floorKey) return true;
      if (store.floors && store.floors.length) {
        return store.floors.some(function (f) {
          return floorsMatch(f, floorKey);
        });
      }
      return true;
    }

    var onFloor = stores.filter(matchesFloor);
    var pool = onFloor.length ? onFloor : stores;

    for (var i = 0; i < pool.length; i++) {
      if (pool[i].role === "primary" && pool[i].local) return pool[i];
    }
    for (var j = 0; j < pool.length; j++) {
      if (pool[j].local) return pool[j];
    }
    return stores[0] || null;
  }

  function formatFloorLabelEs(floorKey) {
    var key = normalizeFloorKey(floorKey || "");
    if (!key) return "";
    if (key === "PB") return "Planta Baja";
    return "Nivel " + key;
  }

  /** Short, floor-aware landmark for elevators — avoid dumping every floor's stores. */
  function elevatorLocationHint(entry, preferFloor, anchor) {
    var desc = (entry && entry.descriptions) || {};
    var brand = anchor && anchor.brand ? String(anchor.brand).trim() : "";
    var floorKey = normalizeFloorKey(preferFloor || "");
    if (!floorKey && anchor && anchor.floors && anchor.floors.length) {
      floorKey = normalizeFloorKey(anchor.floors[0]);
    }
    var floorLabel = formatFloorLabelEs(floorKey);
    if (brand && floorLabel) return "En este piso: junto a " + brand + " · " + floorLabel;
    if (brand) return "Junto a " + brand;
    return desc.short || "";
  }

  function toResultCard(entry, options) {
    if (!entry) return {};
    options = options || {};
    var preferFloor = options.preferFloor || options.floor || "";
    var anchor = primaryAnchor(entry, preferFloor);
    var desc = entry.descriptions || {};
    var isElevator = entry.type === "elevator";
    return {
      id: entry.id,
      catalogId: entry.id,
      name: entry.name,
      description: desc.short || desc.medium || "",
      location: isElevator
        ? elevatorLocationHint(entry, preferFloor, anchor)
        : (desc.medium || desc.short || ""),
      floors: entry.floors || [],
      sector: entry.sector || "",
      type: entry.type || "bathroom",
      features: entry.features || {},
      anchorLocal: anchor && anchor.local ? anchor.local : "",
      anchorBrand: anchor && anchor.brand ? anchor.brand : "",
      poiRef: entry.mapvx && entry.mapvx.poiRef ? entry.mapvx.poiRef : "",
      mapvxId: entry.mapvx && entry.mapvx.mapvxId ? entry.mapvx.mapvxId : "",
      mapvxLat: entry.mapvx && entry.mapvx.lat != null ? entry.mapvx.lat : null,
      mapvxLng: entry.mapvx && entry.mapvx.lng != null ? entry.mapvx.lng : null,
      mall: (catalog && catalog.mall) || "costanera",
    };
  }

  function normalizeFloorKey(value) {
    var raw = String(value == null ? "" : value).trim();
    if (!raw) return "";
    var n = normalizeText(raw);
    if (!n) return "";
    if (n === "pb" || n === "planta baja" || n === "ground" || n === "0") return "PB";
    var m = n.match(/(?:nivel|piso|floor|level|n)\s*(\d+)/);
    if (m) return m[1];
    if (/^\d+$/.test(n)) return n;
    var mapvx = n.match(/\bn\s*(\d+)\b/) || n.match(/(\d+)/);
    if (mapvx) return mapvx[1];
    return raw.toUpperCase();
  }

  function floorsMatch(entryFloor, targetFloor) {
    var a = normalizeFloorKey(entryFloor);
    var b = normalizeFloorKey(targetFloor);
    if (!a || !b) return false;
    return a === b;
  }

  function entryOnFloor(entry, floorKey) {
    if (!floorKey || !entry || !entry.floors || !entry.floors.length) return false;
    return entry.floors.some(function (f) {
      return floorsMatch(f, floorKey);
    });
  }

  function scoreEntry(entry, queryNorm, floorFilter, mudadorOnly, preferFloor, typeFilter) {
    if (!entry) return -1;
    var type = entryType(entry);
    if (typeFilter && type !== typeFilter) return -1;
    if (mudadorOnly) {
      if (type !== "bathroom") return -1;
      if (!(entry.features && entry.features.mudador)) return -1;
    }
    if (floorFilter && entry.floors && entry.floors.length) {
      var floorOk = entry.floors.some(function (f) {
        return floorsMatch(f, floorFilter);
      });
      if (!floorOk) return -1;
    }

    var score = 0;
    var keywords = entry.keywords || [];
    keywords.forEach(function (kw) {
      var k = normalizeText(kw);
      if (k && queryNorm.indexOf(k) >= 0) score += 3;
    });

    if (entry.sector && queryNorm.indexOf(normalizeText(entry.sector)) >= 0) score += 5;
    if (entry.name && queryNorm.indexOf(normalizeText(entry.name)) >= 0) score += 4;

    var anchors = entry.anchorStores || [];
    var seenBrands = {};
    anchors.forEach(function (store) {
      var brand = normalizeText(store.brand || "");
      if (!brand || seenBrands[brand]) return;
      if (queryNorm.indexOf(brand) >= 0) {
        seenBrands[brand] = true;
        score += 6;
      }
    });

    if (type === "bathroom" && looksLikeBathroomQuery(queryNorm)) score += 1;
    if (type === "elevator" && looksLikeElevatorQuery(queryNorm)) score += 1;

    if (preferFloor && entryOnFloor(entry, preferFloor)) {
      score += floorFilter ? 2 : 8;
      if (type === "elevator") {
        var hasAnchorOnFloor = (entry.anchorStores || []).some(function (store) {
          if (!store.floors || !store.floors.length) return false;
          return store.floors.some(function (f) {
            return floorsMatch(f, preferFloor);
          });
        });
        if (hasAnchorOnFloor) score += 4;
      } else if (entry.floors && entry.floors.length && floorsMatch(entry.floors[0], preferFloor)) {
        score += 6;
      }
    }

    return score;
  }

  function inferTypeFilter(queryNorm, mudadorOnly) {
    if (mudadorOnly) return "bathroom";
    var bath = looksLikeBathroomQuery(queryNorm);
    var elev = looksLikeElevatorQuery(queryNorm);
    if (elev && !bath) return "elevator";
    if (bath && !elev) return "bathroom";
    return "";
  }

  function loadCatalog() {
    if (catalog) return Promise.resolve(catalog);
    if (loadPromise) return loadPromise;

    loadPromise = (function () {
      var isFile = false;
      try {
        isFile = window.location && window.location.protocol === "file:";
      } catch (e) { /* noop */ }

      function ingest(data) {
        catalog = data || { services: [] };
        buildIndex(catalog);
        return catalog;
      }

      if (isFile) {
        return loadJsonViaScript(catalogJsonpUrl(), "__SERVICES_CATALOG__")
          .then(ingest)
          .catch(function () {
            return loadJsonViaScript(catalogUrl(), "__SERVICES_CATALOG__").then(ingest);
          });
      }

      return fetch(catalogUrl())
        .then(function (res) {
          if (!res.ok) throw new Error("services catalog fetch failed");
          return res.json();
        })
        .then(ingest)
        .catch(function () {
          return loadJsonViaScript(catalogJsonpUrl(), "__SERVICES_CATALOG__").then(ingest);
        });
    })();

    return loadPromise;
  }

  return {
    loadCatalog: loadCatalog,
    isReady: function () {
      return !!(catalog && catalog.services && catalog.services.length);
    },
    getAll: function () {
      return (catalog && catalog.services) ? catalog.services.slice() : [];
    },
    getByType: function (type) {
      var t = String(type || "").toLowerCase();
      return ((catalog && catalog.services) || []).filter(function (entry) {
        return entryType(entry) === t;
      });
    },
    getById: function (id) {
      if (!id) return null;
      if (!byId) buildIndex(catalog || {});
      return byId[id] || null;
    },
    looksLikeBathroomQuery: looksLikeBathroomQuery,
    looksLikeElevatorQuery: looksLikeElevatorQuery,
    looksLikeServicesQuery: looksLikeServicesQuery,
    toResultCard: toResultCard,
    search: function (query, options) {
      options = options || {};
      if (!catalog || !catalog.services) return [];
      var q = normalizeText(query);
      var floorFilter = options.floor || parseFloorFromQuery(q);
      var preferFloor = normalizeFloorKey(options.preferFloor || options.totemFloor || "");
      var mudadorOnly = options.mudadorOnly != null ? options.mudadorOnly : wantsMudador(q);
      var serviceId = options.serviceId ? String(options.serviceId).trim() : "";
      var typeFilter = options.type
        ? String(options.type).toLowerCase()
        : inferTypeFilter(q, mudadorOnly);

      var cardOpts = { preferFloor: preferFloor || floorFilter || "", floor: floorFilter || preferFloor || "" };

      if (serviceId && byId && byId[serviceId]) {
        return [toResultCard(byId[serviceId], cardOpts)];
      }

      var scored = catalog.services
        .map(function (entry) {
          return {
            entry: entry,
            score: scoreEntry(entry, q, floorFilter, mudadorOnly, preferFloor, typeFilter),
          };
        })
        .filter(function (row) {
          return row.score >= 0;
        })
        .sort(function (a, b) {
          return b.score - a.score;
        });

      if (!scored.length && (looksLikeBathroomQuery(q) || looksLikeElevatorQuery(q))) {
        return catalog.services
          .filter(function (entry) {
            if (typeFilter && entryType(entry) !== typeFilter) return false;
            if (mudadorOnly && !(entry.features && entry.features.mudador)) return false;
            if (!floorFilter || !entry.floors || !entry.floors.length) return !floorFilter;
            return entry.floors.some(function (f) {
              return floorsMatch(f, floorFilter);
            });
          })
          .sort(function (a, b) {
            var aPref = preferFloor && entryOnFloor(a, preferFloor) ? 1 : 0;
            var bPref = preferFloor && entryOnFloor(b, preferFloor) ? 1 : 0;
            return bPref - aPref;
          })
          .map(function (entry) {
            return toResultCard(entry, cardOpts);
          });
      }

      if (!scored.length) return [];

      var topScore = scored[0].score;
      var minScore = topScore > 0 ? 1 : 0;
      // When a strong match exists (brand/sector), drop generic-only hits.
      if (topScore >= 6) minScore = Math.max(minScore, topScore - 2);
      return scored
        .filter(function (row) {
          return row.score >= minScore;
        })
        .map(function (row) {
          return toResultCard(row.entry, cardOpts);
        });
    },
    normalizeFloorKey: normalizeFloorKey,
  };
})();
