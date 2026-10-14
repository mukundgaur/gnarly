using System;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Xml;
using UnityEngine;
using UnityEngine.Networking;

/// <summary>
/// Authenticated navigator client. List and package download go through the publish API,
/// which checks the building ACL and returns short-lived signed URLs. Downloads are staged
/// before the cache pointer moves, so the last complete package remains usable offline.
/// </summary>
public sealed class FirebaseNavigationPackageRepository
{
    const string ConfigFileName = "GoogleService-Info.plist";
    readonly FirebaseNavigatorConfig config;
    string idToken;
    string refreshToken;
    DateTime tokenExpiresAtUtc;

    public string UserId { get; private set; }
    public bool IsAuthenticated => !string.IsNullOrEmpty(idToken);
    public bool HasSavedSession => FirebaseSessionStore.HasRefreshToken;
    public static string ExpectedConfigPath => Path.Combine(Application.streamingAssetsPath, ConfigFileName);

    public FirebaseNavigationPackageRepository(FirebaseNavigatorConfig config)
    {
        this.config = config;
    }

    public static bool TryLoadConfig(out FirebaseNavigatorConfig result, out string error)
    {
        result = null;
        error = null;
        try
        {
            if (!File.Exists(ExpectedConfigPath))
            {
                error = $"Missing {ConfigFileName}. Run Gnarly > Configure Navigator Project before building.";
                return false;
            }

            var document = new XmlDocument();
            document.Load(ExpectedConfigPath);
            var dictionary = document.SelectSingleNode("/plist/dict");
            if (dictionary == null) throw new FormatException("Firebase plist has no dictionary.");
            result = new FirebaseNavigatorConfig
            {
                apiKey = PlistString(dictionary, "API_KEY"),
                projectId = PlistString(dictionary, "PROJECT_ID"),
                storageBucket = PlistString(dictionary, "STORAGE_BUCKET"),
                bundleId = PlistString(dictionary, "BUNDLE_ID")
            };
            result.Validate();
            if (!string.Equals(result.bundleId, Application.identifier, StringComparison.Ordinal))
                throw new FormatException(
                    $"Firebase config bundle ID '{result.bundleId}' does not match navigator bundle ID " +
                    $"'{Application.identifier}'. Register this navigator app in Firebase and download its plist.");
            return true;
        }
        catch (Exception exception)
        {
            result = null;
            error = $"Could not read Firebase configuration: {exception.Message}";
            return false;
        }
    }

    public async Task SignInAsync(string email, string password)
    {
        EnsureConfigured();
        if (string.IsNullOrWhiteSpace(email) || string.IsNullOrEmpty(password))
            throw new ArgumentException("Enter the Firebase email and password.");

        var body = JsonUtility.ToJson(new SignInRequest
        {
            email = email.Trim(),
            password = password,
            returnSecureToken = true
        });
        var url = $"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={Uri.EscapeDataString(config.apiKey)}";
        var response = JsonUtility.FromJson<SignInResponse>(
            await PostJsonAsync(url, body, "Firebase sign-in", config.bundleId));
        if (response == null || string.IsNullOrEmpty(response.idToken) || string.IsNullOrEmpty(response.localId))
            throw new FirebaseNavigationException("Firebase sign-in returned an incomplete response.");

        idToken = response.idToken;
        refreshToken = response.refreshToken;
        UserId = response.localId;
        tokenExpiresAtUtc = DateTime.UtcNow.AddSeconds(ParseLifetime(response.expiresIn));
        FirebaseSessionStore.SaveRefreshToken(refreshToken);
    }

    public async Task<bool> TryRestoreSessionAsync()
    {
        EnsureConfigured();
        var savedRefreshToken = FirebaseSessionStore.LoadRefreshToken();
        if (string.IsNullOrEmpty(savedRefreshToken)) return false;

        refreshToken = savedRefreshToken;
        idToken = null;
        UserId = null;
        tokenExpiresAtUtc = DateTime.MinValue;
        try
        {
            await RefreshTokenAsync();
            return true;
        }
        catch
        {
            ForgetSavedSession();
            return false;
        }
    }

