using System;

[Serializable]
public class RuntimeHtmlManifest
{
    public int schemaVersion = 1;
    public string project;
    public string version;
    public string baseUrl;
    public string generatedAt;
    public string hashAlgorithm = "sha256";
    public string rollbackTo;
    public RuntimeHtmlEntryPoint[] entryPoints;
    public RuntimeHtmlFileEntry[] files;
}

[Serializable]
public class RuntimeHtmlEntryPoint
{
    public string service;
    public string entry;
}

[Serializable]
public class RuntimeHtmlFileEntry
{
    public string path;
    public long size;
    public string sha256;
}

