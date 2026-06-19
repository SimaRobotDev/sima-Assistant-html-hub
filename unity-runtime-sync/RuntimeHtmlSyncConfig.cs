using UnityEngine;

[CreateAssetMenu(menuName = "SIMA/Runtime HTML Sync Config", fileName = "RuntimeHtmlSyncConfig")]
public class RuntimeHtmlSyncConfig : ScriptableObject
{
    [Header("Identity")]
    public string projectSlug = "demo-main";

    [Header("Remote")]
    public string manifestUrl;

    [Header("Local Cache")]
    public string localRootFolderName = "sima_html_cache";

    [Header("Runtime")]
    public bool autoSyncOnStart = true;
    public bool verboseLogs = true;
    public float requestTimeoutSeconds = 20f;

    public string GetProjectRootPath()
    {
        return System.IO.Path.Combine(
            Application.persistentDataPath,
            localRootFolderName,
            projectSlug
        );
    }
}

