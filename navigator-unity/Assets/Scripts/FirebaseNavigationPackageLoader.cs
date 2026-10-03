using System;
using System.Threading.Tasks;
using UnityEngine;

/// <summary>
/// Minimal credential and package-selection UI. Credentials remain in memory only;
/// only the last building and zone identifiers are stored in PlayerPrefs.
/// </summary>
public sealed class FirebaseNavigationPackageLoader : MonoBehaviour
{
    const string BuildingPreference = "gnarly.navigator.buildingId";
    const string ZonePreference = "gnarly.navigator.zoneId";

    FirebaseNavigationPackageRepository repository;
    Action<DownloadedNavigationPackage> packageReady;
    Action<string> statusChanged;
    FirebaseNavigatorConfig firebaseConfig;
    string email = "";
    string password = "";
    string buildingId = "";
    string zoneId = "zone-a";
    string status = "Preparing Firebase…";
    bool visible;
    bool busy;
    bool hasCachedPackage;
    System.Collections.Generic.List<FirebaseScanChoice> library;

    public void Begin(
        string defaultBuildingId,
        string defaultZoneId,
        Action<DownloadedNavigationPackage> onPackageReady,
        Action<string> onStatusChanged)
    {
        packageReady = onPackageReady;
        statusChanged = onStatusChanged;
        buildingId = PlayerPrefs.GetString(BuildingPreference, defaultBuildingId ?? "");
        zoneId = PlayerPrefs.GetString(ZonePreference,
            string.IsNullOrWhiteSpace(defaultZoneId) ? "zone-a" : defaultZoneId);

        var configured = FirebaseNavigationPackageRepository.TryLoadConfig(out firebaseConfig, out var configError);
        repository = new FirebaseNavigationPackageRepository(firebaseConfig);
        visible = true;
        status = configured
            ? "Sign in to download the active Firebase navigation package."
            : configError;
        RefreshCacheState();
        ReportStatus(status);
    }

    void OnGUI()
    {
        if (!visible) return;

        const float referenceWidth = 1170f;
        var scale = Mathf.Max(0.55f, Screen.width / referenceWidth);
        var oldMatrix = GUI.matrix;
        GUI.matrix = Matrix4x4.TRS(Vector3.zero, Quaternion.identity, Vector3.one * scale);
        var width = referenceWidth - 120f;
        var height = 1000f;
        var top = Mathf.Max(380f, Screen.height / scale * 0.5f - height * 0.5f);

        var oldLabelSize = GUI.skin.label.fontSize;
        var oldTextSize = GUI.skin.textField.fontSize;
        var oldButtonSize = GUI.skin.button.fontSize;
        GUI.skin.label.fontSize = 38;
        GUI.skin.textField.fontSize = 38;
        GUI.skin.button.fontSize = 38;

        GUILayout.BeginArea(new Rect(60f, top, width, height), GUI.skin.box);
        GUILayout.Space(20);
        GUILayout.Label("Firebase navigation package");
        GUILayout.Space(14);
        GUILayout.Label("Email");
        email = GUILayout.TextField(email, GUILayout.Height(64));
        GUILayout.Label("Password");
        password = GUILayout.PasswordField(password, '•', GUILayout.Height(64));
        GUILayout.Label("Building ID");
        var updatedBuilding = GUILayout.TextField(buildingId, GUILayout.Height(64));
        GUILayout.Label("Zone ID");
        var updatedZone = GUILayout.TextField(zoneId, GUILayout.Height(64));
        if (updatedBuilding != buildingId || updatedZone != zoneId)
        {
            buildingId = updatedBuilding.Trim();
            zoneId = updatedZone.Trim();
            RefreshCacheState();
        }

        GUILayout.Space(18);
        GUILayout.Label(status, GUILayout.MinHeight(110));
        GUILayout.Space(10);

        GUI.enabled = !busy && firebaseConfig != null;
        if (GUILayout.Button(busy ? "Working…" : "Sign in and download", GUILayout.Height(82)))
            _ = SignInAndDownloadAsync();

        if (library != null)
            foreach (var scan in library)
                if (GUILayout.Button($"{scan.BuildingId} / {scan.ZoneId}", GUILayout.Height(64))) _ = DownloadSelectionAsync(scan);

        GUI.enabled = !busy && hasCachedPackage;
        if (GUILayout.Button("Use downloaded package offline", GUILayout.Height(82)))
            UseCachedPackage();
        GUI.enabled = true;
        GUILayout.EndArea();

        GUI.skin.label.fontSize = oldLabelSize;
        GUI.skin.textField.fontSize = oldTextSize;
        GUI.skin.button.fontSize = oldButtonSize;
        GUI.matrix = oldMatrix;
    }

