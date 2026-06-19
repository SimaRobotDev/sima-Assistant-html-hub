# Guía rápida de sincronización

Atajo operativo para mover cambios entre Unity, el repo espejo y GitHub.

## 1. Traer desde Unity al repo espejo

Usa esto cuando el cambio nació en el proyecto Unity fuente:

```bash
scripts/import-project.sh /ruta/al/proyecto/unity <slug>
```

Ejemplos:

```bash
scripts/import-project.sh ~/Downloads/MainSiMA-Assistant demo-main
scripts/import-project.sh ~/Documents/Cencomall-Assistant cencomall
scripts/import-project.sh /Volumes/DiscoExternoHugetto/AssistantHub hub-providencia
```

## 2. Sincronizar archivos comunes

Usa esto cuando cambió algo de `shared/`:

```bash
scripts/sync-common.sh
```

## 3. Devolver cambios del repo a Unity

Usa esto cuando Git ya tiene el cambio y necesitas reflejarlo en el proyecto Unity fuente:

```bash
scripts/export-project.sh /ruta/al/proyecto/unity <slug>
```

Ejemplos:

```bash
scripts/export-project.sh ~/Downloads/MainSiMA-Assistant demo-main
scripts/export-project.sh ~/Documents/Cencomall-Assistant cencomall
scripts/export-project.sh /Volumes/DiscoExternoHugetto/AssistantHub hub-providencia
```

## 4. Publicar a GitHub

Flujo corto:

1. Revisar cambios.
2. Hacer commit.
3. Hacer push al repo remoto.

## 5. Preparar deploy para Vercel

Genera la carpeta que Vercel va a publicar:

```bash
npm run build:deploy
```

Si ya tienes dominio final, puedes fijar la base URL al construir:

```bash
DEPLOY_BASE_URL=https://sima-html.tu-dominio.com npm run build:deploy
```

## 6. Actualización en runtime

Esto pasa cuando el dispositivo ya está en producción y debe tomar cambios sin reinstalar la app:

1. Unity consulta el `manifest` remoto al iniciar o cuando se le pida.
2. Compara la versión remota con la versión local cacheada.
3. Si hay cambios, descarga solo los archivos que cambiaron.
4. Guarda la nueva copia en `Application.persistentDataPath`.
5. Abre el HTML local cacheado con UniWebView.
6. Si la descarga falla, conserva la versión anterior instalada.
7. Si se necesita volver atrás, se usa `rollbackTo` en el manifest.

## Regla de runtime

- El repo Git no se sincroniza directo al dispositivo.
- El dispositivo toma la versión publicada por manifest.
- El HTML en runtime vive en cache local, no en el repo.

## Regla simple

- Si el cambio nació en Unity, primero se importa al repo.
- Si el cambio nació en Git, luego se exporta a Unity.
- Si el cambio es compartido, se sincroniza `shared/` antes de cerrar.
