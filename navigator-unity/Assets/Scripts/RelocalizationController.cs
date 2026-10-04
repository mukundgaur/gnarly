using System;
using System.Collections.Generic;
using System.IO;
using Unity.Collections;
using Unity.XR.CoreUtils;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.ARSubsystems;
#if UNITY_IOS
using UnityEngine.XR.ARKit;
#endif
#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem.UI;
#endif

/// <summary>
/// Loads the mapper's ARWorldMap, waits for ARKit to relocalize, then places the test cube
/// and routes with A* over the RoomPlan visibility graph (scan-features.json / building.json).
/// With zone-connections.json, A* spans zones (e.g. floor → stairs → floor); each zone has its own
/// world map, so the route is followed one zone leg at a time and the map is switched at connectors.
/// </summary>
public class RelocalizationController : MonoBehaviour
{
    enum State { WaitingForPackage, WaitingForSession, Locating, Located, AwaitingZoneTransition, TrackingLost, Failed }

    sealed class ZonePackage
    {
        public string directory;
        public Pathfinding.ScanFeatures scan;
        public Pathfinding.Graph graph;
    }

    // Matches the website's building-layout.json. It is presentation metadata only: each zone's
    // saved ARWorldMap remains in its own coordinate system.
    [Serializable]
    sealed class BuildingLayoutDocument
    {
        public ZoneLayout[] zones;
    }

    [Serializable]
    sealed class ZoneLayout
    {
        public string zoneId;
        public int floor;
        public float x;
        public float z;
        public float rotationDegrees;
    }

    [Serializable]
    sealed class IndoorMapRouteRequest
    {
        public string startId;
        public string destinationId;
    }

    const string ZoneConnectionsFileName = "zone-connections.json";
    /// <summary>Vertical gap between floors in the building map. Display only; never used for ARKit or routing.</summary>
    const float DisplayFloorSpacingMeters = 6.5f;

    [SerializeField] ARSession session;
    [SerializeField] XROrigin origin;
    [SerializeField] RouteNavigator navigator;
    [SerializeField] FirebaseNavigationPackageLoader packageLoader;
    [SerializeField] string buildingId = "";
    [Tooltip("Enable after Firebase is configured. Disabled uses the packaged local scan so ARKit can relocalize immediately.")]
    [SerializeField] bool useFirebasePackages = true;
    [SerializeField] IndoorMapOverlay indoorMap;
    [SerializeField] LidarPulseView lidarView;
    [SerializeField] string zoneId = "zone-a";
    [SerializeField] string floorId = "ground";
    [SerializeField] float cubeSize = 0.2f;
    [Tooltip("ARKit can complete a fast relocalization without reporting the Relocalizing reason. Accept stable normal tracking after this delay.")]
    [SerializeField] float normalTrackingConfirmationSeconds = 1.5f;
    [Tooltip("Debug only: skip the world map so coordinates are relative to where the app starts.")]
    [SerializeField] bool skipWorldMap;

    State state = State.WaitingForSession;
    string packageDirectory;
    bool sawRelocalizing;
    string lastTrackingSnapshot;
    float normalTrackingStartedAt = -1f;
    TestAnchor anchor;
    Route fallbackRoute;
    [Header("Guidance")]
    [Tooltip("Maximum gap between runtime route targets. Graph and map selection nodes remain unchanged.")]
    [SerializeField, Range(0.1f, 1f)] float guidanceWaypointSpacingMeters = 0.2f;
    [Tooltip("How far (m) guidance may straighten the recorded walk. 0 follows every recorded step.")]
    [SerializeField, Range(0f, 1f)] float routeSmoothingMeters = 0.3f;
    Vector3? automaticRouteStartPosition;
    string currentZoneId;
    bool navigationLoaded;
    readonly Dictionary<string, ZonePackage> zonePackages = new Dictionary<string, ZonePackage>();
    readonly Dictionary<string, ZoneLayout> buildingLayout = new Dictionary<string, ZoneLayout>();
    /// <summary>All zones, keyed by <see cref="Pathfinding.ZoneKey"/>, joined by zone connections.</summary>
    Pathfinding.Graph navigationGraph;
    List<Pathfinding.RouteLeg> activeLegs;
    int activeLegIndex;
    GameObject cube;
    Text statusText;
    Text statusEyebrow;
    Image statusIndicator;
    Image retryBackground;
    RectTransform transitionPanel;
    Text transitionHeading;
    Text transitionInstructions;
    Text transitionButtonLabel;
    RectTransform retryButton;
    RectTransform resetAction;
    RectTransform arrivalPanel;
    Text arrivalDestination;
    /// <summary>Planner selection as combined-graph keys; a null start means "from my location".</summary>
    string selectedStartKey;
    string selectedDestinationKey;
    readonly Dictionary<string, string> placeNames = new Dictionary<string, string>();
    bool arrivalAnnounced;
    float nextPoseLogAt;
#if UNITY_IOS && !UNITY_EDITOR
    ARWorldMap? appliedWorldMap;
#endif

    /// <summary>
    /// The start zone comes from the selected package. Other zones come from the Firebase offline
    /// cache for the same building, or from StreamingAssets/&lt;zoneId&gt;/ when Firebase is off.
    /// </summary>
    string ZoneDirectory(string zone)
    {
        if (zone == zoneId && packageDirectory != null) return packageDirectory;
        if (!useFirebasePackages) return Path.Combine(Application.streamingAssetsPath, zone);
        return packageLoader != null && packageLoader.TryGetCachedZoneDirectory(buildingId, zone, out var directory)
            ? directory
            : null;
    }

    /// <summary>Prefers the connections downloaded with the Firebase version, then a bundled file.</summary>
    string ZoneConnectionsPath
    {
        get
        {
            if (useFirebasePackages && packageDirectory != null)
            {
                var downloaded = Path.Combine(packageDirectory, ZoneConnectionsFileName);
                if (File.Exists(downloaded)) return downloaded;
            }
            return Path.Combine(Application.streamingAssetsPath, ZoneConnectionsFileName);
        }
    }

    void Awake()
    {
        if (session == null) session = FindAnyObjectByType<ARSession>();
        if (origin == null) origin = FindAnyObjectByType<XROrigin>();
        if (navigator == null) navigator = GetComponent<RouteNavigator>();
        if (packageLoader == null) packageLoader = GetComponent<FirebaseNavigationPackageLoader>();
        if (packageLoader == null) packageLoader = gameObject.AddComponent<FirebaseNavigationPackageLoader>();
        if (indoorMap == null) indoorMap = GetComponent<IndoorMapOverlay>();
        if (indoorMap == null) indoorMap = gameObject.AddComponent<IndoorMapOverlay>();
        indoorMap.RouteSelectionChanged += OnPlannerSelectionChanged;
        indoorMap.NavigationRequested += (start, destination) => BeginRoute(start, destination);
        if (lidarView == null) lidarView = GetComponent<LidarPulseView>();
        if (lidarView == null) lidarView = gameObject.AddComponent<LidarPulseView>();
        BuildUi();
    }

    void Start()
    {
        currentZoneId = zoneId;
        if (useFirebasePackages)
        {
            SetStatus("Preparing Firebase navigation package…");
            packageLoader.Begin(buildingId, zoneId, OnPackageReady, SetStatus);
            state = State.WaitingForPackage;
            return;
        }

        packageDirectory = Path.Combine(Application.streamingAssetsPath, zoneId);
        SetStatus("Using packaged navigation map. Starting camera…");
    }

