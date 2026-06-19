using System;
using UnityEngine;

/// <summary>
/// Ejemplo mínimo de arranque para Unity.
/// Asigna el servicio de sync y el nombre del entry point a abrir.
/// </summary>
public class HtmlBootstrapExample : MonoBehaviour
{
    [SerializeField] private RuntimeHtmlSyncService syncService;
    [SerializeField] private string initialService = "mobility";
    [SerializeField] private bool logProgress = true;

    private async void Start()
    {
        if (syncService == null)
        {
            Debug.LogWarning("[HtmlBootstrap] Missing syncService reference");
            return;
        }

        syncService.OnStateChanged += HandleSyncStateChanged;

        var result = await syncService.SyncAsync();
        if (!result.success)
        {
            Debug.LogWarning($"[HtmlBootstrap] Sync failed: {result.message}");
        }

        var localUrl = syncService.ResolveEntryUrl(initialService);
        if (string.IsNullOrEmpty(localUrl))
        {
            Debug.LogWarning($"[HtmlBootstrap] Could not resolve entry url for {initialService}");
            return;
        }

        OpenInWebView(localUrl);
    }

    private void OnDestroy()
    {
        if (syncService != null)
        {
            syncService.OnStateChanged -= HandleSyncStateChanged;
        }
    }

    private void HandleSyncStateChanged(RuntimeHtmlSyncState state, string message)
    {
        if (!logProgress) return;
        Debug.Log($"[HtmlBootstrap] {state}: {message}");
    }

    private void OpenInWebView(string localUrl)
    {
        // Reemplaza este bloque con la API real de UniWebView del proyecto.
        // Ejemplo:
        // webView.Load(localUrl);
        // webView.Show();
        Debug.Log("[HtmlBootstrap] Open HTML: " + localUrl);
    }
}
