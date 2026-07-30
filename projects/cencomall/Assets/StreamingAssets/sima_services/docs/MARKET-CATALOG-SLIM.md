# Market catalog slim (Cencomall OTA)

## Qué es

El listado OTA (`data/market-catalog.json` + `.jsonp.js`) es una **proyección slim** del API Market de Cencomalls. El HTML busca y abre mapa con este archivo; el detalle pesado se pide al seleccionar tienda.

## Campos del listado (obligatorios)

| Campo | Uso |
| --- | --- |
| `id` | CMS id (detalle `GET /api/market/{id}`) |
| `local` | Código MapVX (ej. `CC_N5_5560`) — **sin esto no hay mapa** |
| `brand_name` / `market_name` | Nombre en UI y scoring |
| `keywords` | Scoring multi-token |
| `brand_categories` (+ level1 / sub) | Categorías / filtros |
| `market_levels` | Piso / nivel |
| `renovation` | Disponibilidad |
| `mall` | Mall slug |
| `brand_logo` | Opcional UI (URL relativa) |

Fuera del listado: `brand_description`, fotos, horarios, redes, email, website, etc.

## Regenerar y publicar

### Desde el catálogo actual (re-slim)

```bash
node tools/build-market-catalog-slim.mjs
```

### Desde un dump local (export API)

```bash
node tools/build-market-catalog-slim.mjs --from-file "./Api Market.json"
```

### Desde API staging (requiere token)

```bash
export CENCOMALLS_API_TOKEN="…"
# opcional: export CENCOMALLS_MARKET_API_URL="https://stg.cencomalls.cl/api/market?mall=costanera"
node tools/build-market-catalog-slim.mjs --fetch
```

El script escribe el JSON slim y regenera los companions JSONP (`tools/build-jsonp-assets.mjs`).

### Publicar OTA

```bash
npm run build:manifests -- --project cencomall
# seguir docs/pre-push-checklist.md / docs/runtime-html-sync.md
```

## Detalle en runtime

Al seleccionar tienda, `mobility/index.html` intenta:

`GET {CENCOMALL_SITE_ORIGIN|/stg.cencomalls.cl}/api/market/{id}`

Con auth opcional inyectada por RN:

- `window.CENCOMALL_MARKET_API_TOKEN` → `Authorization: Bearer …`
- `window.CENCOMALL_MARKET_API_BASE` → override de base URL

El mapa usa `local` del resultado de búsqueda **sin esperar** al detail fetch.

## Inject legacy desde RN

`MarketSearch.setCatalog(items)` acepta un array; exige/preserva `id` + `local` en cada ítem. Preferencia a medio plazo: HTML dueño del slim OTA; inject RN es compat/legacy.
