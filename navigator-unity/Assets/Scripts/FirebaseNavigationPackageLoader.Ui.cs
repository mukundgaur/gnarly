using System;
using UnityEngine;
using UnityEngine.UI;

/// <summary>Safe-area, scrollable iPhone launch screen for choosing a downloaded scan.</summary>
public sealed partial class FirebaseNavigationPackageLoader
{
    GameObject launchCanvas;
    RectTransform launchContent;
    RectTransform launchScrollRoot;
    RectTransform launchFooter;
    ScrollRect launchScroll;
    Text launchTitle;
    Text launchSubtitle;
    Text launchStatus;
    Button launchPrimary;
    Text launchPrimaryLabel;
    FirebaseScanChoice selectedScan;
    string expandedBuildingId;
    System.Collections.Generic.List<FirebaseScanChoice> renderedLibrary;

    void BuildUi()
    {
        DestroyUi();
        launchCanvas = new GameObject("NavigatorLaunchCanvas", typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
        var canvas = launchCanvas.GetComponent<Canvas>();
        canvas.renderMode = RenderMode.ScreenSpaceOverlay;
        canvas.sortingOrder = 100;
        var scaler = launchCanvas.GetComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = new Vector2(1170, 2532);
        MapUi.Panel(MapUi.Stretch("Background", launchCanvas.transform), MapUi.Sheet, 0f);

        var safe = MapUi.Stretch("SafeArea", launchCanvas.transform);
        safe.gameObject.AddComponent<SafeAreaPanel>();
        var header = MapUi.Rect("Header", safe, new Vector2(0, 1), Vector2.one,
            new Vector2(44, -310), new Vector2(-44, -16));
        launchTitle = MapUi.Label(MapUi.Rect("Title", header, new Vector2(0, 1), Vector2.one,
            new Vector2(0, -94), Vector2.zero), "Explore indoors", 64, MapUi.TextPrimary,
            TextAnchor.MiddleLeft, FontStyle.Bold);
        launchSubtitle = MapUi.Label(MapUi.Rect("Subtitle", header, new Vector2(0, 1), Vector2.one,
            new Vector2(0, -168), new Vector2(0, -92)), "Choose the map where you are now.", 31,
            MapUi.TextSecondary);
        launchSubtitle.resizeTextForBestFit = true;
        launchSubtitle.resizeTextMinSize = 24;
        launchSubtitle.resizeTextMaxSize = 31;
        var statusRect = MapUi.Rect("Status", header, Vector2.zero, new Vector2(1, 0),
            new Vector2(0, 0), new Vector2(0, 106));
        MapUi.Panel(statusRect, MapUi.SurfaceRaised, 30f);
        launchStatus = MapUi.Label(MapUi.Stretch("Message", statusRect, 24f), "", 28,
            MapUi.TextSecondary, TextAnchor.MiddleLeft);
        launchStatus.resizeTextForBestFit = true;
        launchStatus.resizeTextMinSize = 22;
        launchStatus.resizeTextMaxSize = 28;

        var scrollRoot = MapUi.Rect("MapChoices", safe, Vector2.zero, Vector2.one,
            new Vector2(0, 204), new Vector2(0, -324));
        launchScrollRoot = scrollRoot;
        var viewport = MapUi.Stretch("Viewport", scrollRoot);
        viewport.gameObject.AddComponent<RectMask2D>();
        viewport.gameObject.AddComponent<Image>().color = Color.clear;
        launchContent = MapUi.Rect("Content", viewport, new Vector2(0, 1), Vector2.one,
            Vector2.zero, Vector2.zero);
        launchContent.pivot = new Vector2(0.5f, 1f);
        var layout = launchContent.gameObject.AddComponent<VerticalLayoutGroup>();
        layout.padding = new RectOffset(44, 44, 18, 24);
        layout.spacing = 18f;
        layout.childAlignment = TextAnchor.UpperCenter;
        layout.childControlHeight = true;
        layout.childControlWidth = true;
        layout.childForceExpandHeight = false;
        layout.childForceExpandWidth = true;
        var fitter = launchContent.gameObject.AddComponent<ContentSizeFitter>();
        fitter.verticalFit = ContentSizeFitter.FitMode.PreferredSize;
        launchScroll = scrollRoot.gameObject.AddComponent<ScrollRect>();
        launchScroll.viewport = viewport;
        launchScroll.content = launchContent;
        launchScroll.horizontal = false;
        launchScroll.movementType = ScrollRect.MovementType.Clamped;
        launchScroll.scrollSensitivity = 35f;

        var footer = MapUi.Rect("Footer", safe, Vector2.zero, new Vector2(1, 0),
            Vector2.zero, new Vector2(0, 204));
        launchFooter = footer;
        MapUi.Panel(footer, MapUi.Surface, 0f);
        launchPrimary = MapUi.Button(MapUi.Rect("Continue", footer, Vector2.zero, Vector2.one,
                new Vector2(44, 32), new Vector2(-44, -32)), "", MapUi.Accent,
            MapUi.AccentText, 42, OnPrimaryAction, 38f);
        launchPrimaryLabel = MapUi.ButtonLabel(launchPrimary);

        BuildContent();
        RefreshUi();
    }

    void BuildContent()
    {
        if (launchContent == null) return;
        var scrollPosition = launchScroll != null ? launchScroll.verticalNormalizedPosition : 1f;
        for (var i = launchContent.childCount - 1; i >= 0; i--)
        {
            var old = launchContent.GetChild(i).gameObject;
            old.SetActive(false);
            Destroy(old);
        }
        renderedLibrary = library;

        if (routeSelectionMode)
        {
            BuildRouteContent();
            if (launchScroll != null)
            {
                Canvas.ForceUpdateCanvases();
                launchScroll.verticalNormalizedPosition = scrollPosition;
            }
            return;
        }

        if (library != null && library.Count > 0)
        {
            if (selectedScan != null && !library.Contains(selectedScan))
            {
                selectedScan = library.Find(scan => scan.BuildingId == buildingId && scan.ZoneId == zoneId);
            }
            if (expandedBuildingId == null)
                expandedBuildingId = selectedScan?.BuildingId ?? library[0].BuildingId;
            var groups = new System.Collections.Generic.Dictionary<string, System.Collections.Generic.List<FirebaseScanChoice>>();
            foreach (var scan in library)
            {
                if (!groups.TryGetValue(scan.BuildingId, out var floors))
                {
                    floors = new System.Collections.Generic.List<FirebaseScanChoice>();
                    groups.Add(scan.BuildingId, floors);
                }
                floors.Add(scan);
            }
            var buildingIds = new System.Collections.Generic.List<string>(groups.Keys);
            buildingIds.Sort(StringComparer.CurrentCultureIgnoreCase);
            SectionLabel("BUILDINGS");
            foreach (var id in buildingIds)
            {
                var floors = groups[id];
                floors.Sort((left, right) =>
                {
                    var rank = FloorRank(left).CompareTo(FloorRank(right));
                    return rank != 0 ? rank : StringComparer.CurrentCultureIgnoreCase.Compare(
                        FloorDisplay(left), FloorDisplay(right));
                });
                BuildingCard(id, floors);
            }
        }
        else
        {
            selectedScan = null;
            SectionLabel("YOUR MAPS");
            EmptyCard();
        }
        if (launchScroll != null)
        {
            Canvas.ForceUpdateCanvases();
            launchScroll.verticalNormalizedPosition = scrollPosition;
        }
    }

    RectTransform Block(string name, float height)
    {
        var rect = MapUi.Rect(name, launchContent, Vector2.zero, Vector2.one, Vector2.zero, Vector2.zero);
        var size = rect.gameObject.AddComponent<LayoutElement>();
        size.minHeight = height;
        size.preferredHeight = height;
        return rect;
    }

    void SectionLabel(string title)
    {
        var row = Block("Section", 54);
        MapUi.Label(MapUi.Stretch("Title", row), title, 29, MapUi.Eyebrow,
            TextAnchor.LowerLeft, FontStyle.Bold);
    }

    static string DisplayName(string id)
    {
        if (string.IsNullOrWhiteSpace(id)) return "Map";
        var words = id.Replace('-', ' ').Replace('_', ' ');
        return System.Globalization.CultureInfo.CurrentCulture.TextInfo.ToTitleCase(words);
    }

    static string FloorDisplay(FirebaseScanChoice scan)
    {
        if (string.IsNullOrWhiteSpace(scan.FloorId)) return "Area " + DisplayName(scan.ZoneId);
        if (scan.FloorId.Equals("ground", StringComparison.OrdinalIgnoreCase) ||
            scan.FloorId.Equals("ground-floor", StringComparison.OrdinalIgnoreCase)) return "Ground floor";
        if (int.TryParse(scan.FloorId, out var number)) return "Floor " + number;
        return DisplayName(scan.FloorId);
    }

    static int FloorRank(FirebaseScanChoice scan)
    {
        var id = scan.FloorId ?? scan.ZoneId;
        if (id.IndexOf("basement", StringComparison.OrdinalIgnoreCase) >= 0) return -1;
        if (id.IndexOf("ground", StringComparison.OrdinalIgnoreCase) >= 0) return 0;
        var end = id.Length - 1;
        while (end >= 0 && !char.IsDigit(id[end])) end--;
        var start = end;
        while (start >= 0 && char.IsDigit(id[start])) start--;
        return end >= 0 && int.TryParse(id.Substring(start + 1, end - start), out var number)
            ? number : int.MaxValue;
    }

    void BuildingCard(string id, System.Collections.Generic.List<FirebaseScanChoice> floors)
    {
        var expanded = expandedBuildingId == id;
        var cardHeight = expanded ? 178 + floors.Count * 140 + 20 : 178;
        var card = Block("Building-" + id, cardHeight);
        MapUi.Panel(card, MapUi.Surface, 38f);
        var header = MapUi.Rect("BuildingHeader", card, new Vector2(0, 1), Vector2.one,
            new Vector2(0, -178), Vector2.zero);
        var headerImage = MapUi.Panel(header, Color.clear, 38f, true);
        var headerButton = header.gameObject.AddComponent<Button>();
        headerButton.targetGraphic = headerImage;
        headerButton.onClick.AddListener(() =>
        {
            if (busy) return;
            expandedBuildingId = expanded ? "" : id;
            if (selectedScan != null && selectedScan.BuildingId != id) selectedScan = null;
            BuildContent();
            RefreshUi();
        });
        var glyph = MapUi.Rect("FolderGlyph", header, new Vector2(0, 0.5f), new Vector2(0, 0.5f),
            new Vector2(28, -54), new Vector2(136, 54));
        MapUi.Panel(glyph, MapUi.SurfaceRaised, 28f);
        MapUi.Label(MapUi.Stretch("Text", glyph), "BLDG", 27, MapUi.Accent,
            TextAnchor.MiddleCenter, FontStyle.Bold);
        var title = MapUi.Rect("BuildingName", header, new Vector2(0, 1), Vector2.one,
            new Vector2(162, -92), new Vector2(-75, -20));
        var name = string.IsNullOrWhiteSpace(floors[0].BuildingName) ? id : floors[0].BuildingName;
        var buildingLabel = MapUi.Label(title, DisplayName(name), 46, MapUi.TextPrimary,
            TextAnchor.MiddleLeft, FontStyle.Bold);
        buildingLabel.resizeTextForBestFit = true;
        buildingLabel.resizeTextMinSize = 30;
        buildingLabel.resizeTextMaxSize = 46;
        var uniqueFloors = new System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var hasFloorNames = true;
        foreach (var floor in floors) uniqueFloors.Add(string.IsNullOrWhiteSpace(floor.FloorId) ? floor.ZoneId : floor.FloorId);
        foreach (var floor in floors) hasFloorNames &= !string.IsNullOrWhiteSpace(floor.FloorId);
        var count = uniqueFloors.Count;
        var summary = hasFloorNames ? count + (count == 1 ? " floor" : " floors")
            : floors.Count + (floors.Count == 1 ? " map" : " maps");
        if (hasFloorNames && floors.Count > count) summary += " · " + floors.Count + " areas";
        MapUi.Label(MapUi.Rect("Count", header, Vector2.zero, Vector2.one,
            new Vector2(162, 26), new Vector2(-72, -96)), summary, 34, MapUi.TextSecondary);
        MapUi.Label(MapUi.Rect("Chevron", header, new Vector2(1, 0.5f), new Vector2(1, 0.5f),
            new Vector2(-69, -45), new Vector2(-18, 45)), expanded ? "⌄" : "›", 48, MapUi.TextSecondary,
            TextAnchor.MiddleCenter);
        if (!expanded) return;
        for (var index = 0; index < floors.Count; index++) FloorRow(card, floors[index], 178 + index * 140);
    }

    void FloorRow(RectTransform card, FirebaseScanChoice scan, int top)
    {
        var selected = selectedScan == scan;
        var row = MapUi.Rect("Floor-" + scan.ZoneId, card, new Vector2(0, 1), Vector2.one,
            new Vector2(24, -top - 128), new Vector2(-24, -top));
        var image = MapUi.Panel(row, selected ? MapUi.SurfaceActive : MapUi.SurfaceRaised, 28f, true);
        var button = row.gameObject.AddComponent<Button>();
        button.targetGraphic = image;
        button.onClick.AddListener(() =>
        {
            if (busy) return;
            selectedScan = scan;
            buildingId = scan.BuildingId;
            zoneId = scan.ZoneId;
            RefreshCacheState();
            // A floor row means "I am here". Do not make the user select it, then press a
            // second button before ARKit can start localizing.
            if (onlineMapsAvailable && publishedLibrary != null &&
                publishedLibrary.Exists(item => item.BuildingId == scan.BuildingId && item.ZoneId == scan.ZoneId))
                _ = DownloadSelectionAsync(scan);
            else if (repository.TryGetCachedPackage(scan.BuildingId, scan.ZoneId, out var package))
                Complete(package, null, null);
            else
                SetStatus("That zone is not downloaded yet. Check the connection and try again.");
        });
        var floorName = FloorDisplay(scan);
        var title = MapUi.Label(MapUi.Rect("FloorName", row, new Vector2(0, 1), Vector2.one,
            new Vector2(28, -67), new Vector2(-75, -10)), floorName, 43, MapUi.TextPrimary,
            TextAnchor.MiddleLeft, FontStyle.Bold);
        title.resizeTextForBestFit = true;
        title.resizeTextMinSize = 30;
        title.resizeTextMaxSize = 43;
        var downloaded = repository.TryGetCachedPackage(scan.BuildingId, scan.ZoneId, out _);
        var area = !string.IsNullOrWhiteSpace(scan.ZoneName) &&
            !scan.ZoneName.Equals(scan.FloorId, StringComparison.OrdinalIgnoreCase)
            ? DisplayName(scan.ZoneName) + " · " : "";
        var detail = MapUi.Label(MapUi.Rect("Detail", row, Vector2.zero, Vector2.one,
            new Vector2(28, 12), new Vector2(-75, -68)),
            area + (downloaded ? "Downloaded" : "Available to download"), 32, MapUi.TextSecondary);
        detail.resizeTextForBestFit = true;
        detail.resizeTextMinSize = 25;
        detail.resizeTextMaxSize = 32;
        MapUi.Label(MapUi.Rect("Selected", row, new Vector2(1, 0.5f), new Vector2(1, 0.5f),
            new Vector2(-66, -36), new Vector2(-18, 36)), selected ? "✓" : "›", 42,
            selected ? MapUi.Accent : MapUi.TextSecondary, TextAnchor.MiddleCenter);
    }

    void EmptyCard()
    {
        var card = Block("EmptyMapLibrary", 240);
        MapUi.Panel(card, MapUi.Surface, 38f);
        MapUi.Label(MapUi.Rect("Title", card, new Vector2(0, 1), Vector2.one,
            new Vector2(34, -94), new Vector2(-34, -20)), "No maps available", 37,
            MapUi.TextPrimary, TextAnchor.MiddleLeft, FontStyle.Bold);
        MapUi.Label(MapUi.Rect("Detail", card, Vector2.zero, Vector2.one,
            new Vector2(34, 24), new Vector2(-34, -100)),
            "Check your connection or ask the map owner to publish a map.", 28, MapUi.TextSecondary);
    }

    void OnPrimaryAction()
    {
        if (busy) return;
        if (routeSelectionMode)
        {
            if (pendingPackage != null && (routeDestinationKey != null || routeSkipDestination))
                Complete(pendingPackage, routeStartKey, routeDestinationKey);
            return;
        }
        if (selectedScan == null) { _ = LoadMapsAsync(); return; }
        buildingId = selectedScan.BuildingId;
        zoneId = selectedScan.ZoneId;
        if (onlineMapsAvailable && publishedLibrary != null &&
            publishedLibrary.Exists(scan => scan.BuildingId == buildingId && scan.ZoneId == zoneId))
        {
            _ = DownloadSelectionAsync(selectedScan);
        }
        else if (repository.TryGetCachedPackage(buildingId, zoneId, out var package))
        {
            RememberSelection();
            PrepareRouteChoice(package);
        }
        else _ = LoadMapsAsync();
    }

    void RefreshUi()
    {
        if (launchCanvas == null || !visible) return;
        if (renderedLibrary != library) BuildContent();
        if (routeSelectionMode)
        {
            if (launchTitle != null) launchTitle.text = "Plan your route";
            if (launchSubtitle != null) launchSubtitle.text =
                DisplayName(string.IsNullOrWhiteSpace(selectedScan?.BuildingName) ? pendingPackage?.BuildingId : selectedScan.BuildingName)
                + " · " + (selectedScan != null ? FloorDisplay(selectedScan) : DisplayName(pendingPackage?.ZoneId));
            if (launchStatus != null) launchStatus.text = status;
            if (launchPrimaryLabel != null) launchPrimaryLabel.text = busy ? "Preparing places…" : routeDestinationKey != null
                ? "Continue to camera" : routeSkipDestination ? "Open minimap" : "Select a destination";
            if (launchPrimary != null) launchPrimary.interactable = !busy && (routeDestinationKey != null || routeSkipDestination);
            return;
        }
        var hasMaps = library != null && library.Count > 0;
        if (launchTitle != null) launchTitle.text = "Choose a building";
        if (launchSubtitle != null) launchSubtitle.text = "Choose your building and starting floor.";
        if (launchStatus != null) launchStatus.text = status;
        if (launchPrimaryLabel != null) launchPrimaryLabel.text = busy ? "Finding maps…" :
            selectedScan != null ? "Open selected floor" : hasMaps ? "Select a floor" : "Retry";
        if (launchPrimary != null) launchPrimary.interactable = !busy && (hasMaps ? selectedScan != null : firebaseConfig != null);
    }

    void Update()
    {
        if (launchScrollRoot == null || launchFooter == null) return;
        var keyboardOpen = routeSelectionMode && TouchScreenKeyboard.visible;
        var scale = Mathf.Max(1f, Screen.width) / 1170f;
        var keyboardHeight = keyboardOpen
            ? Mathf.Max(TouchScreenKeyboard.area.height / scale, Screen.height / scale * 0.35f)
            : 0f;
        launchScrollRoot.offsetMin = new Vector2(0, keyboardOpen ? keyboardHeight + 16f : 204f);
        launchFooter.gameObject.SetActive(!keyboardOpen);
    }

    void DestroyUi()
    {
        if (launchCanvas != null) Destroy(launchCanvas);
        launchCanvas = null;
        launchContent = null;
        launchScrollRoot = null;
        launchFooter = null;
        launchScroll = null;
        launchTitle = null;
        launchSubtitle = null;
        launchStatus = null;
        launchPrimary = null;
        launchPrimaryLabel = null;
        renderedLibrary = null;
    }

    void OnDestroy() => DestroyUi();
}