    public void ForgetSavedSession()
    {
        idToken = null;
        refreshToken = null;
        UserId = null;
        tokenExpiresAtUtc = DateTime.MinValue;
        FirebaseSessionStore.ClearRefreshToken();
    }

    public async Task<DownloadedNavigationPackage> DownloadActivePackageAsync(string buildingId, string zoneId)
    {
        ValidateIdentifier(buildingId, nameof(buildingId));
        ValidateIdentifier(zoneId, nameof(zoneId));
        var payload = JsonUtility.FromJson<PackageResponse>(await ApiGetAsync(
            $"/v1/buildings/{Uri.EscapeDataString(buildingId)}/package?zoneId={Uri.EscapeDataString(zoneId)}",
            "package download"));
        if (payload == null || string.IsNullOrEmpty(payload.versionId) || payload.zones == null || payload.zones.Length == 0)
            throw new FirebaseNavigationException($"Building '{buildingId}' has no downloadable zone '{zoneId}'.");
        var versionId = payload.versionId;
        ValidateIdentifier(versionId, "activeVersion");
        var zone = payload.zones[0];
        if (zone == null || zone.zoneId != zoneId)
            throw new FirebaseNavigationException($"Package response did not include zone '{zoneId}'.");

        var packageRoot = PackageRoot(buildingId, zoneId);
        Directory.CreateDirectory(packageRoot);
        var staging = Path.Combine(packageRoot, ".download-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        try
        {
            var buildingFile = Path.Combine(staging, "building.json");
            var scanFile = Path.Combine(staging, "scan.json");
            var scanFeaturesFile = Path.Combine(staging, "scan-features.json");
            var structureFile = Path.Combine(staging, "structure.usdz");
            var worldMapFile = Path.Combine(staging, $"worldmap-{zoneId}.bin");
            await DownloadSignedAsync(RequiredPackageFile(zone.files, "building.json").url, buildingFile, "building.json");
            await DownloadSignedAsync(RequiredPackageFile(zone.files, "scan.json").url, scanFile, "raw RoomPlan scan.json");
            await DownloadSignedAsync(RequiredPackageFile(zone.files, "scan-features.json").url, scanFeaturesFile, "normalized RoomPlan scan-features.json");
            await DownloadSignedAsync(RequiredPackageFile(zone.files, "structure.usdz").url, structureFile, "RoomPlan structure.usdz");
            await DownloadSignedAsync(RequiredPackageFile(zone.files, "worldmap.bin").url, worldMapFile, "ARWorldMap");
            ValidatePackageFiles(buildingFile, scanFile, scanFeaturesFile, structureFile, worldMapFile, zoneId);
            var connectionsFile = Path.Combine(staging, "zone-connections.json");
            await TryDownloadSignedAsync(FindPackageFile(payload.files, "zone-connections.json"), connectionsFile, "zone-connections.json");
            if (File.Exists(connectionsFile))
            {
                try { Pathfinding.ParseConnections(File.ReadAllText(connectionsFile)); }
                catch (Exception exception)
                {
                    File.Delete(connectionsFile);
                    Debug.Log($"[Gnarly] Ignoring unreadable zone connections: {exception.Message}");
                }
            }
            await TryDownloadSignedAsync(FindPackageFile(payload.files, "building-layout.json"), Path.Combine(staging, "building-layout.json"), "building-layout.json");
            var colorJson = Path.Combine(staging, SurfaceColors.JsonFileName);
            var colorAtlas = Path.Combine(staging, SurfaceColors.AtlasFileName);
            await TryDownloadSignedAsync(FindPackageFile(zone.files, SurfaceColors.JsonFileName), colorJson, SurfaceColors.JsonFileName);
            await TryDownloadSignedAsync(FindPackageFile(zone.files, SurfaceColors.AtlasFileName), colorAtlas, SurfaceColors.AtlasFileName);
            if (File.Exists(colorJson) && (SurfaceColors.Parse(File.ReadAllText(colorJson)) == null || !File.Exists(colorAtlas)))
            {
                File.Delete(colorJson);
                if (File.Exists(colorAtlas)) File.Delete(colorAtlas);
            }
            File.WriteAllText(Path.Combine(staging, "package.json"), JsonUtility.ToJson(new CacheManifest
            {
                buildingId = buildingId,
                versionId = versionId,
                zoneId = zoneId,
                cachedAtUtc = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture)
            }, true));

            var finalDirectory = Path.Combine(packageRoot, versionId);
            if (Directory.Exists(finalDirectory)) Directory.Delete(finalDirectory, true);
            Directory.Move(staging, finalDirectory);
            WriteAtomically(LatestPointerPath(buildingId, zoneId),
                JsonUtility.ToJson(new LatestPointer { versionId = versionId }));
            Debug.Log($"[Gnarly] Cached Firebase package {buildingId}/{versionId}/{zoneId} at {finalDirectory}.");
            return new DownloadedNavigationPackage(buildingId, versionId, zoneId, finalDirectory, false);
        }
        catch
        {
            if (Directory.Exists(staging)) Directory.Delete(staging, true);
            throw;
        }
    }

