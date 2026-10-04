using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;

/// <summary>
/// Full-screen route planner: choose a start (default: your location) and a destination by tapping
/// map markers or the places list, preview the A* route, then start AR navigation.
/// </summary>
public partial class IndoorMapOverlay
{
    enum Slot { Start, Destination }

    sealed class PlaceRow
    {
        public MapPlace place;
        public Image background;
        public Text tag;
        public Image tagBackground;
    }

    sealed class MapLabel
    {
        public MapPlace place;
        public RectTransform rect;
        public Image background;
        public Text text;
    }

    const float PickRadius = 80f;
    const float HintSeconds = 3.5f;
    const float MinZoom = 0.6f;
    const float MaxZoom = 6f;

    /// <summary>Start key (null = your location) and destination key whenever the user edits the selection.</summary>
    public event Action<string, string> RouteSelectionChanged;
    /// <summary>The user confirmed the previewed route.</summary>
    public event Action<string, string> NavigationRequested;

    readonly List<MapPlace> places = new List<MapPlace>();
    readonly Dictionary<string, MapPlace> placesByKey = new Dictionary<string, MapPlace>();
    readonly List<PlaceRow> placeRows = new List<PlaceRow>();
    readonly List<MapLabel> mapLabels = new List<MapLabel>();
    string currentZone;
    string startKey;
    string destinationKey;
    Slot activeSlot = Slot.Destination;
    RoutePreview preview;
    /// <summary>Elevator on this floor that an active route uses to leave for another floor.</summary>
    string navigationWaypointKey;
    bool navigationActive;
    float hintUntil;

    RectTransform plannerRoot;
    RectTransform mapViewport;
    RawImage plannerImage;
    RenderTexture plannerTexture;
    RectTransform labelLayer;
    Text plannerSubtitle;
    Image startRowBackground;
    Image destinationRowBackground;
    Text startValue;
    Text destinationValue;
    Button useMyLocationButton;
    Button clearDestinationButton;
    Button swapButton;
    Button viewModeButton;
    RectTransform hintChip;
    Image hintDot;
    Text hintText;
    RectTransform placesContent;
    Text placesHeading;
    Text placesEmpty;
    InputField placeSearch;
    Text zoneFilterLabel;
    string zoneFilter;
    Text summaryText;
    Text detailsText;
    Button startNavigationButton;
    Text startNavigationLabel;

    public bool IsPlannerOpen => plannerRoot != null && plannerRoot.gameObject.activeSelf;

    /// <summary>Selectable places for the current zone (map markers) and every zone (places list).</summary>
    public void SetPlaces(string zone, IReadOnlyList<MapPlace> allPlaces)
    {
        currentZone = zone;
        places.Clear();
        placesByKey.Clear();
        if (allPlaces != null)
        {
            foreach (var place in allPlaces)
            {
                if (place == null || string.IsNullOrEmpty(place.key) || placesByKey.ContainsKey(place.key)) continue;
                places.Add(place);
                placesByKey[place.key] = place;
            }
        }
        BuildPlaceMarkers(places);
        zoneFilter = null;
        BuildPlaceRows();
        BuildMapLabels();
        if (startKey != null && !placesByKey.ContainsKey(startKey)) startKey = null;
        if (destinationKey != null && !placesByKey.ContainsKey(destinationKey)) destinationKey = null;
        RefreshSelection();
    }

    /// <summary>Updates the selection without raising <see cref="RouteSelectionChanged"/>.</summary>
    public void SetSelection(string start, string destination)
    {
        startKey = start != null && placesByKey.ContainsKey(start) ? start : null;
        destinationKey = destination != null && placesByKey.ContainsKey(destination) ? destination : null;
        if (destinationKey == null) ClearPreview();
        RefreshSelection();
    }

    public void SetNavigationActive(bool active)
    {
        navigationActive = active;
        if (!active) navigationWaypointKey = null;
        RefreshFooter();
    }

    /// <summary>
    /// Pins the minimap on the elevator that connects this floor to the next.
    /// Pass null once the destination itself is on the floor being shown.
    /// </summary>
    public void SetFloorWaypoint(string placeKey)
    {
        navigationWaypointKey = placeKey != null && placesByKey.ContainsKey(placeKey) ? placeKey : null;
    }

    public void ShowPreview(RoutePreview routePreview)
    {
        preview = routePreview;
        if (previewRouteRoot != null)
        {
            if (preview != null && preview.ok && preview.mapRoute != null)
            {
                var prefix = startKey == null && userMarker != null ? userMarker.localPosition : (Vector3?)null;
                DrawRoute(previewRouteRoot, preview.mapRoute, previewMaterial, 1.1f, prefix);
            }
            else
            {
                DrawRoute(previewRouteRoot, null, previewMaterial, 1f, null);
            }
        }
        if (activeRouteRoot != null) activeRouteRoot.gameObject.SetActive(!(IsPlannerOpen && preview != null && preview.ok));
        RefreshFooter();
        RefreshHint();
    }

