# Informe de avances — MapVX y búsqueda de tiendas (Cenco Costanera)

**Proyecto:** Sima Assistant — Totem Cenco Costanera  
**Repositorio:** `sima-Assistant-html-hub`  
**Branch:** `juan-dev-ai`  
**Último commit:** `bcf7351` — *Add store categories browser and hybrid market search*  
**Fecha del informe:** 3 de julio de 2026  
**Ámbito:** `projects/cencomall/Assets/StreamingAssets/sima_services/`

---

## 1. Resumen ejecutivo

Se completó una iteración de mejoras sobre la experiencia del mapa indoor y el buscador de tiendas del tótem Cenco Costanera. Los objetivos principales fueron:

1. **Mapa MapVX** más usable (etiquetas, logos, rendimiento, filtrado de iconos).
2. **Búsqueda de tiendas** con catálogo local (411 locales desde API Market) sin depender exclusivamente de Unity.
3. **Compatibilidad con el flujo legacy** (Unity/IA empuja resultados) mediante un **modo híbrido** que no rompe builds existentes.
4. **Navegación por categorías** para explorar tiendas por rubro.
5. **Corrección crítica** de carga del catálogo bajo `file://` en Android WebView.

El trabajo está **listo para revisión** y para montar un **plan de pruebas estructurado** (sección 6).

---

## 2. Alcance de cambios (por área)

### 2.1 Mapa indoor (MapVX)

| Mejora | Descripción |
|--------|-------------|
| Etiquetas de tiendas por zoom | Marcas destacadas con logo ancla; al hacer zoom in se muestran nombres de todas las tiendas del piso (solo texto, sin logos remotos para evitar lag). |
| Logos locales | PNGs transparentes para Falabella, Ripley, Paris, Zara, H&M, Jumbo, Adidas, etc., con manifest configurable (`shared/store-logos/`). |
| Resolución de nombres | Prioridad: catálogo JSON por código `local` (ej. `CC_N5_5560`) → fallback título MapVX sin sufijo de piso. |
| Filtro POI | Ocultos iconos genéricos de retail/restaurantes; visibles servicios (baños, cajeros, escaleras, etc.). |
| Rendimiento | Cache de subplaces, debounce en zoom/centroides, prefetch de catálogo en background, logs de producción reducidos. |

**Archivos principales:** `shared/mapvx-bridge.js`, `shared/mapvx/styles.css`

---

### 2.2 Catálogo y motor de búsqueda local

| Componente | Descripción |
|------------|-------------|
| `data/market-catalog.json` | 411 tiendas (origen: API Market / `Api Market.json`). |
| `shared/market-search.js` | Motor cliente: carga, indexación, ranking por marca/keywords/categoría, agrupación multi-local. |
| `data/market-catalog.jsonp.js` | Companion para WebView `file://` (Android bloquea `fetch` sobre archivos locales). |
| `tools/build-jsonp-assets.mjs` | Regenera companions `.jsonp.js` cuando cambia el JSON fuente. |
| `tools/verify-market-search.mjs` | Smoke tests de búsqueda desde consola/CI. |

**Diagnóstico documentado en:** `FIX-BUSQUEDA-CATALOGO.md`

---

### 2.3 UI Mobility (buscador de tiendas)

| Mejora | Descripción |
|--------|-------------|
| Pantalla de búsqueda | Input + botón Buscar + hint de voz; integrado con `SimaBridge`. |
| Tarjetas de resultados | Misma estética morada Cenco; soporte multi-local por marca; panel de detalle y mapa. |
| **Categorías (nuevo)** | Botón «Categorías» → grilla de ~67 rubros con conteo de tiendas → listado filtrado por categoría. i18n: es / en / pt. |
| **Modo híbrido (nuevo)** | Unity + catálogo JSON en paralelo (detalle en sección 3). |

**Archivo principal:** `mobility/index.html`

---

## 3. Modo híbrido de búsqueda (punto clave para revisión)

### 3.1 Problema que resuelve

Antes del catálogo JSON, el flujo era:

```
Usuario → Web envía market_search a Unity → Unity/IA responde con JSON → Web renderiza
```

Con el catálogo JSON se añadió búsqueda local instantánea, pero las pruebas en build Unity debían seguir funcionando **sin cambiar el contrato** con C#/IA.

### 3.2 Comportamiento actual (default: `hybrid`)

```
                    ┌─────────────────────────────────────┐
                    │         Usuario busca (texto/voz)    │
                    └─────────────────┬───────────────────┘
                                      │
                    ┌─────────────────┴───────────────────┐
                    ▼                                       ▼
         SimaBridge.send("market_search")          Catálogo JSON local
         (flujo legacy — sin cambios)              (resultados inmediatos)
                    │                                       │
                    ▼                                       │
         Unity / IA responde con pushMarketSearchFromUnity  │
         o handleUnityData                                  │
                    │                                       │
                    └───────────────┬───────────────────────┘
                                    ▼
                         Reglas de prioridad (UI)
```

