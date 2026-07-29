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
2. Generar el manifest con `scripts/build-runtime-manifest-from-git.mjs` (hashes LF desde git; no usar el builder de disco en Windows con `autocrlf`).
3. Validar con `scripts/validate-runtime-manifest-from-git.mjs runtime-sync/manifests/<slug>.json`.
4. Subir el manifest junto a los assets.
5. Unity consulta el manifest y compara hashes.
6. Unity descarga solo lo cambiado.
7. Unity abre el HTML cacheado localmente.
8. Si falla la actualización, Unity conserva la última versión funcional.

## Generar manifest (cencomall)

```bash
node scripts/build-runtime-manifest-from-git.mjs \
  cencomall \
  https://sima-assistant-html-hub-rho.vercel.app/cencomall \
  2026.07.28-3 \
  2026.07.24-2

node scripts/validate-runtime-manifest-from-git.mjs runtime-sync/manifests/cencomall.json
```

No incluir `data/*-mapvx-patches.json`: están en `.gitignore` y no se publican.

