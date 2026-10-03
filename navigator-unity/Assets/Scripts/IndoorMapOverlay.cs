using System.Collections.Generic;
using System.Runtime.InteropServices;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

/// <summary>
/// Renders navigation data into an interactive top-right overview.
///
/// This deliberately does not recreate RoomPlan walls with Unity cubes. The actual RoomPlan
/// visual is Apple's structure.usdz and needs a native RealityKit overlay on iOS.
/// </summary>
public class IndoorMapOverlay : MonoBehaviour
{
    const int MapLayer = 30;
    const int TextureSize = 768;

    Transform sessionSpace;
    Camera arCamera;
    Transform mapRoot;
    Camera mapCamera;
    RenderTexture renderTexture;
    RectTransform compactCard;
    RectTransform expandedCard;
    Transform routeRoot;
    Transform userMarker;
    Material routeMaterial;
    Vector3 center;
    float span = 8f;
    string appleModelPath;

#if UNITY_IOS && !UNITY_EDITOR
    [DllImport("__Internal")]
    static extern void GnarlyShowRoomModel(string absolutePath);
    [DllImport("__Internal")]
    static extern void GnarlyUpdateRoomModelPosition(float x, float y, float z);
#endif

    public void SetAppleModelPath(string path) => appleModelPath = path;

    public void Configure(Pathfinding.ScanFeatures scan, Pathfinding.Graph graph, Transform sessionTransform, Camera camera)
    {
        Clear();
        sessionSpace = sessionTransform;
        arCamera = camera;
        BuildMapRoot();
        CalculateMapBounds(scan);
        BuildUserMarker();
        FrameCamera();
        BuildUi();
    }

    public void SetRoute(Route route)
    {
        if (routeRoot == null || route == null) return;
        foreach (Transform child in routeRoot) Destroy(child.gameObject);

        var lineObject = new GameObject("ActiveRoute");
        lineObject.transform.SetParent(routeRoot, false);
        SetLayer(lineObject, MapLayer);
        var line = lineObject.AddComponent<LineRenderer>();
        line.useWorldSpace = false;
        line.widthMultiplier = 0.12f;
        line.numCornerVertices = 3;
        line.sharedMaterial = routeMaterial;
        line.positionCount = route.waypoints.Length;
        var points = new Vector3[route.waypoints.Length];
        for (var i = 0; i < points.Length; i++)
            points[i] = route.SessionSpacePosition(i) + Vector3.up * 0.08f;
        line.SetPositions(points);

        foreach (var point in points)
        {
            var marker = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            marker.name = "RoutePoint";
            marker.transform.SetParent(routeRoot, false);
            marker.transform.localPosition = point;
            marker.transform.localScale = Vector3.one * 0.14f;
            Destroy(marker.GetComponent<Collider>());
            marker.GetComponent<Renderer>().sharedMaterial = routeMaterial;
            SetLayer(marker, MapLayer);
        }
    }

    void Update()
    {
        if (userMarker == null || sessionSpace == null || arCamera == null) return;
        userMarker.localPosition = sessionSpace.InverseTransformPoint(arCamera.transform.position) + Vector3.up * 0.22f;
#if UNITY_IOS && !UNITY_EDITOR
        // RoomPlan/USDZ uses ARKit's right-handed Z axis; Unity mirrors Z on import.
        var roomPlanPosition = sessionSpace.InverseTransformPoint(arCamera.transform.position);
        GnarlyUpdateRoomModelPosition(roomPlanPosition.x, roomPlanPosition.y, -roomPlanPosition.z);
#endif
        var forward = sessionSpace.InverseTransformDirection(arCamera.transform.forward);
        forward.y = 0f;
        if (forward.sqrMagnitude > 0.001f)
            userMarker.localRotation = Quaternion.LookRotation(forward.normalized, Vector3.up);
    }

