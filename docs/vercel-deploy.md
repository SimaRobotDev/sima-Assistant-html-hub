# Vercel Deploy

Esta guía prepara la publicación del runtime HTML en Vercel.

## Estructura que publica Vercel

El build genera una carpeta `deploy/` con:

- `/<project>/manifest.json`
- `/<project>/...` con los HTML y assets del proyecto
- `index.html` como página de entrada

## Configuración recomendada en Vercel

Si el repo incluye `vercel.json`, Vercel puede usarlo directamente.

### Opción 1: publicar desde el repo raíz

- Root Directory: `./`
- Build Command: `npm run build:deploy`
- Output Directory: `deploy`

También puedes dejar que `vercel.json` gobierne esos valores y no tocar la pantalla.

### Opción 2: publicar con base URL fija

Si ya tienes dominio o subdominio final, define:

```bash
DEPLOY_BASE_URL=https://sima-html.tu-dominio.com
```

Y usa el mismo build command:

```bash
npm run build:deploy
```

Eso reescribe `manifest.baseUrl` para cada proyecto con la URL pública correcta.

Si no defines `DEPLOY_BASE_URL`, el build intenta usar `VERCEL_URL` automáticamente durante el deploy.

## Flujo operativo

1. Actualizar el repo.
2. Generar manifests runtime si cambian archivos.
3. Ejecutar el build de `deploy/`.
4. Subir el deploy a Vercel.
5. Copiar la URL pública a `manifestUrl` en Unity.

## Qué debe quedar público

- `manifest.json`
- HTML
- CSS/JS compartido
- assets referenciados por esos HTML

## Qué no debe quedar como host público principal

- documentación interna
- scripts de mantenimiento
- paquetes de referencia C# de Unity