    public void OpenPlanner(bool focusDestination)
    {
        if (plannerRoot == null) return;
        activeSlot = focusDestination || destinationKey == null ? Slot.Destination : Slot.Start;
        plannerRoot.gameObject.SetActive(true);
        if (compactCard != null) compactCard.gameObject.SetActive(false);
        UpdateViewModeButton();
        if (plannerSubtitle != null)
            plannerSubtitle.text = string.IsNullOrEmpty(currentZone) ? "ROUTE PLANNER" : $"ROUTE PLANNER  ·  YOU ARE IN {currentZone.ToUpperInvariant()}";

        Canvas.ForceUpdateCanvases();
        EnsurePlannerTexture();
        topDown = true;
        zoom = 1f;
        cameraFocus = userMarker != null ? ClampFocus(userMarker.localPosition) : center;
        if (mapCamera != null)
        {
            mapCamera.targetTexture = plannerTexture;
            mapCamera.ResetAspect();
        }

        hintUntil = 0f;
        RefreshSelection();
        if (destinationKey != null) RouteSelectionChanged?.Invoke(startKey, destinationKey);
    }

    public void ClosePlanner()
    {
        if (plannerRoot == null) return;
        plannerRoot.gameObject.SetActive(false);
        if (compactCard != null) compactCard.gameObject.SetActive(true);
        topDown = compactTopDown;
        zoom = 1f;
        if (mapCamera != null)
        {
            mapCamera.targetTexture = compactTexture;
            mapCamera.ResetAspect();
        }
        ClearPreview();
    }

    void TogglePlannerMode()
    {
        topDown = !topDown;
        UpdateViewModeButton();
    }

    void UpdateViewModeButton()
    {
        if (viewModeButton == null) return;
        var label = MapUi.ButtonLabel(viewModeButton);
        if (label != null) label.text = topDown ? "3D view" : "2D view";
    }

    void ClearPreview()
    {
        preview = null;
        if (previewRouteRoot != null) DrawRoute(previewRouteRoot, null, previewMaterial, 1f, null);
        if (activeRouteRoot != null) activeRouteRoot.gameObject.SetActive(true);
        RefreshFooter();
    }

    // ---------- Selection ----------

    void Assign(MapPlace place)
    {
        if (place == null) return;
        if (activeSlot == Slot.Start)
        {
            if (!place.inCurrentZone)
            {
                ShowPlannerHint($"Start must be in {currentZone}, where you are now. {place.name} can be a destination.", true);
                return;
            }
            startKey = place.key;
            if (destinationKey == place.key) destinationKey = null;
            activeSlot = Slot.Destination;
        }
        else
        {
            destinationKey = place.key;
            if (startKey == place.key) startKey = null;
        }
        hintUntil = 0f;
        if (place.inCurrentZone) FocusOn(place);
        SelectionEdited();
    }

    void UseMyLocation()
    {
        startKey = null;
        activeSlot = Slot.Destination;
        SelectionEdited();
    }

    void ClearDestination()
    {
        destinationKey = null;
        activeSlot = Slot.Destination;
        SelectionEdited();
    }

    void ClearAll()
    {
        startKey = null;
        destinationKey = null;
        activeSlot = Slot.Destination;
        hintUntil = 0f;
        SelectionEdited();
    }

    void Swap()
    {
        if (destinationKey == null) return;
        var newStart = placesByKey[destinationKey];
        if (!newStart.inCurrentZone)
        {
            ShowPlannerHint($"Can't swap: {newStart.name} is in {newStart.zone}. Your start must be in {currentZone}.", true);
            return;
        }
        // "Your location" can't be a destination, so it becomes the place you're standing nearest to.
        var newDestination = startKey ?? NearestPlaceToUser()?.key;
        if (newDestination == null || newDestination == newStart.key)
        {
            ShowPlannerHint("You're already at the destination, so there's nothing to swap.", true);
            return;
        }
        startKey = newStart.key;
        destinationKey = newDestination;
        SelectionEdited();
    }

    void SelectionEdited()
    {
        ClearPreview();
        RefreshSelection();
        if (destinationKey != null) RouteSelectionChanged?.Invoke(startKey, destinationKey);
    }

    void StartNavigation()
    {
        if (destinationKey == null || preview == null || !preview.ok) return;
        var start = startKey;
        var destination = destinationKey;
        ClosePlanner();
        NavigationRequested?.Invoke(start, destination);
    }

    void OpenNativeFromPlanner()
    {
        var selection = new NativeSelection
        {
            startId = startKey != null && placesByKey.TryGetValue(startKey, out var start) ? start.localId : "",
            destinationId = destinationKey != null && placesByKey.TryGetValue(destinationKey, out var destination) && destination.inCurrentZone
                ? destination.localId
                : ""
        };
        var error = OpenNativeModel(JsonUtility.ToJson(selection));
        if (error != null) ShowPlannerHint(error, true);
    }

    [Serializable]
    sealed class NativeSelection
    {
        public string startId;
        public string destinationId;
    }