    void BuildMapRoot()
    {
        mapRoot = new GameObject("IndoorMapModel").transform;
        mapRoot.SetParent(sessionSpace, false);
        SetLayer(mapRoot.gameObject, MapLayer);
        routeRoot = new GameObject("Route").transform;
        routeRoot.SetParent(mapRoot, false);
        SetLayer(routeRoot.gameObject, MapLayer);

        routeMaterial = MakeMaterial(new Color(0.08f, 0.95f, 0.82f, 1f));
    }

    void CalculateMapBounds(Pathfinding.ScanFeatures scan)
    {
        var points = new List<Vector3>();
        if (scan?.walls != null)
        {
            foreach (var wall in scan.walls)
            {
                if (wall.position == null || wall.position.Length != 3) continue;
                var position = ToUnity(wall.position);
                var width = wall.dimensions != null && wall.dimensions.Length > 0 ? wall.dimensions[0] : 1f;
                var axis = WallAxis(wall.transformColumnMajor);
                points.Add(position + axis * (width * 0.5f));
                points.Add(position - axis * (width * 0.5f));
            }
        }

        if (points.Count == 0)
        {
            center = Vector3.zero;
            span = 8f;
            return;
        }

        var min = points[0];
        var max = points[0];
        foreach (var point in points)
        {
            min = Vector3.Min(min, point);
            max = Vector3.Max(max, point);
        }
        center = (min + max) * 0.5f;
        span = Mathf.Max(4f, Mathf.Max(max.x - min.x, max.z - min.z) + 2f);
    }

    void BuildUserMarker()
    {
        userMarker = GameObject.CreatePrimitive(PrimitiveType.Cylinder).transform;
        userMarker.name = "YourPosition";
        userMarker.SetParent(mapRoot, false);
        userMarker.localScale = new Vector3(0.3f, 0.13f, 0.3f);
        Destroy(userMarker.GetComponent<Collider>());
        userMarker.GetComponent<Renderer>().sharedMaterial = routeMaterial;
        SetLayer(userMarker.gameObject, MapLayer);
    }

    void FrameCamera()
    {
        var cameraObject = new GameObject("IndoorMapCamera");
        mapCamera = cameraObject.AddComponent<Camera>();
        mapCamera.cullingMask = 1 << MapLayer;
        mapCamera.clearFlags = CameraClearFlags.SolidColor;
        mapCamera.backgroundColor = new Color(0.015f, 0.035f, 0.06f, 1f);
        mapCamera.orthographic = true;
        mapCamera.orthographicSize = span * 0.72f;
        mapCamera.nearClipPlane = 0.01f;
        mapCamera.farClipPlane = 100f;
        renderTexture = new RenderTexture(TextureSize, TextureSize, 16, RenderTextureFormat.ARGB32);
        mapCamera.targetTexture = renderTexture;
        cameraObject.transform.position = sessionSpace.TransformPoint(center + new Vector3(0f, span, -span * 0.55f));
        cameraObject.transform.LookAt(sessionSpace.TransformPoint(center));
    }