    void Update()
    {
        switch (state)
        {
            case State.WaitingForPackage:
                break;

            case State.WaitingForSession:
                if (ARSession.state == ARSessionState.Unsupported)
                    Fail("This device does not support ARKit.");
                else if (ARSession.state == ARSessionState.SessionTracking)
                    LoadAndApplyZoneMap();
                break;

            case State.Locating:
                ReportTrackingState();
                if (ARSession.notTrackingReason == NotTrackingReason.Relocalizing)
                    sawRelocalizing = true;
                if (IsTrackingNormally())
                {
                    if (normalTrackingStartedAt < 0f)
                        normalTrackingStartedAt = Time.unscaledTime;

                    // ARKit often switches straight from Initializing to normal tracking when
                    // it recognizes a small room. Unity then never emits Relocalizing, even
                    // though the initialWorldMap was applied. Waiting for that transient state
                    // made the POC remain on "Locating" indefinitely.
                    if (sawRelocalizing || skipWorldMap ||
                        Time.unscaledTime - normalTrackingStartedAt >= normalTrackingConfirmationSeconds)
                        OnLocated();
                }
                else
                {
                    normalTrackingStartedAt = -1f;
                }
                break;

            case State.Located:
                if (!IsTrackingNormally())
                {
                    state = State.TrackingLost;
                    if (navigator != null) navigator.SetVisible(false);
                    SetStatus("Position lost. Point at familiar walls and slowly look around.");
                }
                else if (navigator != null && navigator.IsActive)
                {
                    LogCameraPose();
                    if (navigator.HasArrived && activeLegs != null && activeLegIndex < activeLegs.Count - 1)
                        AwaitZoneTransition();
                    else
                        SetStatus(LegStatus());
                    if (navigator.HasArrived && !arrivalAnnounced && (activeLegs == null || activeLegIndex == activeLegs.Count - 1))
                    {
                        arrivalAnnounced = true;
                        indoorMap?.SetCompactCaption($"ARRIVED AT {NameOf(selectedDestinationKey).ToUpperInvariant()}  ·  TAP FOR NEW ROUTE");
                        if (arrivalDestination != null) arrivalDestination.text = NameOf(selectedDestinationKey);
                        if (arrivalPanel != null) arrivalPanel.gameObject.SetActive(true);
                    }
                }
                break;

            case State.AwaitingZoneTransition:
                if (!IsTrackingNormally())
                    SetStatus("Tracking paused. Keep the phone pointed at the scanned area, then continue into the next zone.");
                break;

            case State.TrackingLost:
                if (IsTrackingNormally())
                {
                    state = State.Located;
                    if (navigator != null) navigator.SetVisible(true);
                    SetStatus("Located");
                }
                break;
        }
    }

    static bool IsTrackingNormally() =>
        ARSession.state == ARSessionState.SessionTracking &&
        ARSession.notTrackingReason == NotTrackingReason.None;

    void LoadNavigationData()
    {
        zonePackages.Clear();
        LoadBuildingLayout();
        var connectionsPath = ZoneConnectionsPath;
        var connections = File.Exists(connectionsPath)
            ? Pathfinding.ParseConnections(File.ReadAllText(connectionsPath))
            : null;

        var zoneIds = new List<string> { zoneId };
        if (connections != null)
        {
            foreach (var connection in connections.connections)
            {
                if (!zoneIds.Contains(connection.from.zoneId)) zoneIds.Add(connection.from.zoneId);
                if (!zoneIds.Contains(connection.to.zoneId)) zoneIds.Add(connection.to.zoneId);
            }
        }

        foreach (var zone in zoneIds)
        {
            var directory = ZoneDirectory(zone);
            if (directory == null || !Directory.Exists(directory))
            {
                Debug.LogWarning($"[Gnarly] No package directory for zone '{zone}'; routes through it are unavailable.");
                continue;
            }

            Pathfinding.ScanFeatures scan = null;
            Pathfinding.BuildingDocument building = null;
            var scanPath = Path.Combine(directory, "scan-features.json");
            if (File.Exists(scanPath))
                scan = Pathfinding.ParseScan(File.ReadAllText(scanPath));
            var buildingPath = Path.Combine(directory, "building.json");
            if (File.Exists(buildingPath))
                building = Pathfinding.ParseBuilding(File.ReadAllText(buildingPath));
            if (building != null && !string.IsNullOrEmpty(building.zoneId) && building.zoneId != zone)
                throw new FormatException($"building.json in '{zone}' is for zone '{building.zoneId}'.");

            // RoomPlan nodes must share the floor id of building.json nodes (such as web-placed
            // elevators), or they never get visibility edges to each other.
            var zoneFloorId = building?.floors != null && building.floors.Length == 1 ? building.floors[0].id
                : zone == zoneId ? floorId
                : building?.floors != null && building.floors.Length > 0 ? building.floors[0].id
                : zone;
            zonePackages[zone] = new ZonePackage
            {
                directory = directory,
                scan = scan,
                graph = scan != null || building != null ? Pathfinding.Build(scan, building, zoneFloorId) : null
            };
        }

        ResolveDisplayLayouts(connections);
        var zoneGraphs = new Dictionary<string, Pathfinding.Graph>();
        foreach (var pair in zonePackages)
            if (pair.Value.graph != null) zoneGraphs[pair.Key] = pair.Value.graph;
        navigationGraph = zoneGraphs.Count > 0 ? Pathfinding.Combine(zoneGraphs, connections) : null;
        navigationLoaded = true;
        Debug.Log($"[Gnarly] Navigation zones loaded: {string.Join(", ", zonePackages.Keys)}; " +
                  $"{connections?.connections.Length ?? 0} zone connection(s).");
    }

    void LoadBuildingLayout()
    {
        buildingLayout.Clear();
        // Firebase places this alongside the selected zone package. A bundled version is also
        // supported for offline test packages.
        var layoutPath = packageDirectory != null
            ? Path.Combine(packageDirectory, "building-layout.json")
            : Path.Combine(Application.streamingAssetsPath, "building-layout.json");
        if (!File.Exists(layoutPath)) return;
        try
        {
            var document = JsonUtility.FromJson<BuildingLayoutDocument>(File.ReadAllText(layoutPath));
            if (document?.zones == null) return;
            foreach (var layout in document.zones)
                if (layout != null && !string.IsNullOrEmpty(layout.zoneId)) buildingLayout[layout.zoneId] = layout;
            Debug.Log($"[Gnarly] Loaded authored map layout for {buildingLayout.Count} zone(s).");
        }
        catch (Exception exception)
        {
            Debug.LogWarning($"[Gnarly] Couldn't read building-layout.json: {exception.Message}");
        }
    }

    /// <summary>
    /// Mirrors the website's continuation alignment fallback. Authored layout positions win;
    /// unplaced scans inherit a same-floor position by matching their continuation anchors.
    /// This only affects the full-screen map presentation, never ARKit coordinates.
    /// </summary>
    void ResolveDisplayLayouts(Pathfinding.ZoneConnections connections)
    {
        if (zonePackages.Count == 0) return;
        if (!buildingLayout.ContainsKey(currentZoneId) && zonePackages.ContainsKey(currentZoneId))
            buildingLayout[currentZoneId] = new ZoneLayout
            {
                zoneId = currentZoneId,
                floor = GuessDisplayFloor(currentZoneId),
                x = 0f,
                z = 0f,
                rotationDegrees = 0f
            };

        if (connections?.connections != null)
        {
            for (var changed = true; changed;)
            {
                changed = false;
                foreach (var connection in connections.connections)
                {
                    if (!TryContinuationPair(connection, out var from, out var to)) continue;
                    var fromPlaced = buildingLayout.TryGetValue(connection.from.zoneId, out var fromLayout);
                    var toPlaced = buildingLayout.TryGetValue(connection.to.zoneId, out var toLayout);
                    if (fromPlaced == toPlaced) continue;

                    var placedNode = fromPlaced ? from : to;
                    var missingNode = fromPlaced ? to : from;
                    var placedLayout = fromPlaced ? fromLayout : toLayout;
                    var missingZone = fromPlaced ? connection.to.zoneId : connection.from.zoneId;
                    var target = DisplayArkitPosition(placedNode.position, placedLayout);
                    // With one connector the web keeps the missing scan's rotation at zero and solves
                    // translation. A later authored edit may refine that rotation.
                    buildingLayout[missingZone] = new ZoneLayout
                    {
                        zoneId = missingZone,
                        floor = placedLayout.floor,
                        x = target.x - missingNode.position[0],
                        z = target.z - missingNode.position[2],
                        rotationDegrees = 0f
                    };
                    changed = true;
                }
            }
        }

        // A layout is presentation data, not routing data. Do not make a valid downloaded
        // elevator destination disappear simply because its placement has not been saved yet.
        // Put unknown zones on distinct cards/floors until the website supplies their final
        // placement. This never affects ARKit coordinates or route costs.
        var fallbackIndex = 0;
        foreach (var zone in zonePackages.Keys)
        {
            if (buildingLayout.ContainsKey(zone)) continue;
            var floor = GuessDisplayFloor(zone);
            buildingLayout[zone] = new ZoneLayout
            {
                zoneId = zone,
                floor = floor,
                x = (fallbackIndex % 3) * 28f,
                z = (fallbackIndex / 3) * 28f,
                rotationDegrees = 0f
            };
            fallbackIndex++;
        }
    }

