# Implementación MapVX — Cenco Costanera

Documentación de las mejoras al mapa indoor, búsqueda de tiendas y UX del totem/mobility para el mall Cenco Costanera.

**Branch:** `juan-dev-ai`  
**Base:** `main` @ `8718eb2`  
**Ámbito:** `projects/cencomall/Assets/StreamingAssets/sima_services/`

---

## Resumen

Se implementaron tres bloques principales:

1. **Mapa MapVX** — etiquetas de tiendas por zoom, logos en anclas, ocultar iconos POI de retail/restaurantes.
2. **Búsqueda de tiendas** — catálogo local (`Api Market.json`) consultable desde el HTML sin depender solo de Unity.
3. **Integración mobility** — pantalla de búsqueda, apertura de mapa por `local` MapVX y comportamiento de zoom coherente con el totem.

La configuración sensible (`apiKey`, `parentPlace`, `institutionId`, `totemPlaceId`) sigue inyectándose desde Unity vía `window.MAPVX_CONFIG` en producción. En browser de desarrollo se usa el panel de `map/index.html` con `sessionStorage`.

---

## 1. Mapa MapVX (`mapvx-bridge.js`)

### 1.1 Etiquetas de tiendas por zoom

El bridge agrega markers de texto sobre el mapa usando la API nativa de MapVX (`addMarker`). Comportamiento:

| Zoom | Modo | Qué se muestra |
|------|------|----------------|
| Alejado (baseline) | `featured` | Solo tiendas ancla (Falabella, Ripley, Zara, etc.) con logo o fallback tipográfico |
| Acercado (+Δ zoom) | `all` | Nombres de todas las tiendas del piso actual |

**Configuración (`MAPVX_CONFIG`):**

```js
{
  showStoreLabels: "featured",   // "featured" | "all" | "none"
  storeLabelMax: 0,              // 0 = sin límite en modo "all"
  storeLabelZoomDelta: 2         // niveles de zoom extra para pasar a "all"
}
```

**Lógica:**

- Tras `fitMapToPlace` o abrir una tienda, se guarda `zoomBaseline`.
- Un listener en `zoom` / `zoomend` del mapa MapLibre compara `currentZoom - baseline >= storeLabelZoomDelta`.
- Al alejar de nuevo, vuelve a `featured` (solo anclas).
- Los nombres se resuelven con `MarketSearch.getBrandByLocal(local)` cuando el catálogo está cargado; si no, se usa el título MapVX sin sufijo `- N3 - CC`.

**Centroides:** para tiendas destacadas, el marker se reposiciona al centro del polígono consultando features de `indoor-poi-rank1` (`queryPOICentroids`).

### 1.2 Logos en tiendas ancla

Soporte opcional de PNG/SVG locales:

- Carpeta: `shared/store-logos/`
- Manifiesto: `store-logos.manifest.json` (clave normalizada → archivo)
- Base URL configurable: `MAPVX_CONFIG.storeLogosBase` o `../shared/store-logos/`

Si no hay imagen, se usa **fallback tipográfico** (inicial o abreviatura de marca con estilo por tienda).

> Los iconos circulares de camiseta/carrito que se veían antes **no eran logos locales**: son símbolos POI del estilo MapVX/IndoorEqual.

### 1.3 Ocultar iconos POI de tiendas y restaurantes

Los iconos feos (camiseta, carrito, etc.) vienen de la capa nativa **`indoor-poi-rank1`** (IndoorEqual). Se filtran clases retail/comida sin tocar servicios.

**Se ocultan** (ejemplos de `class`): `shop`, `clothing_store`, `grocery`, `cafe`, `fast_food`, `bar`, etc.

**Se mantienen:**

- `indoor-poi-rank2` — expendedoras, información, bancos de basura, etc.
- `indoor-transportation-poi` — escaleras, ascensores, escaleras mecánicas

El filtro se reaplica en:

