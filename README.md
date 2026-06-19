# SIMA HTML Hub

Repositorio para centralizar los HTML de `Assets/StreamingAssets/sima_services` de los asistentes SIMA.

## Objetivo

- Mantener una copia espejo por proyecto para que volver a Unity sea directo.
- Tener una capa común para bridge, estilos y helpers compartidos.
- Documentar qué usa cada proyecto y cómo extenderlo a futuros asistentes.

## Estructura

```text
shared/
  bridge.js
  app.css
  fragment.js
  qrcode.min.js
  mapvx/

projects/
  demo-main/Assets/StreamingAssets/sima_services/
  cencomall/Assets/StreamingAssets/sima_services/
  hub-providencia/Assets/StreamingAssets/sima_services/
  colina/Assets/StreamingAssets/sima_services/
  onstar/Assets/StreamingAssets/sima_services/

deploy/
  cencomall/
  demo-main/
  hub-providencia/
```

## Proyectos incluidos

- `demo-main`: base de `MainSiMA-Assistant`
- `cencomall`: base de `Cencomall-Assistant`
- `hub-providencia`: base de `AssistantHub`
- `colina`: placeholder preparado
- `onstar`: placeholder preparado

## Flujo recomendado

1. Importar o actualizar desde el proyecto Unity fuente.
2. Sincronizar los archivos comunes desde `shared/`.
3. Revisar el contrato del bridge antes de agregar una función nueva.
4. Documentar cualquier diferencia por proyecto en `docs/projects.md`.
5. Seguir el paso a paso de sincronización en `docs/sync-process.md`.

## Scripts

- `scripts/import-project.sh`: copia el árbol `sima_services` desde un proyecto Unity fuente a `projects/<slug>/...`
- `scripts/export-project.sh`: copia el espejo del repo de vuelta al proyecto Unity fuente
- `scripts/sync-common.sh`: propaga los archivos comunes del directorio `shared/` a cada proyecto espejo
- `scripts/build-runtime-manifest.mjs`: genera el manifest runtime por proyecto
- `scripts/build-deploy.mjs`: construye la carpeta `deploy/` lista para Vercel
- `scripts/validate-runtime-manifest.mjs`: valida un manifest generado contra el espejo local

## Lecturas útiles

- `docs/bridge-contract.md`
- `docs/projects.md`
- `docs/sync-process.md`
- `docs/quick-sync-guide.md`
- `docs/pre-push-checklist.md`
- `docs/html-authoring-note.md`
- `docs/runtime-html-sync.md`
- `docs/vercel-deploy.md`
- `runtime-sync/`
- `unity-runtime-sync/`
- `unity-runtime-sync/README.md`
- `unity-runtime-sync/COPY-PASTE-IMPLEMENTATION.md`
