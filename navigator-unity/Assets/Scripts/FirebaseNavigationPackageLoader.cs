using System;
using System.IO;
using System.Threading.Tasks;
using UnityEngine;

/// <summary>
/// Map library launch flow. Online maps use a background Firebase session; downloaded maps work offline.
/// </summary>
public sealed partial class FirebaseNavigationPackageLoader : MonoBehaviour
{
    const string BuildingPreference = "gnarly.navigator.buildingId";
    const string ZonePreference = "gnarly.navigator.zoneId";

    FirebaseNavigationPackageRepository repository;
    Action<DownloadedNavigationPackage, string, string> packageReady;
    Action<string> statusChanged;
    FirebaseNavigatorConfig firebaseConfig;
    string buildingId = "";
    string zoneId = "zone-a";
    string status = "Preparing Firebase…";
    bool visible;
    bool busy;
    bool hasCachedPackage;
    bool onlineMapsAvailable;
    System.Collections.Generic.List<FirebaseScanChoice> library;
    System.Collections.Generic.List<FirebaseScanChoice> publishedLibrary;

    public void Begin(
        string defaultBuildingId,
        string defaultZoneId,
        Action<DownloadedNavigationPackage, string, string> onPackageReady,
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
        status = configured ? "Finding available maps…" : configError;
        RefreshCacheState();
        LoadCachedLibrary();
        BuildUi();
        ReportStatus(status);
        if (configured) _ = LoadMapsAsync();
    }

    void LoadCachedLibrary()
    {
        library = new System.Collections.Generic.List<FirebaseScanChoice>();
        foreach (var package in repository.ListCachedPackages())
        {
            string floorId = null;
            try
            {
                var buildingJson = Path.Combine(package.DirectoryPath, "building.json");
                if (File.Exists(buildingJson))
                {
                    var building = Pathfinding.ParseBuilding(File.ReadAllText(buildingJson));
                    if (building.floors != null && building.floors.Length == 1)
                        floorId = building.floors[0].id;
                }
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"[Gnarly] Could not read cached floor name for {package.ZoneId}: {exception.Message}");
            }
            library.Add(new FirebaseScanChoice(package.BuildingId, package.VersionId, package.ZoneId,
                floorId: floorId));
        }
    }

    async Task LoadMapsAsync()
    {
        if (busy) return;
        busy = true;
        try
        {
            SetStatus("Finding available maps…");
            if (!await repository.TryRestoreSessionAsync()) await repository.SignInAnonymouslyAsync();
            var published = await repository.ListAvailableScansAsync();
            publishedLibrary = published;
            onlineMapsAvailable = true;
            foreach (var scan in published)
            {
                var cachedIndex = library.FindIndex(cached => cached.BuildingId == scan.BuildingId && cached.ZoneId == scan.ZoneId);
                if (cachedIndex >= 0) library[cachedIndex] = scan;
                else library.Add(scan);
            }
            library = new System.Collections.Generic.List<FirebaseScanChoice>(library);
            SetStatus(library.Count == 0 ? "No maps have been published yet." : "Choose a floor to continue.");
        }
        catch (Exception exception)
        {
            onlineMapsAvailable = false;
            publishedLibrary = null;
            SetStatus(library.Count > 0
                ? "Online maps are unavailable. Your downloaded maps are ready."
                : "Maps could not be loaded. Check the connection and map access, then retry.");
            Debug.LogWarning($"[Gnarly] Map library unavailable: {exception.Message}");
        }
        finally { busy = false; RefreshUi(); }
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
            // The selected zone is the user's physical starting area. Go straight to ARKit
            // relocalization; the post-location minimap is the destination picker.
            Complete(package, null, null);
        }
        catch (Exception exception)
        {
            SetStatus(exception.Message);
            Debug.LogError($"[Gnarly] Firebase scan download failed: {exception}");
        }
        finally { busy = false; RefreshUi(); }
    }

    /// <summary>
    /// Multi-zone routes (floor → stairs → floor) relocalize in each zone's own map, so the
    /// building's other zones are cached too. A zone that fails is only unavailable for routing.
    /// </summary>
    async Task DownloadOtherZonesAsync(FirebaseScanChoice selected)
    {
        if (!onlineMapsAvailable || publishedLibrary == null) return;
        foreach (var other in publishedLibrary)
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
            Complete(package, null, null);
        else
            SetStatus("No complete cached package exists for this building and zone.");
    }

    void Complete(DownloadedNavigationPackage package, string startKey, string destinationKey)
    {
        visible = false;
        DestroyUi();
        var source = package.IsOfflineCache ? "offline cache" : "Firebase";
        ReportStatus($"Loaded {package.BuildingId}/{package.VersionId}/{package.ZoneId} from {source}.");
        packageReady?.Invoke(package, startKey, destinationKey);
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
        RefreshUi();
        ReportStatus(message);
    }

    void ReportStatus(string message)
    {
        statusChanged?.Invoke(message);
    }
}
