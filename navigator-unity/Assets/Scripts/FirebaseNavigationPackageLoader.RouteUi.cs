using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using UnityEngine;
using UnityEngine.UI;

/// <summary>Searchable, pre-camera start and destination selection from downloaded building graphs.</summary>
public sealed partial class FirebaseNavigationPackageLoader
{
    sealed class RoutePlace
    {
        public string key;
        public string name;
        public string zone;
        public string area;
        public string kind;
        public bool reachable;
    }

    readonly List<RoutePlace> routePlaces = new List<RoutePlace>();
    DownloadedNavigationPackage pendingPackage;
    string routeStartKey;
    string routeDestinationKey;
    bool routeSkipDestination;
    bool routeSelectionMode;
    bool routeChoosingStart;
    InputField routeSearch;
    RectTransform routeResults;
    LayoutElement routeResultsHeight;
    string previewZoneId;

#if UNITY_IOS && !UNITY_EDITOR
    [DllImport("__Internal")]
    static extern void GnarlyShowRoomModel(string modelPath, string buildingPath, string scanPath,
        string callbackObjectName, string selectionJson);
#endif

    [Serializable]
    sealed class RouteModelRequest
    {
        public string startId;
        public string destinationId;
        public bool previewMode = true;
        public string focusId;
        public string selectionSlot;
    }

    [Serializable]
    sealed class RouteModelChoice
    {
        public string id;
        public string slot;
    }

    public void OnRoutePreviewSelection(string json)
    {
        if (!routeSelectionMode || string.IsNullOrEmpty(previewZoneId)) return;
        var choice = JsonUtility.FromJson<RouteModelChoice>(json);
        if (choice == null || string.IsNullOrEmpty(choice.id)) return;
        var key = Pathfinding.ZoneKey(previewZoneId, choice.id);
        if (!routePlaces.Exists(place => place.key == key && place.reachable)) return;
        if (choice.slot == "start")
        {
            if (previewZoneId != pendingPackage.ZoneId) return;
            routeStartKey = key;
            if (routeDestinationKey == key) routeDestinationKey = null;
            routeChoosingStart = false;
        }
        else if (choice.slot == "destination")
        {
            routeDestinationKey = key;
            if (routeStartKey == key) routeStartKey = null;
            routeSkipDestination = false;
            routeChoosingStart = false;
        }
        else return;
        SetStatus("Selected " + RoutePlaceName(key) + ". Look around or continue to camera.");
        BuildContent();
        RefreshUi();
    }

    void OpenRouteModel(RoutePlace focus = null)
    {
        if (routeSearch != null) routeSearch.DeactivateInputField();
        var zone = focus?.zone ?? pendingPackage?.ZoneId;
        var zonePackage = repository.ListCachedPackages().Find(package =>
            package.BuildingId == pendingPackage?.BuildingId &&
            package.VersionId == pendingPackage?.VersionId && package.ZoneId == zone);
        if (zonePackage == null) { UseListFallback(focus); return; }
        var model = Path.Combine(zonePackage.DirectoryPath, "structure.usdz");
        var building = Path.Combine(zonePackage.DirectoryPath, "building.json");
        var scan = Path.Combine(zonePackage.DirectoryPath, "scan-features.json");
        if (!File.Exists(model) || !File.Exists(building) || !File.Exists(scan))
        { UseListFallback(focus); return; }
#if UNITY_IOS && !UNITY_EDITOR
        previewZoneId = zone;
        var request = new RouteModelRequest
        {
            startId = routeStartKey != null && routeStartKey.StartsWith(zone + "/") ? routeStartKey.Substring(zone.Length + 1) : "",
            destinationId = routeDestinationKey != null && routeDestinationKey.StartsWith(zone + "/") ? routeDestinationKey.Substring(zone.Length + 1) : "",
            focusId = focus?.key != null ? focus.key.Substring(zone.Length + 1) : "",
            selectionSlot = routeChoosingStart ? "start" : "destination"
        };
        GnarlyShowRoomModel(model, building, scan, gameObject.name, JsonUtility.ToJson(request));
#else
        UseListFallback(focus);
#endif
        RefreshUi();
    }

