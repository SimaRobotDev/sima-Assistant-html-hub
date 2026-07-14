# Bridge contract

Este documento define el contrato común para los HTML de SIMA.

## Objeto global

El contrato expone `window.SimaBridge`.

## Nota para autores de HTML

Regla práctica:

- el estado del asistente vive en Unity;
- el HTML puede guardar preferencias locales, pero no debe reemplazar la fuente de verdad del proyecto;
- `PlayerPrefs` + bridge = datos del asistente;
- `localStorage` = solo estado local de la pantalla o helper.

## Métodos base

- `send(type, payload)` envía un mensaje genérico a Unity.
- `ready(screenName)` avisa que la pantalla HTML está lista.
- `log(text)` manda un log técnico.
- `requestClose()` solicita cerrar el webview.
- `speak(text)` pide TTS/voz.
- `animate(state)` cambia el estado del avatar.
- `start_stt()` inicia reconocimiento de voz.
- `onUnityData(raw)` recibe datos desde Unity y los reenvía al HTML.

## Compatibilidad extendida

El bridge también conserva estas funciones porque ya existen en proyectos activos:

- `loadUrl(url, speakText)`
- `setMicVisible(visible)`
- `startSTT()` como alias de `start_stt()`

## Persistencia y estado

Los HTML no deben asumir que el estado principal del asistente vive en `localStorage`.

- La persistencia de la app Unity debe tratarse como `PlayerPrefs` o payloads que vienen desde Unity.
- `localStorage` puede existir en algunos helpers web o pantallas concretas, pero eso es persistencia interna del navegador o del SDK web, no la fuente de verdad del asistente.
- Si un contenido HTML necesita recordar una preferencia real del asistente, esa decisión debe venir del lado Unity y pasar al HTML por el bridge.

## Envío de mensajes

El envío usa este formato:

```json
{
  "type": "web_ready",
  "payload": {
    "screen": "viewer"
  }
}
```

El bridge intenta primero un canal seguro basado en iframe oculto y deja fallback a `window.location.href` para entornos más simples.

## Datos desde Unity

`onUnityData()` intenta parsear JSON si llega como string. Luego:

- llama a `handleUnityData(data)` si existe;
- llama a `handleUnityCommand(command, data)` si el payload trae `command` o `type`.

## Reglas de implementación

- No renombrar mensajes ya usados por Unity.
- Si un proyecto necesita un nombre distinto, agregar alias en el bridge común.
- Mantener el bridge compatible con `file://`, WKWebView y UniWebView.

## Mobility: búsqueda inicial al abrir la pantalla

Cuando Unity abre `mobility/index.html` con una URL nueva (en vez de reutilizar
un WebView ya cargado y llamar a `handleUnityData`/`pushMarketSearchFromUnity`
por JS), no hay forma de invocar funciones JS antes de que la página cargue.
Para esos casos, `mobility/index.html` lee, en este orden, una búsqueda
inicial y la dispara automáticamente en `DOMContentLoaded` (mismo flujo que
usa la búsqueda por voz, incluyendo texto en el buscador y TTS de
confirmación):

1. `window.MALL_SEARCH_QUERY` / `window.MALL_INITIAL_QUERY` / `window.MALL_VOICE_QUERY`
   (igual convención que `window.MALL_LOCALE`, inyectado antes de cargar la página).
2. Parámetros de URL: `?q=`, `?query=`, `?search=` o `?text=`.

Si Unity ya conoce la marca/tienda que el usuario pidió por voz o texto antes
de navegar a `mobility`, debe pasarla por alguno de estos canales para que
quede reflejada en el buscador y dispare la búsqueda local/híbrida.

## Eventos observados

| type | uso |
| --- | --- |
| `web_ready` | pantalla lista |
| `web_log` | trazas y depuración |
| `close_webview` | cerrar vista |
| `avatar_speak` | síntesis de voz |
| `avatar_anim` | animación del avatar |
| `start_stt` | iniciar STT |
| `load_url` | abrir contenido externo |
| `generate_qr` | crear código QR |
| `mapvx_log` | depuración de mapa |