    MapPlace NearestPlaceToUser()
    {
        if (userMarker == null) return null;
        MapPlace best = null;
        var bestDistance = float.MaxValue;
        foreach (var place in places)
        {
            if (!place.inCurrentZone) continue;
            var offset = place.sessionPosition - userMarker.localPosition;
            offset.y = 0f;
            var distance = offset.sqrMagnitude - (place.major ? 0.25f : 0f);
            if (distance < bestDistance)
            {
                bestDistance = distance;
                best = place;
            }
        }
        return best;
    }

    // ---------- Map interaction ----------

    void OnMapTapped(Vector2 viewport)
    {
        if (mapCamera == null || mapViewport == null) return;
        var size = mapViewport.rect.size;
        MapPlace best = null;
        var bestScore = float.MaxValue;
        foreach (var place in places)
        {
            if (!place.inCurrentZone) continue;
            var projected = mapCamera.WorldToViewportPoint(sessionSpace.TransformPoint(MarkerPosition(place)));
            if (projected.z < 0f) continue;
            var pixels = Vector2.Scale(new Vector2(projected.x - viewport.x, projected.y - viewport.y), size).magnitude;
            if (pixels > PickRadius) continue;
            var score = pixels - (place.major ? 18f : 0f);
            if (score < bestScore)
            {
                bestScore = score;
                best = place;
            }
        }

        if (best == null)
            ShowPlannerHint("No place there. Tap one of the dots on the map.", true);
        else
            Assign(best);
    }

    void OnMapPanned(Vector2 delta)
    {
        if (mapCamera == null) return;
        var height = mapCamera.orthographicSize * 2f;
        var width = height * mapCamera.aspect;
        var groundDelta = topDown ? delta.y * height : delta.y * height / Mathf.Sin(CompactPitch * Mathf.Deg2Rad);
        cameraFocus = ClampFocus(cameraFocus - new Vector3(delta.x * width, 0f, groundDelta));
    }

    void OnMapZoomed(float factor) => zoom = Mathf.Clamp(zoom * factor, MinZoom, MaxZoom);

    void Recenter()
    {
        zoom = 1f;
        cameraFocus = userMarker != null ? ClampFocus(userMarker.localPosition) : center;
    }

    void FocusOn(MapPlace place) => cameraFocus = ClampFocus(place.sessionPosition);

    Vector3 ClampFocus(Vector3 focus)
    {
        var limit = span * 0.6f;
        return new Vector3(
            Mathf.Clamp(focus.x, center.x - limit, center.x + limit),
            center.y,
            Mathf.Clamp(focus.z, center.z - limit, center.z + limit));
    }

    void EnsurePlannerTexture()
    {
        if (plannerImage == null) return;
        var size = mapViewport.rect.size;
        if (size.x < 10f || size.y < 10f) size = new Vector2(1000f, 1000f);
        var width = 1024;
        var height = Mathf.Clamp(Mathf.RoundToInt(width * size.y / size.x), 256, 2048);
        if (plannerTexture != null && plannerTexture.width == width && plannerTexture.height == height) return;
        ReleasePlannerTexture();
        plannerTexture = new RenderTexture(width, height, 16, RenderTextureFormat.ARGB32);
        plannerImage.texture = plannerTexture;
    }

    void ReleasePlannerTexture()
    {
        if (plannerTexture == null) return;
        if (mapCamera != null && mapCamera.targetTexture == plannerTexture) mapCamera.targetTexture = compactTexture;
        plannerTexture.Release();
        Destroy(plannerTexture);
        plannerTexture = null;
    }

    /// <summary>Positions name chips over the map and keeps the selection pins on their places.</summary>
    void UpdatePlannerOverlays()
    {
        UpdatePin(startPin, startKey);
        UpdatePin(destinationPin, destinationKey);
        if (hintChip != null && hintUntil > 0f && Time.unscaledTime > hintUntil)
        {
            hintUntil = 0f;
            RefreshHint();
        }
        if (!IsPlannerOpen || labelLayer == null || mapCamera == null) return;

        EnsurePlannerTexture();
        if (mapCamera.targetTexture != plannerTexture)
        {
            mapCamera.targetTexture = plannerTexture;
            mapCamera.ResetAspect();
        }

        var rect = labelLayer.rect;
        foreach (var label in mapLabels)
        {
            var isWaypoint = label.place.key == ActiveFloorWaypoint();
            var selected = label.place.key == startKey || label.place.key == destinationKey || isWaypoint;
            var showLabel = label.place.major || selected;
            var viewport = mapCamera.WorldToViewportPoint(sessionSpace.TransformPoint(MarkerPosition(label.place)));
            var visible = showLabel && viewport.z > 0f && viewport.x > 0.02f && viewport.x < 0.98f && viewport.y > 0.02f && viewport.y < 0.95f;
            label.rect.gameObject.SetActive(visible);
            if (!visible) continue;
            label.text.text = isWaypoint ? $"{label.place.name}  ·  waypoint" : label.place.name;
            label.rect.sizeDelta = new Vector2(Mathf.Min(420f, label.text.preferredWidth + 32f), 46f);
            label.rect.anchoredPosition = new Vector2(viewport.x * rect.width, viewport.y * rect.height + 28f);
            label.background.color = label.place.key == startKey ? MapUi.WithAlpha(MapUi.Start, 0.95f)
                : label.place.key == destinationKey || isWaypoint ? MapUi.WithAlpha(MapUi.Destination, 0.95f)
                : new Color(0.12f, 0.2f, 0.3f, 0.9f);
            label.text.color = Color.white;
        }
    }