    bool TryContinuationPair(Pathfinding.ZoneConnection connection, out Pathfinding.Node from, out Pathfinding.Node to)
    {
        from = to = null;
        if (connection == null || (connection.kind != "continuation" && !string.IsNullOrEmpty(connection.kind))) return false;
        if (!zonePackages.TryGetValue(connection.from.zoneId, out var fromPackage) ||
            !zonePackages.TryGetValue(connection.to.zoneId, out var toPackage)) return false;
        from = fromPackage.graph?.Node(connection.from.nodeId);
        to = toPackage.graph?.Node(connection.to.nodeId);
        return Pathfinding.IsContinuation(from) && Pathfinding.IsContinuation(to) &&
            from.position?.Length == 3 && to.position?.Length == 3;
    }

    static Vector3 DisplayArkitPosition(float[] position, ZoneLayout layout)
    {
        var radians = layout.rotationDegrees * Mathf.Deg2Rad;
        var cos = Mathf.Cos(radians);
        var sin = Mathf.Sin(radians);
        return new Vector3(
            position[0] * cos + position[2] * sin + layout.x,
            position[1] + layout.floor * DisplayFloorSpacingMeters,
            -position[0] * sin + position[2] * cos + layout.z);
    }

    int GuessDisplayFloor(string zone)
    {
        if (!zonePackages.TryGetValue(zone, out var package)) return 0;
        return package.graph?.story ?? 0;
    }

    void LoadAndApplyZoneMap()
    {
        try
        {
            if (!navigationLoaded) LoadNavigationData();
            if (!zonePackages.TryGetValue(currentZoneId, out var package))
                throw new DirectoryNotFoundException($"No navigation package for zone '{currentZoneId}'.");

            var anchorPath = Path.Combine(package.directory, "test-anchor.json");
            anchor = File.Exists(anchorPath)
                ? TestAnchor.Parse(File.ReadAllText(anchorPath), currentZoneId)
                : null;
            var routePath = Path.Combine(package.directory, "route.json");
            fallbackRoute = File.Exists(routePath) ? Route.Parse(File.ReadAllText(routePath), currentZoneId) : null;
            Pathfinding.SnapToFloor(fallbackRoute, package.graph);

            if (!skipWorldMap)
                ApplyWorldMap(File.ReadAllBytes(Path.Combine(package.directory, $"worldmap-{currentZoneId}.bin")));
            sawRelocalizing = false;
            lastTrackingSnapshot = null;
            normalTrackingStartedAt = -1f;
            state = State.Locating;
            SetStatus(zonePackages.Count > 1
                ? $"Locating in {currentZoneId}… Look around the scanned area."
                : "Locating… Look around the scanned area.");
            ReportTrackingState(force: true);
        }
        catch (Exception e)
        {
            Fail(e.Message);
        }
    }

    void ApplyWorldMap(byte[] mapBytes)
    {
#if UNITY_IOS && !UNITY_EDITOR
        if (!ARKitSessionSubsystem.worldMapSupported)
            throw new InvalidOperationException("ARWorldMap is not supported on this device.");
        if (session.subsystem is not ARKitSessionSubsystem arkit)
            throw new InvalidOperationException("The ARKit session subsystem is not running.");

        using var data = new NativeArray<byte>(mapBytes, Allocator.Temp);
        if (!ARWorldMap.TryDeserialize(data, out var worldMap))
            throw new InvalidOperationException("Unity could not deserialize the mapper's ARWorldMap. A native bridge is required.");
        if (!worldMap.valid)
        {
            worldMap.Dispose();
            throw new InvalidOperationException("The deserialized ARWorldMap is invalid.");
        }

        Debug.Log($"[Gnarly] Applying {mapBytes.Length}-byte world map for {currentZoneId}.");
        arkit.ApplyWorldMap(worldMap);
        DisposeWorldMap();
        appliedWorldMap = worldMap;
#else
        throw new PlatformNotSupportedException($"Loaded {mapBytes.Length}-byte map, but ARWorldMap can only be applied on an iOS device.");
#endif
    }

    void OnDestroy() => DisposeWorldMap();

    void DisposeWorldMap()
    {
#if UNITY_IOS && !UNITY_EDITOR
        appliedWorldMap?.Dispose();
        appliedWorldMap = null;
#endif
    }

    void OnLocated()
    {
        if (anchor != null) PlaceCube();
        state = State.Located;
        lidarView?.ClearPoints();
        // Construct the map UI only after ARKit has accepted the saved world map. Creating a
        // second camera/render texture while ApplyWorldMap is starting can delay relocalization.
        var zone = zonePackages[currentZoneId];
        indoorMap?.Configure(zone.scan, zone.graph, origin.TrackablesParent, origin.Camera, SurfaceColors.Load(zone.directory));
        if (buildingLayout.TryGetValue(currentZoneId, out var currentLayout))
            indoorMap?.SetPlannerCurrentZoneTransform(
                new Vector3(currentLayout.x, currentLayout.floor * DisplayFloorSpacingMeters, -currentLayout.z),
                -currentLayout.rotationDegrees);
        else
            indoorMap?.SetPlannerCurrentZoneTransform(Vector3.zero, 0f);
        indoorMap?.SetBuildingZones(BuildBuildingMapZones());
        indoorMap?.SetPackagePaths(
            Path.Combine(zone.directory, "structure.usdz"),
            Path.Combine(zone.directory, "building.json"),
            Path.Combine(zone.directory, "scan-features.json"));

        // A start chosen in a previous zone can't be used here: you are physically in this zone now.
        if (selectedStartKey != null && navigationGraph?.Node(selectedStartKey)?.zone != currentZoneId)
            selectedStartKey = null;
        indoorMap?.SetPlaces(currentZoneId, BuildPlaces());
        indoorMap?.SetSelection(selectedStartKey, selectedDestinationKey);
        indoorMap?.SetNavigationActive(activeLegs != null);

        if (activeLegs != null)
        {
            BeginLeg();
            return;
        }

        if (navigationGraph != null && navigationGraph.Nodes.Count >= 2)
        {
            var destinations = navigationGraph.Destinations();
            if (destinations.Count == 0 && fallbackRoute != null && navigator != null)
            {
                navigator.Begin(GuidanceRoute(fallbackRoute), origin.TrackablesParent, origin.Camera);
                indoorMap?.SetRoute(fallbackRoute);
                return;
            }
            if (destinations.Count == 1 && selectedDestinationKey == null)
            {
                selectedDestinationKey = destinations[0].id;
                indoorMap?.SetSelection(selectedStartKey, selectedDestinationKey);
            }
            SetStatus("Located. Choose where to go on the map.");
            indoorMap?.OpenPlanner(true);
        }
        else if (fallbackRoute != null && navigator != null)
        {
            navigator.Begin(GuidanceRoute(fallbackRoute), origin.TrackablesParent, origin.Camera);
            indoorMap?.SetRoute(fallbackRoute);
        }
        else
            SetStatus(fallbackRoute == null ? "Located (no graph or route.json)" : "Located");
    }

    void PlaceCube()
    {
        if (cube == null)
        {
            cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
            cube.name = "TestAnchorCube";
            cube.transform.localScale = Vector3.one * cubeSize;
            Destroy(cube.GetComponent<Collider>());
        }

        cube.transform.SetParent(origin.TrackablesParent, false);
        cube.transform.localPosition = anchor.ToUnitySessionSpace();
        cube.transform.localRotation = Quaternion.identity;
        Debug.Log($"[Gnarly] Placed cube at session-space {cube.transform.localPosition}.");
    }