### 3.3 Reglas de prioridad en pantalla

| Situación | Qué ve el usuario |
|-----------|-------------------|
| Unity responde **con resultados** | Se muestran los de **Unity** (autoritativo para pruebas legacy). |
| Unity responde **vacío `[]`** pero el JSON local ya encontró tiendas | Se **mantienen** los resultados locales (fallback). |
| Unity responde **vacío** y local también vacío | «Sin resultados». |
| Unity envía **solo query** (sin array `results`) | El catálogo local completa la búsqueda. |
| Unity **no responde** (timeout / error) | El usuario igual ve resultados del JSON local. |

### 3.4 Compatibilidad con Unity — ¿hay conflicto?

**No.** El contrato web ↔ Unity se mantiene:

- **Web → Unity:** mismo evento `market_search` con `{ text: query }`.
- **Unity → Web:** mismo payload `{ type: "market_search", query, results: [...] }`.
- **APIs expuestas:** `pushMarketSearchFromUnity`, `pushMallContentFromUnity`, `handleUnityData` sin cambios de firma.

El JSON es una **capa aditiva**: mejora UX y resiliencia; no sustituye ni bloquea el camino legacy.

### 3.5 Modos opcionales (solo para pruebas aisladas)

| Modo | Activación | Uso |
|------|------------|-----|
| **`hybrid`** | Default (sin flag) | Producción y pruebas integradas Unity + JSON |
| **`unity-only`** | `?marketSearch=unity-only` o `window.MARKET_SEARCH_LEGACY = true` | Probar **solo** flujo C#/IA, sin catálogo local |
| **`catalog-only`** | `?marketSearch=catalog-only` | Probar **solo** catálogo web, sin notificar Unity |

En logcat al iniciar mobility:  
`mobility DOM ready ... marketSearch=hybrid`

---

## 4. Commits relevantes (branch `juan-dev-ai`)

| Commit | Descripción |
|--------|-------------|
| `dd7105d` | Catálogo JSON, motor `MarketSearch`, integración mobility, mapa UX inicial |
| `6277e92` | Panel detalle tienda, preload mapa, fix speech duplicado |
| `f9d3a27` | Fix carga catálogo bajo `file://` (jsonp companions), optimización mapa |
| `bcf7351` | **Categorías** + **modo híbrido** de búsqueda |

**Estadísticas acumuladas** (desde base `8718eb2`): ~2.866 líneas añadidas, 28 archivos tocados.

---

## 5. Dependencias y pendientes del equipo Unity

Estos puntos **no bloquean** la revisión web, pero mejoran la experiencia en dispositivo:

| # | Item | Prioridad | Detalle |
|---|------|-----------|---------|
| 1 | WebView file access | Alta | `setAllowFileAccessFromFileURLs(true)` restaura `fetch()` sobre `file://` (ver `FIX-BUSQUEDA-CATALOGO.md`). Los `.jsonp.js` ya actúan como respaldo. |
| 2 | Normalización búsqueda C# | Media | Alinear `MarketCatalogBridge` con reglas web (minúsculas, sin tildes, match compacto: `mcdonald` → `Mc Donald's`). |
| 3 | Navegación multi-sucursal | Media | Definir si misma marca en varios pisos navega directo vs. forzar lista. |
| 4 | Regenerar jsonp en pipeline OTA | Media | Ejecutar `node tools/build-jsonp-assets.mjs` al actualizar catálogo o logos. |

---

## 6. Propuesta: sistema de pruebas

### 6.1 Objetivo

Validar que **mapa**, **búsqueda híbrida**, **categorías** y **compatibilidad Unity** funcionan antes de montar en tótem de producción.

### 6.2 Entornos de prueba

