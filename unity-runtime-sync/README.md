# Unity Runtime HTML Sync

Paquete C# compartido para implementar el runtime sync de HTML en Unity.

## Qué resuelve

- Consulta de manifest remoto.
- Descarga incremental de HTML y shared assets.
- Cache local en `persistentDataPath`.
- Commit atómico de versión.
- Rollback a una versión previa instalada.

## Uso recomendado

1. Copiar estos archivos a un proyecto Unity o importarlos como paquete interno.
2. Crear un `RuntimeHtmlSyncConfig` por proyecto.
3. Asignar la URL del manifest remoto.
4. Llamar `SyncAsync()` al iniciar o bajo demanda.
5. Abrir el HTML con la URL local resuelta por el servicio.
6. Revisar `HtmlBootstrapExample.cs` como punto de integración mínimo.

## Archivos

- `RuntimeHtmlManifest.cs`
- `RuntimeHtmlCache.cs`
- `RuntimeHtmlSyncConfig.cs`
- `RuntimeHtmlSyncService.cs`
- `HtmlBootstrapExample.cs`