    void UseListFallback(RoutePlace place)
    {
        if (place == null)
        {
            SetStatus("The 3D model is unavailable for this floor. Search the place list below.");
            return;
        }
        if (routeChoosingStart)
        {
            routeStartKey = place.key;
            if (routeDestinationKey == routeStartKey) routeDestinationKey = null;
            routeChoosingStart = false;
        }
        else
        {
            routeDestinationKey = place.key;
            if (routeStartKey == routeDestinationKey) routeStartKey = null;
            routeSkipDestination = false;
        }
        SetStatus("Selected " + place.name + " from the place list.");
        BuildContent();
        RefreshUi();
    }

    void PrepareRouteChoice(DownloadedNavigationPackage package)
    {
        pendingPackage = package;
        routeStartKey = null;
        routeDestinationKey = null;
        // A destination list is optional metadata. Never block a user from entering the
        // camera/minimap just because a building has no labelled places yet.
        routeSkipDestination = true;
        routeChoosingStart = false;
        routePlaces.Clear();
        LoadRoutePlaces(package);
        routeSelectionMode = true;
        SetStatus(routePlaces.Count == 0
            ? "No tagged places yet. Continue to the minimap, then tap a point after locating."
            : "Choose a destination now, or continue to the minimap. Your start defaults to your location.");
        BuildContent();
        RefreshUi();
        if (launchScroll != null) launchScroll.verticalNormalizedPosition = 1f;
    }

