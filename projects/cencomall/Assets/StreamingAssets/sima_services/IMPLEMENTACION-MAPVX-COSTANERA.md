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

### 1.6 Optimización de performance para tótems (etiquetas por piso + timeline de logs)

**Problema detectado:** en modo de etiquetas `"all"` (zoom profundo), el bridge construía un marcador
DOM por cada tienda de **todo el mall** (~400+) de una sola vez, sin importar el piso visible. Revisando
el SDK (`shared/mapvx/index.js`) se confirmó que **cada cambio de piso** (`updateFiltersTo` /
`updateMarkersTo`) itera **todos** los markers vivos (`this.markers.forEach(...changeFloor...)`), y
además remueve/vuelve a agregar capas de MapLibre GL para el piso nuevo — un costo real de GPU/CPU
propio del SDK que no podemos evitar desde el bridge. Con cientos de markers vivos, cada cambio de piso
se volvía más lento de lo necesario, y la primera vez que se activaba el modo `"all"` (p. ej. al abrir
una tienda con zoom profundo) generaba una ráfaga de creación de markers notoria en tótems de bajo
rendimiento.

**Fix:** el modo `"all"` ahora sólo construye etiquetas para el **piso actualmente activo**
(`storeLabelState.allModeFloorId`), no para todo el mall. Al cambiar de piso mientras se está en modo
`"all"`, `switchFloor` fuerza un rebuild acotado al nuevo piso (`evaluateStoreLabelZoom(..., true)`).
Visualmente no cambia nada (las tiendas de otros pisos no se veían de todas formas hasta cambiar de
piso), pero reduce drásticamente el total de markers vivos que el SDK debe reposicionar/iterar.

**Timeline de performance real:** todas las líneas de `log()` del bridge ahora incluyen el tiempo
transcurrido desde que se cargó el script (`+1234ms mensaje`), así que el logging ya existente
(`ensureReady`, `createMap`, `ensureIndoorMapReady`, `refreshStoreLabels`, `switchFloor`, etc.) sirve
como línea de tiempo real de dónde se va el tiempo en el tótem, sin adivinar. Activar con
`MAPVX_CONFIG.debugMapvx = true` (o `mapvxVerboseLog`) para verlo en consola / `SimaBridge`.

**Tope de markers en modo "all" (antes ignorado):** se detectó que el código forzaba
`storeLabelMax: 0` (sin límite) cada vez que se entraba a modo `"all"`, sin importar lo que se
configurara en Unity. Ahora respeta `MAPVX_CONFIG.storeLabelMax` si viene seteado, y si no, usa un
default de **60** markers (`getAllModeLabelLimit`) — pensado para el hardware real del tótem (ver
`4. Hardware del tótem` abajo). Ajustable sin tocar código.

### 1.7 Hardware real del tótem (ficha técnica Dimacofi KS-IOT550RA-W)

La ficha técnica del proveedor solo especifica la **CPU** (`RK3576 / KR3566`, dos variantes de SoC
Rockchip posibles), no la GPU. La GPU se infirió y se verificó contra las datasheets oficiales de
Rockchip (no es un dato del fabricante del tótem, es conocimiento del SoC):

| SoC | CPU | GPU (datasheet Rockchip) | Fill rate |
|---|---|---|---|
| RK3566 | Quad-core Cortex-A55 @ 1.8GHz | Mali-G52 **1-Core-2EE** @ hasta 800MHz | 1600 Mpix/s, 38.4 GFLOPS |
| RK3576 | 4x Cortex-A72 + 4x Cortex-A53 | Mali-G52 **MC3** (3 núcleos) @ hasta 1GHz | Notablemente más potente que la variante RK3566 |

Ambas son GPUs de gama baja/media pensadas para señalética digital (UI 2D, video), no para
renderizado 3D/WebGL pesado — pero hay una diferencia real entre las dos variantes (RK3576 es bastante
más capaz, con NPU de 6 TOPS vs 0.8 TOPS). Vale la pena confirmar con el proveedor **cuál de las dos
llega finalmente**, porque cambia el margen de maniobra.