    Vector3 CameraArkitPosition()
    {
        var session = origin.TrackablesParent.InverseTransformPoint(origin.Camera.transform.position);
        return new Vector3(session.x, session.y, -session.z);
    }

    /// <summary>Called by the native iPhone map after the user chooses map markers. An empty start means "my location".</summary>
    public void OnIndoorMapRouteRequested(string requestJson)
    {
        try
        {
            var request = JsonUtility.FromJson<IndoorMapRouteRequest>(requestJson);
            if (request == null || string.IsNullOrEmpty(request.destinationId))
                throw new FormatException("The map route request did not contain a destination node ID.");

            var startId = string.IsNullOrEmpty(request.startId) ? null : ResolveCurrentZoneNode(request.startId);
            var destinationId = ResolveCurrentZoneNode(request.destinationId);
            if ((startId == null && !string.IsNullOrEmpty(request.startId)) || destinationId == null)
                throw new KeyNotFoundException(
                    $"The selected map node is not in the navigation graph ({request.startId} -> {request.destinationId}).");

            BeginRoute(startId, destinationId);
        }
        catch (Exception exception)
        {
            Debug.LogError($"[Gnarly] Interactive map route selection failed: {exception}");
            var message = "Could not create the selected map route: " + exception.Message;
            indoorMap?.SetExpandedStatus(message);
            SetStatus(message);
        }
    }

    string ResolveCurrentZoneNode(string nodeId)
    {
        if (navigationGraph == null) return null;
        var zoneKey = Pathfinding.ZoneKey(currentZoneId, nodeId);
        if (navigationGraph.Node(zoneKey) != null) return zoneKey;
        return navigationGraph.Node(nodeId) != null ? nodeId : null;
    }

    /// <summary>Starts AR navigation. A null start means the graph node nearest to the user.</summary>
    void BeginRoute(string startKey, string destinationKey)
    {
        if (navigationGraph == null || navigator == null) return;

        if (!TryPlan(startKey, destinationKey, out var path, out var error))
        {
            indoorMap?.SetExpandedStatus(error);
            SetStatus(error);
            return;
        }

        selectedStartKey = startKey;
        selectedDestinationKey = destinationKey;
        automaticRouteStartPosition = startKey == null ? CameraArkitPosition() : null;
        indoorMap?.SetSelection(startKey, destinationKey);
        indoorMap?.SetNavigationActive(true);
        arrivalAnnounced = false;
        if (arrivalPanel != null) arrivalPanel.gameObject.SetActive(false);

        activeLegs = Pathfinding.SplitByZone(navigationGraph, path);
        activeLegIndex = 0;
        if (transitionPanel != null) transitionPanel.gameObject.SetActive(false);
        Debug.Log($"[Gnarly] A* {string.Join(" -> ", path)} ({activeLegs.Count} zone leg(s))");
        BeginLeg();
    }

    void OnPlannerSelectionChanged(string startKey, string destinationKey)
    {
        indoorMap?.ShowPreview(PreviewRoute(startKey, destinationKey));
    }

    bool TryPlan(string startKey, string destinationKey, out List<string> path, out string error)
    {
        path = null;
        error = null;
        if (navigationGraph == null)
        {
            error = "This map has no navigation graph yet.";
            return false;
        }
        if (destinationKey == null || navigationGraph.Node(destinationKey) == null)
        {
            error = "Pick a destination on the map.";
            return false;
        }

        string startId;
        if (startKey == null)
        {
            var currentPosition = CameraArkitPosition();
            var candidates = navigationGraph.NearestRecordedWalkEndpoints(currentPosition, currentZoneId);
            if (candidates.Count == 0)
                candidates.Add(navigationGraph.NearestNodeId(currentPosition, currentZoneId));
            // The website lets a visitor begin from wherever they are in a zone. A camera pose
            // can briefly contain non-finite values immediately after relocalization, so never
            // turn that transient pose into "this zone has no navigation points". Fall back to
            // every graph node in the localized zone and let A* select a reachable start.
            if (candidates.Count == 0 || candidates.TrueForAll(string.IsNullOrEmpty))
                foreach (var node in navigationGraph.Nodes)
                    if (node.zone == currentZoneId) candidates.Add(node.id);

            var bestCost = float.MaxValue;
            List<string> bestPath = null;
            startId = null;
            foreach (var candidate in candidates)
            {
                if (string.IsNullOrEmpty(candidate)) continue;
                var candidatePath = Pathfinding.AStar(navigationGraph, candidate, destinationKey);
                if (candidatePath == null) continue;
                var distanceToCandidate = IsFinite(currentPosition)
                    ? HorizontalDistance(currentPosition, Pathfinding.Position(navigationGraph.Node(candidate)))
                    : 0f;
                var cost = distanceToCandidate + PathMeters(candidatePath);
                if (cost >= bestCost) continue;
                bestCost = cost;
                startId = candidate;
                bestPath = candidatePath;
            }
            // The closest recorded segment can belong to a disconnected draft fragment. If it
            // does, try the rest of this zone before declaring the selected destination unroutable.
            if (startId == null)
            {
                foreach (var node in navigationGraph.Nodes)
                {
                    if (node.zone != currentZoneId) continue;
                    var candidatePath = Pathfinding.AStar(navigationGraph, node.id, destinationKey);
                    if (candidatePath == null) continue;
                    var distanceToCandidate = IsFinite(currentPosition)
                        ? HorizontalDistance(currentPosition, Pathfinding.Position(node))
                        : 0f;
                    var cost = distanceToCandidate + PathMeters(candidatePath);
                    if (cost >= bestCost) continue;
                    bestCost = cost;
                    startId = node.id;
                    bestPath = candidatePath;
                }
            }
            if (startId == null)
            {
                error = $"No connected route from {currentZoneId} to that destination.{UnreachableZoneHint(destinationKey)}";
                return false;
            }

            path = bestPath;
        }
        else
        {
            var start = navigationGraph.Node(startKey);
            if (start == null)
            {
                error = "That start point is no longer in the map.";
                return false;
            }
            if (start.zone != currentZoneId)
            {
                error = $"The start must be in {currentZoneId}, where you are now.";
                return false;
            }
            startId = startKey;
        }

        if (startId == destinationKey)
        {
            error = startKey == null
                ? $"You're already at {NameOf(destinationKey)}."
                : "Start and destination are the same place. Choose two different points.";
            return false;
        }

        if (path == null)
            path = Pathfinding.AStar(navigationGraph, startId, destinationKey);
        if (path == null)
        {
            error = $"No walkable path from {(startKey == null ? "your location" : NameOf(startKey))} to {NameOf(destinationKey)}. Try another point.{UnreachableZoneHint(destinationKey)}";
            return false;
        }
        return true;
    }

    /// <summary>Explains a cross-zone failure: the destination's zone has no usable link, or its connector is cut off.</summary>
    string UnreachableZoneHint(string destinationKey)
    {
        var destinationZone = navigationGraph?.Node(destinationKey)?.zone;
        if (destinationZone == null || destinationZone == currentZoneId) return "";
        string linked = null;
        foreach (var node in navigationGraph.Nodes)
        {
            if (node.zone != destinationZone || (!Pathfinding.IsElevator(node) && !Pathfinding.IsContinuation(node))) continue;
            foreach (var edge in navigationGraph.Neighbors(node.id))
            {
                if (navigationGraph.Node(edge.to)?.zone == destinationZone) continue;
                linked = node.id;
                break;
            }
            if (linked != null) break;
        }
        var message = linked == null
            ? $" {destinationZone} has no elevator or continuation linked to this building's other zones."
            : $" {destinationZone} is linked through {NameOf(linked)}, but an elevator or connector is cut off from the walkable path on one of the floors. Connect each to a walkable waypoint on the website.";
        Debug.LogWarning("[Gnarly] Route to " + destinationKey + " failed." + message);
        return message;
    }

    float PathMeters(List<string> nodeIds)
    {
        var meters = 0f;
        for (var i = 1; i < nodeIds.Count; i++)
            meters += EdgeMeters(nodeIds[i - 1], nodeIds[i]);
        return meters;
    }

    float EdgeMeters(string from, string to)
    {
        foreach (var edge in navigationGraph.Neighbors(from))
            if (edge.to == to) return edge.meters;
        return 0f;
    }

