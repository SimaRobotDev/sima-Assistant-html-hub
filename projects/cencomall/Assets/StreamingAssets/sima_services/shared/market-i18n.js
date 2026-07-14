/**
 * Localized labels for market catalog categories and store descriptions.
 * Categories: static dictionary (es source → en/pt).
 * Descriptions: optional overlay data/market-catalog-i18n.json (+ .jsonp.js for file://).
 */
window.MarketI18n = (function (global) {
  var overlay = null;
  var overlayPromise = null;

  var CATEGORY_LABELS = {
    gastronomia: { en: "Food & Dining", pt: "Gastronomia" },
    vestuario: { en: "Apparel", pt: "Vestuário" },
    calzado: { en: "Footwear", pt: "Calçados" },
    "vestuario unisex": { en: "Unisex apparel", pt: "Vestuário unissex" },
    accesorios: { en: "Accessories", pt: "Acessórios" },
    cafeteria: { en: "Café", pt: "Cafeteria" },
    "heladeria y pasteleria": { en: "Ice cream & pastry", pt: "Sorvete e confeitaria" },
    belleza: { en: "Beauty", pt: "Beleza" },
    qinto: { en: "Qinto", pt: "Qinto" },
    "deportes y outdoor": { en: "Sports & outdoor", pt: "Esportes e outdoor" },
    "tiendas especializadas": { en: "Specialty stores", pt: "Lojas especializadas" },
    "productos de belleza": { en: "Beauty products", pt: "Produtos de beleza" },
    restaurantes: { en: "Restaurants", pt: "Restaurantes" },
    hogar: { en: "Home", pt: "Casa e decoração" },
    servicios: { en: "Services", pt: "Serviços" },
    "patio de comidas": { en: "Food court", pt: "Praça de alimentação" },
    optica: { en: "Optician", pt: "Óptica" },
    entretencion: { en: "Entertainment", pt: "Entretenimento" },
    "vestuario mujer": { en: "Women's apparel", pt: "Vestuário feminino" },
    deportes: { en: "Sports", pt: "Esportes" },
    "tecnologia y accesorios": { en: "Technology & accessories", pt: "Tecnologia e acessórios" },
    "joyeria y relojeria": { en: "Jewelry & watches", pt: "Joias e relógios" },
    salud: { en: "Health", pt: "Saúde" },
    "grandes tiendas": { en: "Department stores", pt: "Grandes lojas" },
    infantil: { en: "Kids", pt: "Infantil" },
    outdoor: { en: "Outdoor", pt: "Outdoor" },
    mochilas: { en: "Backpacks", pt: "Mochilas" },
    "bolsos y maletas": { en: "Bags & luggage", pt: "Bolsas e malas" },
    "farmacias y suplementos": { en: "Pharmacies & supplements", pt: "Farmácias e suplementos" },
    "vestuario hombre": { en: "Men's apparel", pt: "Vestuário masculino" },
    especialistas: { en: "Specialists", pt: "Especialistas" },
    "accesorios y carteras": { en: "Accessories & handbags", pt: "Acessórios e bolsas" },
    "chocolateria y confites": { en: "Chocolates & confectionery", pt: "Chocolateria e confeitos" },
    lenceria: { en: "Lingerie", pt: "Lingerie" },
    "libreria y papeleria": { en: "Bookstore & stationery", pt: "Livraria e papelaria" },
    chilena: { en: "Chilean cuisine", pt: "Cozinha chilena" },
    "telefonia e internet": { en: "Telephony & internet", pt: "Telefonia e internet" },
    americana: { en: "American cuisine", pt: "Cozinha americana" },
    "servicios de belleza": { en: "Beauty services", pt: "Serviços de beleza" },
    "pasatiempos y manualidades": { en: "Hobbies & crafts", pt: "Passatempos e artesanato" },
    "agencias de viaje": { en: "Travel agencies", pt: "Agências de viagens" },
    "jugueteria y regalos": { en: "Toys & gifts", pt: "Brinquedos e presentes" },
    mirador: { en: "Viewpoint", pt: "Mirante" },
    manualidades: { en: "Crafts", pt: "Artesanato" },
    "kiosko y tabaqueria": { en: "Kiosk & tobacco", pt: "Quiosque e tabacaria" },
    parrilladas: { en: "Grill", pt: "Parrillas" },
    asiatica: { en: "Asian cuisine", pt: "Cozinha asiática" },
    mediterranea: { en: "Mediterranean cuisine", pt: "Cozinha mediterrânea" },
    "otros servicios": { en: "Other services", pt: "Outros serviços" },
    gourmet: { en: "Gourmet", pt: "Gourmet" },
    "alto diseno": { en: "High design", pt: "Alto design" },
    "centros medicos": { en: "Medical centers", pt: "Centros médicos" },
    "casas de cambio": { en: "Currency exchange", pt: "Casas de câmbio" },
    "tiendas de musica": { en: "Music stores", pt: "Lojas de música" },
    francesa: { en: "French cuisine", pt: "Cozinha francesa" },
    peruana: { en: "Peruvian cuisine", pt: "Cozinha peruana" },
    italiana: { en: "Italian cuisine", pt: "Cozinha italiana" },
    saludable: { en: "Healthy food", pt: "Comida saudável" },
    lavanderia: { en: "Laundry", pt: "Lavanderia" },
    argentina: { en: "Argentine cuisine", pt: "Cozinha argentina" },
    supermercados: { en: "Supermarket", pt: "Supermercado" },
    supermercado: { en: "Supermarket", pt: "Supermercado" },
    "gimnasio y centros deportivos": { en: "Gym & sports centers", pt: "Academia e centros esportivos" },
  };

  function resolveLocale(raw) {
    if (global.SimaLocale && global.SimaLocale.resolveLocale) {
      return global.SimaLocale.resolveLocale(raw || global.SimaLocale.readLocaleFromPage());
    }
    var value = String(raw || global.MALL_LOCALE || "es").toLowerCase().trim();
    if (value.indexOf("en") === 0) return "en";
    if (value.indexOf("pt") === 0) return "pt";
    return "es";
  }

  function normKey(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function translateCategory(name, locale) {
    var resolved = resolveLocale(locale);
    var label = String(name || "").trim();
    if (!label || resolved === "es") return label;
    var pack = CATEGORY_LABELS[normKey(label)];
    if (pack && pack[resolved]) return pack[resolved];
    return label;
  }

  function translateCategoryList(rawCategories, locale) {
    return String(rawCategories || "")
      .split(",")
      .map(function (part) {
        return translateCategory(String(part || "").trim(), locale);
      })
      .filter(Boolean)
      .join(", ");
  }

  function translateDescription(storeId, text, locale, descriptionLocales) {
    var resolved = resolveLocale(locale);
    var description = String(text || "").trim();
    if (!description && descriptionLocales && descriptionLocales.es) {
      description = String(descriptionLocales.es).trim();
    }

    var id = String(storeId != null ? storeId : "").trim();
    if (id && overlay && overlay.stores && overlay.stores[id]) {
      var fromOverlay = overlay.stores[id][resolved];
      if (fromOverlay && String(fromOverlay).trim()) {
        return String(fromOverlay).trim();
      }
    }

    if (descriptionLocales && descriptionLocales[resolved]) {
      var fromEntry = String(descriptionLocales[resolved]).trim();
      if (fromEntry) return fromEntry;
    }

    if (!description || resolved === "es") return description;
    return description;
  }

  function overlayBase() {
    var base = global.MARKET_CATALOG_BASE || "../data/";
    if (base.charAt(base.length - 1) !== "/") base += "/";
    return base;
  }

  function loadJsonViaScript(url, globalName) {
    return new Promise(function (resolve, reject) {
      if (global[globalName] != null) {
        resolve(global[globalName]);
        return;
      }
      var script = document.createElement("script");
      script.async = true;
      script.src = url;
      script.onload = function () {
        if (global[globalName] != null) resolve(global[globalName]);
        else reject(new Error("i18n jsonp loaded but global missing: " + globalName));
      };
      script.onerror = function () {
        reject(new Error("i18n jsonp failed: " + url));
      };
      (document.head || document.documentElement).appendChild(script);
    });
  }

  function loadOverlay(force) {
    if (overlay && !force) return Promise.resolve(overlay);
    if (overlayPromise && !force) return overlayPromise;

    var url = overlayBase() + (global.MARKET_CATALOG_I18N_FILE || "market-catalog-i18n.json");
    var jsonpUrl = overlayBase() + (global.MARKET_CATALOG_I18N_JSONP_FILE || "market-catalog-i18n.jsonp.js");

    overlayPromise = fetch(url, { cache: "no-cache" })
      .then(function (response) {
        if (!response.ok) throw new Error("market i18n HTTP " + response.status);
        return response.json();
      })
      .catch(function () {
        return loadJsonViaScript(jsonpUrl, "__MARKET_CATALOG_I18N__");
      })
      .then(function (data) {
        overlay = data && typeof data === "object" ? data : { stores: {} };
        if (!overlay.stores) overlay.stores = {};
        return overlay;
      })
      .catch(function () {
        overlay = { stores: {} };
        return overlay;
      });

    return overlayPromise;
  }

  function isOverlayReady() {
    return !!overlay;
  }

  return {
    resolveLocale: resolveLocale,
    normKey: normKey,
    translateCategory: translateCategory,
    translateCategoryList: translateCategoryList,
    translateDescription: translateDescription,
    loadOverlay: loadOverlay,
    isOverlayReady: isOverlayReady,
  };
})(window);