    public async Task<List<FirebaseScanChoice>> ListAvailableScansAsync()
    {
        var payload = JsonUtility.FromJson<LibraryResponse>(await ApiGetAsync("/v1/buildings", "scan library"));
        var result = new List<FirebaseScanChoice>();
        if (payload?.buildings == null) return result;
        foreach (var building in payload.buildings)
        {
            if (building == null || string.IsNullOrEmpty(building.id) || string.IsNullOrEmpty(building.activeVersion) || building.zones == null)
                continue;
            foreach (var zone in building.zones)
            {
                if (zone == null || string.IsNullOrEmpty(zone.id)) continue;
                result.Add(new FirebaseScanChoice(building.id, building.activeVersion, zone.id, building.name, zone.floorId, zone.name));
            }
        }
        return result;
    }

    public bool TryGetCachedPackage(string buildingId, string zoneId, out DownloadedNavigationPackage package)
    {
        package = null;
        try
        {
            ValidateIdentifier(buildingId, nameof(buildingId));
            ValidateIdentifier(zoneId, nameof(zoneId));
            var root = PackageRoot(buildingId, zoneId);
            if (!Directory.Exists(root)) return false;
            var candidates = new System.Collections.Generic.List<string>();
            var pointerPath = LatestPointerPath(buildingId, zoneId);
            if (File.Exists(pointerPath))
            {
                var pointer = JsonUtility.FromJson<LatestPointer>(File.ReadAllText(pointerPath));
                if (pointer != null && !string.IsNullOrEmpty(pointer.versionId))
                    candidates.Add(Path.Combine(root, pointer.versionId));
            }

            var directories = Directory.GetDirectories(root);
            Array.Sort(directories, (left, right) =>
                Directory.GetLastWriteTimeUtc(right).CompareTo(Directory.GetLastWriteTimeUtc(left)));
            foreach (var directory in directories)
                if (!Path.GetFileName(directory).StartsWith(".download-", StringComparison.Ordinal) && !candidates.Contains(directory))
                    candidates.Add(directory);
            foreach (var directory in candidates)
            {
                try
                {
                    if (TryReadCompleteCache(directory, buildingId, zoneId, out package)) return true;
                }
                catch (Exception exception)
                {
                    Debug.LogWarning($"[Gnarly] Ignoring incomplete cache at {directory}: {exception.Message}");
                }
            }
        }
        catch (Exception exception)
        {
            Debug.LogWarning($"[Gnarly] Could not inspect Firebase cache: {exception.Message}");
        }
        return false;
    }

    async Task EnsureFreshTokenAsync()
    {
        if (!IsAuthenticated)
            throw new FirebaseNavigationException("Sign in before accessing Firestore or Storage.");
        if (DateTime.UtcNow < tokenExpiresAtUtc.AddMinutes(-2)) return;
        if (string.IsNullOrEmpty(refreshToken))
            throw new FirebaseNavigationException("The Firebase session expired. Sign in again.");

        await RefreshTokenAsync();
    }

