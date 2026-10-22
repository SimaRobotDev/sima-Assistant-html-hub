# Registro de cambios para cherry-pick (HTMLs)

> **Para qué sirve:** que Hugo (o su Claude) sepa qué cambió en las pantallas HTML y qué archivos toca cada cambio.
>
> - **Rama de trabajo:** `juan-dev-ai`. Los commits de abajo ya están en `origin/main`.
> - **Cómo llega un cambio al tótem:** no va en el APK. Se regenera el manifest (`node scripts/build-runtime-manifest-from-git.mjs`, **no** el builder de disco en Windows), se valida con `validate-runtime-manifest-from-git.mjs` y se publica en Vercel; el tótem descarga los archivos nuevos. Ver `docs/pre-push-checklist.md`.
> - **Regla:** cada commit nuevo agrega una fila a la tabla; si cambia lo que el visitante ve o el contrato con la app, también una ficha.

## Fichas (lo más reciente)

### 22-oct · `fc11a0a` + `c39dd57` · `store-map-web` acepta el tipo de ruta (`routeMode`)
- **Qué cambia:** `store-map-web/index.html` lee `routeMode` (`pickRouteMode`) del payload de `openStoreMapById` / `handleUnityData` y de la URL (`?route=1&routeMode=accessible`) y arranca la ruta con ese modo (`showRouteView(cfg, placeId, name, {mode})` ya lo soportaba). Sin el dato o con cualquier otro valor sigue saliendo a pie: una app sin el campo no nota el cambio. El selector de la tarjeta adopta el modo con que nace la ruta, así que el botón correcto queda relleno.
- **Para qué:** el botón "Ruta accesible" de la burbuja del chat (app, pedido de Hugo) abre el mapa con la ruta accesible ya pedida, sin pasar por el botón de la tarjeta. Antes `?route=1` arrancaba siempre a pie (por escaleras).
- **Archivos:** `projects/cencomall/Assets/StreamingAssets/sima_services/store-map-web/index.html` (9 líneas). `c39dd57` solo sube el manifest OTA a `2026.09.02-55` (regenerado con `build-runtime-manifest-from-git.mjs`, 125 archivos, validado).
- **Contrato con la app:** la orden que inyecta la app lleva `routeMode: 'walk' | 'accessible'` (`buildOpenStoreScript` en `src/web/PreloadedStoreMapWeb.tsx`) y la URL de arranque `routeMode=accessible` (`src/web/storeMapNavigation.ts`).

### 21-oct · `6c7e22e` + `22914de` · botones "Ver ruta" / "Ruta accesible" en la tarjeta
- **Qué ve el visitante:** dos botones dentro de la tarjeta de la tienda y del servicio. Se elige el tipo de ruta **antes** de que exista; después el par queda: el activo va relleno, tocar el otro cambia la ruta y tocar el activo la quita. Textos en español, inglés y portugués.
- **Archivos:** `shared/route-mode-picker.js` (la interfaz y el estado), `store-map-web/index.html` (`getRoutePicker`, `showRouteView(cfg, placeId, name, {mode})`), `mobility/index.html`, `shared/mapvx-wc-runtime.js`. Reemplaza el botón flotante de `shared/mapvx-accessible-route.js`, que este commit borra (lo había creado `00bf3ae`). `22914de` solo sube la versión OTA del manifest (`2026.09.02-54`).
- **Contrato con la app:** `?route=1` (y `route: true` en `handleUnityData`) arranca **siempre a pie**. Hoy la app no puede pedir la ruta accesible desde afuera.

### 20-oct · `00bf3ae` + `02f07b9` · MapVX WC 0.13.0, ascensores y baños
- Motor de rutas nuevo con piso de destino para los ascensores, botón de ruta accesible y referencias de baños corregidas. Manifest `2026.09.02-53`. Archivos: `data/services-catalog.json` y su `.jsonp.js`, `mapvx-embed/mvx-tiles-sw.js` y más (ver la tabla).

## En curso

(Nada pendiente.)

## Commits desde el 14-oct

| Commit | Fecha | Qué cambia (título del commit) | Archivos |
|---|---|---|---|
| `c39dd57` | 22-Oct | Bump Cencomall OTA to 2026.09.02-55 for store-map-web accepting the route mode (Ruta accesible from the chat bubble) | `runtime-sync/manifests/cencomall.json` |
| `fc11a0a` | 22-Oct | store-map-web: acepta el tipo de ruta (routeMode) para abrir ya en "Ruta accesible" | `projects/cencomall/Assets/StreamingAssets/sima_services/store-map-web/index.html` |
| `22914de` | 21-Oct | Bump Cencomall OTA to 2026.09.02-54 for the Ver ruta / Ruta accesible buttons in the store and service card | `runtime-sync/manifests/cencomall.json` |
| `6c7e22e` | 21-Oct | Botones "Ver ruta" / "Ruta accesible" dentro de la tarjeta de la tienda y del servicio | `projects/cencomall/Assets/StreamingAssets/sima_services/mobility/index.html`, `projects/cencomall/Assets/StreamingAssets/sima_services/shared/mapvx-accessible-route.js`, `projects/cencomall/Assets/StreamingAssets/sima_services/shared/mapvx-wc-runtime.js`, `projects/cencomall/Assets/StreamingAssets/sima_services/shared/mapvx-wc/README.md`, `projects/cencomall/Assets/StreamingAssets/sima_services/shared/route-mode-picker.js` (+3 más) |
| `02f07b9` | 20-Oct | Bump Cencomall OTA to 2026.09.02-53 for MapVX WC 0.13.0, elevators on the WC with floor ids, accessible-route button and corrected bathroom references | `runtime-sync/manifests/cencomall.json` |
| `00bf3ae` | 20-Oct | MapVX WC 0.13.0, ascensores en el motor nuevo con piso de destino, botón Ruta accesible y referencias de baños corregidas | `projects/cencomall/Assets/StreamingAssets/sima_services/data/services-catalog.json`, `projects/cencomall/Assets/StreamingAssets/sima_services/data/services-catalog.jsonp.js`, `projects/cencomall/Assets/StreamingAssets/sima_services/mapvx-embed/mvx-tiles-sw.js`, `projects/cencomall/Assets/StreamingAssets/sima_services/mapvx-embed/store-map.html`, `projects/cencomall/Assets/StreamingAssets/sima_services/mobility/index.html` (+10 más) |
