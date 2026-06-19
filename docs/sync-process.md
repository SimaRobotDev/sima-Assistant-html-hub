# Sincronización de proyectos

Esta guía explica el paso a paso para mantener sincronizados los HTML de los asistentes dentro del hub.

## Principio base

- Cada proyecto se mantiene como un espejo de su ruta Unity original.
- Los archivos comunes viven en `shared/` y se propagan a cada proyecto.
- Las diferencias reales por proyecto se documentan, no se esconden.

## Nota para autores de HTML

Antes de tocar una pantalla nueva o cambiar una existente:

- si el dato define el estado del asistente, debe venir de Unity;
- si el dato solo mejora la experiencia local de esa vista, puede quedarse en el navegador;
- `PlayerPrefs` y el bridge son la fuente de verdad para perfil, idioma, sesión y configuración del asistente;
- `localStorage` solo debe usarse para preferencias locales de esa pantalla y nunca como reemplazo del estado maestro.

## Orden de sincronización

### 1. Identificar el proyecto fuente

Ubica la carpeta Unity origen y confirma su ruta:

- `MainSiMA-Assistant` -> `projects/demo-main`
- `Cencomall-Assistant` -> `projects/cencomall`
- `AssistantHub` -> `projects/hub-providencia`

Si el proyecto no existe todavía en el hub, crear primero su carpeta espejo:

- `projects/<slug>/Assets/StreamingAssets/sima_services/`

### 2. Importar el árbol `sima_services`

Ejecuta la importación desde la raíz del proyecto del hub:

```bash
scripts/import-project.sh /ruta/al/proyecto/unity <slug>
```

Ejemplos:

```bash
scripts/import-project.sh ~/Downloads/MainSiMA-Assistant demo-main
scripts/import-project.sh ~/Documents/Cencomall-Assistant cencomall
scripts/import-project.sh /Volumes/DiscoExternoHugetto/AssistantHub hub-providencia
```

Este paso:

- copia `Assets/StreamingAssets/sima_services/` al espejo del proyecto;
- preserva la estructura interna de Unity;
- reemplaza el contenido anterior del espejo para que quede fiel al fuente.

### 3. Resolver diferencias por proyecto

Antes de tocar archivos comunes, revisar qué cambia entre proyectos:

- servicios o pantallas nuevas;
- nombres distintos de funciones del bridge;
- helpers exclusivos como `mapvx-bridge.js` o `locale.js`;
- recursos adicionales como imágenes, zips o bundles.

La regla es:

- si un archivo solo lo usa un proyecto, se queda dentro de ese proyecto;
- si un archivo ya existe en varios proyectos con el mismo propósito, se mueve a `shared/`.

### 4. Sincronizar los archivos comunes

Una vez definido el contenido común, propágalo con:

```bash
scripts/sync-common.sh
```

Este script copia a cada proyecto espejo:

- `bridge.js`
- `app.css`
- `fragment.js`
- `qrcode.min.js`
- `mapvx/`

Si el archivo tiene `.meta`, también se copia.

### 5. Verificar el bridge

Después de sincronizar, revisar que los HTML sigan usando los mismos nombres:

- `SimaBridge.ready(...)`
- `SimaBridge.speak(...)`
- `SimaBridge.send(...)`
- `SimaBridge.loadUrl(...)`
- `SimaBridge.setMicVisible(...)`

Si un proyecto usa una función distinta, agregar un alias en `shared/bridge.js` en lugar de cambiar todos los HTML.

### 6. Validar referencias internas

Confirmar que los HTML cargan el bridge correcto según su ruta:

- `../shared/bridge.js`
- `../shared/app.css`
- `../shared/fragment.js`
- `../shared/mapvx/...`

En los proyectos espejo, la ruta debe seguir siendo la misma que en Unity.

### 7. Revisar `.meta`

En este hub se guardan los `.meta` porque ayudan a volver a Unity sin romper referencias.

Reglas prácticas:

- no borrar `.meta` de archivos ya importados;
- si entra un archivo nuevo común, incluir también su `.meta` cuando exista;
- si un proyecto fuente no trae `.meta`, documentarlo antes de agregarlo manualmente.

### 7.1 Recordar la persistencia de Unity

Cuando el HTML necesite recuperar o reflejar estado del asistente, no asumir `localStorage` como fuente de verdad.

- El estado maestro del asistente vive en Unity, normalmente en `PlayerPrefs`.
- El HTML recibe ese estado por `SimaBridge.onUnityData(...)` o por mensajes enviados desde Unity.
- `localStorage` solo debe considerarse si un helper web o una pantalla concreta lo usa para su propia caché interna.

### 8. Documentar el cambio

Después de cada sincronización importante, actualizar:

- `docs/projects.md` si cambió la lista de páginas o helpers usados;
- `docs/bridge-contract.md` si apareció un evento nuevo;
- `README.md` si cambia el flujo general.

## Caso típico de trabajo

### Cuando llega una actualización de Cencomall

1. Importar el árbol desde `Cencomall-Assistant`.
2. Comparar con la versión previa del mirror.
3. Detectar si hay cambios exclusivos de Cencomall.
4. Revisar si algún helper pasó a ser común.
5. Ejecutar `scripts/sync-common.sh`.
6. Validar que `bridge.js` siga cubriendo `loadUrl`, `setMicVisible` y `mapvx`.
7. Actualizar la matriz de proyectos.

### Cuando llega un HTML nuevo a MainSiMA

1. Copiarlo dentro de `projects/demo-main/Assets/StreamingAssets/sima_services/<servicio>/`.
2. Revisar qué archivos comparte con otros proyectos.
3. Si usa utilidades repetidas, moverlas a `shared/` o reutilizar las existentes.
4. Confirmar que el bridge no requiera una función nueva.
5. Si requiere una función nueva, agregarla como alias compatible.

### Cuando Git tiene cambios que deben volver a Unity

1. Hacer `git pull` o actualizar el repo local del hub.
2. Verificar qué cambió en `projects/<slug>/Assets/StreamingAssets/sima_services/`.
3. Exportar el espejo al proyecto Unity fuente con:

```bash
scripts/export-project.sh /ruta/al/proyecto/unity <slug>
```

4. Confirmar que el árbol quedó copiado dentro de `Assets/StreamingAssets/sima_services/`.
5. Abrir Unity y validar la escena o pantalla que consume esos HTML.
6. Si el cambio era compartido, revisar también `shared/` y volver a propagarlo si corresponde.

## Criterio de cierre

Una sincronización está completa cuando:

- el mirror del proyecto refleja la ruta Unity correcta;
- los archivos comunes quedaron copiados en todos los proyectos que los usan;
- no quedaron enlaces rotos a `../shared/...`;
- la documentación refleja los cambios;
- las funciones del bridge usadas por los HTML siguen disponibles.