    /// <summary>True when leg <paramref name="index"/> ends at an elevator that carries the user to the next leg's floor.</summary>
    bool IsElevatorRide(List<Pathfinding.RouteLeg> legs, int index)
    {
        if (legs == null || index < 0 || index >= legs.Count - 1) return false;
        var leg = legs[index];
        return Pathfinding.IsElevator(navigationGraph.Node(leg.nodeIds[leg.nodeIds.Count - 1])) &&
               Pathfinding.IsElevator(navigationGraph.Node(legs[index + 1].nodeIds[0]));
    }

    string ConnectorName(Pathfinding.RouteLeg leg)
    {
        var connector = navigationGraph.Node(leg.nodeIds[leg.nodeIds.Count - 1]);
        if (placeNames.TryGetValue(connector.id, out var name)) return name;
        return string.IsNullOrEmpty(connector.label) ? Humanize(connector.localId) : connector.label;
    }

    static string FloorName(string zone) => Humanize(zone);

    /// <summary>"up" or "down" when both floors have known stories, otherwise null.</summary>
    string RideDirection(string fromZone, string toZone)
    {
        if (!navigationGraph.ZoneStories.TryGetValue(fromZone, out var from) ||
            !navigationGraph.ZoneStories.TryGetValue(toZone, out var to) || from == to)
            return null;
        return to > from ? "up" : "down";
    }

    RoutePreview PreviewRoute(string startKey, string destinationKey)
    {
        if (!TryPlan(startKey, destinationKey, out var path, out var error))
            return new RoutePreview { ok = false, error = error };

        var legs = Pathfinding.SplitByZone(navigationGraph, path);
        var meters = 0f;
        var rideMeters = 0f;
        if (startKey == null) meters += HorizontalDistance(CameraArkitPosition(), Pathfinding.Position(navigationGraph.Node(path[0])));
        for (var i = 1; i < path.Count; i++)
        {
            var a = navigationGraph.Node(path[i - 1]);
            var b = navigationGraph.Node(path[i]);
            if (a.zone == b.zone) meters += HorizontalDistance(Pathfinding.Position(a), Pathfinding.Position(b));
            else if (Pathfinding.IsElevator(a) && Pathfinding.IsElevator(b)) rideMeters += EdgeMeters(a.id, b.id);
        }

        Route mapRoute = null;
        string waypointKey = null;
        var exitLeg = -1;
        for (var legIndex = 0; legIndex < legs.Count; legIndex++)
        {
            if (legs[legIndex].zoneId != currentZoneId) continue;
            mapRoute = LegRoute(legs[legIndex]);
            waypointKey = Pathfinding.ZoneExitWaypoint(navigationGraph, legs, legIndex);
            exitLeg = legIndex;
            break;
        }

        var minutes = Mathf.CeilToInt((meters + rideMeters) / 1.2f / 60f);
        var summary = $"{meters:0} m  ·  {(minutes <= 1 ? "about 1 min" : $"{minutes} min")}{(rideMeters > 0f ? "" : " walk")}";
        string details;
        if (legs.Count > 1)
        {
            var steps = new List<string>();
            var rides = 0;
            for (var i = 0; i < legs.Count - 1; i++)
            {
                if (IsElevatorRide(legs, i))
                {
                    rides++;
                    steps.Add($"{ConnectorName(legs[i])} to {FloorName(legs[i + 1].zoneId)}");
                }
                else
                {
                    steps.Add($"{ConnectorName(legs[i])} into {FloorName(legs[i + 1].zoneId)}");
                }
            }
            var changes = legs.Count - 1;
            summary += rides == changes
                ? $"  ·  {rides} elevator ride{(rides > 1 ? "s" : "")}"
                : $"  ·  {changes} zone change{(changes > 1 ? "s" : "")}";
            var lead = waypointKey == null
                ? ""
                : IsElevatorRide(legs, exitLeg)
                    ? $"Walk to {NameOf(waypointKey)}. That elevator is the waypoint onto the next floor. "
                    : $"Walk to {NameOf(waypointKey)}. That point continues into the next part of this floor. ";
            details = lead + "Continue via " + string.Join(", then ", steps) + ". You'll confirm each zone on arrival.";
        }
        else
        {
            details = $"From {(startKey == null ? "your location" : NameOf(startKey))} to {NameOf(destinationKey)}  ·  {path.Count} waypoints";
        }
        return new RoutePreview { ok = true, mapRoute = mapRoute, waypointKey = waypointKey, summary = summary, details = details };
    }

    static float HorizontalDistance(Vector3 a, Vector3 b) => Vector2.Distance(new Vector2(a.x, a.z), new Vector2(b.x, b.z));

    static bool IsFinite(Vector3 value) =>
        !float.IsNaN(value.x) && !float.IsNaN(value.y) && !float.IsNaN(value.z) &&
        !float.IsInfinity(value.x) && !float.IsInfinity(value.y) && !float.IsInfinity(value.z);

    string NameOf(string key)
    {
        if (key != null && placeNames.TryGetValue(key, out var name)) return name;
        return string.IsNullOrEmpty(key) ? "the destination" : key;
    }

    /// <summary>Every graph node as a selectable place, with readable names (e.g. "Living room", "Door 2").</summary>
    List<MapPlace> BuildPlaces()
    {
        var places = new List<MapPlace>();
        placeNames.Clear();
        if (navigationGraph == null) return places;

        var counters = new Dictionary<string, int>();
        foreach (var node in navigationGraph.Nodes)
        {
            var kind = PlaceKind(node);
            var name = PlaceName(node, kind, counters);
            var inCurrentZone = node.zone == currentZoneId;
            places.Add(new MapPlace
            {
                key = node.id,
                localId = node.localId,
                zone = node.zone,
                name = name,
                kind = kind,
                major = kind is "destination" or "entrance" or "room" or "elevator" or "continuation" or "stairs" ||
                        (kind == "waypoint" && !string.IsNullOrEmpty(node.label)),
                inCurrentZone = inCurrentZone,
                sessionPosition = inCurrentZone && node.position != null && node.position.Length == 3
                    ? new Vector3(node.position[0], node.position[1], -node.position[2])
                    : Vector3.zero,
                plannerPosition = PlannerPosition(node, node.zone),
                // Remote zones are only safe to draw in the shared picker when the website has
                // authored their placement. Their native ARKit coordinates are otherwise unrelated.
                hasPlannerPosition = node.position != null && node.position.Length == 3 &&
                    (node.zone == currentZoneId || buildingLayout.ContainsKey(node.zone))
            });
            placeNames[node.id] = name;
        }
        return places;
    }

    Vector3 PlannerPosition(Pathfinding.Node node, string nodeZone)
    {
        if (node.position == null || node.position.Length != 3) return Vector3.zero;
        var local = new Vector3(node.position[0], node.position[1], -node.position[2]);
        if (!buildingLayout.TryGetValue(nodeZone, out var layout)) return local;
        // The web editor operates in ARKit X/Z. Unity's imported map mirrors Z, which also
        // mirrors the authored Y-axis rotation.
        var rotated = Quaternion.Euler(0f, -layout.rotationDegrees, 0f) * local;
        return new Vector3(rotated.x + layout.x, rotated.y + layout.floor * DisplayFloorSpacingMeters, rotated.z - layout.z);
    }

    List<BuildingMapZone> BuildBuildingMapZones()
    {
        var result = new List<BuildingMapZone>();
        foreach (var pair in zonePackages)
        {
            // A remote ARKit scan has arbitrary local coordinates. Only show it in the shared
            // map after the website has authored where it belongs in the building.
            if (pair.Key != currentZoneId && !buildingLayout.ContainsKey(pair.Key)) continue;
            var layout = buildingLayout.TryGetValue(pair.Key, out var authored) ? authored : null;
            result.Add(new BuildingMapZone
            {
                id = pair.Key,
                scan = pair.Value.scan,
                graph = pair.Value.graph,
                plannerOffset = layout == null
                    ? Vector3.zero
                    : new Vector3(layout.x, layout.floor * DisplayFloorSpacingMeters, -layout.z),
                plannerRotationDegrees = layout == null ? 0f : -layout.rotationDegrees,
                colors = SurfaceColors.Load(pair.Value.directory)
            });
        }
        return result;
    }