Confirmado directamente por Juan (no inferido):

| Componente | Confirmado |
|---|---|
| Pantalla | **1080p (Full HD) al 100%**, no 4K — descarta la preocupación de fill-rate 4x por 4K |
| Red | Probablemente Ethernet, pero **hay que asumir que algunos tótems pueden estar por Wi-Fi 2.4GHz** |

Resto de la ficha (sin cambios): 4 GB RAM, 32 GB almacenamiento, Android, Wi-Fi 802.11 b/g/n 2.4GHz +
Ethernet RJ-45 disponible.

### 1.8 Logos ancla mal centrados en tiendas multi-piso (Falabella, Ripley, H&M, Jumbo...)

**Causa raíz encontrada:** MapVX solo expone **un punto (`place.position`) por tienda**, no uno por
piso. `buildStoreLabelMarkers` reutilizaba esa misma coordenada para el marker de **cada** piso que
ocupa la tienda — por eso el logo quedaba bien centrado en un piso (el que coincidía con esa
coordenada) y desalineado en el resto.

Ya existía un sistema de corrección (`queryPOICentroids` / `applyFeaturedCentroids`) que ajusta la
posición leyendo el punto real de la capa `indoor-poi-rank1` una vez el mapa termina de renderizar,
pero tenía dos bugs que lo inutilizaban para multi-piso:

1. Usaba `querySourceFeatures` (lee **todos** los tiles cargados, ignorando el filtro de piso activo).
   Si el mismo `ref`/mapvxId aparecía en más de un piso, la corrección podía aplicar la coordenada de
   **otro piso** por error.
2. La corrección se aplicaba a todos los markers de esa tienda sin distinguir piso, y una vez el
   contador global de "aplicados" llegaba a completarse (aunque fuera con datos cruzados), el listener
   se desconectaba — sin reintentar nunca en los pisos que el usuario aún no había visitado.

**Fix:** `queryPOICentroids` ahora usa solo `queryRenderedFeatures` (respeta el filtro de piso activo
del SDK), `applyFeaturedCentroids` recibe el `floorId` consultado y solo corrige markers de **ese**
piso, y `switchFloor` vuelve a armar el listener de corrección (`attachCentroidUpdater`) en cada
cambio de piso — así cada piso de una tienda ancla se centra con el punto real de **su propio**
polígono la primera vez que el usuario lo visita, sin tocar el tamaño fijo del logo (eso no cambió).

**Límite honesto:** esto depende de que el piso tenga un punto POI mapeado en `indoor-poi-rank1` para
esa tienda. Si el dataset del mall no tiene ese punto para un piso específico, ese piso se queda con el
`place.position` genérico (igual que antes — no empeora, pero tampoco mejora ese caso puntual).
Verificable en vivo con `MapVxBridge._debugCentroids()` (piso por piso, revisando `featuredPlaces` y
si `applied: true`).

**Recomendaciones de infraestructura (no requieren cambios de código):**

- Como no podemos garantizar que todos los tótems estén por Ethernet, el bridge debe asumir el
  escenario más lento (Wi-Fi 2.4GHz) al decidir timeouts/reintentos de red — revisar que las esperas
  de `ensureIndoorMapReady`/`getSubPlacesCached` tengan margen suficiente para eso (ver timeline de
  logs, sección 1.6).
- Ya no aplica la recomendación de bajar a 1080p — está confirmado que ya se despliega así, por lo que
  el fill-rate de la GPU no se ve exigido por 4K.

---

### 1.9 Rotación fija por marca en logos ancla (para calzar con el ángulo del polígono)

Comparando con el mapa oficial de Cencosud (referencia visual del usuario), varias anclas no solo
necesitan reposicionarse — su logo está **rotado** para seguir el ángulo del contorno de la tienda
(ej. "RIPLEY" se lee vertical, de arriba hacia abajo). Los markers del bridge se construyen siempre con
`rotationAlignment: "viewport"` (se mantienen "de pie" en pantalla sin importar el bearing del mapa), así
que no existía forma de inclinar un logo de forma fija por marca.

