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

    [Serializable]
    sealed class IndoorMapRouteRequest
    {
        public string startId;
        public string destinationId;
    }

    const string ZoneConnectionsFileName = "zone-connections.json";

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
    string currentZoneId;
    bool navigationLoaded;
    readonly Dictionary<string, ZonePackage> zonePackages = new Dictionary<string, ZonePackage>();
    /// <summary>All zones, keyed by <see cref="Pathfinding.ZoneKey"/>, joined by zone connections.</summary>
    Pathfinding.Graph navigationGraph;
    List<Pathfinding.RouteLeg> activeLegs;
    int activeLegIndex;
    GameObject cube;
    Text statusText;
    Text statusEyebrow;
    Image statusIndicator;
    Image retryBackground;
    RectTransform destinationPanel;
    RectTransform transitionPanel;
    Text transitionHeading;
    Text transitionInstructions;
    Text transitionButtonLabel;
    readonly List<GameObject> destinationButtons = new List<GameObject>();
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
                    SetStatus($"Tracking lost ({ARSession.notTrackingReason}). Look around the scanned area.");
                }
                else if (navigator != null && navigator.IsActive)
                {
                    if (navigator.HasArrived && activeLegs != null && activeLegIndex < activeLegs.Count - 1)
                        AwaitZoneTransition();
                    else
                        SetStatus(LegStatus());
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

            var zoneFloorId = zone == zoneId ? floorId
                : building?.floors != null && building.floors.Length > 0 ? building.floors[0].id
                : zone;
            zonePackages[zone] = new ZonePackage
            {
                directory = directory,
                scan = scan,
                graph = scan != null || building != null ? Pathfinding.Build(scan, building, zoneFloorId) : null
            };
        }

        var zoneGraphs = new Dictionary<string, Pathfinding.Graph>();
        foreach (var pair in zonePackages)
            if (pair.Value.graph != null) zoneGraphs[pair.Key] = pair.Value.graph;
        navigationGraph = zoneGraphs.Count > 0 ? Pathfinding.Combine(zoneGraphs, connections) : null;
        navigationLoaded = true;
        Debug.Log($"[Gnarly] Navigation zones loaded: {string.Join(", ", zonePackages.Keys)}; " +
                  $"{connections?.connections.Length ?? 0} zone connection(s).");
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
        indoorMap?.Configure(zone.scan, zone.graph, origin.TrackablesParent, origin.Camera);
        indoorMap?.SetPackagePaths(
            Path.Combine(zone.directory, "structure.usdz"),
            Path.Combine(zone.directory, "building.json"),
            Path.Combine(zone.directory, "scan-features.json"));

        if (activeLegs != null)
        {
            BeginLeg();
            return;
        }

        if (navigationGraph != null && navigationGraph.Nodes.Count >= 2)
        {
            var destinations = navigationGraph.Destinations();
            if (destinations.Count == 1)
                RouteTo(destinations[0].id);
            else if (destinations.Count > 1)
            {
                ShowDestinations(destinations);
                SetStatus("Located. Choose a destination.");
            }
            else if (fallbackRoute != null && navigator != null)
            {
                navigator.Begin(fallbackRoute, origin.TrackablesParent, origin.Camera);
                indoorMap?.SetRoute(fallbackRoute);
            }
            else
                SetStatus("Located (graph has no destination nodes)");
        }
        else if (fallbackRoute != null && navigator != null)
        {
            navigator.Begin(fallbackRoute, origin.TrackablesParent, origin.Camera);
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

    void RouteTo(string goalId)
    {
        if (navigationGraph == null || navigator == null) return;
        var startId = navigationGraph.NearestNodeId(CameraArkitPosition(), currentZoneId);
        if (startId == null)
        {
            SetStatus($"Located, but zone {currentZoneId} has no graph nodes.");
            return;
        }

        BeginRoute(startId, goalId);
    }

    /// <summary>Called by the native iPhone map after the user chooses map markers.</summary>
    public void OnIndoorMapRouteRequested(string requestJson)
    {
        try
        {
            var request = JsonUtility.FromJson<IndoorMapRouteRequest>(requestJson);
            if (request == null || string.IsNullOrEmpty(request.startId) || string.IsNullOrEmpty(request.destinationId))
                throw new FormatException("The map route request did not contain start and destination node IDs.");

            var startId = ResolveCurrentZoneNode(request.startId);
            var destinationId = ResolveCurrentZoneNode(request.destinationId);
            if (startId == null || destinationId == null)
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

    void BeginRoute(string startId, string goalId)
    {
        if (navigationGraph == null || navigator == null) return;

        var path = Pathfinding.AStar(navigationGraph, startId, goalId);
        if (path == null)
        {
            var message = $"No A* path from {startId} to {goalId}. Pick another map point.";
            indoorMap?.SetExpandedStatus(message);
            SetStatus(message);
            return;
        }
        if (path.Count < 2)
        {
            const string message = "Start and destination are the same location. Choose two different map points.";
            indoorMap?.SetExpandedStatus(message);
            SetStatus(message);
            return;
        }

        activeLegs = Pathfinding.SplitByZone(navigationGraph, path);
        activeLegIndex = 0;
        if (transitionPanel != null) transitionPanel.gameObject.SetActive(false);
        ClearDestinationButtons();
        if (destinationPanel != null) destinationPanel.gameObject.SetActive(false);
        Debug.Log($"[Gnarly] A* {string.Join(" -> ", path)} ({activeLegs.Count} zone leg(s))");
        BeginLeg();
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

        var route = Pathfinding.ToRoute(navigationGraph, leg.nodeIds, leg.zoneId);
        navigator.Begin(route, origin.TrackablesParent, origin.Camera);
        indoorMap?.SetRoute(route);
        SetStatus(LegStatus());
    }

    string LegStatus()
    {
        if (activeLegs == null || activeLegIndex >= activeLegs.Count - 1) return navigator.StatusMessage;
        var leg = activeLegs[activeLegIndex];
        var connector = navigationGraph.Node(leg.nodeIds[leg.nodeIds.Count - 1]);
        var connectorName = string.IsNullOrEmpty(connector.label) ? connector.localId : connector.label;
        return $"{navigator.StatusMessage} to {connectorName}, then into {activeLegs[activeLegIndex + 1].zoneId}";
    }

    void AwaitZoneTransition()
    {
        var nextZone = activeLegs[activeLegIndex + 1].zoneId;
        var leg = activeLegs[activeLegIndex];
        var connector = navigationGraph.Node(leg.nodeIds[leg.nodeIds.Count - 1]);
        var connectorName = string.IsNullOrEmpty(connector.label) ? "the connection" : connector.label;
        state = State.AwaitingZoneTransition;
        navigator.SetVisible(false);
        if (transitionHeading != null) transitionHeading.text = $"{currentZoneId}  →  {nextZone}";
        if (transitionInstructions != null)
            transitionInstructions.text = $"Reached {connectorName}. Walk into {nextZone}, then tap below to load its map. Look around there until your position is confirmed.";
        if (transitionButtonLabel != null) transitionButtonLabel.text = $"I'm in {nextZone}";
        if (transitionPanel != null) transitionPanel.gameObject.SetActive(true);
        SetStatus($"At {connectorName}. Continue into {nextZone}, then confirm below.");
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

    void ShowDestinations(List<Pathfinding.Node> destinations)
    {
        if (destinationPanel == null) return;
        ClearDestinationButtons();
        destinationPanel.gameObject.SetActive(true);
        for (var i = 0; i < destinations.Count; i++)
        {
            var node = destinations[i];
            var button = CreateRect($"Dest-{node.id}", destinationPanel, new Vector2(0, 1), new Vector2(1, 1), new Vector2(18, -148 - i * 102), new Vector2(-18, -54 - i * 102));
            button.gameObject.AddComponent<Image>().color = new Color(0.12f, 0.31f, 0.4f, 0.96f);
            var captured = node.id;
            button.gameObject.AddComponent<Button>().onClick.AddListener(() => RouteTo(captured));
            var label = CreateRect("Label", button, Vector2.zero, Vector2.one, Vector2.zero, Vector2.zero).gameObject.AddComponent<Text>();
            label.font = statusText.font;
            label.fontSize = 32;
            label.fontStyle = FontStyle.Bold;
            label.alignment = TextAnchor.MiddleCenter;
            label.color = Color.white;
            label.text = string.IsNullOrEmpty(node.label) ? node.localId : node.label;
            if (zonePackages.Count > 1) label.text += $"  ·  {node.zone}";
            destinationButtons.Add(button.gameObject);
        }
    }

    void ClearDestinationButtons()
    {
        foreach (var button in destinationButtons) Destroy(button);
        destinationButtons.Clear();
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
        ClearDestinationButtons();
        if (destinationPanel != null) destinationPanel.gameObject.SetActive(false);
        if (transitionPanel != null) transitionPanel.gameObject.SetActive(false);
        state = State.WaitingForSession;
        session.Reset();
        SetStatus(message);
    }

    void OnPackageReady(DownloadedNavigationPackage package)
    {
        buildingId = package.BuildingId;
        zoneId = package.ZoneId;
        currentZoneId = zoneId;
        packageDirectory = package.DirectoryPath;
        navigationLoaded = false;
        activeLegs = null;
        state = State.WaitingForSession;
        var source = package.IsOfflineCache ? "offline cache" : "Firebase";
        SetStatus($"Loaded version {package.VersionId} from {source}. Starting camera…");
        Debug.Log($"[Gnarly] Navigation package ready at {packageDirectory}.");
    }

    void Fail(string message)
    {
        state = State.Failed;
        if (transitionPanel != null) transitionPanel.gameObject.SetActive(false);
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

        SetStatus($"Locating in {currentZoneId}… ARKit: {snapshot}. Look around the scanned area.");
    }

    void BuildUi()
    {
        var canvasObject = new GameObject("StatusCanvas", typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
        canvasObject.GetComponent<Canvas>().renderMode = RenderMode.ScreenSpaceOverlay;
        var scaler = canvasObject.GetComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = new Vector2(1170, 2532);

        var font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");

        var panel = CreateRect("StatusPanel", canvasObject.transform, new Vector2(0, 1), new Vector2(1, 1), new Vector2(22, -330), new Vector2(-22, -112));
        panel.gameObject.AddComponent<Image>().color = new Color(0.025f, 0.06f, 0.1f, 0.88f);

        statusIndicator = CreateRect("StatusIndicator", panel, new Vector2(0, 0.5f), new Vector2(0, 0.5f), new Vector2(26, -11), new Vector2(48, 11)).gameObject.AddComponent<Image>();
        statusIndicator.color = StatusColor();

        statusEyebrow = CreateRect("Eyebrow", panel, new Vector2(0, 1), new Vector2(1, 1), new Vector2(64, -57), new Vector2(-28, -16)).gameObject.AddComponent<Text>();
        statusEyebrow.font = font;
        statusEyebrow.fontSize = 24;
        statusEyebrow.fontStyle = FontStyle.Bold;
        statusEyebrow.alignment = TextAnchor.MiddleLeft;
        statusEyebrow.color = new Color(0.44f, 0.78f, 0.92f);
        statusEyebrow.text = "GNARLY NAVIGATION";

        statusText = CreateRect("StatusText", panel, Vector2.zero, Vector2.one, new Vector2(64, 8), new Vector2(-28, -54)).gameObject.AddComponent<Text>();
        statusText.font = font;
        statusText.fontSize = 38;
        statusText.alignment = TextAnchor.MiddleLeft;
        statusText.color = Color.white;
        statusText.horizontalOverflow = HorizontalWrapMode.Wrap;

        var button = CreateRect("RetryButton", canvasObject.transform, new Vector2(0.5f, 0), new Vector2(0.5f, 0), new Vector2(-190, 88), new Vector2(190, 190));
        retryBackground = button.gameObject.AddComponent<Image>();
        retryBackground.color = new Color(0.05f, 0.12f, 0.18f, 0.92f);
        button.gameObject.AddComponent<Button>().onClick.AddListener(Retry);

        var label = CreateRect("Label", button, Vector2.zero, Vector2.one, Vector2.zero, Vector2.zero).gameObject.AddComponent<Text>();
        label.font = font;
        label.fontSize = 34;
        label.fontStyle = FontStyle.Bold;
        label.alignment = TextAnchor.MiddleCenter;
        label.color = Color.white;
        label.text = "Reset map";

        destinationPanel = CreateRect("DestinationPanel", canvasObject.transform, new Vector2(0, 0), new Vector2(1, 0), new Vector2(24, 220), new Vector2(-24, 860));
        destinationPanel.gameObject.AddComponent<Image>().color = new Color(0.025f, 0.06f, 0.1f, 0.9f);
        var destinationHeading = CreateRect("Heading", destinationPanel, new Vector2(0, 1), new Vector2(1, 1), new Vector2(24, -60), new Vector2(-24, -12)).gameObject.AddComponent<Text>();
        destinationHeading.font = font;
        destinationHeading.fontSize = 26;
        destinationHeading.fontStyle = FontStyle.Bold;
        destinationHeading.alignment = TextAnchor.MiddleLeft;
        destinationHeading.color = new Color(0.44f, 0.78f, 0.92f);
        destinationHeading.text = "CHOOSE A DESTINATION";
        destinationPanel.gameObject.SetActive(false);

        transitionPanel = CreateRect("ZoneTransitionPanel", canvasObject.transform, new Vector2(0, 0.5f), new Vector2(1, 0.5f), new Vector2(24, -245), new Vector2(-24, 245));
        transitionPanel.gameObject.AddComponent<Image>().color = new Color(0.025f, 0.06f, 0.1f, 0.96f);
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
        var transitionButton = CreateRect("ConfirmZoneTransition", transitionPanel, new Vector2(0, 0), new Vector2(1, 0), new Vector2(32, 24), new Vector2(-32, 116));
        transitionButton.gameObject.AddComponent<Image>().color = new Color(0.08f, 0.49f, 0.5f, 1f);
        transitionButton.gameObject.AddComponent<Button>().onClick.AddListener(ConfirmZoneTransition);
        transitionButtonLabel = CreateRect("Label", transitionButton, Vector2.zero, Vector2.one, Vector2.zero, Vector2.zero).gameObject.AddComponent<Text>();
        transitionButtonLabel.font = font;
        transitionButtonLabel.fontSize = 34;
        transitionButtonLabel.fontStyle = FontStyle.Bold;
        transitionButtonLabel.alignment = TextAnchor.MiddleCenter;
        transitionButtonLabel.color = Color.white;
        transitionPanel.gameObject.SetActive(false);

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