    void LoadRoutePlaces(DownloadedNavigationPackage package)
    {
        var reachableZones = new HashSet<string>(StringComparer.Ordinal) { package.ZoneId };
        var connectionsPath = Path.Combine(package.DirectoryPath, "zone-connections.json");
        if (File.Exists(connectionsPath))
        {
            try
            {
                var connections = Pathfinding.ParseConnections(File.ReadAllText(connectionsPath));
                var changed = true;
                while (changed && connections.connections != null)
                {
                    changed = false;
                    foreach (var connection in connections.connections)
                    {
                        if (reachableZones.Contains(connection.from.zoneId)) changed |= reachableZones.Add(connection.to.zoneId);
                        if (reachableZones.Contains(connection.to.zoneId)) changed |= reachableZones.Add(connection.from.zoneId);
                    }
                }
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"[Gnarly] Could not read zone connections for route search: {exception.Message}");
            }
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var zonePackage in repository.ListCachedPackages())
        {
            if (zonePackage.BuildingId != package.BuildingId || zonePackage.VersionId != package.VersionId) continue;
            var path = Path.Combine(zonePackage.DirectoryPath, "building.json");
            if (!File.Exists(path)) continue;
            try
            {
                var graph = Pathfinding.ParseBuilding(File.ReadAllText(path));
                if (graph.nodes == null) continue;
                var choice = library?.Find(scan => scan.BuildingId == package.BuildingId && scan.ZoneId == zonePackage.ZoneId);
                var area = choice != null ? FloorDisplay(choice) : "Area " + DisplayName(zonePackage.ZoneId);
                foreach (var node in graph.nodes)
                {
                    if (node == null || string.IsNullOrWhiteSpace(node.id) || !IsSearchableNode(node)) continue;
                    var key = Pathfinding.ZoneKey(zonePackage.ZoneId, node.id);
                    if (!seen.Add(key)) continue;
                    routePlaces.Add(new RoutePlace
                    {
                        key = key,
                        name = PrettyPlaceName(!string.IsNullOrWhiteSpace(node.label) ? node.label : node.id),
                        zone = zonePackage.ZoneId,
                        area = area,
                        kind = node.id.StartsWith("section-", StringComparison.OrdinalIgnoreCase)
                            ? "Room" : DisplayName(node.type),
                        reachable = reachableZones.Contains(zonePackage.ZoneId)
                    });
                }
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"[Gnarly] Could not index places in {zonePackage.ZoneId}: {exception.Message}");
            }
        }
        routePlaces.Sort((left, right) =>
        {
            var area = StringComparer.CurrentCultureIgnoreCase.Compare(left.area, right.area);
            return area != 0 ? area : StringComparer.CurrentCultureIgnoreCase.Compare(left.name, right.name);
        });
    }

    static bool IsSearchableNode(Pathfinding.Node node) =>
        node.type != "door" && node.type != "opening" &&
        (node.type == "destination" || node.type == "entrance" || node.type == "stairs" ||
         node.id.StartsWith("section-", StringComparison.OrdinalIgnoreCase) ||
         !string.IsNullOrWhiteSpace(node.label));

    static string PrettyPlaceName(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "Place";
        var result = new System.Text.StringBuilder();
        foreach (var character in raw)
        {
            if (character == '-' || character == '_') { result.Append(' '); continue; }
            if (char.IsUpper(character) && result.Length > 0 && char.IsLower(result[result.Length - 1])) result.Append(' ');
            result.Append(character);
        }
        return System.Globalization.CultureInfo.CurrentCulture.TextInfo.ToTitleCase(result.ToString().Trim());
    }

    void BuildRouteContent()
    {
        routeSearch = null;
        routeResults = null;
        routeResultsHeight = null;

        var back = MapUi.Button(Block("BackToBuildings", 74), "‹  Buildings and floors", MapUi.SurfaceRaised,
            MapUi.TextPrimary, 30, () =>
            {
                routeSelectionMode = false;
                pendingPackage = null;
                SetStatus("Choose a floor to continue.");
                BuildContent();
                RefreshUi();
            }, 26f);
        back.interactable = true;

        var selection = Block("RouteSelection", 280);
        MapUi.Panel(selection, MapUi.Surface, 34f);
        BuildRouteSlot(selection, true, 16);
        BuildRouteSlot(selection, false, 146);

        MapUi.Button(Block("Explore3D", 88), "Explore this floor in 3D", MapUi.SurfaceRaised,
            MapUi.TextPrimary, 32, () => OpenRouteModel(), 28f);

        var searchCard = Block("PlaceSearch", 112);
        var searchBackground = MapUi.Panel(searchCard, MapUi.Surface, 30f, true);
        routeSearch = searchCard.gameObject.AddComponent<InputField>();
        routeSearch.targetGraphic = searchBackground;
        routeSearch.lineType = InputField.LineType.SingleLine;
        var placeholder = MapUi.Label(MapUi.Stretch("Placeholder", searchCard, 30f),
            routeChoosingStart ? "Search starts on this floor" : "Search all building places", 42,
            MapUi.TextSecondary);
        var typed = MapUi.Label(MapUi.Stretch("Query", searchCard, 30f), "", 42, MapUi.TextPrimary);
        typed.supportRichText = false;
        routeSearch.placeholder = placeholder;
        routeSearch.textComponent = typed;
        routeSearch.onValueChanged.AddListener(_ => BuildRouteResults());

        SectionLabel(routeChoosingStart ? "STARTING POINTS" : "DESTINATIONS · ALL AREAS");
        routeResults = Block("SearchResults", 0);
        routeResultsHeight = routeResults.GetComponent<LayoutElement>();
        BuildRouteResults();

        var skip = MapUi.Button(Block("ChooseLater", 82), "Choose on minimap after locating",
            MapUi.SurfaceRaised, MapUi.TextSecondary, 29, () =>
            {
                routeDestinationKey = null;
                routeSkipDestination = true;
                RefreshUi();
            }, 27f);
        skip.interactable = true;
    }

    void BuildRouteSlot(RectTransform parent, bool start, int top)
    {
        var slot = MapUi.Rect(start ? "From" : "To", parent, new Vector2(0, 1), Vector2.one,
            new Vector2(18, -top - 118), new Vector2(-18, -top));
        var selected = routeChoosingStart == start;
        var image = MapUi.Panel(slot, selected ? MapUi.SurfaceActive : MapUi.SurfaceRaised, 26f, true);
        var button = slot.gameObject.AddComponent<Button>();
        button.targetGraphic = image;
        button.onClick.AddListener(() =>
        {
            if (routeChoosingStart == start) return;
            routeChoosingStart = start;
            SetStatus(start
                ? "Choose a tagged starting point on your selected floor, or use My location."
                : "Search destinations across every connected area of this building.");
            BuildContent();
            RefreshUi();
        });
        MapUi.Label(MapUi.Rect("Caption", slot, new Vector2(0, 1), Vector2.one,
            new Vector2(24, -48), new Vector2(-24, -8)), start ? "FROM" : "TO", 25,
            MapUi.Eyebrow, TextAnchor.MiddleLeft, FontStyle.Bold);
        var value = start
            ? routeStartKey == null ? "My location" : RoutePlaceName(routeStartKey)
            : routeDestinationKey == null ? "Choose a destination" : RoutePlaceName(routeDestinationKey);
        var label = MapUi.Label(MapUi.Rect("Value", slot, Vector2.zero, Vector2.one,
            new Vector2(24, 12), new Vector2(-24, -52)), value, 42, MapUi.TextPrimary,
            TextAnchor.MiddleLeft, FontStyle.Bold);
        label.resizeTextForBestFit = true;
        label.resizeTextMinSize = 29;
        label.resizeTextMaxSize = 42;
    }

    string RoutePlaceName(string key) => routePlaces.Find(place => place.key == key)?.name ?? "Place";

    void BuildRouteResults()
    {
        if (routeResults == null || routeResultsHeight == null) return;
        foreach (Transform child in routeResults)
        {
            child.gameObject.SetActive(false);
            Destroy(child.gameObject);
        }
        var query = routeSearch != null ? routeSearch.text.Trim() : "";
        var matches = routePlaces.FindAll(place =>
            (!routeChoosingStart || place.zone == pendingPackage.ZoneId) &&
            (query.Length == 0 || place.name.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0 ||
             place.area.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0 ||
             place.zone.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0));
        const int rowHeight = 126;
        const int gap = 12;
        if (routeChoosingStart && query.Length == 0)
        {
            var location = RouteResultRow("My location", "Use your position after locating", 0, true,
                () =>
                {
                    routeStartKey = null;
                    routeChoosingStart = false;
                    SetStatus("Starting from your location. Choose a destination.");
                    BuildContent();
                    RefreshUi();
                });
            location.name = "MyLocation";
        }
        var offset = routeChoosingStart && query.Length == 0 ? 1 : 0;
        for (var i = 0; i < matches.Count; i++)
        {
            var place = matches[i];
            var detail = place.area + " · " + place.kind + (place.reachable ? "" : " · No connected route");
            var selectable = place.reachable && (!routeChoosingStart || place.zone == pendingPackage.ZoneId);
            RouteResultRow(place.name, detail + (selectable ? " · View in 3D" : ""), i + offset,
                selectable, () => OpenRouteModel(place), selectable ? (Action)(() => UseListFallback(place)) : null);
        }
        var count = matches.Count + offset;
        if (count == 0)
            MapUi.Label(MapUi.Stretch("NoMatches", routeResults), "No matching tagged places.", 30,
                MapUi.TextSecondary, TextAnchor.MiddleCenter);
        routeResultsHeight.minHeight = count == 0 ? 110 : count * (rowHeight + gap);
        routeResultsHeight.preferredHeight = routeResultsHeight.minHeight;
    }

    RectTransform RouteResultRow(string title, string detail, int index, bool enabled, Action choose,
        Action selectDirect = null)
    {
        const int rowHeight = 126;
        const int gap = 12;
        var top = index * (rowHeight + gap);
        var row = MapUi.Rect("PlaceResult", routeResults, new Vector2(0, 1), Vector2.one,
            new Vector2(0, -top - rowHeight), new Vector2(0, -top));
        var image = MapUi.Panel(row, enabled ? MapUi.Surface : MapUi.SurfaceRaised, 27f, true);
        var button = row.gameObject.AddComponent<Button>();
        button.targetGraphic = image;
        button.interactable = enabled;
        button.onClick.AddListener(() => choose());
        var name = MapUi.Label(MapUi.Rect("Name", row, new Vector2(0, 1), Vector2.one,
            new Vector2(26, -69), new Vector2(selectDirect == null ? -44 : -185, -10)), title, 40, MapUi.TextPrimary,
            TextAnchor.MiddleLeft, FontStyle.Bold);
        name.resizeTextForBestFit = true;
        name.resizeTextMinSize = 27;
        name.resizeTextMaxSize = 40;
        var subtitle = MapUi.Label(MapUi.Rect("Detail", row, Vector2.zero, Vector2.one,
            new Vector2(26, 10), new Vector2(selectDirect == null ? -44 : -185, -70)), detail, 31, MapUi.TextSecondary);
        subtitle.resizeTextForBestFit = true;
        subtitle.resizeTextMinSize = 23;
        subtitle.resizeTextMaxSize = 31;
        if (selectDirect != null)
            MapUi.Button(MapUi.Rect("SelectFromList", row, new Vector2(1, 0.5f),
                    new Vector2(1, 0.5f), new Vector2(-174, -47), new Vector2(-14, 47)),
                "Select", MapUi.SurfaceRaised, MapUi.TextPrimary, 27, selectDirect, 20f);
        return row;
    }
}