    void UpdatePin(Transform pin, string key)
    {
        if (pin == null) return;
        if (pin == destinationPin)
        {
            var destinationOnMap = key != null && placesByKey.TryGetValue(key, out var destination) && destination.inCurrentZone;
            if (!destinationOnMap) key = ActiveFloorWaypoint();
        }
        var visible = key != null && placesByKey.TryGetValue(key, out var place) && place.inCurrentZone;
        pin.gameObject.SetActive(visible);
        if (visible) pin.localPosition = MarkerPosition(placesByKey[key]) + Vector3.up * 0.05f;
    }

    /// <summary>
    /// While the planner is open, the preview's elevator. While navigating, the elevator of the active leg.
    /// Null when the destination is already on this floor.
    /// </summary>
    string ActiveFloorWaypoint()
    {
        if (IsPlannerOpen)
            return preview != null && preview.ok && !string.IsNullOrEmpty(preview.waypointKey) ? preview.waypointKey : null;
        return navigationWaypointKey;
    }

    // ---------- UI ----------

    void BuildPlanner()
    {
        plannerRoot = MapUi.Stretch("RoutePlanner", canvasRoot);
        MapUi.Panel(plannerRoot, MapUi.Sheet, 0f, true);

        var scale = Mathf.Max(1f, Screen.width) / 1170f;
        var safeHeight = Screen.safeArea.height / scale;
        var content = MapUi.Rect("Content", plannerRoot, Vector2.zero, Vector2.one, new Vector2(32, 20), new Vector2(-32, -20));

        const float headerHeight = 170f;
        const float cardHeight = 300f;
        var placesHeight = Mathf.Clamp(safeHeight * 0.19f, 320f, 420f);
        const float footerHeight = 262f;
        const float gap = 18f;

        BuildHeader(Top(content, 0f, headerHeight));
        BuildRouteCard(Top(content, headerHeight + gap, cardHeight));
        var mapTop = headerHeight + gap + cardHeight + gap;
        var mapBottom = footerHeight + gap + placesHeight - 40f;
        BuildMap(MapUi.Rect("Map", content, Vector2.zero, Vector2.one, new Vector2(0, mapBottom), new Vector2(0, -mapTop)));
        var sheet = MapUi.Rect("PlacesSheet", content, Vector2.zero, new Vector2(1, 0), Vector2.zero,
            new Vector2(0, footerHeight + gap + placesHeight));
        MapUi.Panel(sheet, MapUi.Surface, 42f, true);
        BuildPlacesSection(MapUi.Rect("Places", sheet, Vector2.zero, new Vector2(1, 0),
            new Vector2(20, footerHeight + gap), new Vector2(-20, footerHeight + gap + placesHeight - 12f)));
        BuildFooter(MapUi.Rect("Footer", sheet, Vector2.zero, new Vector2(1, 0), new Vector2(20, 0), new Vector2(-20, footerHeight)));

        plannerRoot.gameObject.SetActive(false);
        RefreshSelection();
    }

    static RectTransform Top(RectTransform parent, float top, float height) =>
        MapUi.Rect("Section", parent, new Vector2(0, 1), Vector2.one, new Vector2(0, -top - height), new Vector2(0, -top));

    void BuildHeader(RectTransform header)
    {
        header.name = "Header";
        plannerSubtitle = MapUi.Label(MapUi.Rect("Eyebrow", header, new Vector2(0, 1), new Vector2(1, 1), new Vector2(4, -44), new Vector2(-360, 0)),
            "ROUTE PLANNER", 24, MapUi.Eyebrow, TextAnchor.MiddleLeft, FontStyle.Bold);
        var searchBox = MapUi.Rect("Search", header, Vector2.zero, new Vector2(1, 0), new Vector2(0, 0), new Vector2(0, 84));
        var searchBackground = MapUi.Panel(searchBox, MapUi.Surface, 34f, true);
        placeSearch = searchBox.gameObject.AddComponent<InputField>();
        placeSearch.targetGraphic = searchBackground;
        var placeholder = MapUi.Label(MapUi.Stretch("Placeholder", searchBox, 28f), "Where to? Search rooms and places", 33,
            MapUi.TextSecondary, TextAnchor.MiddleLeft);
        var typed = MapUi.Label(MapUi.Stretch("Input", searchBox, 28f), "", 33,
            MapUi.TextPrimary, TextAnchor.MiddleLeft);
        typed.supportRichText = false;
        placeSearch.placeholder = placeholder;
        placeSearch.textComponent = typed;
        placeSearch.onValueChanged.AddListener(_ => { BuildPlaceRows(); RefreshSelection(); });

        var close = MapUi.Sized("Close", header, new Vector2(1, 1), new Vector2(80, 80), new Vector2(-40, -40));
        MapUi.Button(close, "×", MapUi.SurfaceRaised, MapUi.TextPrimary, 60, ClosePlanner, 52f);

        var mode = MapUi.Sized("MapViewMode", header, new Vector2(1, 1), new Vector2(190, 80), new Vector2(-185, -40));
        viewModeButton = MapUi.Button(mode, "3D view", MapUi.SurfaceRaised, MapUi.TextPrimary, 30, TogglePlannerMode, 52f);
    }