    async Task SignInAndDownloadAsync()
    {
        if (busy) return;
        busy = true;
        try
        {
            RememberSelection();
            SetStatus("Signing in to Firebase…");
            await repository.SignInAsync(email, password);
            password = "";
            SetStatus($"Signed in as {repository.UserId}. Loading scan library…");
            library = await repository.ListAvailableScansAsync();
            SetStatus(library.Count == 0 ? "No published scans are available." : "Choose a scan to download.");
        }
        catch (Exception exception)
        {
            RefreshCacheState();
            SetStatus(hasCachedPackage
                ? $"{exception.Message}\nA complete cached package is available for offline use."
                : exception.Message);
            Debug.LogError($"[Gnarly] Firebase package download failed: {exception}");
        }
        finally
        {
            busy = false;
        }
    }

    async Task DownloadSelectionAsync(FirebaseScanChoice scan)
    {
        if (busy) return;
        busy = true;
        try
        {
            buildingId = scan.BuildingId;
            zoneId = scan.ZoneId;
            RememberSelection();
            SetStatus($"Downloading {buildingId}/{zoneId}…");
            var package = await repository.DownloadActivePackageAsync(buildingId, zoneId);
            await DownloadOtherZonesAsync(scan);
            Complete(package);
        }
        catch (Exception exception)
        {
            SetStatus(exception.Message);
            Debug.LogError($"[Gnarly] Firebase scan download failed: {exception}");
        }
        finally { busy = false; }
    }

    /// <summary>
    /// Multi-zone routes (floor → stairs → floor) relocalize in each zone's own map, so the
    /// building's other zones are cached too. A zone that fails is only unavailable for routing.
    /// </summary>
    async Task DownloadOtherZonesAsync(FirebaseScanChoice selected)
    {
        foreach (var other in library)
        {
            if (other.BuildingId != selected.BuildingId || other.ZoneId == selected.ZoneId) continue;
            try
            {
                SetStatus($"Downloading connected zone {other.ZoneId}…");
                await repository.DownloadActivePackageAsync(other.BuildingId, other.ZoneId);
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"[Gnarly] Zone {other.ZoneId} is unavailable for multi-zone routes: {exception.Message}");
            }
        }
    }

    public bool TryGetCachedZoneDirectory(string cachedBuildingId, string cachedZoneId, out string directory)
    {
        directory = null;
        if (repository == null || !repository.TryGetCachedPackage(cachedBuildingId, cachedZoneId, out var package))
            return false;
        directory = package.DirectoryPath;
        return true;
    }

    void UseCachedPackage()
    {
        RememberSelection();
        if (repository.TryGetCachedPackage(buildingId, zoneId, out var package))
            Complete(package);
        else
            SetStatus("No complete cached package exists for this building and zone.");
    }

    void Complete(DownloadedNavigationPackage package)
    {
        visible = false;
        var source = package.IsOfflineCache ? "offline cache" : "Firebase";
        ReportStatus($"Loaded {package.BuildingId}/{package.VersionId}/{package.ZoneId} from {source}.");
        packageReady?.Invoke(package);
    }

    void RefreshCacheState()
    {
        hasCachedPackage = repository != null &&
                           repository.TryGetCachedPackage(buildingId, zoneId, out _);
    }

    void RememberSelection()
    {
        buildingId = buildingId.Trim();
        zoneId = zoneId.Trim();
        PlayerPrefs.SetString(BuildingPreference, buildingId);
        PlayerPrefs.SetString(ZonePreference, zoneId);
        PlayerPrefs.Save();
    }

    void SetStatus(string message)
    {
        status = message;
        ReportStatus(message);
    }

    void ReportStatus(string message)
    {
        statusChanged?.Invoke(message);
    }
}
