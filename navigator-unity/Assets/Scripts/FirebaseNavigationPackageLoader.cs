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
    bool hasSavedSession;
    bool showManualIds;
    Vector2 scrollPosition;
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
        status = configured ? "Checking saved Firebase session…" : configError;
        RefreshCacheState();
        hasSavedSession = configured && repository.HasSavedSession;
        ReportStatus(status);
        if (hasSavedSession) _ = RestoreSavedSessionAsync();
    }

    void OnGUI()
    {
        if (!visible) return;

        const float referenceWidth = 1170f;
        var scale = Screen.width / referenceWidth;
        var safe = Screen.safeArea;
        var left = safe.xMin / scale + 32f;
        var right = (Screen.width - safe.xMax) / scale + 32f;
        var top = (Screen.height - safe.yMax) / scale + 24f;
        var bottom = safe.yMin / scale + 24f;
        var width = referenceWidth - left - right;
        var height = Screen.height / scale - top - bottom;
        var oldMatrix = GUI.matrix;
        var oldColor = GUI.color;
        var oldBackground = GUI.backgroundColor;
        GUI.matrix = Matrix4x4.TRS(Vector3.zero, Quaternion.identity, Vector3.one * scale);
        GUI.color = new Color(0.04f, 0.09f, 0.15f);
        GUI.DrawTexture(new Rect(0, 0, referenceWidth, Screen.height / scale), Texture2D.whiteTexture);
        GUI.color = Color.white;

        var oldLabelSize = GUI.skin.label.fontSize;
        var oldLabelWrap = GUI.skin.label.wordWrap;
        var oldLabelColor = GUI.skin.label.normal.textColor;
        var oldTextSize = GUI.skin.textField.fontSize;
        var oldButtonSize = GUI.skin.button.fontSize;
        GUI.skin.label.fontSize = 31;
        GUI.skin.label.wordWrap = true;
        GUI.skin.label.normal.textColor = new Color(0.86f, 0.92f, 0.98f);
        GUI.skin.textField.fontSize = 33;
        GUI.skin.button.fontSize = 32;

        var titleStyle = new GUIStyle(GUI.skin.label) { fontSize = 57, fontStyle = FontStyle.Bold };
        var sectionStyle = new GUIStyle(GUI.skin.label) { fontSize = 35, fontStyle = FontStyle.Bold };
        GUILayout.BeginArea(new Rect(left, top, width, height));
        scrollPosition = GUILayout.BeginScrollView(scrollPosition, false, true);
        GUILayout.Space(28);
        GUILayout.Label("Choose a map", titleStyle);
        GUILayout.Label("Pick the area where you'll start. Your route can continue to connected floors.");
        GUILayout.Space(30);

        if (library != null && library.Count > 0)
        {
            GUILayout.Label("AVAILABLE MAPS", sectionStyle);
            foreach (var scan in library)
            {
                GUI.enabled = !busy;
                GUI.backgroundColor = new Color(0.27f, 0.62f, 0.96f);
                if (GUILayout.Button($"{scan.BuildingId}  ·  {scan.ZoneId}   ›", GUILayout.Height(106)))
                    _ = DownloadSelectionAsync(scan);
                GUILayout.Space(12);
            }
        }

        GUI.enabled = !busy && hasCachedPackage;
        GUI.backgroundColor = new Color(0.27f, 0.62f, 0.96f);
        if (GUILayout.Button($"Open saved map offline  ·  {buildingId} / {zoneId}", GUILayout.Height(94)))
            UseCachedPackage();
        GUI.enabled = true;
        GUI.backgroundColor = oldBackground;
        GUILayout.Space(24);
        GUILayout.Label(status, GUILayout.MinHeight(86));
        GUILayout.Space(20);

        if (library == null || library.Count == 0)
        {
            GUILayout.Label("SIGN IN TO LOAD MAPS", sectionStyle);
            GUILayout.Label("Email");
            email = GUILayout.TextField(email, GUILayout.Height(76));
            GUILayout.Label("Password");
            password = GUILayout.PasswordField(password, '•', GUILayout.Height(76));
            GUI.enabled = !busy && firebaseConfig != null;
            if (GUILayout.Button(busy ? "Loading maps…" : "Show available maps", GUILayout.Height(94)))
                _ = SignInAndDownloadAsync();
            GUI.enabled = true;
        }

        GUILayout.Space(18);
        if (GUILayout.Button(showManualIds ? "Hide map IDs" : "Manual map ID / offline setup", GUILayout.Height(68)))
            showManualIds = !showManualIds;
        if (showManualIds)
        {
            GUILayout.Label("Building ID");
            var updatedBuilding = GUILayout.TextField(buildingId, GUILayout.Height(74));
            GUILayout.Label("Starting zone ID");
            var updatedZone = GUILayout.TextField(zoneId, GUILayout.Height(74));
            if (updatedBuilding != buildingId || updatedZone != zoneId)
            {
                buildingId = updatedBuilding.Trim();
                zoneId = updatedZone.Trim();
                RefreshCacheState();
            }
            GUI.enabled = !busy && hasSavedSession;
            if (GUILayout.Button("Forget saved login", GUILayout.Height(68)))
            {
                repository.ForgetSavedSession();
                hasSavedSession = false;
                SetStatus("Saved Firebase login removed.");
            }
        }
        GUI.enabled = true;
        GUILayout.EndScrollView();
        GUILayout.EndArea();

        GUI.skin.label.fontSize = oldLabelSize;
        GUI.skin.label.wordWrap = oldLabelWrap;
        GUI.skin.label.normal.textColor = oldLabelColor;
        GUI.skin.textField.fontSize = oldTextSize;
        GUI.skin.button.fontSize = oldButtonSize;
        GUI.backgroundColor = oldBackground;
        GUI.color = oldColor;
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
            hasSavedSession = repository.HasSavedSession;
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

    async Task RestoreSavedSessionAsync()
    {
        busy = true;
        try
        {
            SetStatus("Restoring saved Firebase session…");
            if (!await repository.TryRestoreSessionAsync())
            {
                hasSavedSession = false;
                SetStatus("Sign in to download the active Firebase navigation package.");
                return;
            }

            SetStatus($"Signed in as {repository.UserId}. Loading scan library…");
            library = await repository.ListAvailableScansAsync();
            SetStatus(library.Count == 0 ? "No published scans are available." : "Choose a scan to download.");
        }
        catch (Exception exception)
        {
            hasSavedSession = false;
            SetStatus($"Saved session could not be restored: {exception.Message}");
        }
        finally { busy = false; }
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