    void BuildRouteCard(RectTransform card)
    {
        card.name = "RouteCard";
        MapUi.Panel(card, MapUi.Surface, 40f);

        const float swapWidth = 150f;
        var rows = MapUi.Rect("Rows", card, Vector2.zero, Vector2.one, new Vector2(16, 16), new Vector2(-swapWidth - 16, -16));
        var startRow = MapUi.Rect("StartRow", rows, new Vector2(0, 0.5f), Vector2.one, new Vector2(0, 6), Vector2.zero);
        var destinationRow = MapUi.Rect("DestinationRow", rows, Vector2.zero, new Vector2(1, 0.5f), Vector2.zero, new Vector2(0, -6));
        startRowBackground = BuildSlotRow(startRow, "FROM", MapUi.Start, Slot.Start, out startValue);
        destinationRowBackground = BuildSlotRow(destinationRow, "TO", MapUi.Destination, Slot.Destination, out destinationValue);

        // Dotted connector between the two slot dots.
        for (var i = 0; i < 3; i++)
            MapUi.Dot(MapUi.Sized("Connector", rows, new Vector2(0, 0.5f), new Vector2(8, 8), new Vector2(46, 18 - i * 18)),
                MapUi.TextSecondary);

        useMyLocationButton = MapUi.Button(
            MapUi.Sized("UseMyLocation", startRow, new Vector2(1, 0.5f), new Vector2(220, 76), new Vector2(-126, 0)),
            "My location", MapUi.SurfaceRaised, MapUi.User, 26, UseMyLocation, 38f);
        clearDestinationButton = MapUi.Button(
            MapUi.Sized("ClearDestination", destinationRow, new Vector2(1, 0.5f), new Vector2(76, 76), new Vector2(-54, 0)),
            "×", MapUi.SurfaceRaised, MapUi.TextPrimary, 44, ClearDestination, 38f);

        var swap = MapUi.Rect("Swap", card, new Vector2(1, 0), Vector2.one, new Vector2(-swapWidth - 4, 40), new Vector2(-24, -40));
        swapButton = MapUi.Button(swap, "SWAP", MapUi.SurfaceRaised, MapUi.TextPrimary, 26, Swap, 36f);
    }

    Image BuildSlotRow(RectTransform row, string caption, Color color, Slot slot, out Text value)
    {
        var background = MapUi.Panel(row, MapUi.Surface, 30f, true);
        var button = row.gameObject.AddComponent<Button>();
        button.targetGraphic = background;
        button.transition = Selectable.Transition.None;
        button.onClick.AddListener(() =>
        {
            activeSlot = slot;
            hintUntil = 0f;
            RefreshSelection();
        });
        MapUi.Dot(MapUi.Sized("Dot", row, new Vector2(0, 0.5f), new Vector2(34, 34), new Vector2(46, 0)), color);
        MapUi.Label(MapUi.Rect("Caption", row, new Vector2(0, 0.5f), new Vector2(1, 1), new Vector2(92, 0), new Vector2(-250, -10)),
            caption, 22, MapUi.TextSecondary, TextAnchor.LowerLeft, FontStyle.Bold);
        value = MapUi.Label(MapUi.Rect("Value", row, Vector2.zero, new Vector2(1, 0.5f), new Vector2(92, 8), new Vector2(-250, 6)),
            "", 36, MapUi.TextPrimary, TextAnchor.UpperLeft, FontStyle.Bold);
        value.horizontalOverflow = HorizontalWrapMode.Overflow;
        return background;
    }