- Carga inicial del mapa (`ensureIndoorMapReady`)
- Apertura de tienda (`showPlace`, cambio de piso)
- Cambio manual de piso (`switchFloor`)

**Config:** `hideRetailPoiIcons: false` desactiva el filtro (por defecto está activo).

**Debug en consola:**

```js
MapVxBridge._debugPoiLayers()
MapVxBridge._debugCentroids()
MapVxBridge._debugStoreLogos()
MapVxBridge._refreshStoreLabels("all")  // forzar modo etiquetas
```

### 1.4 Otras capacidades del bridge (sin cambio de contrato)

- `showPlace` / `showRouteTo` — abrir tienda y opcionalmente dibujar ruta desde totem
- `switchFloor` — cambio de piso con re-highlight y popover
- `showPlacePopOver` — popup HTML sobre la tienda seleccionada
- Límites de zoom y `fitMapToPlace` para encuadrar locales

### 1.5 Velocidad de la ruta animada (`drawRouteToTarget`)

Los defaults del SDK de MapVX (`stepTime: 3`, `minimumSpeed: 40`, `changeFloorTime: 0`) hacían que la
ruta se trazara muy rápido y que el cambio de piso (escaleras/ascensores) ocurriera sin pausa, lo que en
tótems de bajo rendimiento se veía a tirones porque el mapa del nuevo piso aún no terminaba de renderizar.

El bridge ahora aplica valores más lentos y agrega una pausa en cada cambio de piso antes de continuar.
Son overrideables desde `MAPVX_CONFIG` sin tocar código:

```js
MAPVX_CONFIG.routeStepTime = 4.5;        // seg. por tramo recto (SDK default: 3, mayor = más lento)
MAPVX_CONFIG.routeMinimumSpeed = 25;      // velocidad mínima para tramos cortos (SDK default: 40)
MAPVX_CONFIG.routeChangeFloorTime = 1.4;  // seg. de pausa al subir/bajar piso (SDK default: 0)
MAPVX_CONFIG.routeIconRotationTime = 0.35; // seg. de transición al girar el ícono en curvas (SDK default: 0)
MAPVX_CONFIG.routeKeepFixedBearing = false;
```

Si en el tótem real la ruta sigue viéndose entrecortada, subir `routeChangeFloorTime` (p.ej. a `2`) da más
margen para que el piso siguiente termine de dibujarse antes de reanudar la animación.

---

## 2. Búsqueda de tiendas (`market-search.js`)

Módulo cliente `window.MarketSearch` que indexa el catálogo Cenco en JSON.

### API

| Método | Descripción |
|--------|-------------|
| `loadCatalog()` | Carga `../data/market-catalog.json` (async) |
| `search(query, { limit })` | Scoring por nombre, keywords, `local`, id |
| `getBrandByLocal("CC_N3_3129")` | Nombre de marca para etiquetas del mapa |
| `getCatalogSize()` | Cantidad de entradas cargadas |

### Rutas configurables

```js
window.MARKET_CATALOG_BASE = "../data/";
window.MARKET_CATALOG_FILE = "market-catalog.json";
```

### Catálogo (`data/market-catalog.json`)

- **411 tiendas** exportadas desde `Api Market.json`
- Cada entrada incluye `local` (código MapVX, ej. `CC_N5_5560`), `brand_name`, categorías, keywords, horarios, etc.
- Tamaño ~646 KB

> Hay 2 `local` duplicados en el JSON (`CC_N1_1125`, `CC_N2_2176`); `getBrandByLocal` usa la última entrada indexada.

---

## 3. Mobility / totem (`mobility/index.html`)

### Búsqueda integrada

- Script `market-search.js` cargado en el head
- `runMarketCatalogSearch(query)` — busca y renderiza resultados en la UI
- `prefetchMarketCatalog()` — precarga al iniciar la pantalla
- Compatible con flujo Unity: `pushMarketSearchFromUnity`, `SimaBridge.send("market_search", …)`

### Apertura de mapa

