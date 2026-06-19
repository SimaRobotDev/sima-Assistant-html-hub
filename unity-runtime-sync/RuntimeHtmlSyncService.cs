using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Networking;

public enum RuntimeHtmlSyncState
{
    Idle,
    CheckingManifest,
    Downloading,
    Verifying,
    Committing,
    Ready,
    RolledBack,
    Failed
}

public class RuntimeHtmlSyncResult
{
    public bool success;
    public string project;
    public string version;
    public string message;
    public RuntimeHtmlSyncState state;
}

public class RuntimeHtmlSyncService : MonoBehaviour
{
    [SerializeField] private RuntimeHtmlSyncConfig config;

    public RuntimeHtmlSyncState State { get; private set; } = RuntimeHtmlSyncState.Idle;
    public string CurrentVersion { get; private set; }

    public event Action<RuntimeHtmlSyncState, string> OnStateChanged;

    private RuntimeHtmlCache _cache;

    private void Awake()
    {
        if (config == null)
        {
            Debug.LogWarning("[RuntimeHtmlSync] Missing config");
            return;
        }

        _cache = new RuntimeHtmlCache(config.GetProjectRootPath());
    }

    private void Start()
    {
        if (config != null && config.autoSyncOnStart)
        {
            _ = SyncAsync();
        }
    }

    public async Task<RuntimeHtmlSyncResult> SyncAsync(CancellationToken cancellationToken = default)
    {
        EnsureReady();
        return await SyncInternalAsync(cancellationToken);
    }

    public async Task<RuntimeHtmlSyncResult> SyncToVersionAsync(string targetVersion, CancellationToken cancellationToken = default)
    {
        EnsureReady();
        if (string.IsNullOrWhiteSpace(targetVersion))
        {
            return Fail("Rollback target version is empty.");
        }

        if (!_cache.IsVersionInstalled(targetVersion))
        {
            return Fail($"Rollback target {targetVersion} is not installed.");
        }

        _cache.SetCurrentVersion(targetVersion);
        CurrentVersion = targetVersion;
        SetState(RuntimeHtmlSyncState.RolledBack, $"Rolled back to {targetVersion}");
        return Ok(targetVersion, "Rollback applied.");
    }

    public string ResolveEntryUrl(string serviceName)
    {
        EnsureReady();

        if (!_cache.TryGetCurrentVersion(out var version))
        {
            return null;
        }

        var manifestPath = _cache.GetManifestPath(version);
        if (!File.Exists(manifestPath))
        {
            return null;
        }

        var manifest = JsonUtility.FromJson<RuntimeHtmlManifest>(File.ReadAllText(manifestPath, Encoding.UTF8));
        var entry = manifest.entryPoints?.FirstOrDefault(x => string.Equals(x.service, serviceName, StringComparison.OrdinalIgnoreCase));
        var relativePath = entry != null && !string.IsNullOrWhiteSpace(entry.entry)
            ? entry.entry
            : $"{serviceName}/index.html";

        var localFile = _cache.GetInstalledFilePath(version, relativePath);
        return File.Exists(localFile) ? RuntimeHtmlCache.ToFileUrl(localFile) : null;
    }