    void BuildMap(RectTransform map)
    {
        MapUi.Panel(map, MapUi.SurfaceRaised, 40f);
        mapViewport = MapUi.Stretch("Viewport", map, 6f);
        mapViewport.gameObject.AddComponent<RectMask2D>();
        plannerImage = MapUi.Stretch("MapImage", mapViewport).gameObject.AddComponent<RawImage>();
        plannerImage.raycastTarget = true;
        var input = plannerImage.gameObject.AddComponent<MapViewportInput>();
        input.Tapped += OnMapTapped;
        input.Panned += OnMapPanned;
        input.Zoomed += OnMapZoomed;

        labelLayer = MapUi.Stretch("Labels", mapViewport);

        hintChip = MapUi.Rect("Hint", mapViewport, new Vector2(0, 1), Vector2.one, new Vector2(20, -96), new Vector2(-20, -20));
        MapUi.Panel(hintChip, new Color(1f, 1f, 1f, 0.96f), 38f);
        hintDot = MapUi.Dot(MapUi.Sized("Dot", hintChip, new Vector2(0, 0.5f), new Vector2(22, 22), new Vector2(38, 0)), MapUi.Destination);
        hintText = MapUi.Label(MapUi.Rect("Text", hintChip, Vector2.zero, Vector2.one, new Vector2(64, 0), new Vector2(-20, 0)),
            "", 27, MapUi.TextPrimary, TextAnchor.MiddleLeft, FontStyle.Bold);

        var controls = MapUi.Rect("Controls", mapViewport, new Vector2(1, 0), new Vector2(1, 0), new Vector2(-104, 20), new Vector2(-20, 300));
        MapUi.Button(MapUi.Rect("ZoomIn", controls, new Vector2(0, 1), Vector2.one, new Vector2(0, -84), Vector2.zero),
            "+", MapUi.Surface, MapUi.TextPrimary, 48, () => OnMapZoomed(1.4f), 30f);
        MapUi.Button(MapUi.Rect("ZoomOut", controls, new Vector2(0, 0.5f), new Vector2(1, 0.5f), new Vector2(0, -42), new Vector2(0, 42)),
            "-", MapUi.Surface, MapUi.TextPrimary, 52, () => OnMapZoomed(1f / 1.4f), 30f);
        MapUi.Button(MapUi.Rect("Recenter", controls, Vector2.zero, new Vector2(1, 0), Vector2.zero, new Vector2(0, 84)),
            "ME", MapUi.Surface, MapUi.User, 28, Recenter, 30f);

        var legend = MapUi.Rect("Legend", mapViewport, Vector2.zero, Vector2.zero, new Vector2(20, 20), new Vector2(560, 76));
        MapUi.Panel(legend, new Color(1f, 1f, 1f, 0.94f), 28f);
        AddLegendItem(legend, 0, "You", MapUi.User);
        AddLegendItem(legend, 1, "Start", MapUi.Start);
        AddLegendItem(legend, 2, "Destination", MapUi.Destination);
    }

    static void AddLegendItem(RectTransform legend, int index, string text, Color color)
    {
        var widths = new[] { 0f, 120f, 260f };
        var item = MapUi.Rect(text, legend, Vector2.zero, new Vector2(0, 1), new Vector2(20 + widths[index], 0), new Vector2(20 + widths[index] + 260, 0));
        MapUi.Dot(MapUi.Sized("Dot", item, new Vector2(0, 0.5f), new Vector2(20, 20), new Vector2(10, 0)), color);
        MapUi.Label(MapUi.Rect("Text", item, Vector2.zero, Vector2.one, new Vector2(30, 0), Vector2.zero), text, 23, MapUi.TextSecondary);
    }

    void BuildPlacesSection(RectTransform section)
    {
        placesHeading = MapUi.Label(MapUi.Rect("Heading", section, new Vector2(0, 1), Vector2.one, new Vector2(8, -44), Vector2.zero),
            "DESTINATIONS", 24, MapUi.Eyebrow, TextAnchor.MiddleLeft, FontStyle.Bold);

        var filter = MapUi.Rect("FloorFilter", section, new Vector2(1, 1), Vector2.one, new Vector2(-250, -52), new Vector2(0, 0));
        var filterButton = MapUi.Button(filter, "All areas", MapUi.SurfaceRaised, MapUi.TextPrimary, 25, CycleZoneFilter, 26f);
        zoneFilterLabel = MapUi.ButtonLabel(filterButton);

        var scrollRect = MapUi.Rect("List", section, Vector2.zero, Vector2.one, Vector2.zero, new Vector2(0, -56));
        MapUi.Panel(scrollRect, MapUi.Surface, 36f);
        var viewport = MapUi.Stretch("Viewport", scrollRect, 10f);
        viewport.gameObject.AddComponent<RectMask2D>();
        var viewportImage = viewport.gameObject.AddComponent<Image>();
        viewportImage.color = Color.clear;
        placesContent = MapUi.Rect("Content", viewport, new Vector2(0, 1), Vector2.one, Vector2.zero, Vector2.zero);
        placesContent.pivot = new Vector2(0.5f, 1f);
        var scroll = scrollRect.gameObject.AddComponent<ScrollRect>();
        scroll.viewport = viewport;
        scroll.content = placesContent;
        scroll.horizontal = false;
        scroll.movementType = ScrollRect.MovementType.Clamped;
        scroll.scrollSensitivity = 30f;

        placesEmpty = MapUi.Label(MapUi.Stretch("Empty", scrollRect, 30f),
            "No matching places. Try another name or floor.", 28, MapUi.TextSecondary, TextAnchor.MiddleCenter);
    }

    void CycleZoneFilter()
    {
        var zones = new List<string>();
        foreach (var place in places)
            if (place.major && !zones.Contains(place.zone)) zones.Add(place.zone);
        zones.Sort(StringComparer.OrdinalIgnoreCase);
        if (zones.Count == 0) return;
        var index = zoneFilter == null ? -1 : zones.IndexOf(zoneFilter);
        zoneFilter = index + 1 < zones.Count ? zones[index + 1] : null;
        BuildPlaceRows();
        RefreshSelection();
    }