| Entorno | Cómo | Para qué |
|---------|------|----------|
| **Dev local (HTTP)** | `npx http-server -p 8765 -c-1` en `sima_services/` | UI, categorías, búsqueda JSON, mapa con api-key manual |
| **Dev local (file://)** | APK/BlueStacks OTA o abrir HTML directo | Validar companions jsonp + WebView |
| **Build Unity staging** | OTA branch `juan-dev-ai` | Flujo híbrido real totem + voz + IA |

URLs de referencia:
- `http://127.0.0.1:8765/mobility/index.html?mode=store_search`
- `http://127.0.0.1:8765/map/index.html`

### 6.3 Matriz de casos de prueba

#### A. Búsqueda híbrida (crítico)

| ID | Caso | Pasos | Resultado esperado |
|----|------|-------|-------------------|
| H-01 | Búsqueda texto | Escribir «Zara» → Buscar | Resultados inmediatos del JSON; Unity recibe `market_search` |
| H-02 | Unity con resultados | Voz «McDonald's» con IA activa | Si Unity empuja results, pantalla muestra los de Unity |
| H-03 | Unity vacío, JSON ok | Query que C# no encuentra pero JSON sí | Usuario ve resultados locales (no pantalla en blanco) |
| H-04 | Sin resultados | Query inexistente «xyzxyz» | Mensaje «Sin resultados» |
| H-05 | Modo unity-only | URL `?marketSearch=unity-only` | Solo respuesta Unity; sin fallback JSON |
| H-06 | Eco Unity | Buscar y verificar logcat | No duplicar render innecesario; log `marketSearch=hybrid` |

#### B. Categorías

| ID | Caso | Pasos | Resultado esperado |
|----|------|-------|-------------------|
| C-01 | Listado | Buscar tiendas → Categorías | ~67 categorías con conteo |
| C-02 | Drill-down | Elegir «Calzado» (ej.) | Tarjetas de tiendas de esa categoría |
| C-03 | Volver | «← Ver categorías» / «← Buscar tiendas» | Navegación correcta |
| C-04 | i18n | Cambiar locale en totem | Textos en es/en/pt |

#### C. Mapa

| ID | Caso | Pasos | Resultado esperado |
|----|------|-------|-------------------|
| M-01 | Abrir tienda | Tarjeta → Ver mapa | Mapa carga, local correcto |
| M-02 | Zoom etiquetas | Zoom in +1.2 niveles | Aparecen nombres de tiendas del piso |
| M-03 | Logos ancla | Zoom out en marcas destacadas | Logos locales visibles (Zara, Jumbo, etc.) |
| M-04 | POI servicios | Observar mapa | Baños/cajeros visibles; iconos retail genéricos ocultos |
| M-05 | Rendimiento | Zoom repetido en piso con muchas tiendas | Sin crash ni lag severo |

#### D. Catálogo file:// (Android)

| ID | Caso | Pasos | Resultado esperado |
|----|------|-------|-------------------|
| F-01 | Prefetch catálogo | Abrir mobility en APK | Log: `market catalog ready count=411` |
| F-02 | Manifest logos | Abrir mapa | Log: `store logo manifest loaded {"entries":>0}` |
| F-03 | Búsqueda post-OTA | «mcdonald», «jumbo», «nike» | Resultados > 0 |

### 6.4 Automatización disponible hoy

```powershell
cd projects/cencomall/Assets/StreamingAssets/sima_services
node tools/verify-market-search.mjs
node tools/build-jsonp-assets.mjs   # tras cambiar JSON fuente
```

### 6.5 Criterios de aprobación (Definition of Done)

- [ ] Matriz H (híbrido): casos H-01 a H-04 OK en build Unity staging  
- [ ] Matriz C (categorías): C-01 a C-03 OK  
- [ ] Matriz M (mapa): M-01, M-02, M-05 OK  
- [ ] Matriz F (file://): F-01 y F-03 OK en dispositivo/emulador  
- [ ] Supervisor aprueba informe → proceder a integración OTA / producción  

### 6.6 Próximo paso sugerido: checklist en spreadsheet

Montar una hoja (Google Sheets / Excel) con columnas:

`ID | Área | Caso | Tester | Build | Fecha | Pass/Fail | Notas | Evidencia (screenshot/log)`

Asignar responsables: **Web** (casos C, parte M), **Unity** (H-02, H-03, F), **QA totem** (regresión voz completa).

---

## 7. Riesgos conocidos (bajo)

| Riesgo | Mitigación |
|--------|------------|
| Flash breve de resultados locales antes de respuesta Unity | Aceptable en UX; estado final = Unity si trae datos |
| Respuesta Unity tardía de búsqueda anterior | Caso raro; mitigado por match de query |
| Catálogo desactualizado vs. API Market | Regenerar JSON + jsonp en pipeline de release |
| Búsqueda C# distinta a web | Documentado en FIX-BUSQUEDA-CATALOGO; híbrido compensa con fallback JSON |

---

## 8. Documentación de referencia en repo

| Archivo | Contenido |
|---------|-----------|
| `IMPLEMENTACION-MAPVX-COSTANERA.md` | Detalle técnico mapa + búsqueda |
| `FIX-BUSQUEDA-CATALOGO.md` | Diagnóstico logcat, file://, acciones Unity |
| `INFORME-CENCO-COSTANERA.md` | Este informe |

---

## 9. Conclusión y solicitud de revisión

El branch `juan-dev-ai` entrega:

- Mapa indoor mejorado y optimizado.
- Búsqueda con catálogo local de 411 tiendas.
- **Modo híbrido** que preserva el contrato Unity legacy y usa JSON como refuerzo.
- Exploración por **categorías**.
- Fix de carga bajo Android WebView.

**Solicitud:** Revisión de este informe y aprobación para ejecutar la matriz de pruebas (sección 6). Con OK del supervisor, proceder a formalizar el checklist de QA y programar prueba en build staging del tótem.

---

*Informe generado para revisión interna — Sima Cenco Costanera.*
