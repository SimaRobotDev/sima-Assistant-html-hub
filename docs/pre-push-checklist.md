# Antes de subir a GitHub

Checklist corto para validar un cambio antes de publicar el repo o un mirror.

## Validación rápida

- [ ] El proyecto fuente quedó importado en su mirror correcto.
- [ ] Los archivos comunes fueron sincronizados con `scripts/sync-common.sh`.
- [ ] El HTML sigue apuntando a `../shared/...` y no a rutas rotas.
- [ ] `shared/bridge.js` expone todas las funciones que usan los HTML tocados.
- [ ] Las diferencias por proyecto quedaron documentadas en `docs/projects.md`.
- [ ] Si apareció un evento nuevo, quedó agregado en `docs/bridge-contract.md`.
- [ ] Los `.meta` acompañan a los archivos que necesitan volver a Unity.
- [ ] No quedaron archivos temporales, capturas ni artefactos locales sin querer.

## Revisión de persistencia

- [ ] Si el HTML necesita guardar estado del asistente, revisar que venga desde Unity por `PlayerPrefs` o por los payloads del bridge.
- [ ] No asumir que la app usa `localStorage` del navegador para preferencias globales del asistente.
- [ ] Si algún helper web o pantalla usa `localStorage`, dejar claro que es persistencia interna de esa vista y no del estado maestro del asistente.

## OTA / runtime manifest

- [ ] Regenerar con `scripts/build-runtime-manifest-from-git.mjs` (no el builder de disco en Windows).
- [ ] `baseUrl` apunta al host Vercel estable del proyecto (no un flag CLI).
- [ ] `node scripts/validate-runtime-manifest-from-git.mjs runtime-sync/manifests/<slug>.json` pasa.
- [ ] Si tocaste el catálogo de servicios o `shared/services-catalog.js`: `npm run verify:services` (pruebas de búsqueda, integridad, robustez y fuzz; `tools/verify-services-catalog.mjs` conserva 11 fallos antiguos conocidos).
- [ ] Si cambió `data/market-catalog.json`: `npm run build:store-services` y luego `node tools/build-jsonp-assets.mjs` (las tiendas que dan servicio técnico/reparación se derivan del catálogo; `node tools/verify-services-generic.mjs` falla si quedaron desactualizadas).
- [ ] El manifest no lista archivos gitignored (`data/*-mapvx-patches.json`).

## Validación final

- [ ] Abrir el HTML en el entorno esperado y confirmar que carga sin errores.
- [ ] Probar el flujo mínimo: `ready`, `speak`, `send`, `requestClose`.
- [ ] Confirmar que no se rompió ninguna pantalla que ya existía.
