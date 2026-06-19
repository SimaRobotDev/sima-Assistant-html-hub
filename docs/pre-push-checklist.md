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

## Validación final

- [ ] Abrir el HTML en el entorno esperado y confirmar que carga sin errores.
- [ ] Probar el flujo mínimo: `ready`, `speak`, `send`, `requestClose`.
- [ ] Confirmar que no se rompió ninguna pantalla que ya existía.
