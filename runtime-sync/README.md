# Runtime HTML Sync

Esta carpeta define el formato y el flujo de actualización online de los HTML SIMA en runtime.

## Objetivo

- Publicar HTML por proyecto con versionado.
- Descargar solo los archivos que cambiaron.
- Mantener una copia local lista para offline.
- Permitir rollback a una versión anterior si una publicación falla.

## Componentes

- `manifests/<project>.json`: manifiesto de versión por proyecto.
- `README.md`: contrato operativo.
- `docs/runtime-html-sync.md`: guía de implementación y operación.

## Flujo operativo resumido

1. Publicar los HTML en el host remoto.
2. Generar el manifest con `scripts/build-runtime-manifest.mjs`.
3. Subir el manifest junto a los assets.
4. Unity consulta el manifest y compara hashes.
5. Unity descarga solo lo cambiado.
6. Unity abre el HTML cacheado localmente.
7. Si falla la actualización, Unity conserva la última versión funcional.

