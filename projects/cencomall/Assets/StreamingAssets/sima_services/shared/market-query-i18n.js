/**
 * Maps EN/PT voice queries to Spanish catalog search terms (keywords/categories).
 */
window.MarketQueryI18n = (function () {
  var TOKEN_ALIASES = {
    restroom: "banos",
    bathroom: "banos",
    bathrooms: "banos",
    toilet: "banos",
    toilets: "banos",
    wc: "banos",
    banheiro: "banos",
    banheiros: "banos",
    food: "gastronomia restaurante",
    restaurant: "restaurante",
    restaurants: "restaurante",
    dining: "gastronomia",
    comida: "gastronomia",
    restaurante: "restaurante",
    restaurantes: "restaurante",
    almoco: "gastronomia",
    almoço: "gastronomia",
    jantar: "gastronomia",
    lunch: "gastronomia",
    dinner: "gastronomia",
    shoes: "calzado zapatillas",
    shoe: "calzado",
    sneakers: "zapatillas calzado",
    sneaker: "zapatillas",
    footwear: "calzado",
    sapato: "calzado",
    sapatos: "calzado",
    tenis: "calzado zapatillas",
    clothing: "vestuario moda",
    clothes: "vestuario",
    apparel: "vestuario",
    fashion: "moda vestuario",
    roupa: "vestuario",
    roupas: "vestuario",
    moda: "moda vestuario",
    pharmacy: "farmacia",
    pharmacies: "farmacia",
    drugstore: "farmacia",
    farmacia: "farmacia",
    remedio: "farmacia",
    atm: "cajero banco",
    bank: "banco cajero",
    banco: "banco cajero",
    information: "informacion servicios",
    info: "informacion",
    informacao: "informacion",
    parking: "estacionamiento",
    estacionamento: "estacionamiento",
    car: "estacionamiento",
    kids: "infantil",
    children: "infantil",
    infantil: "infantil",
    criancas: "infantil",
    crianças: "infantil",
    cinema: "cine entretencion",
    movie: "cine entretencion",
    movies: "cine entretencion",
    entertainment: "entretencion",
    supermarket: "supermercado jumbo",
    supermercado: "supermercado",
    grocery: "supermercado",
    coffee: "cafeteria starbucks",
    cafe: "cafeteria",
    cafeteria: "cafeteria",
    beauty: "belleza",
    cosmetics: "belleza",
    beleza: "belleza",
    makeup: "belleza",
    jewelry: "joyeria",
    joias: "joyeria",
    watch: "relojeria",
    watches: "relojeria",
    electronics: "tecnologia",
    technology: "tecnologia",
    tecnologia: "tecnologia",
    phone: "telefonia",
    celular: "telefonia",
    optician: "optica",
    glasses: "optica",
    oculos: "optica",
    óculos: "optica",
    home: "hogar",
    casa: "hogar",
    sports: "deportes",
    esportes: "deportes",
    gym: "gimnasio deportes",
    academia: "gimnasio",
    ice: "heladeria",
    cream: "heladeria",
    sorvete: "heladeria",
    heladeria: "heladeria",
    pizza: "pizza gastronomia",
    burger: "hamburguesa gastronomia",
    hamburguer: "hamburguesa",
    hamburguesa: "hamburguesa",
    sushi: "sushi gastronomia",
    chinese: "asiatica",
    japanese: "asiatica",
    mexican: "americana",
    chilean: "chilena",
  };

  var PHRASE_ALIASES = [
    { re: /\b(where is|where's|where are|find the|find me|search for|look for|i want|i need|show me|quiero|buscar|busca|donde esta|dónde está|onde fica|onde esta|onde está|me mostra|mostre|me muestra|muestrame|muéstrame|podrias|podrías|puedes|puede|decirme|dime|necesito|busco|hay algun|hay algún|hay una|hay un|tienda de|local de|ir a|comer en|comer algo|comprar en|llevame|llévame|llevame a|llévame a)\b/gi, rep: " " },
    { re: /\b(the|a|an|el|la|los|las|un|una|unos|unas|o|a|os|as|um|uma|de|del|da|do|em|no|na|en|al|para|por|con|que|qué|algo|rico|rica|bueno|buena|some|any)\b/gi, rep: " " },
  ];

  var STOP_TOKENS = {
    quiero: true,
    buscar: true,
    busca: true,
    tienda: true,
    tiendas: true,
    local: true,
    mall: true,
    centro: true,
    comercial: true,
    donde: true,
    esta: true,
    estan: true,
    hay: true,
    algo: true,
    rico: true,
    comer: true,
    comprar: true,
    need: true,
    want: true,
    find: true,
    store: true,
    shop: true,
  };

  function resolveLocale(raw) {
    if (window.SimaLocale && window.SimaLocale.resolveLocale) {
      return window.SimaLocale.resolveLocale(raw || window.SimaLocale.readLocaleFromPage());
    }
    return "es";
  }

  function normalizeToken(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stripVoicePhrases(query) {
    var cleaned = String(query || "").trim();
    if (!cleaned) return cleaned;
    PHRASE_ALIASES.forEach(function (rule) {
      cleaned = cleaned.replace(rule.re, rule.rep);
    });
    return cleaned.replace(/\s+/g, " ").trim();
  }

  function extractSignificantTokens(query) {
    var norm = normalizeToken(stripVoicePhrases(query));
    if (!norm) return "";
    var tokens = norm.split(" ").filter(function (token) {
      return token.length >= 2 && !STOP_TOKENS[token];
    });
    if (!tokens.length) return "";
    if (tokens.length === 1) return tokens[0];
    return tokens.join(" ");
  }

  function prepareVoiceQuery(query, locale) {
    var original = String(query || "").trim();
    if (!original) return original;

    var stripped = stripVoicePhrases(original);
    var resolved = resolveLocale(locale);

    if (resolved !== "es") {
      return expandForCatalogSearch(stripped || original, locale);
    }

    var seed = extractSignificantTokens(stripped || original);
    return seed || stripped || original;
  }

  function expandForCatalogSearch(query, locale) {
    var original = String(query || "").trim();
    if (!original) return original;

    var resolved = resolveLocale(locale);
    var cleaned = stripVoicePhrases(original);
    if (!cleaned) cleaned = original;

    if (resolved === "es") {
      return extractSignificantTokens(cleaned) || cleaned || original;
    }

    var norm = normalizeToken(cleaned);
    if (!norm) return original;

    if (TOKEN_ALIASES[norm]) return TOKEN_ALIASES[norm];

    var tokens = norm.split(" ").filter(Boolean);
    var mapped = [];
    tokens.forEach(function (token) {
      if (TOKEN_ALIASES[token]) {
        mapped.push(TOKEN_ALIASES[token]);
      } else if (token.length >= 2) {
        mapped.push(token);
      }
    });

    var expanded = mapped.join(" ").replace(/\s+/g, " ").trim();
    return expanded || cleaned || original;
  }

  return {
    expandForCatalogSearch: expandForCatalogSearch,
    prepareVoiceQuery: prepareVoiceQuery,
    extractSignificantTokens: extractSignificantTokens,
    normalizeToken: normalizeToken,
  };
})();
