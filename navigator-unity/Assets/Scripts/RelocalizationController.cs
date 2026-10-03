using System;
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
/// and, if route.json is present, starts route guidance.
/// </summary>
public class RelocalizationController : MonoBehaviour
{
    enum State { WaitingForSession, Locating, Located, TrackingLost, Failed }

    [SerializeField] ARSession session;
    [SerializeField] XROrigin origin;
    [SerializeField] RouteNavigator navigator;
    [SerializeField] string zoneId = "zone-a";
    [SerializeField] float cubeSize = 0.2f;
    [Tooltip("Debug only: skip the world map so coordinates are relative to where the app starts.")]
    [SerializeField] bool skipWorldMap;

    State state = State.WaitingForSession;
    bool sawRelocalizing;
    TestAnchor anchor;
    Route route;
    GameObject cube;
    Text statusText;
#if UNITY_IOS && !UNITY_EDITOR
    ARWorldMap? appliedWorldMap;
#endif

    string PackageDirectory => Path.Combine(Application.streamingAssetsPath, zoneId);

    void Awake()
    {
        if (session == null) session = FindAnyObjectByType<ARSession>();
        if (origin == null) origin = FindAnyObjectByType<XROrigin>();
        if (navigator == null) navigator = GetComponent<RouteNavigator>();
        BuildUi();
    }

    void Start() => SetStatus("Starting camera…");

    void Update()
    {
        switch (state)
        {
            case State.WaitingForSession:
                if (ARSession.state == ARSessionState.Unsupported)
                    Fail("This device does not support ARKit.");
                else if (ARSession.state == ARSessionState.SessionTracking)
                    LoadAndApplyMap();
                break;

            case State.Locating:
                if (ARSession.notTrackingReason == NotTrackingReason.Relocalizing)
                    sawRelocalizing = true;
                if ((sawRelocalizing || skipWorldMap) && IsTrackingNormally())
                    OnLocated();
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
            anchor = TestAnchor.Parse(File.ReadAllText(Path.Combine(PackageDirectory, "test-anchor.json")), zoneId);
            var routePath = Path.Combine(PackageDirectory, "route.json");
            route = File.Exists(routePath) ? Route.Parse(File.ReadAllText(routePath), zoneId) : null;
            if (!skipWorldMap)
                ApplyWorldMap(File.ReadAllBytes(Path.Combine(PackageDirectory, $"worldmap-{zoneId}.bin")));
            sawRelocalizing = false;
            state = State.Locating;
            SetStatus("Locating… Look around the scanned area.");
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
        PlaceCube();
        state = State.Located;
        if (route != null && navigator != null)
            navigator.Begin(route, origin.TrackablesParent, origin.Camera);
        else
            SetStatus(route == null ? "Located (no route.json)" : "Located");
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

    public void Retry()
    {
        if (cube != null) Destroy(cube);
        cube = null;
        if (navigator != null) navigator.Clear();
        state = State.WaitingForSession;
        session.Reset();
        SetStatus("Restarting…");
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