    void BuildFooter(RectTransform footer)
    {
        MapUi.Panel(footer, MapUi.Surface, 40f);
        summaryText = MapUi.Label(MapUi.Rect("Summary", footer, new Vector2(0, 1), Vector2.one, new Vector2(32, -76), new Vector2(-32, -18)),
            "", 36, MapUi.TextPrimary, TextAnchor.MiddleLeft, FontStyle.Bold);
        detailsText = MapUi.Label(MapUi.Rect("Details", footer, new Vector2(0, 1), Vector2.one, new Vector2(32, -126), new Vector2(-32, -74)),
            "", 25, MapUi.TextSecondary);

        MapUi.Button(MapUi.Rect("Clear", footer, Vector2.zero, Vector2.zero, new Vector2(24, 22), new Vector2(244, 124)),
            "Clear", MapUi.SurfaceRaised, MapUi.TextPrimary, 32, ClearAll, 50f);
        startNavigationButton = MapUi.Button(MapUi.Rect("StartNavigation", footer, Vector2.zero, new Vector2(1, 0), new Vector2(264, 22), new Vector2(-24, 124)),
            "Start navigation", MapUi.Accent, MapUi.AccentText, 36, StartNavigation, 50f);
        startNavigationLabel = MapUi.ButtonLabel(startNavigationButton);
    }

    void BuildPlaceRows()
    {
        if (placesContent == null) return;
        foreach (Transform child in placesContent) Destroy(child.gameObject);
        placeRows.Clear();

        var query = placeSearch != null ? placeSearch.text.Trim() : "";
        var listed = places.FindAll(place => place.major &&
            (zoneFilter == null || place.zone == zoneFilter) &&
            (query.Length == 0 || place.name.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0 ||
             place.zone.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0));
        listed.Sort((a, b) =>
        {
            if (a.inCurrentZone != b.inCurrentZone) return a.inCurrentZone ? -1 : 1;
            var zone = string.CompareOrdinal(a.zone, b.zone);
            if (zone != 0) return zone;
            var kind = KindOrder(a.kind).CompareTo(KindOrder(b.kind));
            return kind != 0 ? kind : string.Compare(a.name, b.name, StringComparison.OrdinalIgnoreCase);
        });

        const float rowHeight = 104f;
        const float spacing = 8f;
        var multiZone = places.Exists(place => !place.inCurrentZone);
        for (var i = 0; i < listed.Count; i++)
        {
            var place = listed[i];
            var row = MapUi.Rect("Place-" + place.key, placesContent, new Vector2(0, 1), Vector2.one,
                new Vector2(0, -(i + 1) * rowHeight - i * spacing), new Vector2(0, -i * (rowHeight + spacing)));
            var background = MapUi.Panel(row, MapUi.Surface, 28f, true);
            var button = row.gameObject.AddComponent<Button>();
            button.targetGraphic = background;
            var captured = place;
            button.onClick.AddListener(() => Assign(captured));

            MapUi.Dot(MapUi.Sized("Dot", row, new Vector2(0, 0.5f), new Vector2(26, 26), new Vector2(36, 0)), place.Color);
            MapUi.Label(MapUi.Rect("Name", row, new Vector2(0, 0.5f), Vector2.one, new Vector2(74, -4), new Vector2(-230, -6)),
                place.name, 32, MapUi.TextPrimary, TextAnchor.LowerLeft, FontStyle.Bold);
            var where = multiZone ? $"{place.KindLabel}  ·  {place.zone}{(place.inCurrentZone ? " (here)" : "")}" : place.KindLabel;
            MapUi.Label(MapUi.Rect("Kind", row, Vector2.zero, new Vector2(1, 0.5f), new Vector2(74, 6), new Vector2(-230, 2)),
                where, 23, MapUi.TextSecondary, TextAnchor.UpperLeft);

            var tagRect = MapUi.Sized("Tag", row, new Vector2(1, 0.5f), new Vector2(196, 54), new Vector2(-118, 0));
            var tagBackground = MapUi.Panel(tagRect, MapUi.Start, 27f);
            var tag = MapUi.Label(MapUi.Stretch("Text", tagRect), "", 22, MapUi.AccentText, TextAnchor.MiddleCenter, FontStyle.Bold);
            placeRows.Add(new PlaceRow { place = place, background = background, tag = tag, tagBackground = tagBackground });
        }
        placesContent.sizeDelta = new Vector2(0, listed.Count * (rowHeight + spacing));
        if (placesEmpty != null) placesEmpty.gameObject.SetActive(listed.Count == 0);
        if (placesHeading != null)
            placesHeading.text = listed.Count == 0 ? "DESTINATIONS" : $"DESTINATIONS  ·  {listed.Count}";
        if (zoneFilterLabel != null) zoneFilterLabel.text = zoneFilter ?? "All areas";
    }

    static int KindOrder(string kind) => kind switch
    {
        "destination" => 0,
        "entrance" => 1,
        "room" => 2,
        "elevator" => 3,
        "stairs" => 4,
        _ => 5
    };