    private async Task<RuntimeHtmlSyncResult> SyncInternalAsync(CancellationToken cancellationToken)
    {
        SetState(RuntimeHtmlSyncState.CheckingManifest, "Checking remote manifest");

        var remoteManifest = await DownloadManifestAsync(config.manifestUrl, cancellationToken);
        if (remoteManifest == null)
        {
            return Fail("Unable to download manifest.");
        }

        var version = string.IsNullOrWhiteSpace(remoteManifest.version)
            ? DateTime.UtcNow.ToString("yyyy.MM.dd-HHmmss")
            : remoteManifest.version;

        if (_cache.TryGetCurrentVersion(out var currentVersion) && currentVersion == version)
        {
            CurrentVersion = currentVersion;
            SetState(RuntimeHtmlSyncState.Ready, $"Already on {version}");
            return Ok(version, "Already up to date.");
        }

        var stagingPath = _cache.GetStagingPath(version);
        _cache.DeleteDirectorySafe(stagingPath);
        _cache.EnsureDirectory(stagingPath);

        SetState(RuntimeHtmlSyncState.Downloading, $"Downloading {remoteManifest.files?.Length ?? 0} file(s)");

        var currentReleasePath = !string.IsNullOrWhiteSpace(currentVersion) && _cache.IsVersionInstalled(currentVersion)
            ? _cache.GetReleasePath(currentVersion)
            : null;

        foreach (var file in remoteManifest.files ?? Array.Empty<RuntimeHtmlFileEntry>())
        {
            cancellationToken.ThrowIfCancellationRequested();

            var stagingFile = Path.Combine(stagingPath, file.path.Replace('/', Path.DirectorySeparatorChar));
            EnsureParentDirectory(stagingFile);

            var currentFile = currentReleasePath == null
                ? null
                : Path.Combine(currentReleasePath, file.path.Replace('/', Path.DirectorySeparatorChar));

            if (!string.IsNullOrEmpty(currentFile) && File.Exists(currentFile))
            {
                var currentHash = RuntimeHtmlCache.ComputeSha256(currentFile);
                if (string.Equals(currentHash, file.sha256, StringComparison.OrdinalIgnoreCase))
                {
                    File.Copy(currentFile, stagingFile, true);
                    continue;
                }
            }

            var remoteFileUrl = BuildRemoteFileUrl(remoteManifest.baseUrl, file.path);
            var bytes = await DownloadBytesAsync(remoteFileUrl, cancellationToken);
            if (bytes == null || bytes.Length == 0)
            {
                return Fail($"Download failed for {file.path}");
            }

            File.WriteAllBytes(stagingFile, bytes);
        }

        SetState(RuntimeHtmlSyncState.Verifying, "Verifying downloaded files");

        foreach (var file in remoteManifest.files ?? Array.Empty<RuntimeHtmlFileEntry>())
        {
            var stagingFile = Path.Combine(stagingPath, file.path.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(stagingFile))
            {
                return Fail($"Missing staged file: {file.path}");
            }

            var hash = RuntimeHtmlCache.ComputeSha256(stagingFile);
            if (!string.Equals(hash, file.sha256, StringComparison.OrdinalIgnoreCase))
            {
                return Fail($"Hash mismatch for {file.path}");
            }
        }

        SetState(RuntimeHtmlSyncState.Committing, "Committing release");

        var releasePath = _cache.GetReleasePath(version);
        _cache.DeleteDirectorySafe(releasePath);
        Directory.CreateDirectory(Path.GetDirectoryName(releasePath));
        Directory.Move(stagingPath, releasePath);
        _cache.SaveManifest(remoteManifest, version);
        _cache.SetCurrentVersion(version);
        CurrentVersion = version;

        SetState(RuntimeHtmlSyncState.Ready, $"Ready on {version}");
        return Ok(version, "Sync completed.");
    }

    private async Task<RuntimeHtmlManifest> DownloadManifestAsync(string manifestUrl, CancellationToken cancellationToken)
    {
        using (var request = UnityWebRequest.Get(manifestUrl))
        {
            request.timeout = Mathf.CeilToInt(config.requestTimeoutSeconds);
            var op = request.SendWebRequest();

            while (!op.isDone)
            {
                cancellationToken.ThrowIfCancellationRequested();
                await Task.Yield();
            }

            if (request.result != UnityWebRequest.Result.Success)
            {
                if (config.verboseLogs)
                {
                    Debug.LogWarning($"[RuntimeHtmlSync] Manifest download failed: {request.error}");
                }
                return null;
            }

            return JsonUtility.FromJson<RuntimeHtmlManifest>(request.downloadHandler.text);
        }
    }

    private async Task<byte[]> DownloadBytesAsync(string url, CancellationToken cancellationToken)
    {
        using (var request = UnityWebRequest.Get(url))
        {
            request.timeout = Mathf.CeilToInt(config.requestTimeoutSeconds);
            var op = request.SendWebRequest();

            while (!op.isDone)
            {
                cancellationToken.ThrowIfCancellationRequested();
                await Task.Yield();
            }

            if (request.result != UnityWebRequest.Result.Success)
            {
                if (config.verboseLogs)
                {
                    Debug.LogWarning($"[RuntimeHtmlSync] Download failed: {url} -> {request.error}");
                }
                return null;
            }

            return request.downloadHandler.data;
        }
    }

    private static string BuildRemoteFileUrl(string baseUrl, string relativePath)
    {
        return $"{baseUrl.TrimEnd('/')}/{relativePath.Replace("\\", "/").TrimStart('/')}";
    }

    private static void EnsureParentDirectory(string filePath)
    {
        var directory = Path.GetDirectoryName(filePath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }
    }

    private void EnsureReady()
    {
        if (config == null) throw new InvalidOperationException("RuntimeHtmlSyncConfig is not assigned.");
        if (_cache == null)
        {
            _cache = new RuntimeHtmlCache(config.GetProjectRootPath());
        }
    }

    private void SetState(RuntimeHtmlSyncState state, string message)
    {
        State = state;
        if (config != null && config.verboseLogs)
        {
            Debug.Log($"[RuntimeHtmlSync] {state}: {message}");
        }
        OnStateChanged?.Invoke(state, message);
    }

    private RuntimeHtmlSyncResult Ok(string version, string message)
    {
        return new RuntimeHtmlSyncResult
        {
            success = true,
            project = config.projectSlug,
            version = version,
            message = message,
            state = State
        };
    }

    private RuntimeHtmlSyncResult Fail(string message)
    {
        SetState(RuntimeHtmlSyncState.Failed, message);
        return new RuntimeHtmlSyncResult
        {
            success = false,
            project = config?.projectSlug,
            version = CurrentVersion,
            message = message,
            state = State
        };
    }
}