    async Task RefreshTokenAsync()
    {
        if (string.IsNullOrEmpty(refreshToken))
            throw new FirebaseNavigationException("The Firebase session expired. Sign in again.");
        EnsureConfigured();
        var url = $"https://securetoken.googleapis.com/v1/token?key={Uri.EscapeDataString(config.apiKey)}";
        var form = "grant_type=refresh_token&refresh_token=" + UnityWebRequest.EscapeURL(refreshToken);
        var response = JsonUtility.FromJson<RefreshResponse>(
            await PostFormAsync(url, form, "Firebase session refresh", config.bundleId));
        if (response == null || string.IsNullOrEmpty(response.id_token))
            throw new FirebaseNavigationException("Firebase session refresh returned an incomplete response.");

        idToken = response.id_token;
        if (!string.IsNullOrEmpty(response.refresh_token)) refreshToken = response.refresh_token;
        if (!string.IsNullOrEmpty(response.user_id)) UserId = response.user_id;
        tokenExpiresAtUtc = DateTime.UtcNow.AddSeconds(ParseLifetime(response.expires_in));
        FirebaseSessionStore.SaveRefreshToken(refreshToken);
    }

    async Task<string> ApiGetAsync(string path, string operation)
    {
        await EnsureFreshTokenAsync();
        using var request = UnityWebRequest.Get(ApiBaseUrl() + path);
        request.SetRequestHeader("Authorization", "Bearer " + idToken);
        return await SendForTextAsync(request, operation);
    }

    string _apiBaseUrl;

