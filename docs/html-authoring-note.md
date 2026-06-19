# Nota para autores de HTML

Esta guía resume qué tipo de estado debe vivir en Unity y qué tipo de estado puede quedarse dentro del navegador.

## Regla corta

- Si el dato define el estado del asistente, viene de Unity.
- Si el dato solo mejora la experiencia de esa pantalla, puede quedarse en el HTML.

## Comparación práctica

| Estado que viene de Unity | Estado que puede quedar en el navegador |
| --- | --- |
| `PlayerPrefs` del proyecto | Tema visual de la pantalla |
| Identidad del usuario o perfil | Filtros temporales de una vista |
| Idioma activo del asistente | Última pestaña abierta en esa página |
| Prompt o configuración remota | Datos de caché interna del helper |
| Contexto de sesión enviado por `onUnityData()` | Formulario local no crítico |

## Recomendación de implementación

- Para estado del asistente, leer desde `window.SimaBridge.onUnityData(...)` o mensajes desde Unity.
- Para estado local de la vista, usar `localStorage` solo si esa pantalla realmente lo necesita.
- No mezclar ambos niveles en una sola clave.
- Si una pantalla guarda algo en `localStorage`, documentarlo como estado local y no como persistencia de la app.

## Ejemplo de criterio

- Correcto: guardar el último filtro de una pantalla en `localStorage`.
- Correcto: recibir el nombre del usuario desde Unity.
- Incorrecto: usar `localStorage` para reemplazar `PlayerPrefs` del perfil.
- Incorrecto: asumir que un HTML puede reconstruir solo el estado global del asistente.

## Texto sugerido para reutilizar

> Los HTML de SIMA pueden usar `localStorage` para preferencias locales de una pantalla, pero el estado del asistente y la identidad del usuario deben venir desde Unity, normalmente vía `PlayerPrefs` y el bridge.

