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
            MapUi.AccentText, 38, OnPrimaryAction, 38f);
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

        if (library != null && library.Count > 0)
        {
            if (selectedScan == null || !library.Contains(selectedScan))
            {
                selectedScan = library.Find(scan => scan.BuildingId == buildingId && scan.ZoneId == zoneId);
                selectedScan ??= library[0];
            }
            SectionLabel("AVAILABLE MAPS");
            foreach (var scan in library)
                ScanChoice(scan);
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
        MapUi.Label(MapUi.Stretch("Title", row), title, 26, MapUi.Eyebrow,
            TextAnchor.LowerLeft, FontStyle.Bold);
    }

    static string DisplayName(string id)
    {
        if (string.IsNullOrWhiteSpace(id)) return "Map";
        var words = id.Replace('-', ' ').Replace('_', ' ');
        return System.Globalization.CultureInfo.CurrentCulture.TextInfo.ToTitleCase(words);
    }

    void ScanChoice(FirebaseScanChoice scan)
    {
        var selected = selectedScan == scan;
        var card = Block("Map-" + scan.ZoneId, 204);
        var image = MapUi.Panel(card, selected ? MapUi.SurfaceActive : MapUi.Surface, 38f, true);
        var button = card.gameObject.AddComponent<Button>();
        button.targetGraphic = image;
        button.onClick.AddListener(() =>
        {
            if (busy) return;
            selectedScan = scan;
            buildingId = scan.BuildingId;
            zoneId = scan.ZoneId;
            RefreshCacheState();
            BuildContent();
            RefreshUi();
        });
        var glyph = MapUi.Rect("MapGlyph", card, new Vector2(0, 0.5f), new Vector2(0, 0.5f),
            new Vector2(28, -60), new Vector2(148, 60));
        MapUi.Panel(glyph, selected ? MapUi.Accent : MapUi.SurfaceRaised, 30f);
        MapUi.Label(MapUi.Stretch("Text", glyph), "MAP", 26,
            selected ? Color.white : MapUi.TextSecondary, TextAnchor.MiddleCenter, FontStyle.Bold);
        var title = MapUi.Rect("Building", card, new Vector2(0, 1), Vector2.one,
            new Vector2(178, -92), new Vector2(-72, -22));
        var buildingLabel = MapUi.Label(title, DisplayName(scan.BuildingId), 39, MapUi.TextPrimary,
            TextAnchor.MiddleLeft, FontStyle.Bold);
        buildingLabel.resizeTextForBestFit = true;
        buildingLabel.resizeTextMinSize = 27;
        buildingLabel.resizeTextMaxSize = 39;
        var subtitle = MapUi.Rect("Area", card, Vector2.zero, Vector2.one,
            new Vector2(178, 26), new Vector2(-72, -94));
        var downloaded = repository.TryGetCachedPackage(scan.BuildingId, scan.ZoneId, out _);
        var areaLabel = MapUi.Label(subtitle, DisplayName(scan.ZoneId) + (downloaded ? " · Downloaded" : ""),
            30, MapUi.TextSecondary);
        areaLabel.resizeTextForBestFit = true;
        areaLabel.resizeTextMinSize = 24;
        areaLabel.resizeTextMaxSize = 30;
        MapUi.Label(MapUi.Rect("Chevron", card, new Vector2(1, 0.5f), new Vector2(1, 0.5f),
            new Vector2(-68, -48), new Vector2(-18, 48)), "›", 52, MapUi.TextSecondary,
            TextAnchor.MiddleCenter);
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
            Complete(package);
        }
        else _ = LoadMapsAsync();
    }

    void RefreshUi()
    {
        if (launchCanvas == null || !visible) return;
        if (renderedLibrary != library) BuildContent();
        var hasMaps = library != null && library.Count > 0;
        if (launchTitle != null) launchTitle.text = "Choose a map";
        if (launchSubtitle != null) launchSubtitle.text = "Pick the area where you are now.";
        if (launchStatus != null) launchStatus.text = status;
        if (launchPrimaryLabel != null) launchPrimaryLabel.text = busy ? "Finding maps…" : hasMaps ? "Open selected map" : "Retry";
        if (launchPrimary != null) launchPrimary.interactable = !busy && (hasMaps ? selectedScan != null : firebaseConfig != null);
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
