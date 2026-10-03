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
/// </summary>
public class RelocalizationController : MonoBehaviour
{
    enum State { WaitingForPackage, WaitingForSession, Locating, Located, TrackingLost, Failed }

    [SerializeField] ARSession session;
    [SerializeField] XROrigin origin;
    [SerializeField] RouteNavigator navigator;
    [SerializeField] FirebaseNavigationPackageLoader packageLoader;
    [SerializeField] string buildingId = "";
    [SerializeField] string zoneId = "zone-a";
    [SerializeField] string floorId = "ground";
    [SerializeField] float cubeSize = 0.2f;
    [Tooltip("ARKit can complete a fast relocalization without reporting the Relocalizing reason. Accept stable normal tracking after this delay.")]
    [SerializeField] float normalTrackingConfirmationSeconds = 1.5f;
    [Tooltip("Debug only: skip the world map so coordinates are relative to where the app starts.")]
    [SerializeField] bool skipWorldMap;

    State state = State.WaitingForPackage;
    string packageDirectory;
    bool sawRelocalizing;
    string lastTrackingSnapshot;
    float normalTrackingStartedAt = -1f;
    TestAnchor anchor;
    Route fallbackRoute;
    Pathfinding.Graph navigationGraph;
    GameObject cube;
    Text statusText;
    RectTransform destinationPanel;
    readonly List<GameObject> destinationButtons = new List<GameObject>();
#if UNITY_IOS && !UNITY_EDITOR
    ARWorldMap? appliedWorldMap;
#endif

    string PackageDirectory => packageDirectory ?? Path.Combine(Application.streamingAssetsPath, zoneId);

    void Awake()
    {
        if (session == null) session = FindAnyObjectByType<ARSession>();
        if (origin == null) origin = FindAnyObjectByType<XROrigin>();
        if (navigator == null) navigator = GetComponent<RouteNavigator>();
        if (packageLoader == null) packageLoader = GetComponent<FirebaseNavigationPackageLoader>();
        if (packageLoader == null) packageLoader = gameObject.AddComponent<FirebaseNavigationPackageLoader>();
        BuildUi();
    }

    void Start()
    {
        SetStatus("Preparing Firebase navigation package…");
        packageLoader.Begin(buildingId, zoneId, OnPackageReady, SetStatus);
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
                    LoadAndApplyMap();
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
                    SetStatus(navigator.StatusMessage);
                }
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

    void LoadAndApplyMap()
    {
        try
        {
            var anchorPath = Path.Combine(PackageDirectory, "test-anchor.json");
            anchor = File.Exists(anchorPath)
                ? TestAnchor.Parse(File.ReadAllText(anchorPath), zoneId)
                : null;
            var routePath = Path.Combine(PackageDirectory, "route.json");
            fallbackRoute = File.Exists(routePath) ? Route.Parse(File.ReadAllText(routePath), zoneId) : null;

            Pathfinding.ScanFeatures scan = null;
            Pathfinding.BuildingDocument building = null;
            var scanPath = Path.Combine(PackageDirectory, "scan-features.json");
            if (File.Exists(scanPath))
                scan = Pathfinding.ParseScan(File.ReadAllText(scanPath));
            var buildingPath = Path.Combine(PackageDirectory, "building.json");
            if (File.Exists(buildingPath))
                building = Pathfinding.ParseBuilding(File.ReadAllText(buildingPath));
            navigationGraph = scan != null || building != null
                ? Pathfinding.Build(scan, building, floorId)
                : null;

            if (!skipWorldMap)
                ApplyWorldMap(File.ReadAllBytes(Path.Combine(PackageDirectory, $"worldmap-{zoneId}.bin")));
            sawRelocalizing = false;
            lastTrackingSnapshot = null;
            normalTrackingStartedAt = -1f;
            state = State.Locating;
            SetStatus("Locating… Look around the scanned area.");
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

        Debug.Log($"[Gnarly] Applying {mapBytes.Length}-byte world map for {zoneId}.");
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
                navigator.Begin(fallbackRoute, origin.TrackablesParent, origin.Camera);
            else
                SetStatus("Located (graph has no destination nodes)");
        }
        else if (fallbackRoute != null && navigator != null)
            navigator.Begin(fallbackRoute, origin.TrackablesParent, origin.Camera);
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
        var startId = navigationGraph.NearestNodeId(CameraArkitPosition());
        if (startId == null)
        {
            SetStatus("Located, but the graph has no nodes.");
            return;
        }

        var path = Pathfinding.AStar(navigationGraph, startId, goalId);
        if (path == null || path.Count < 2)
        {
            SetStatus($"No A* path from {startId} to {goalId}. Look around or pick another destination.");
            return;
        }

        var route = Pathfinding.ToRoute(navigationGraph, path, zoneId);
        navigator.Begin(route, origin.TrackablesParent, origin.Camera);
        ClearDestinationButtons();
        if (destinationPanel != null) destinationPanel.gameObject.SetActive(false);
        SetStatus(navigator.StatusMessage);
        Debug.Log($"[Gnarly] A* {string.Join(" -> ", path)}");
    }