    void BuildUi()
    {
        var canvasObject = new GameObject("IndoorMapCanvas", typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
        var canvas = canvasObject.GetComponent<Canvas>();
        canvas.renderMode = RenderMode.ScreenSpaceOverlay;
        canvas.sortingOrder = 20;
        var scaler = canvasObject.GetComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = new Vector2(1170, 2532);
        var font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");

        compactCard = CreateRect("MiniMap", canvasObject.transform, new Vector2(1, 1), new Vector2(1, 1), new Vector2(-314, -374), new Vector2(-22, -82));
        compactCard.gameObject.AddComponent<Image>().color = new Color(0.025f, 0.06f, 0.1f, 0.93f);
        AddMapImage(compactCard, new Vector2(12, 12), new Vector2(-12, -50));
        AddText(compactCard, "LIVE POSITION · TAP TO EXPAND", 18, new Vector2(14, 8), new Vector2(-14, 40), new Color(0.45f, 0.83f, 0.95f), font);
        compactCard.gameObject.AddComponent<Button>().onClick.AddListener(OpenExpandedModel);

        expandedCard = CreateRect("ExpandedMap", canvasObject.transform, new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), new Vector2(-430, -430), new Vector2(430, 430));
        AddMapImage(expandedCard, Vector2.zero, new Vector2(0, -74));
        AddText(expandedCard, "NAVIGATION MAP  ·  YOUR POSITION IS MINT", 25, new Vector2(28, 14), new Vector2(-190, 74), new Color(0.45f, 0.83f, 0.95f), font);
        var close = CreateRect("Close", expandedCard, new Vector2(1, 0), new Vector2(1, 0), new Vector2(-150, 14), new Vector2(-24, 74));
        close.gameObject.AddComponent<Image>().color = new Color(0.12f, 0.31f, 0.4f, 1f);
        close.gameObject.AddComponent<Button>().onClick.AddListener(() => expandedCard.gameObject.SetActive(false));
        AddText(close, "×  CLOSE", 22, Vector2.zero, Vector2.zero, Color.white, font, true);
        expandedCard.gameObject.SetActive(false);

        if (FindAnyObjectByType<EventSystem>() == null)
            new GameObject("MapEventSystem", typeof(EventSystem), typeof(StandaloneInputModule));
    }

    void OpenExpandedModel()
    {
#if UNITY_IOS && !UNITY_EDITOR
        if (!string.IsNullOrEmpty(appleModelPath))
        {
            GnarlyShowRoomModel(appleModelPath);
            return;
        }
#endif
        // The editor and other platforms retain a data-only expanded map for development.
        expandedCard.gameObject.SetActive(true);
    }

    void AddMapImage(RectTransform parent, Vector2 insetMin, Vector2 insetMax)
    {
        var image = CreateRect("MapImage", parent, Vector2.zero, Vector2.one, insetMin, insetMax).gameObject.AddComponent<RawImage>();
        image.texture = renderTexture;
        image.color = Color.white;
        image.raycastTarget = false;
    }

    static void AddText(RectTransform parent, string text, int size, Vector2 offsetMin, Vector2 offsetMax, Color color, Font font, bool centered = false)
    {
        var labelRect = centered
            ? CreateRect("Label", parent, Vector2.zero, Vector2.one, Vector2.zero, Vector2.zero)
            : CreateRect("Label", parent, new Vector2(0, 0), new Vector2(1, 0), offsetMin, offsetMax);
        var label = labelRect.gameObject.AddComponent<Text>();
        label.font = font;
        label.fontSize = size;
        label.fontStyle = FontStyle.Bold;
        label.alignment = centered ? TextAnchor.MiddleCenter : TextAnchor.MiddleLeft;
        label.color = color;
        label.text = text;
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

    static Material MakeMaterial(Color color)
    {
        var material = new Material(Shader.Find("Sprites/Default"));
        material.color = color;
        return material;
    }

    static Vector3 ToUnity(float[] arkit) => new Vector3(arkit[0], arkit[1], -arkit[2]);

    static Vector3 WallAxis(float[] transform)
    {
        if (transform == null || transform.Length != 16) return Vector3.right;
        var axis = new Vector3(transform[0], transform[1], -transform[2]);
        axis.y = 0f;
        return axis.sqrMagnitude > 0.0001f ? axis.normalized : Vector3.right;
    }

    static void SetLayer(GameObject gameObject, int layer)
    {
        gameObject.layer = layer;
        foreach (Transform child in gameObject.transform) SetLayer(child.gameObject, layer);
    }

    public void Clear()
    {
        if (mapRoot != null) Destroy(mapRoot.gameObject);
        if (mapCamera != null) Destroy(mapCamera.gameObject);
        if (compactCard != null) Destroy(compactCard.root.gameObject);
        if (renderTexture != null) renderTexture.Release();
        if (routeMaterial != null) Destroy(routeMaterial);
    }

    void OnDestroy() => Clear();
}