    void BuildMapLabels()
    {
        if (labelLayer == null) return;
        foreach (Transform child in labelLayer) Destroy(child.gameObject);
        mapLabels.Clear();
        foreach (var place in places)
        {
            if (!place.inCurrentZone) continue;
            var rect = MapUi.Rect("Label-" + place.localId, labelLayer, Vector2.zero, Vector2.zero, Vector2.zero, Vector2.zero);
            rect.pivot = new Vector2(0.5f, 0f);
            var background = MapUi.Panel(rect, new Color(0.12f, 0.2f, 0.3f, 0.9f), 22f);
            var text = MapUi.Label(MapUi.Stretch("Text", rect), place.name, 24, Color.white, TextAnchor.MiddleCenter, FontStyle.Bold);
            text.horizontalOverflow = HorizontalWrapMode.Overflow;
            rect.sizeDelta = new Vector2(Mathf.Min(420f, text.preferredWidth + 32f), 46f);
            rect.gameObject.SetActive(false);
            mapLabels.Add(new MapLabel { place = place, rect = rect, background = background, text = text });
        }
    }

    void RefreshSelection()
    {
        if (plannerRoot == null) return;
        var start = startKey != null && placesByKey.TryGetValue(startKey, out var s) ? s : null;
        var destination = destinationKey != null && placesByKey.TryGetValue(destinationKey, out var d) ? d : null;

        startValue.text = start == null ? "My location" : start.name;
        startValue.color = start == null ? MapUi.User : MapUi.TextPrimary;
        destinationValue.text = destination == null
            ? activeSlot == Slot.Destination ? "Tap the map or a place" : "Choose a destination"
            : destination.inCurrentZone ? destination.name : $"{destination.name}  ·  {destination.zone}";
        destinationValue.color = destination == null ? MapUi.TextSecondary : MapUi.TextPrimary;

        startRowBackground.color = activeSlot == Slot.Start ? MapUi.SurfaceActive : MapUi.Surface;
        destinationRowBackground.color = activeSlot == Slot.Destination ? MapUi.SurfaceActive : MapUi.Surface;
        useMyLocationButton.gameObject.SetActive(start != null);
        clearDestinationButton.gameObject.SetActive(destination != null);
        swapButton.interactable = destination != null;

        foreach (var row in placeRows)
        {
            var isStart = row.place.key == startKey;
            var isDestination = row.place.key == destinationKey;
            row.tag.text = isStart ? "START" : isDestination ? "DESTINATION" : "";
            row.tagBackground.gameObject.SetActive(isStart || isDestination);
            row.tagBackground.color = isStart ? MapUi.Start : MapUi.Destination;
            row.background.color = isStart || isDestination ? MapUi.SurfaceActive : MapUi.Surface;
        }

        RefreshHint();
        RefreshFooter();
    }

    void ShowPlannerHint(string message, bool warning)
    {
        if (hintText == null) return;
        hintText.text = message;
        hintText.color = warning ? MapUi.Warning : MapUi.TextPrimary;
        hintDot.color = warning ? MapUi.Warning : activeSlot == Slot.Start ? MapUi.Start : MapUi.Destination;
        hintUntil = Time.unscaledTime + HintSeconds;
    }

    void RefreshHint()
    {
        if (hintText == null || hintUntil > 0f) return;
        hintText.color = MapUi.TextPrimary;
        if (activeSlot == Slot.Start)
        {
            hintDot.color = MapUi.Start;
            hintText.text = "Tap a dot to set where the route starts";
        }
        else if (!string.IsNullOrEmpty(ActiveFloorWaypoint()) && placesByKey.TryGetValue(ActiveFloorWaypoint(), out var waypoint))
        {
            hintDot.color = MapUi.Destination;
            hintText.text = $"This floor's route leads to {waypoint.name}, the waypoint onto the next floor";
        }
        else
        {
            hintDot.color = MapUi.Destination;
            hintText.text = destinationKey == null
                ? "Tap a dot to choose your destination"
                : "Tap another dot to change the destination";
        }
    }

    void RefreshFooter()
    {
        if (summaryText == null) return;
        var canStart = destinationKey != null && preview != null && preview.ok;
        startNavigationButton.interactable = canStart;
        startNavigationLabel.text = navigationActive ? "Update route" : "Start navigation";

        if (destinationKey == null)
        {
            summaryText.text = "Pick a destination";
            summaryText.color = MapUi.TextPrimary;
            detailsText.text = "The route starts from your location unless you choose another start.";
        }
        else if (preview == null)
        {
            summaryText.text = "Finding the best route…";
            summaryText.color = MapUi.TextSecondary;
            detailsText.text = "";
        }
        else if (!preview.ok)
        {
            summaryText.text = "No route";
            summaryText.color = MapUi.Warning;
            detailsText.text = preview.error ?? "";
        }
        else
        {
            summaryText.text = preview.summary ?? "";
            summaryText.color = MapUi.TextPrimary;
            detailsText.text = preview.details ?? "";
        }
    }

    void ResetPlannerUi()
    {
        plannerRoot = null;
        mapViewport = null;
        plannerImage = null;
        labelLayer = null;
        hintChip = null;
        hintText = null;
        placesContent = null;
        placeSearch = null;
        zoneFilterLabel = null;
        zoneFilter = null;
        summaryText = null;
        placeRows.Clear();
        mapLabels.Clear();
        preview = null;
        previewRouteRoot = null;
        activeRouteRoot = null;
    }
}
