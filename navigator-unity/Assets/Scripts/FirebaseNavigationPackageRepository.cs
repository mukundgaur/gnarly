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
/// Authenticated Firebase REST client for the navigator. It stages and validates downloads
/// before moving the cache pointer, so the last complete package remains usable offline.
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
    }

    public async Task<DownloadedNavigationPackage> DownloadActivePackageAsync(string buildingId, string zoneId)
    {
        ValidateIdentifier(buildingId, nameof(buildingId));
        ValidateIdentifier(zoneId, nameof(zoneId));
        await EnsureFreshTokenAsync();

        var building = await GetDocumentAsync($"buildings/{buildingId}", "building metadata");
        var versionId = RequiredString(building.fields?.activeVersion, "activeVersion", $"buildings/{buildingId}");
        ValidateIdentifier(versionId, "activeVersion");
        var versionPath = $"buildings/{buildingId}/versions/{versionId}";
        var version = await GetDocumentAsync(versionPath, "active building version");
        var zonePath = $"{versionPath}/zones/{zoneId}";
        var zone = await GetDocumentAsync(zonePath, "zone metadata");

        var expectedBuildingPath = $"buildings/{buildingId}/{versionId}/building.json";
        var expectedWorldMapPath = $"buildings/{buildingId}/{versionId}/worldmaps/{zoneId}.bin";
        RequireExpectedPath(expectedBuildingPath,
            RequiredString(version.fields?.buildingJsonPath, "buildingJsonPath", versionPath), "buildingJsonPath");
        RequireExpectedPath(expectedWorldMapPath,
            RequiredString(zone.fields?.worldMapPath, "worldMapPath", zonePath), "worldMapPath");

        var packageRoot = PackageRoot(buildingId, zoneId);
        Directory.CreateDirectory(packageRoot);
        var staging = Path.Combine(packageRoot, ".download-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        try
        {
            var buildingFile = Path.Combine(staging, "building.json");
            var worldMapFile = Path.Combine(staging, $"worldmap-{zoneId}.bin");
            await DownloadStorageObjectAsync(expectedBuildingPath, buildingFile, "building.json");
            await DownloadStorageObjectAsync(expectedWorldMapPath, worldMapFile, "ARWorldMap");
            ValidatePackageFiles(buildingFile, worldMapFile, zoneId);
            await TryDownloadZoneConnectionsAsync(
                $"buildings/{buildingId}/{versionId}/zone-connections.json",
                Path.Combine(staging, "zone-connections.json"));
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
        await EnsureFreshTokenAsync();
        var result = new List<FirebaseScanChoice>();
        foreach (var building in await ListDocumentsAsync("buildings", "scan library buildings"))
        {
            var buildingId = LastPathComponent(building.name);
            var versionId = building.fields?.activeVersion?.stringValue;
            if (string.IsNullOrEmpty(buildingId) || string.IsNullOrEmpty(versionId)) continue;
            foreach (var zone in await ListDocumentsAsync($"buildings/{buildingId}/versions/{versionId}/zones", "scan library zones"))
            {
                var zoneId = LastPathComponent(zone.name);
                if (!string.IsNullOrEmpty(zoneId)) result.Add(new FirebaseScanChoice(buildingId, versionId, zoneId));
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
    }

    async Task<FirestoreDocument> GetDocumentAsync(string documentPath, string operation)
    {
        await EnsureFreshTokenAsync();
        var url = $"https://firestore.googleapis.com/v1/projects/{Uri.EscapeDataString(config.projectId)}/databases/(default)/documents/{documentPath}";
        using var request = UnityWebRequest.Get(url);
        request.SetRequestHeader("Authorization", "Bearer " + idToken);
        var responseText = await SendForTextAsync(request, "Firestore " + operation);
        var document = JsonUtility.FromJson<FirestoreDocument>(responseText);
        if (document == null || document.fields == null)
            throw new FirebaseNavigationException($"Firestore {operation} returned no fields.");
        return document;
    }

    async Task<List<FirestoreDocument>> ListDocumentsAsync(string collectionPath, string operation)
    {
        var url = $"https://firestore.googleapis.com/v1/projects/{Uri.EscapeDataString(config.projectId)}/databases/(default)/documents/{collectionPath}";
        using var request = UnityWebRequest.Get(url);
        request.SetRequestHeader("Authorization", "Bearer " + idToken);
        var response = JsonUtility.FromJson<FirestoreListResponse>(await SendForTextAsync(request, "Firestore " + operation));
        return response?.documents == null ? new List<FirestoreDocument>() : new List<FirestoreDocument>(response.documents);
    }

    /// <summary>zone-connections.json is optional; a missing or invalid file leaves the package single-zone.</summary>
    async Task TryDownloadZoneConnectionsAsync(string objectPath, string destination)
    {
        try
        {
            await DownloadStorageObjectAsync(objectPath, destination, "zone-connections.json");
            Pathfinding.ParseConnections(File.ReadAllText(destination));
        }
        catch (Exception exception)
        {
            if (File.Exists(destination)) File.Delete(destination);
            Debug.Log($"[Gnarly] No zone connections at {objectPath}: {exception.Message}");
        }
    }

    static string LastPathComponent(string path) => string.IsNullOrEmpty(path) ? "" : path.Substring(path.LastIndexOf('/') + 1);

    async Task DownloadStorageObjectAsync(string objectPath, string destination, string label)
    {
        await EnsureFreshTokenAsync();
        var encodedObject = Uri.EscapeDataString(objectPath);
        var url = $"https://firebasestorage.googleapis.com/v0/b/{Uri.EscapeDataString(config.storageBucket)}/o/{encodedObject}?alt=media";
        using var request = new UnityWebRequest(url, UnityWebRequest.kHttpVerbGET)
        {
            downloadHandler = new DownloadHandlerFile(destination, true)
        };
        request.SetRequestHeader("Authorization", "Bearer " + idToken);
        await SendAsync(request, "Storage download " + label);
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
            Path.Combine(directory, $"worldmap-{expectedZoneId}.bin"),
            expectedZoneId);
        package = new DownloadedNavigationPackage(
            manifest.buildingId, manifest.versionId, manifest.zoneId, directory, true);
        return true;
    }

    static void ValidatePackageFiles(string buildingFile, string worldMapFile, string expectedZoneId)
    {
        if (!File.Exists(buildingFile) || new FileInfo(buildingFile).Length == 0)
            throw new FirebaseNavigationException("Downloaded building.json is missing or empty.");
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
    }

    static string RequiredString(FirestoreStringValue value, string field, string documentPath)
    {
        if (value == null || string.IsNullOrWhiteSpace(value.stringValue))
            throw new FirebaseNavigationException($"Firestore document {documentPath} is missing {field}.");
        return value.stringValue;
    }

    static void RequireExpectedPath(string expected, string actual, string field)
    {
        if (!string.Equals(expected, actual, StringComparison.Ordinal))
            throw new FirebaseNavigationException($"Unexpected {field}. Expected '{expected}', received '{actual}'.");
    }

    static void ValidateIdentifier(string value, string field)
    {
        if (string.IsNullOrWhiteSpace(value) || value == "." || value == "..")
            throw new ArgumentException($"{field} is required.");
        foreach (var character in value)
            if (!(char.IsLetterOrDigit(character) || character == '-' || character == '_' || character == '.'))
                throw new ArgumentException($"{field} may only contain letters, numbers, '.', '-' and '_'.");
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

    [Serializable] sealed class FirestoreDocument
    {
        public string name;
        public FirestoreFields fields;
    }
    [Serializable] sealed class FirestoreListResponse { public FirestoreDocument[] documents; }

    [Serializable] sealed class FirestoreFields
    {
        public FirestoreStringValue activeVersion;
        public FirestoreStringValue buildingJsonPath;
        public FirestoreStringValue worldMapPath;
    }

    [Serializable] sealed class FirestoreStringValue
    {
        public string stringValue;
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
    public FirebaseScanChoice(string buildingId, string versionId, string zoneId)
    { BuildingId = buildingId; VersionId = versionId; ZoneId = zoneId; }
}

public sealed class FirebaseNavigationException : Exception
{
    public FirebaseNavigationException(string message) : base(message) { }
}