    string ApiBaseUrl()
    {
        if (!string.IsNullOrEmpty(_apiBaseUrl)) return _apiBaseUrl;
        var asset = Resources.Load<TextAsset>("gnarly-api-base");
        var text = asset == null ? "" : asset.text;
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal)) continue;
            if (!line.StartsWith("https://", StringComparison.Ordinal) &&
                !line.StartsWith("http://127.0.0.1", StringComparison.Ordinal) &&
                !line.StartsWith("http://localhost", StringComparison.Ordinal))
                break;
            _apiBaseUrl = line.TrimEnd('/');
            return _apiBaseUrl;
        }
        throw new FirebaseNavigationException(
            "Set the publish API origin in Assets/Resources/gnarly-api-base.txt. " +
            "Use the Cloud Run, Functions, or API Gateway URL, with no trailing slash.");
    }

    static PackageFile FindPackageFile(PackageFile[] files, string name)
    {
        if (files == null) return null;
        foreach (var file in files)
            if (file != null && file.name == name && !string.IsNullOrEmpty(file.url)) return file;
        return null;
    }

    static PackageFile RequiredPackageFile(PackageFile[] files, string name)
    {
        var file = FindPackageFile(files, name);
        if (file == null) throw new FirebaseNavigationException($"The publish API did not return {name}.");
        return file;
    }

    async Task DownloadSignedAsync(string url, string destination, string label)
    {
        using var request = new UnityWebRequest(url, UnityWebRequest.kHttpVerbGET)
        {
            downloadHandler = new DownloadHandlerFile(destination, true)
        };
        await SendAsync(request, "Package download " + label);
    }

    async Task TryDownloadSignedAsync(PackageFile file, string destination, string label)
    {
        if (file == null) return;
        try { await DownloadSignedAsync(file.url, destination, label); }
        catch (Exception exception)
        {
            if (File.Exists(destination)) File.Delete(destination);
            Debug.Log($"[Gnarly] Optional {label} was not downloaded: {exception.Message}");
        }
    }

    static async Task<string> PostJsonAsync(string url, string body, string operation, string bundleId)
    {
        using var request = new UnityWebRequest(url, UnityWebRequest.kHttpVerbPOST)
        {
            uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body)),
            downloadHandler = new DownloadHandlerBuffer()
        };
        request.SetRequestHeader("Content-Type", "application/json");
        request.SetRequestHeader("X-Ios-Bundle-Identifier", bundleId);
        return await SendForTextAsync(request, operation);
    }

    static async Task<string> PostFormAsync(string url, string body, string operation, string bundleId)
    {
        using var request = new UnityWebRequest(url, UnityWebRequest.kHttpVerbPOST)
        {
            uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body)),
            downloadHandler = new DownloadHandlerBuffer()
        };
        request.SetRequestHeader("Content-Type", "application/x-www-form-urlencoded");
        request.SetRequestHeader("X-Ios-Bundle-Identifier", bundleId);
        return await SendForTextAsync(request, operation);
    }

    static async Task<string> SendForTextAsync(UnityWebRequest request, string operation)
    {
        if (request.downloadHandler == null) request.downloadHandler = new DownloadHandlerBuffer();
        await SendAsync(request, operation);
        return request.downloadHandler.text;
    }

    static async Task SendAsync(UnityWebRequest request, string operation)
    {
        var completion = new TaskCompletionSource<bool>();
        var asyncOperation = request.SendWebRequest();
        asyncOperation.completed += _ => completion.TrySetResult(true);
        await completion.Task;
        if (request.result == UnityWebRequest.Result.Success) return;

        var detail = request.downloadHandler is DownloadHandlerBuffer
            ? ExtractFirebaseError(request.downloadHandler.text)
            : null;
        if (string.IsNullOrEmpty(detail)) detail = request.error;
        throw new FirebaseNavigationException($"{operation} failed ({request.responseCode}): {detail}");
    }

    static string ExtractFirebaseError(string body)
    {
        if (string.IsNullOrEmpty(body)) return null;
        try
        {
            return JsonUtility.FromJson<FirebaseErrorEnvelope>(body)?.error?.message;
        }
        catch
        {
            return null;
        }
    }

    static bool TryReadCompleteCache(
        string directory,
        string expectedBuildingId,
        string expectedZoneId,
        out DownloadedNavigationPackage package)
    {
        package = null;
        var manifestPath = Path.Combine(directory, "package.json");
        if (!File.Exists(manifestPath)) return false;
        var manifest = JsonUtility.FromJson<CacheManifest>(File.ReadAllText(manifestPath));
        if (manifest == null || manifest.buildingId != expectedBuildingId || manifest.zoneId != expectedZoneId)
            return false;

        ValidateIdentifier(manifest.versionId, "cached versionId");
        ValidatePackageFiles(
            Path.Combine(directory, "building.json"),
            Path.Combine(directory, "scan.json"),
            Path.Combine(directory, "scan-features.json"),
            Path.Combine(directory, "structure.usdz"),
            Path.Combine(directory, $"worldmap-{expectedZoneId}.bin"),
            expectedZoneId);
        package = new DownloadedNavigationPackage(
            manifest.buildingId, manifest.versionId, manifest.zoneId, directory, true);
        return true;
    }

    static void ValidatePackageFiles(
        string buildingFile,
        string scanFile,
        string scanFeaturesFile,
        string structureFile,
        string worldMapFile,
        string expectedZoneId)
    {
        if (!File.Exists(buildingFile) || new FileInfo(buildingFile).Length == 0)
            throw new FirebaseNavigationException("Downloaded building.json is missing or empty.");
        if (!File.Exists(scanFile) || new FileInfo(scanFile).Length == 0)
            throw new FirebaseNavigationException("Downloaded raw RoomPlan scan.json is missing or empty.");
        if (!File.Exists(scanFeaturesFile) || new FileInfo(scanFeaturesFile).Length == 0)
            throw new FirebaseNavigationException("Downloaded normalized RoomPlan scan-features.json is missing or empty.");
        if (!File.Exists(structureFile) || new FileInfo(structureFile).Length == 0)
            throw new FirebaseNavigationException("Downloaded RoomPlan structure.usdz is missing or empty.");
        if (!File.Exists(worldMapFile) || new FileInfo(worldMapFile).Length == 0)
            throw new FirebaseNavigationException("Downloaded ARWorldMap is missing or empty.");

        var building = Pathfinding.ParseBuilding(File.ReadAllText(buildingFile));
        if (building.schemaVersion != 1)
            throw new FirebaseNavigationException($"Unsupported building.json schemaVersion {building.schemaVersion}.");
        if (building.zoneId != expectedZoneId)
            throw new FirebaseNavigationException(
                $"building.json zone '{building.zoneId}' does not match requested zone '{expectedZoneId}'.");
        if (building.nodes == null || building.edges == null)
            throw new FirebaseNavigationException("building.json must contain nodes and edges arrays.");

        var rawScan = File.ReadAllText(scanFile).TrimStart();
        if (!rawScan.StartsWith("{", StringComparison.Ordinal))
            throw new FirebaseNavigationException("Downloaded raw RoomPlan scan.json is not a JSON object.");

        var scan = Pathfinding.ParseScan(File.ReadAllText(scanFeaturesFile));
        if (scan.schemaVersion != 1)
            throw new FirebaseNavigationException($"Unsupported scan-features.json schemaVersion {scan.schemaVersion}.");
        if (scan.zoneId != expectedZoneId)
            throw new FirebaseNavigationException(
                $"scan-features.json zone '{scan.zoneId}' does not match requested zone '{expectedZoneId}'.");
    }

    static void ValidateIdentifier(string value, string field)
    {
        if (string.IsNullOrWhiteSpace(value) || value == "." || value == "..")
            throw new ArgumentException($"{field} is required.");
        foreach (var character in value)
            if (character == '/' || character == '\\' || char.IsControl(character))
                throw new ArgumentException($"{field} cannot contain '/', '\\', or control characters.");
    }

    public async Task SignInAnonymouslyAsync()
    {
        EnsureConfigured();
        var url = $"https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={Uri.EscapeDataString(config.apiKey)}";
        var response = JsonUtility.FromJson<SignInResponse>(
            await PostJsonAsync(url, "{\"returnSecureToken\":true}", "Firebase anonymous access", config.bundleId));
        if (response == null || string.IsNullOrEmpty(response.idToken) || string.IsNullOrEmpty(response.localId))
            throw new FirebaseNavigationException("Firebase anonymous access returned an incomplete response.");
        idToken = response.idToken;
        refreshToken = response.refreshToken;
        UserId = response.localId;
        tokenExpiresAtUtc = DateTime.UtcNow.AddSeconds(ParseLifetime(response.expiresIn));
        FirebaseSessionStore.SaveRefreshToken(refreshToken);
    }

    public List<DownloadedNavigationPackage> ListCachedPackages()
    {
        var result = new List<DownloadedNavigationPackage>();
        var root = Path.Combine(Application.persistentDataPath, "navigation-cache");
        if (!Directory.Exists(root)) return result;
        foreach (var buildingPath in Directory.GetDirectories(root))
            foreach (var zonePath in Directory.GetDirectories(buildingPath))
                if (TryGetCachedPackage(Path.GetFileName(buildingPath), Path.GetFileName(zonePath), out var package))
                    result.Add(package);
        return result;
    }

    void EnsureConfigured()
    {
        if (config == null)
            throw new FirebaseNavigationException($"Firebase is not configured. Add {ConfigFileName} to Assets/StreamingAssets.");
    }

    static long ParseLifetime(string value) =>
        long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var seconds)
            ? Math.Max(60, seconds)
            : 3600;

    static string PackageRoot(string buildingId, string zoneId) =>
        Path.Combine(Application.persistentDataPath, "navigation-cache", buildingId, zoneId);

    static string LatestPointerPath(string buildingId, string zoneId) =>
        Path.Combine(PackageRoot(buildingId, zoneId), "latest.json");

    static void WriteAtomically(string path, string contents)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        var temporary = path + ".tmp";
        File.WriteAllText(temporary, contents);
        if (File.Exists(path)) File.Delete(path);
        File.Move(temporary, path);
    }

    static string PlistString(XmlNode dictionary, string wantedKey)
    {
        for (var node = dictionary.FirstChild; node != null; node = node.NextSibling)
        {
            if (node.NodeType != XmlNodeType.Element || node.Name != "key" || node.InnerText != wantedKey) continue;
            var value = node.NextSibling;
            while (value != null && value.NodeType != XmlNodeType.Element) value = value.NextSibling;
            return value?.InnerText;
        }
        return null;
    }

    [Serializable] sealed class SignInRequest
    {
        public string email;
        public string password;
        public bool returnSecureToken;
    }

    [Serializable] sealed class SignInResponse
    {
        public string idToken;
        public string refreshToken;
        public string expiresIn;
        public string localId;
    }

    [Serializable] sealed class RefreshResponse
    {
        public string id_token;
        public string expires_in;
        public string refresh_token;
        public string user_id;
    }

    [Serializable] sealed class LibraryResponse { public LibraryBuilding[] buildings; }
    [Serializable] sealed class LibraryBuilding
    {
        public string id;
        public string name;
        public string activeVersion;
        public LibraryZone[] zones;
    }
    [Serializable] sealed class LibraryZone
    {
        public string id;
        public string name;
        public string floorId;
    }
    [Serializable] sealed class PackageResponse
    {
        public string buildingId;
        public string versionId;
        public PackageFile[] files;
        public PackageZone[] zones;
    }
    [Serializable] sealed class PackageZone
    {
        public string zoneId;
        public string name;
        public string floorId;
        public PackageFile[] files;
    }
    [Serializable] sealed class PackageFile
    {
        public string name;
        public string url;
        public bool required;
    }

    [Serializable] sealed class FirebaseErrorEnvelope
    {
        public FirebaseError error;
    }

    [Serializable] sealed class FirebaseError
    {
        public string message;
    }

    [Serializable] sealed class CacheManifest
    {
        public string buildingId;
        public string versionId;
        public string zoneId;
        public string cachedAtUtc;
    }

    [Serializable] sealed class LatestPointer
    {
        public string versionId;
    }
}