    static string PlaceKind(Pathfinding.Node node)
    {
        switch (node.type)
        {
            case "destination":
            case "entrance":
            case "elevator":
            case "continuation":
            case "stairs":
            case "door":
            case "opening":
                return node.type;
        }
        return node.localId != null && node.localId.StartsWith("section-", StringComparison.Ordinal) ? "room" : "waypoint";
    }

    static string PlaceName(Pathfinding.Node node, string kind, Dictionary<string, int> counters)
    {
        string Numbered(string baseName)
        {
            var counterKey = node.zone + "/" + baseName;
            counters.TryGetValue(counterKey, out var count);
            counters[counterKey] = ++count;
            return count == 1 ? baseName : $"{baseName} {count}";
        }

        switch (kind)
        {
            case "door": return Numbered("Door");
            case "opening": return Numbered("Opening");
            case "room": return Numbered(Humanize(node.label ?? node.localId.Substring("section-".Length)));
            case "elevator":
                return Numbered(string.IsNullOrEmpty(node.label) ? "Elevator" : node.label);
            case "stairs":
                return Numbered(string.IsNullOrEmpty(node.label) || node.label == "stairs" ? "Stairs" : node.label);
            default:
                return !string.IsNullOrEmpty(node.label) ? node.label : Numbered(Humanize(node.localId ?? node.id));
        }
    }

    /// <summary>"livingRoom" → "Living room", "front_door" → "Front door".</summary>
    static string Humanize(string raw)
    {
        if (string.IsNullOrEmpty(raw)) return "Point";
        var builder = new System.Text.StringBuilder();
        for (var i = 0; i < raw.Length; i++)
        {
            var c = raw[i];
            if (c == '-' || c == '_')
            {
                builder.Append(' ');
                continue;
            }
            if (char.IsUpper(c) && i > 0 && char.IsLower(raw[i - 1])) builder.Append(' ');
            builder.Append(builder.Length == 0 ? char.ToUpperInvariant(c) : char.ToLowerInvariant(c));
        }
        return builder.ToString().Trim();
    }

    /// <summary>Draws the active leg; positions are only valid inside the zone whose map is applied.</summary>
    void BeginLeg()
    {
        var leg = activeLegs[activeLegIndex];
        if (leg.zoneId != currentZoneId)
        {
            SwitchZone(leg.zoneId);
            return;
        }

        var route = LegRoute(leg);
        if (activeLegIndex == 0 && automaticRouteStartPosition.HasValue)
            route = PrependAutomaticStart(route, automaticRouteStartPosition.Value);
        navigator.Begin(GuidanceRoute(route), origin.TrackablesParent, origin.Camera);
        indoorMap?.SetRoute(route);
        ShowFloorWaypoint();
        SetStatus(LegStatus());
    }

    Route GuidanceRoute(Route route) => Pathfinding.DensifyRoute(route, guidanceWaypointSpacingMeters);

    /// <summary>One zone leg as a route, with small recorded-walk wobbles straightened.</summary>
    Route LegRoute(Pathfinding.RouteLeg leg)
    {
        var route = Pathfinding.ToRoute(navigationGraph, leg.nodeIds, leg.zoneId);
        var walls = zonePackages.TryGetValue(leg.zoneId, out var package) ? package.graph?.Walls : null;
        return Pathfinding.SimplifyRoute(route, navigationGraph, walls, routeSmoothingMeters);
    }

    static Route PrependAutomaticStart(Route route, Vector3 arkitPosition)
    {
        if (route?.waypoints == null || route.waypoints.Length == 0) return route;
        var waypoints = new Route.Waypoint[route.waypoints.Length + 1];
        // Keep the guidance polyline on the map's established floor height; only X/Z come from
        // the live camera pose.
        waypoints[0] = new Route.Waypoint
        {
            id = Route.GuidanceWaypointPrefix + "live-start",
            position = new[] { arkitPosition.x, route.waypoints[0].position[1], arkitPosition.z }
        };
        Array.Copy(route.waypoints, 0, waypoints, 1, route.waypoints.Length);
        return new Route
        {
            schemaVersion = route.schemaVersion,
            zoneId = route.zoneId,
            coordinateSystem = route.coordinateSystem,
            heightReference = route.heightReference,
            waypoints = waypoints
        };
    }

    /// <summary>
    /// On this zone's map the route ends at the connector when the destination is in another zone:
    /// the elevator for another floor, or the continuation for another scan of the same space.
    /// That connector is the waypoint the minimap leads to.
    /// </summary>
    void ShowFloorWaypoint()
    {
        var connector = Pathfinding.ZoneExitWaypoint(navigationGraph, activeLegs, activeLegIndex);
        indoorMap?.SetFloorWaypoint(connector);
        if (connector != null)
            indoorMap?.SetCompactCaption($"TO {ConnectorName(activeLegs[activeLegIndex]).ToUpperInvariant()}  ·  THEN {NameOf(selectedDestinationKey).ToUpperInvariant()}");
        else if (selectedDestinationKey != null)
            indoorMap?.SetCompactCaption($"TO {NameOf(selectedDestinationKey).ToUpperInvariant()}  ·  TAP TO CHANGE");
    }

    string LegStatus()
    {
        if (activeLegs == null || activeLegIndex >= activeLegs.Count - 1) return navigator.StatusMessage;
        var connectorName = ConnectorName(activeLegs[activeLegIndex]);
        var nextFloor = FloorName(activeLegs[activeLegIndex + 1].zoneId);
        return IsElevatorRide(activeLegs, activeLegIndex)
            ? $"{navigator.StatusMessage} to {connectorName}, then ride it to {nextFloor}"
            : $"{navigator.StatusMessage} to {connectorName}, then continue to {nextFloor}";
    }

    void AwaitZoneTransition()
    {
        var nextZone = activeLegs[activeLegIndex + 1].zoneId;
        var nextFloor = FloorName(nextZone);
        var connectorName = ConnectorName(activeLegs[activeLegIndex]);
        state = State.AwaitingZoneTransition;
        navigator.SetVisible(false);
        if (IsElevatorRide(activeLegs, activeLegIndex))
        {
            var direction = RideDirection(currentZoneId, nextZone);
            var ride = direction == null ? $"to {nextFloor}" : $"{direction} to {nextFloor}";
            if (transitionHeading != null) transitionHeading.text = $"Take the elevator {ride}";
            if (transitionInstructions != null)
                transitionInstructions.text = $"You've reached {connectorName}. Ride it {ride}. When you step out, tap below and look around so we can find you on {nextFloor}.";
            if (transitionButtonLabel != null) transitionButtonLabel.text = $"I'm on {nextFloor}";
            SetStatus($"At {connectorName}. Ride {ride}, then confirm below.");
        }
        else
        {
            if (transitionHeading != null) transitionHeading.text = $"Continue to {nextFloor}";
            if (transitionInstructions != null)
                transitionInstructions.text = $"You've reached {connectorName}. Continue to {nextFloor}. When you're there, load its map and look around to locate yourself.";
            if (transitionButtonLabel != null) transitionButtonLabel.text = $"I'm at {nextFloor}";
            SetStatus($"At {connectorName}. Continue to {nextFloor}, then confirm below.");
        }
        if (transitionPanel != null) transitionPanel.gameObject.SetActive(true);
        Debug.Log($"[Gnarly] Waiting at connector {currentZoneId} -> {nextZone} for the user to enter the next zone.");
    }

    void ConfirmZoneTransition()
    {
        if (state != State.AwaitingZoneTransition || activeLegs == null || activeLegIndex >= activeLegs.Count - 1)
            return;
        var nextZone = activeLegs[activeLegIndex + 1].zoneId;
        if (!zonePackages.ContainsKey(nextZone))
        {
            SetStatus($"Map for {nextZone} is unavailable. Stay in {currentZoneId} and retry the download.");
            return;
        }
        activeLegIndex++;
        if (transitionPanel != null) transitionPanel.gameObject.SetActive(false);
        SwitchZone(nextZone);
    }

