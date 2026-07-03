# Fix búsqueda de tiendas (Costanera) — diagnóstico y acciones

Diagnóstico a partir del `logcat` de la build `2026.07.02-1` corriendo en emulador
(BlueStacks / Android WebView). Explica por qué "McDonald's" y otras búsquedas
no devuelven resultados, y separa lo ya corregido en la webapp de lo que debe
corregir el equipo Unity.

---

## 1. Causa raíz

El WebView carga la app desde `file://`:

```
file:///storage/emulated/0/Android/data/com.SimaRobot.CencoMallAssistant/files/
       sima_html_cache/cencomall/releases/2026.07.02-1/mobility/index.html
```

Y **el WebView bloquea `fetch()`/XHR sobre `file://`**. En el log:

```
Fetch API cannot load file:///.../shared/store-logos/store-logos.manifest.json.
URL scheme "file" is not supported.
[MapVxBridge] store logo manifest loaded {"entries":0}      ← 0 entradas
[MapVxBridge] market catalog prefetch failed {"error":"Failed to fetch"}
runMarketCatalogSearch failed TypeError: Failed to fetch
market catalog search failed: Failed to fetch
```

Consecuencias:

- **`market-catalog.json` nunca carga** → el buscador web (`MarketSearch`) queda
  vacío → **toda búsqueda del lado web devuelve 0 resultados**.
- **`store-logos.manifest.json` carga 0 entradas** → los logos locales (Zara,
  Jumbo, H&M, etc.) **no se renderizan** en esta build.

> El buscador web en sí está bien: para "mcdonald" hace match compacto por
> prefijo contra `Mc Donald's` (score ~980). El problema era solo que el
> catálogo no cargaba.

### Caso "McDonald's" paso a paso (del log)

1. Usuario dice `mcdonald`.
2. GPT responde correcto: `action=open_store_navigation`, `args.extra="mcdonald"`,
   mensaje "Te muestro cómo llegar a McDonald's."
3. Unity `MarketCatalogBridge`: `OpenNavigation query=mcdonald` →
   **`sin resultados → OpenSearch`** (la búsqueda C# no matcheó `Mc Donald's`).
4. Cae al buscador web → `Failed to fetch` → no se muestra nada.

Doble falla: (a) la búsqueda C# no normaliza igual que la web, y (b) el fallback
web estaba roto por el `fetch` bloqueado.

---

## 2. Corregido en la webapp (este repo)

Ya no dependemos de `fetch` para los JSON locales. `loadCatalog()` y
`loadStoreLogoManifest()` intentan `fetch` y, si falla (file://), cargan un
**companion `.js` vía `<script>`** (los `<script src>` sí funcionan bajo file://):

- `data/market-catalog.jsonp.js` → `window.__MARKET_CATALOG__ = [...]`
- `shared/store-logos/store-logos.manifest.jsonp.js` → `window.__STORE_LOGO_MANIFEST__ = {...}`

Estos companions se generan con:

```
node tools/build-jsonp-assets.mjs
```

> IMPORTANTE: cada vez que se actualice `market-catalog.json` o
> `store-logos.manifest.json`, hay que **re-ejecutar el generador** para
> mantener los `.jsonp.js` sincronizados. (Idealmente encadenarlo en el pipeline
> que refresca el catálogo / arma el release OTA.)

Con esto, la webapp funciona aunque el WebView siga bloqueando `fetch`.

---

## 3. Acciones para el equipo Unity

### 3.1 (Recomendado) Habilitar acceso a archivos en el WebView

La corrección de raíz, de una línea: al configurar el WebView, activar

```java
webView.getSettings().setAllowFileAccessFromFileURLs(true);
webView.getSettings().setAllowUniversalAccessFromFileURLs(true);
```

Esto restaura `fetch()` sobre `file://` y arregla **catálogo + logos** sin
depender de los companions. (Los companions quedan como respaldo, no molestan.)

### 3.2 Normalizar la búsqueda C# igual que la web

`MarketCatalogBridge` / `MarketSearchCache` decide navegación-directa vs.
búsqueda ANTES de pasar al web, y hoy no encuentra tiendas que la web sí
encuentra. Debe normalizar con la misma regla:

1. minúsculas
2. quitar tildes (NFD + strip diacríticos)
3. reemplazar todo lo no `[a-z0-9]` por espacio y colapsar espacios
4. comparar también en forma **compacta** (sin espacios): `mcdonald` debe
   matchear `Mc Donald's` → `mc donald s` → compacto `mcdonalds`
   (match por prefijo compacto).

Ejemplos del log que hoy fallan o degradan a OpenSearch cuando deberían navegar:

| Query usuario                     | Catálogo real   | Resultado actual                    |
|-----------------------------------|-----------------|-------------------------------------|
| `mcdonald`                        | `Mc Donald's`   | sin resultados → OpenSearch         |
| `quiero comer mcdonald`           | `Mc Donald's`   | "varias tiendas posibles (2)"       |

### 3.3 Criterio navegación directa vs. lista

Cuando hay varias sucursales de la **misma marca** (p. ej. Jumbo con 2
locales, Paris en varios niveles), Unity manda a OpenSearch:

```
OpenNavigation: varias tiendas posibles (2) query="jumbo" → OpenSearch para elegir
```

Definir el comportamiento deseado: si es la **misma marca** en varios niveles,
conviene navegar a la más cercana (o mostrar una tarjeta agrupada) en vez de
forzar al usuario a elegir. Sólo abrir lista cuando son marcas distintas.

---

## 4. Verificación sugerida tras el próximo release

1. Confirmar en logcat: `market catalog ready count=<N>` y
   `store logo manifest loaded {"entries":<N>}` con N > 0.
2. Probar por voz/texto: `mcdonald`, `quiero comer mcdonald`, `jumbo`,
   `quiero comprar zapatillas` → deben devolver resultados/navegación.
3. Confirmar que los logos locales (Zara, Jumbo, H&M, Paris) se ven en el mapa.