    void ShowDestinations(List<Pathfinding.Node> destinations)
    {
        if (destinationPanel == null) return;
        ClearDestinationButtons();
        destinationPanel.gameObject.SetActive(true);
        for (var i = 0; i < destinations.Count; i++)
        {
            var node = destinations[i];
            var button = CreateRect($"Dest-{node.id}", destinationPanel, new Vector2(0, 1), new Vector2(1, 1), new Vector2(16, -100 - i * 100), new Vector2(-16, -20 - i * 100));
            button.gameObject.AddComponent<Image>().color = new Color(1, 1, 1, 0.9f);
            var captured = node.id;
            button.gameObject.AddComponent<Button>().onClick.AddListener(() => RouteTo(captured));
            var label = CreateRect("Label", button, Vector2.zero, Vector2.one, Vector2.zero, Vector2.zero).gameObject.AddComponent<Text>();
            label.font = statusText.font;
            label.fontSize = 36;
            label.alignment = TextAnchor.MiddleCenter;
            label.color = Color.black;
            label.text = string.IsNullOrEmpty(node.label) ? node.id : node.label;
            destinationButtons.Add(button.gameObject);
        }
    }

    void ClearDestinationButtons()
    {
        foreach (var button in destinationButtons) Destroy(button);
        destinationButtons.Clear();
    }

    public void Retry()
    {
        if (cube != null) Destroy(cube);
        cube = null;
        if (navigator != null) navigator.Clear();
        ClearDestinationButtons();
        if (destinationPanel != null) destinationPanel.gameObject.SetActive(false);
        state = State.WaitingForSession;
        session.Reset();
        SetStatus("Restarting…");
    }

    void OnPackageReady(DownloadedNavigationPackage package)
    {
        buildingId = package.BuildingId;
        zoneId = package.ZoneId;
        packageDirectory = package.DirectoryPath;
        state = State.WaitingForSession;
        var source = package.IsOfflineCache ? "offline cache" : "Firebase";
        SetStatus($"Loaded version {package.VersionId} from {source}. Starting camera…");
        Debug.Log($"[Gnarly] Navigation package ready at {packageDirectory}.");
    }

    void Fail(string message)
    {
        state = State.Failed;
        Debug.LogError($"[Gnarly] {message}");
        SetStatus($"Error: {message}");
    }

    void SetStatus(string message)
    {
        if (statusText != null) statusText.text = message;
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
            SetStatus("ARKit is tracking normally, but has not reported relocalization. Look around the scanned area.");
            return;
        }

        SetStatus($"Locating… ARKit: {snapshot}. Look around the scanned area.");
    }

    void BuildUi()
    {
        var canvasObject = new GameObject("StatusCanvas", typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
        canvasObject.GetComponent<Canvas>().renderMode = RenderMode.ScreenSpaceOverlay;
        var scaler = canvasObject.GetComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = new Vector2(1170, 2532);

        var font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");

        var panel = CreateRect("StatusPanel", canvasObject.transform, new Vector2(0, 1), new Vector2(1, 1), new Vector2(0, -360), new Vector2(0, -120));
        panel.gameObject.AddComponent<Image>().color = new Color(0, 0, 0, 0.6f);

        statusText = CreateRect("StatusText", panel, Vector2.zero, Vector2.one, new Vector2(40, 0), new Vector2(-40, 0)).gameObject.AddComponent<Text>();
        statusText.font = font;
        statusText.fontSize = 48;
        statusText.alignment = TextAnchor.MiddleCenter;
        statusText.color = Color.white;

        var button = CreateRect("RetryButton", canvasObject.transform, new Vector2(0.5f, 0), new Vector2(0.5f, 0), new Vector2(-220, 120), new Vector2(220, 260));
        button.gameObject.AddComponent<Image>().color = new Color(1, 1, 1, 0.85f);
        button.gameObject.AddComponent<Button>().onClick.AddListener(Retry);

        var label = CreateRect("Label", button, Vector2.zero, Vector2.one, Vector2.zero, Vector2.zero).gameObject.AddComponent<Text>();
        label.font = font;
        label.fontSize = 48;
        label.alignment = TextAnchor.MiddleCenter;
        label.color = Color.black;
        label.text = "Retry";

        destinationPanel = CreateRect("DestinationPanel", canvasObject.transform, new Vector2(0, 0), new Vector2(1, 0), new Vector2(40, 280), new Vector2(-40, 900));
        destinationPanel.gameObject.SetActive(false);

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
