using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using UnityEngine;

public class RuntimeHtmlCache
{
    private readonly string _rootPath;

    public RuntimeHtmlCache(string rootPath)
    {
        _rootPath = rootPath;
    }

    public string RootPath => _rootPath;
    public string ReleasesPath => Path.Combine(_rootPath, "releases");
    public string StagingPath => Path.Combine(_rootPath, "staging");
    public string CurrentVersionPath => Path.Combine(_rootPath, "current-version.txt");

    public string GetReleasePath(string version)
    {
        return Path.Combine(ReleasesPath, version);
    }

    public string GetStagingPath(string version)
    {
        return Path.Combine(StagingPath, version);
    }

    public string GetManifestPath(string version)
    {
        return Path.Combine(GetReleasePath(version), "manifest.json");
    }

    public bool TryGetCurrentVersion(out string version)
    {
        if (File.Exists(CurrentVersionPath))
        {
            version = File.ReadAllText(CurrentVersionPath).Trim();
            return !string.IsNullOrEmpty(version);
        }

        version = null;
        return false;
    }

    public void SetCurrentVersion(string version)
    {
        Directory.CreateDirectory(_rootPath);
        File.WriteAllText(CurrentVersionPath, version ?? string.Empty, Encoding.UTF8);
    }

    public bool IsVersionInstalled(string version)
    {
        return !string.IsNullOrEmpty(version) && Directory.Exists(GetReleasePath(version));
    }

    public void EnsureDirectory(string path)
    {
        Directory.CreateDirectory(path);
    }

    public void DeleteDirectorySafe(string path)
    {
        if (!Directory.Exists(path)) return;
        Directory.Delete(path, true);
    }

    public void SaveManifest(RuntimeHtmlManifest manifest, string version)
    {
        var releasePath = GetReleasePath(version);
        Directory.CreateDirectory(releasePath);
        File.WriteAllText(GetManifestPath(version), JsonUtility.ToJson(manifest, true), Encoding.UTF8);
    }

    public static string ComputeSha256(byte[] bytes)
    {
        using (var sha = SHA256.Create())
        {
            var hash = sha.ComputeHash(bytes);
            var sb = new StringBuilder(hash.Length * 2);
            foreach (var b in hash) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }
    }

    public static string ComputeSha256(string filePath)
    {
        return ComputeSha256(File.ReadAllBytes(filePath));
    }

    public static string ToFileUrl(string filePath)
    {
        return new Uri(filePath).AbsoluteUri;
    }

    public string GetInstalledFilePath(string version, string relativePath)
    {
        return Path.Combine(GetReleasePath(version), relativePath.Replace('/', Path.DirectorySeparatorChar));
    }

    public IEnumerable<string> ListInstalledVersions()
    {
        if (!Directory.Exists(ReleasesPath)) yield break;

        foreach (var dir in Directory.GetDirectories(ReleasesPath))
        {
            yield return Path.GetFileName(dir);
        }
    }
}