    /// <summary>Each zone has its own ARWorldMap, so crossing a connection means relocalizing in the next map.</summary>
    void SwitchZone(string nextZoneId)
    {
        if (!zonePackages.ContainsKey(nextZoneId))
        {
            Fail($"The route continues into zone '{nextZoneId}', but its package is missing.");
            return;
        }

        Debug.Log($"[Gnarly] Switching zone {currentZoneId} -> {nextZoneId}.");
        currentZoneId = nextZoneId;
        ResetSession($"Entering {nextZoneId}. Look around so ARKit can recognize it.");
    }

    /// <summary>Relocalizes in the current zone again; an in-progress multi-zone route resumes afterwards.</summary>
    public void Retry() => ResetSession("Restarting…");

    void ResetSession(string message)
    {
        if (cube != null) Destroy(cube);
        cube = null;
        if (navigator != null) navigator.Clear();
        indoorMap?.Clear();
        lidarView?.ClearPoints();
        if (transitionPanel != null) transitionPanel.gameObject.SetActive(false);
        if (arrivalPanel != null) arrivalPanel.gameObject.SetActive(false);
        state = State.WaitingForSession;
        session.Reset();
        SetStatus(message);
    }

    void OnPackageReady(DownloadedNavigationPackage package, string startKey, string destinationKey)
    {
        buildingId = package.BuildingId;
        zoneId = package.ZoneId;
        currentZoneId = zoneId;
        packageDirectory = package.DirectoryPath;
        navigationLoaded = false;
        activeLegs = null;
        selectedStartKey = startKey;
        selectedDestinationKey = destinationKey;
        state = State.WaitingForSession;
        var source = package.IsOfflineCache ? "offline cache" : "Firebase";
        SetStatus($"Loaded version {package.VersionId} from {source}. Starting camera…");
        Debug.Log($"[Gnarly] Navigation package ready at {packageDirectory}.");
    }

    void Fail(string message)
    {
        state = State.Failed;
        if (transitionPanel != null) transitionPanel.gameObject.SetActive(false);
        if (arrivalPanel != null) arrivalPanel.gameObject.SetActive(false);
        Debug.LogError($"[Gnarly] {message}");
        SetStatus($"Error: {message}");
    }

    void SetStatus(string message)
    {
        if (statusText != null) statusText.text = message;
        if (statusEyebrow != null)
            statusEyebrow.text = activeLegs != null && activeLegs.Count > 0
                ? $"ZONE {currentZoneId}  ·  LEG {activeLegIndex + 1}/{activeLegs.Count}"
                : state == State.Located ? "LOCATION CONFIRMED" : "GNARLY NAVIGATION";
        if (statusIndicator != null)
            statusIndicator.color = StatusColor();
        if (retryBackground != null)
            retryBackground.color = state == State.Failed
                ? new Color(0.7f, 0.18f, 0.2f, 0.96f)
                : new Color(0.05f, 0.12f, 0.18f, 0.92f);
        if (retryButton != null)
            retryButton.gameObject.SetActive(state == State.Locating || state == State.TrackingLost || state == State.Failed);
        if (resetAction != null) resetAction.gameObject.SetActive(state == State.Located);
    }

    void FinishRoute()
    {
        if (arrivalPanel != null) arrivalPanel.gameObject.SetActive(false);
        navigator?.Clear();
        indoorMap?.SetRoute(null);
        indoorMap?.SetNavigationActive(false);
        indoorMap?.SetCompactCaption(null);
        activeLegs = null;
        activeLegIndex = 0;
        selectedStartKey = null;
        selectedDestinationKey = null;
        arrivalAnnounced = false;
        SetStatus("Choose where to go next.");
    }

    void ChooseAnotherDestination()
    {
        FinishRoute();
        indoorMap?.SetSelection(null, null);
        indoorMap?.OpenPlanner(true);
    }

    Color StatusColor()
    {
        return state switch
        {
            State.Located => new Color(0.25f, 0.95f, 0.72f),
            State.AwaitingZoneTransition => new Color(1f, 0.69f, 0.24f),
            State.Failed => new Color(1f, 0.35f, 0.36f),
            State.TrackingLost => new Color(1f, 0.69f, 0.24f),
            _ => new Color(0.25f, 0.85f, 1f)
        };
    }

    /// <summary>
    /// With the phone held upright in portrait, roll should be near 0°. Near ±90° means the AR camera
    /// is rotated against the camera feed, so world-up content (the destination pillar) draws sideways.
    /// </summary>
    void LogCameraPose()
    {
        if (Time.unscaledTime < nextPoseLogAt) return;
        nextPoseLogAt = Time.unscaledTime + 2f;
        var camera = origin.Camera.transform;
        var upInView = Vector3.ProjectOnPlane(Vector3.up, camera.forward);
        var roll = upInView.sqrMagnitude > 1e-4f ? Vector3.SignedAngle(upInView, camera.up, camera.forward) : float.NaN;
        var pitch = 90f - Vector3.Angle(Vector3.up, camera.forward);
        Debug.Log($"[Gnarly] Pose: screen={Screen.orientation} {Screen.width}x{Screen.height}, camera roll={roll:0}° pitch={pitch:0}°, " +
                  $"trackables rotation={origin.TrackablesParent.rotation.eulerAngles}, camera offset={origin.CameraFloorOffsetObject.transform.localPosition}.");
    }

    void ReportTrackingState(bool force = false)
    {
        var snapshot = $"{ARSession.state} / {ARSession.notTrackingReason}";
        if (!force && snapshot == lastTrackingSnapshot) return;
        lastTrackingSnapshot = snapshot;
        Debug.Log($"[Gnarly] ARKit tracking state: {snapshot}; sawRelocalizing={sawRelocalizing}.");

        if (state != State.Locating) return;
        if (IsTrackingNormally() && !sawRelocalizing)
        {
            SetStatus($"Locating in {currentZoneId}. Look around the scanned area until your position is confirmed.");
            return;
        }

        SetStatus($"Finding your position in {Humanize(currentZoneId)}. Slowly look around the scanned area.");
    }