[Serializable]
public sealed class FirebaseNavigatorConfig
{
    public string apiKey;
    public string projectId;
    public string storageBucket;
    public string bundleId;

    public void Validate()
    {
        if (string.IsNullOrWhiteSpace(apiKey)) throw new FormatException("API_KEY is missing.");
        if (string.IsNullOrWhiteSpace(projectId)) throw new FormatException("PROJECT_ID is missing.");
        if (string.IsNullOrWhiteSpace(storageBucket)) throw new FormatException("STORAGE_BUCKET is missing.");
        if (string.IsNullOrWhiteSpace(bundleId)) throw new FormatException("BUNDLE_ID is missing.");
    }
}

public sealed class DownloadedNavigationPackage
{
    public string BuildingId { get; }
    public string VersionId { get; }
    public string ZoneId { get; }
    public string DirectoryPath { get; }
    public bool IsOfflineCache { get; }

    public DownloadedNavigationPackage(
        string buildingId,
        string versionId,
        string zoneId,
        string directoryPath,
        bool isOfflineCache)
    {
        BuildingId = buildingId;
        VersionId = versionId;
        ZoneId = zoneId;
        DirectoryPath = directoryPath;
        IsOfflineCache = isOfflineCache;
    }
}

public sealed class FirebaseScanChoice
{
    public string BuildingId { get; }
    public string VersionId { get; }
    public string ZoneId { get; }
    public string BuildingName { get; }
    public string FloorId { get; }
    public string ZoneName { get; }
    public FirebaseScanChoice(string buildingId, string versionId, string zoneId,
        string buildingName = null, string floorId = null, string zoneName = null)
    {
        BuildingId = buildingId;
        VersionId = versionId;
        ZoneId = zoneId;
        BuildingName = buildingName;
        FloorId = floorId;
        ZoneName = ZoneLabels.Known(buildingId, zoneId) ?? zoneName;
    }
}

/// <summary>Display names fixed in the app for zones whose scans carry no useful name.</summary>
public static class ZoneLabels
{
    public static string Known(string buildingId, string zoneId) =>
        string.Equals(buildingId, "baker", StringComparison.OrdinalIgnoreCase) && zoneId == "1" ? "Entrance" : null;
}

public sealed class FirebaseNavigationException : Exception
{
    public FirebaseNavigationException(string message) : base(message) { }
}