**Fix:** se agregó un campo `rotation` (grados, sentido horario) al tratamiento de logo en
`store-logos.manifest.json`, resuelto en `getLocalStoreLogoTreatment` y aplicado en
`buildAnchorLogoElement` como parte del mismo `transform` que ya maneja `offsetX`/`offsetY`
(`translate(...) rotate(...)` — el translate ocurre primero, así que offsetX/offsetY se siguen leyendo
en px de pantalla sin importar si además hay rotación). Es puramente cosmético: no toca el anclaje
geográfico (`place.position` / corrección de centroide por piso de la sección 1.8), solo la orientación
visual del logo dentro de su caja.

**Aplicado:** `ripley` → `rotation: 90` (texto pasa de horizontal a vertical, R arriba / Y abajo).

**Límite importante encontrado al revisar los PNG actuales:**

| Marca | Asset actual | ¿Rotar sirve? |
|-------|--------------|----------------|
| Ripley | Wordmark plano "RIPLEY" | Sí — ya es solo texto, rotar 90° lo deja vertical como la referencia |
| H&M / Zara | Wordmark plano horizontal | No hace falta — en la referencia también están horizontales |
| Paris | Círculo "paris cencosud" | No hace falta — ya es centrado/circular, sin orientación que calzar |
| Falabella | ~~Ícono cuadrado verde con "f." cursiva~~ → reemplazado por el wordmark "falabella." (PNG entregado por el usuario, `falabella-wordmark.png`) | Sí — con el wordmark correcto, `rotation` sí logra el efecto diagonal de la referencia. |

---

### 1.10 Ajustes de offset/rotation por piso (`perFloor`) para anclas multi-piso

Aun con la corrección de centroide de la sección 1.8 (que ubica el punto **geográfico** correcto por
piso), el tratamiento **cosmético** del logo (`offsetX`/`offsetY`/`scale`/`rotation`) seguía siendo un
solo valor fijo por marca aplicado a todos sus pisos por igual. Como el polígono de una tienda no tiene
la misma forma en cada piso (ej. H&M es más angosto del lado derecho en Nivel 2 que en Nivel 3), un
`offsetX` afinado a ojo para un piso podía sacar el logo del polígono en otro piso — caso reportado:
H&M se veía bien centrado en Nivel 3 pero muy corrido a la derecha (casi saliéndose del mapa) en Nivel 2.

**Fix:** `store-logos.manifest.json` ahora acepta un campo opcional `perFloor` dentro de cada entrada,
con overrides de `offsetX`/`offsetY`/`scale`/`rotation` para un piso específico (clave = label del piso,
ej. `"Nivel 2"`). `getLocalStoreLogoTreatment` combina primero los valores base de la marca y luego
aplica el override del piso activo si existe. El match de la clave es tolerante: compara el texto
normalizado y, si no calza literal, compara solo el número de piso extraído (para no depender del
formato exacto que entregue MapVX — "Nivel 2", "N2", "Piso 2" matchean igual).

Como consecuencia, `buildAnchorLogoElement` ahora recibe el label del piso activo y
`buildStoreLabelMarkers` construye el elemento del logo **por piso** (antes se construía una sola vez
por tienda y se clonaba para cada piso) — necesario para que el override por piso realmente tenga efecto
en cada marker. Sin impacto de performance relevante: solo aplica a tiendas `featured` (anclas), que son
un puñado por mall.

**Aplicado:** `h&m` (y sus alias `h m`/`hm`) → `perFloor: { "Nivel 2": { offsetX: 20 } }` (base
`offsetX: 110`, pensado para Nivel 3).

**Cómo depurar/ajustar en terreno:** con `MAPVX_CONFIG.debugMapvx = true`, cada vez que se construye el
logo de una tienda featured se loguea `anchorLogo floor treatment` con el label exacto del piso y los
valores resueltos — así se sabe con certeza qué string usar como clave de `perFloor` sin adivinar el
formato que entrega el SDK para ese mall.

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