    void BuildUi()
    {
        var canvasObject = new GameObject("StatusCanvas", typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
        var statusCanvas = canvasObject.GetComponent<Canvas>();
        statusCanvas.renderMode = RenderMode.ScreenSpaceOverlay;
        statusCanvas.sortingOrder = 17;
        var scaler = canvasObject.GetComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = new Vector2(1170, 2532);
        var safeRoot = CreateRect("SafeArea", canvasObject.transform, Vector2.zero, Vector2.one, Vector2.zero, Vector2.zero);
        safeRoot.gameObject.AddComponent<SafeAreaPanel>();

        var font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");

        var panel = CreateRect("StatusPanel", safeRoot, new Vector2(0, 1), new Vector2(1, 1), new Vector2(22, -218), new Vector2(-22, -12));
        MapUi.Panel(panel, new Color(0.025f, 0.06f, 0.1f, 0.9f), 32f);

        statusIndicator = CreateRect("StatusIndicator", panel, new Vector2(0, 0.5f), new Vector2(0, 0.5f), new Vector2(26, -11), new Vector2(48, 11)).gameObject.AddComponent<Image>();
        statusIndicator.color = StatusColor();

        statusEyebrow = CreateRect("Eyebrow", panel, new Vector2(0, 1), new Vector2(1, 1), new Vector2(64, -57), new Vector2(-172, -16)).gameObject.AddComponent<Text>();
        statusEyebrow.font = font;
        statusEyebrow.fontSize = 24;
        statusEyebrow.fontStyle = FontStyle.Bold;
        statusEyebrow.alignment = TextAnchor.MiddleLeft;
        statusEyebrow.color = new Color(0.44f, 0.78f, 0.92f);
        statusEyebrow.text = "GNARLY NAVIGATION";

        resetAction = CreateRect("ResetAction", panel, new Vector2(1, 1), new Vector2(1, 1), new Vector2(-150, -68), new Vector2(-16, -16));
        MapUi.Panel(resetAction, new Color(0.2f, 0.29f, 0.38f, 0.94f), 24f, true);
        resetAction.gameObject.AddComponent<Button>().onClick.AddListener(Retry);
        var resetLabel = CreateRect("Label", resetAction, Vector2.zero, Vector2.one, Vector2.zero, Vector2.zero).gameObject.AddComponent<Text>();
        resetLabel.font = font;
        resetLabel.fontSize = 23;
        resetLabel.fontStyle = FontStyle.Bold;
        resetLabel.alignment = TextAnchor.MiddleCenter;
        resetLabel.color = Color.white;
        resetLabel.text = "Relocate";

        statusText = CreateRect("StatusText", panel, Vector2.zero, Vector2.one, new Vector2(64, 8), new Vector2(-28, -76)).gameObject.AddComponent<Text>();
        statusText.font = font;
        statusText.fontSize = 38;
        statusText.alignment = TextAnchor.MiddleLeft;
        statusText.color = Color.white;
        statusText.horizontalOverflow = HorizontalWrapMode.Wrap;
        statusText.resizeTextForBestFit = true;
        statusText.resizeTextMinSize = 25;
        statusText.resizeTextMaxSize = 38;

        var button = CreateRect("RetryButton", safeRoot, new Vector2(0.5f, 0), new Vector2(0.5f, 0), new Vector2(-190, 16), new Vector2(190, 112));
        retryButton = button;
        retryBackground = MapUi.Panel(button, new Color(0.05f, 0.12f, 0.18f, 0.92f), 32f, true);
        button.gameObject.AddComponent<Button>().onClick.AddListener(Retry);

        var label = CreateRect("Label", button, Vector2.zero, Vector2.one, Vector2.zero, Vector2.zero).gameObject.AddComponent<Text>();
        label.font = font;
        label.fontSize = 34;
        label.fontStyle = FontStyle.Bold;
        label.alignment = TextAnchor.MiddleCenter;
        label.color = Color.white;
        label.text = "Try locating again";

        transitionPanel = CreateRect("ZoneTransitionPanel", safeRoot, new Vector2(0, 0.5f), new Vector2(1, 0.5f), new Vector2(24, -245), new Vector2(-24, 245));
        MapUi.Panel(transitionPanel, new Color(0.025f, 0.06f, 0.1f, 0.96f), 40f, true);
        transitionHeading = CreateRect("ZoneTransitionHeading", transitionPanel, new Vector2(0, 1), new Vector2(1, 1), new Vector2(32, -90), new Vector2(-32, -22)).gameObject.AddComponent<Text>();
        transitionHeading.font = font;
        transitionHeading.fontSize = 42;
        transitionHeading.fontStyle = FontStyle.Bold;
        transitionHeading.alignment = TextAnchor.MiddleCenter;
        transitionHeading.color = new Color(0.44f, 0.78f, 0.92f);
        transitionInstructions = CreateRect("ZoneTransitionInstructions", transitionPanel, Vector2.zero, Vector2.one, new Vector2(36, 130), new Vector2(-36, -104)).gameObject.AddComponent<Text>();
        transitionInstructions.font = font;
        transitionInstructions.fontSize = 34;
        transitionInstructions.alignment = TextAnchor.MiddleCenter;
        transitionInstructions.color = Color.white;
        transitionInstructions.resizeTextForBestFit = true;
        transitionInstructions.resizeTextMinSize = 25;
        transitionInstructions.resizeTextMaxSize = 34;
        var transitionButton = CreateRect("ConfirmZoneTransition", transitionPanel, new Vector2(0, 0), new Vector2(1, 0), new Vector2(32, 24), new Vector2(-32, 116));
        MapUi.Panel(transitionButton, new Color(0.1f, 0.37f, 0.83f, 1f), 30f, true);
        transitionButton.gameObject.AddComponent<Button>().onClick.AddListener(ConfirmZoneTransition);
        transitionButtonLabel = CreateRect("Label", transitionButton, Vector2.zero, Vector2.one, Vector2.zero, Vector2.zero).gameObject.AddComponent<Text>();
        transitionButtonLabel.font = font;
        transitionButtonLabel.fontSize = 34;
        transitionButtonLabel.fontStyle = FontStyle.Bold;
        transitionButtonLabel.alignment = TextAnchor.MiddleCenter;
        transitionButtonLabel.color = Color.white;
        transitionPanel.gameObject.SetActive(false);

        arrivalPanel = CreateRect("ArrivalPanel", safeRoot, new Vector2(0, 0), new Vector2(1, 0), new Vector2(24, 22), new Vector2(-24, 410));
        MapUi.Panel(arrivalPanel, new Color(0.97f, 0.98f, 1f, 0.98f), 40f, true);
        var arrivedTitle = CreateRect("ArrivedTitle", arrivalPanel, new Vector2(0, 1), Vector2.one, new Vector2(32, -96), new Vector2(-32, -24)).gameObject.AddComponent<Text>();
        arrivedTitle.font = font;
        arrivedTitle.fontSize = 30;
        arrivedTitle.fontStyle = FontStyle.Bold;
        arrivedTitle.color = new Color(0.1f, 0.44f, 0.82f);
        arrivedTitle.text = "YOU'VE ARRIVED";
        arrivalDestination = CreateRect("Destination", arrivalPanel, new Vector2(0, 1), Vector2.one, new Vector2(32, -180), new Vector2(-32, -96)).gameObject.AddComponent<Text>();
        arrivalDestination.font = font;
        arrivalDestination.fontSize = 44;
        arrivalDestination.fontStyle = FontStyle.Bold;
        arrivalDestination.color = new Color(0.1f, 0.16f, 0.24f);
        arrivalDestination.horizontalOverflow = HorizontalWrapMode.Wrap;
        arrivalDestination.resizeTextForBestFit = true;
        arrivalDestination.resizeTextMinSize = 28;
        arrivalDestination.resizeTextMaxSize = 44;
        var done = CreateRect("Done", arrivalPanel, Vector2.zero, new Vector2(0.5f, 0), new Vector2(28, 24), new Vector2(-8, 116));
        MapUi.Panel(done, new Color(0.87f, 0.91f, 0.96f), 28f, true);
        done.gameObject.AddComponent<Button>().onClick.AddListener(FinishRoute);
        var doneLabel = CreateRect("Label", done, Vector2.zero, Vector2.one, Vector2.zero, Vector2.zero).gameObject.AddComponent<Text>();
        doneLabel.font = font;
        doneLabel.fontSize = 31;
        doneLabel.fontStyle = FontStyle.Bold;
        doneLabel.color = new Color(0.1f, 0.16f, 0.24f);
        doneLabel.alignment = TextAnchor.MiddleCenter;
        doneLabel.text = "Done";
        var another = CreateRect("NewDestination", arrivalPanel, new Vector2(0.5f, 0), new Vector2(1, 0), new Vector2(8, 24), new Vector2(-28, 116));
        MapUi.Panel(another, new Color(0.1f, 0.37f, 0.83f), 28f, true);
        another.gameObject.AddComponent<Button>().onClick.AddListener(ChooseAnotherDestination);
        var anotherLabel = CreateRect("Label", another, Vector2.zero, Vector2.one, Vector2.zero, Vector2.zero).gameObject.AddComponent<Text>();
        anotherLabel.font = font;
        anotherLabel.fontSize = 31;
        anotherLabel.fontStyle = FontStyle.Bold;
        anotherLabel.color = Color.white;
        anotherLabel.alignment = TextAnchor.MiddleCenter;
        anotherLabel.text = "New destination";
        arrivalPanel.gameObject.SetActive(false);

        if (FindAnyObjectByType<EventSystem>() == null)
        {
#if ENABLE_INPUT_SYSTEM
            new GameObject("EventSystem", typeof(EventSystem), typeof(InputSystemUIInputModule));
#else
            new GameObject("EventSystem", typeof(EventSystem), typeof(StandaloneInputModule));
#endif
        }
    }

    static RectTransform CreateRect(string name, Transform parent, Vector2 anchorMin, Vector2 anchorMax, Vector2 offsetMin, Vector2 offsetMax)
    {
        var rect = new GameObject(name, typeof(RectTransform)).GetComponent<RectTransform>();
        rect.SetParent(parent, false);
        rect.anchorMin = anchorMin;
        rect.anchorMax = anchorMax;
        rect.offsetMin = offsetMin;
        rect.offsetMax = offsetMax;
        return rect;
    }
}
