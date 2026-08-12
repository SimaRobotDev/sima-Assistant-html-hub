(function (global) {
  "use strict";

  var detailCache = Object.create(null);

  function text(value) {
    return value == null ? "" : String(value).trim();
  }

  function escapeHtml(value) {
    return text(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function siteOrigin() {
    return text(global.CENCOMALL_SITE_ORIGIN || "https://www.cencomalls.cl")
      .replace(/\/$/, "");
  }

  function marketApiBase() {
    var override = text(global.CENCOMALL_MARKET_API_BASE);
    return override ? override.replace(/\/$/, "") : siteOrigin() + "/api/market";
  }

  function apiHeaders() {
    var headers = { Accept: "application/json" };
    var token = text(
      global.CENCOMALL_MARKET_API_TOKEN || global.CENCOMALL_API_TOKEN
    );
    if (token) headers.Authorization = "Bearer " + token;
    return headers;
  }

  function mediaUrl(value) {
    var url = text(value);
    if (!url) return "";
    if (/^(https?:|data:|blob:|file:)/i.test(url)) return url;
    return url.charAt(0) === "/" ? siteOrigin() + url : siteOrigin() + "/" + url;
  }

  function resolvePhotos(store) {
    var photos = store && (
      store.market_photos || store.marketPhotos || store["market-photos"] ||
      store.photos || store.images
    );
    if (Array.isArray(photos)) {
      return photos.map(function (item) {
        if (typeof item === "string") return text(item);
        if (!item || typeof item !== "object") return "";
        return text(item.url || item.path || item.photo || item.image);
      }).filter(Boolean);
    }
    if (typeof photos === "string" && text(photos)) return [text(photos)];
    return [];
  }

  function firstPhoto(store) {
    var photos = resolvePhotos(store);
    return photos.length ? mediaUrl(photos[0]) : "";
  }

  function logoUrl(store) {
    return mediaUrl(store && (
      store.logoUrl || store.LogoUrl || store.logo || store.brand_logo
    ));
  }

  function initials(name) {
    var parts = text(name).split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
  }

  function scheduleText(store) {
    var schedules = store && (
      store.market_schedules || store.schedules || store.schedule
    );
    if (typeof schedules === "string") return text(schedules);
    if (!Array.isArray(schedules)) return "";
    return schedules.map(function (row) {
      if (typeof row === "string") return text(row);
      if (!row || typeof row !== "object") return "";
      var days = text(
        row.dias_txhorarios || row.days || row.day || row.label
      );
      var hours = text(
        row.horas_txhorarios || row.hours || row.time || row.value
      );
      return [days, hours].filter(Boolean).join(" ");
    }).filter(Boolean).join(" · ");
  }

  function localizedDescription(store, locale) {
    var id = catalogId(store);
    var locales = store && store.descriptionLocales;
    var base = text(
      store && (
        store.description || store.brand_description || store.market_description
      )
    );
    if (global.MarketI18n && typeof global.MarketI18n.translateDescription === "function") {
      var translated = text(
        global.MarketI18n.translateDescription(id, base, locale, locales)
      );
      if (translated) return translated;
    }
    if (locales && typeof locales === "object") {
      var localized = text(locales[locale] || locales.es || locales.en);
      if (localized) return localized;
    }
    return base;
  }

  function displayName(store) {
    return text(store && (
      store.name || store.brand || store.brand_name || store.market_name
    )) || "Tienda";
  }

  /** Same wording as mobility: "Nivel 3" / "PB", never "Piso: …". */
  function formatFloorLabel(floor, locale) {
    var raw = text(floor)
      .replace(/^(piso|level|nivel|andar)\s*[:\-–]?\s*/i, "")
      .trim();
    if (!raw) return "";
    if (/^all$/i.test(raw)) {
      return locale.indexOf("en") === 0
        ? "All levels"
        : locale.indexOf("pt") === 0
          ? "Todos os níveis"
          : "Todos los niveles";
    }
    if (/^pb$/i.test(raw) || /planta baja/i.test(raw)) {
      return locale.indexOf("en") === 0
        ? "Ground floor"
        : locale.indexOf("pt") === 0
          ? "Térreo"
          : "PB";
    }
    if (/^(nivel|level|piso|andar)\s+/i.test(raw)) {
      // Normalize "Piso 3" → "Nivel 3" in Spanish UI.
      var numOnly = raw.match(/(\d+)/);
      if (numOnly && locale.indexOf("en") !== 0 && locale.indexOf("pt") !== 0) {
        return "Nivel " + numOnly[1];
      }
      return raw;
    }
    var match = raw.match(/(\d+)/);
    if (match) {
      var prefix = locale.indexOf("en") === 0
        ? "Level"
        : locale.indexOf("pt") === 0
          ? "Nível"
          : "Nivel";
      return prefix + " " + match[1];
    }
    return raw;
  }

  function catalogId(store) {
    var id = text(store && (
      store.catalogId || store.id || store.market_id || store.store_id
    ));
    return /^\d+$/.test(id) ? id : "";
  }

  function pickPhotos(detail, base) {
    var fromDetail = resolvePhotos(detail);
    if (fromDetail.length) return fromDetail;
    return resolvePhotos(base);
  }

  function merge(baseStore, detail) {
    var base = baseStore && typeof baseStore === "object" ? baseStore : {};
    if (!detail || typeof detail !== "object") return base;
    var description = text(
      detail.brand_description || detail.description || base.description
    );
    var schedules = Array.isArray(detail.market_schedules) && detail.market_schedules.length
      ? detail.market_schedules
      : (Array.isArray(detail.schedules) && detail.schedules.length
        ? detail.schedules
        : (base.market_schedules || base.schedules || base.schedule || []));
    var photos = pickPhotos(detail, base);
    var descriptionLocales = Object.assign({}, base.descriptionLocales || {});
    if (description) descriptionLocales.es = description;
    return Object.assign({}, base, detail, {
      id: base.id || detail.id,
      catalogId: base.catalogId || detail.id,
      local: base.local || text(detail.local),
      name: base.name || detail.brand_name || detail.market_name || detail.name,
      brand: base.brand || detail.brand_name || detail.brand,
      floor: base.floor || detail.floor || detail.market_levels,
      logoUrl: base.logoUrl || detail.brand_logo || detail.logoUrl || "",
      brand_logo: base.brand_logo || detail.brand_logo || "",
      description: description || base.description || "",
      descriptionLocales: descriptionLocales,
      market_photos: photos,
      market_schedules: schedules,
      schedules: schedules,
      detailLoaded: true,
    });
  }

  async function fetchById(id) {
    var key = text(id);
    if (!/^\d+$/.test(key)) return null;
    if (detailCache[key]) return detailCache[key];
    try {
      var response = await fetch(
        marketApiBase() + "/" + encodeURIComponent(key),
        { cache: "no-cache", headers: apiHeaders() }
      );
      if (!response.ok) {
        if (global.SimaBridge && global.SimaBridge.log) {
          global.SimaBridge.log("store detail HTTP " + response.status + " id=" + key);
        }
        return null;
      }
      var raw = await response.json();
      var detail = raw && raw.data && typeof raw.data === "object"
        ? raw.data
        : raw;
      if (!detail || typeof detail !== "object") return null;
      detailCache[key] = detail;
      return detail;
    } catch (error) {
      if (global.SimaBridge && global.SimaBridge.log) {
        global.SimaBridge.log(
          "store detail fetch failed id=" + key + " err=" +
          text(error && (error.message || error))
        );
      }
      return null;
    }
  }

  function mediaMarkup(store) {
    var name = displayName(store);
    var photo = firstPhoto(store);
    var logo = logoUrl(store);
    if (photo) {
      return '<img class="store-detail-photo" src="' + escapeHtml(photo) +
        '" alt="" data-fallback-logo="' + escapeHtml(logo) +
        '" onerror="StoreDetail.handleMediaError(this)" />';
    }
    if (logo) {
      return '<img class="store-detail-logo" src="' + escapeHtml(logo) +
        '" alt="" onerror="StoreDetail.handleMediaError(this)" />';
    }
    return '<div class="store-detail-initials" aria-hidden="true">' +
      escapeHtml(initials(name)) + "</div>";
  }

  function handleMediaError(image) {
    if (!image || !image.parentNode) return;
    var fallback = text(image.getAttribute("data-fallback-logo"));
    if (fallback && image.src !== fallback) {
      image.removeAttribute("data-fallback-logo");
      image.className = "store-detail-logo";
      image.src = fallback;
      return;
    }
    var replacement = document.createElement("div");
    replacement.className = "store-detail-initials";
    replacement.setAttribute("aria-hidden", "true");
    replacement.textContent = initials(
      image.closest(".store-detail-panel")
        ? image.closest(".store-detail-panel").getAttribute("data-store-name")
        : ""
    );
    image.parentNode.replaceChild(replacement, image);
  }

  function render(container, store, options) {
    if (!container) return;
    if (!store) {
      container.classList.add("hidden");
      container.innerHTML = "";
      return;
    }
    options = options || {};
    var locale = text(options.locale || global.MALL_LOCALE || "es").toLowerCase();
    var name = displayName(store);
    var floor = formatFloorLabel(
      store.floor || store.location || options.floor,
      locale
    );
    var schedule = scheduleText(store);
    var description = localizedDescription(store, locale);
    var scheduleLabel = locale.indexOf("en") === 0
      ? "Hours"
      : locale.indexOf("pt") === 0
        ? "Horário"
        : "Horario";

    container.setAttribute("data-store-name", name);
    container.innerHTML =
      '<div class="store-detail-header">' +
        '<div class="store-detail-media">' + mediaMarkup(store) + "</div>" +
        '<div class="store-detail-body">' +
          '<h2 class="store-detail-name">' + escapeHtml(name) + "</h2>" +
          (floor
            ? '<div class="store-detail-meta"><span class="store-detail-chip store-detail-chip-floor">' +
              escapeHtml(floor) + "</span></div>"
            : "") +
          (schedule
            ? '<p class="store-detail-schedule"><strong>' +
              escapeHtml(scheduleLabel) + ":</strong> " +
              escapeHtml(schedule) + "</p>"
            : "") +
          (description
            ? '<p class="store-detail-description">' +
              escapeHtml(description) + "</p>"
            : "") +
        "</div>" +
      "</div>";
    container.classList.remove("hidden");
  }

  async function enrich(store) {
    var id = catalogId(store);
    if (!id) return store || null;
    var detail = await fetchById(id);
    return detail ? merge(store, detail) : store;
  }

  global.StoreDetail = {
    catalogId: catalogId,
    enrich: enrich,
    escapeHtml: escapeHtml,
    fetchById: fetchById,
    formatFloorLabel: formatFloorLabel,
    handleMediaError: handleMediaError,
    merge: merge,
    render: render,
  };
})(window);