`openPoiMapViaMapVx` usa `MapVxBridge.showPlace` o `showRouteTo` con:

- `local` — preferido (código MapVX)
- `id` — id catálogo Cenco (fallback)
- `name` / `floor` — fallbacks adicionales

Al abrir mapa se fuerza:

```js
MAPVX_CONFIG.showStoreLabels = "featured";
MAPVX_CONFIG.storeLabelMax = 0;
MAPVX_CONFIG.storeLabelZoomDelta = 2;
```

### Versión UI

Comentario de build: `mobility-ui-v26-market-search` / `OTA market-search v1`

---

## 4. Pantalla de prueba (`map/index.html`)

Herramienta de desarrollo en browser:

- Panel para api-key, `parentPlace`, `institutionId` (guardado en `sessionStorage`)
- Campos: `local` MapVX, id catálogo, nombre, piso
- Botones: mostrar tienda, ruta, refrescar etiquetas
- Requiere servidor HTTP local (no `file://` por CORS)

```bash
cd projects/cencomall/Assets/StreamingAssets/sima_services
npx http-server -p 8765 -c-1
# http://127.0.0.1:8765/map/index.html
# http://127.0.0.1:8765/mobility/index.html?mode=store_search
```

---

## 5. Estilos (`shared/mapvx/styles.css`)

Estilos añadidos para:

- Markers MapVX (`.mapvx-marker`, contenedores de texto)
- Logos ancla (`.store-anchor-logo`, fallback tipográfico)
- Popover de tienda (`.mapvx-place-popover`)

---

## 6. Archivos del cambio

| Archivo | Rol |
|---------|-----|
| `shared/mapvx-bridge.js` | Wrapper principal: etiquetas, POI, logos, zoom |
| `shared/market-search.js` | Motor de búsqueda cliente |
| `data/market-catalog.json` | Datos de 411 tiendas |
| `shared/store-logos/store-logos.manifest.json` | Mapa nombre → PNG (assets pendientes) |
| `mobility/index.html` | UI totem + búsqueda + mapa |
| `map/index.html` | Pantalla de prueba dev |
| `shared/mapvx/styles.css` | CSS markers y popover |

---

## 7. Producción Unity

### Lo que inyecta C# (`MAPVX_CONFIG`)

Mínimo requerido:

- `apiKey`
- `parentPlace` — Costanera: `-N19VjzEVIj2RDKu7i4r`
- `institutionId`
- `totemPlaceId` — origen de rutas (desde `CencomallApiConfig`)

Opcional para mapa:

- `showStoreLabels`, `storeLabelZoomDelta`, `storeLabelFeatured` (lista de anclas)
- `hideRetailPoiIcons` (default `true`)

### Pendientes conocidos

- Subir PNGs reales a `shared/store-logos/` (Falabella, Ripley, Paris, etc.)
- Archivos `.meta` de Unity para carpetas/archivos nuevos (se generan al abrir el proyecto)
- Floor switcher UI en mobility (badge de piso existe; selector completo en standby)

---

## 8. Checklist de prueba

- [ ] Mapa carga Costanera (no mapa del mundo)
- [ ] Zoom out: solo anclas / logos
- [ ] Zoom in: nombres de tiendas legibles
- [ ] Sin iconos circulares de retail sobre tiendas
- [ ] Baños, escaleras, expendedoras siguen visibles
- [ ] Búsqueda "Mango" / "Falabella" devuelve resultados
- [ ] Abrir tienda desde resultado centra mapa y resalta polígono
- [ ] Ruta funciona si `totemPlaceId` está configurado
- [ ] Cambio de piso no restaura iconos retail

---

## 9. Referencias técnicas

- **IndoorEqual layers:** `indoor-poi-rank1` (retail filtrado), `indoor-poi-rank2` (servicios), `indoor-transportation-poi` (vertical circulation)
- **MapVX SDK:** `shared/mapvx/index.js` (no editar salvo actualización de versión)
- **Bridge público:** `window.MapVxBridge`
