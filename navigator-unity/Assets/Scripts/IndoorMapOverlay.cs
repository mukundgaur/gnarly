using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;
#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem.UI;
#endif

/// <summary>
/// Renders navigation data into an interactive top-right overview.
///
/// The compact card renders normalized RoomPlan geometry into a Unity RenderTexture. On iPhone,
/// the expanded view uses the original structure.usdz in RealityKit and returns selected graph IDs
/// to the existing A* navigator.
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
    Material graphMaterial;
    Material routeMaterial;
    Material wallMaterial;
    Material floorMaterial;
    Material openingMaterial;
    Material objectMaterial;
    Vector3 center;
    float span = 8f;
    string appleModelPath;
    string buildingJsonPath;
    string scanJsonPath;
    Text expandedMessage;

#if UNITY_IOS && !UNITY_EDITOR
    [DllImport("__Internal")]
    static extern void GnarlyShowRoomModel(
        string absolutePath,
        string buildingPath,
        string scanPath,
        string callbackObjectName);
    [DllImport("__Internal")]
    static extern void GnarlySetRoomModelRoute(string routeJson);
    [DllImport("__Internal")]
    static extern void GnarlySetRoomModelStatus(string message);
    [DllImport("__Internal")]
    static extern void GnarlyUpdateRoomModelPosition(float x, float y, float z);
#endif

    public void SetPackagePaths(string modelPath, string buildingPath, string scanPath)
    {
        appleModelPath = modelPath;
        buildingJsonPath = buildingPath;
        scanJsonPath = scanPath;
    }

    public void Configure(Pathfinding.ScanFeatures scan, Pathfinding.Graph graph, Transform sessionTransform, Camera camera)
    {
        Clear();
        sessionSpace = sessionTransform;
        arCamera = camera;
        BuildMapRoot();
        CalculateMapBounds(scan);
        BuildScanGeometry(scan);
        BuildGraph(graph);
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
#if UNITY_IOS && !UNITY_EDITOR
        GnarlySetRoomModelRoute(JsonUtility.ToJson(route));
#endif
    }

    public void SetExpandedStatus(string message)
    {
#if UNITY_IOS && !UNITY_EDITOR
        GnarlySetRoomModelStatus(message ?? "");
#endif
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

        graphMaterial = MakeMaterial(new Color(0.42f, 0.75f, 0.85f, 0.35f));
        routeMaterial = MakeMaterial(new Color(0.08f, 0.95f, 0.82f, 1f));
        wallMaterial = MakeMaterial(new Color(0.66f, 0.76f, 0.82f, 0.9f));
        floorMaterial = MakeMaterial(new Color(0.11f, 0.2f, 0.25f, 1f));
        openingMaterial = MakeMaterial(new Color(0.24f, 0.72f, 0.9f, 0.72f));
        objectMaterial = MakeMaterial(new Color(0.35f, 0.48f, 0.55f, 0.88f));
    }

    void BuildScanGeometry(Pathfinding.ScanFeatures scan)
    {
        if (scan == null)
        {
            Debug.LogError("[Gnarly] The RoomPlan scan is missing; the minimap cannot render building geometry.");
            return;
        }

        BuildSurfaces(scan.floors, floorMaterial, true);
        BuildSurfaces(scan.walls, wallMaterial, false);
        BuildSurfaces(scan.doors, openingMaterial, false);
        BuildSurfaces(scan.openings, openingMaterial, false);
        BuildSurfaces(scan.windows, openingMaterial, false);
        if (scan.objects == null) return;
        foreach (var item in scan.objects)
        {
            if (!ValidVector(item.position) || !ValidVector(item.dimensions)) continue;
            CreateScanBox("RoomPlanObject-" + item.category, item.position, item.dimensions,
                item.transformColumnMajor, objectMaterial, false);
        }
    }

    void BuildSurfaces(Pathfinding.Surface[] surfaces, Material material, bool floor)
    {
        if (surfaces == null) return;
        foreach (var surface in surfaces)
        {
            if (!ValidVector(surface.position) || surface.dimensions == null || surface.dimensions.Length < 2) continue;
            var dimensions = surface.dimensions.Length >= 3
                ? (float[])surface.dimensions.Clone()
                : new[] { surface.dimensions[0], surface.dimensions[1], 0.06f };
            if (floor)
            {
                // RoomPlan surfaces are nearly planar. Keep the scan footprint visible from oblique angles.
                dimensions[1] = 0.04f;
                if (dimensions[2] < 0.1f) dimensions[2] = Math.Max(0.5f, surface.dimensions[1]);
            }
            else if (dimensions[2] < 0.04f)
            {
                dimensions[2] = 0.06f;
            }
            CreateScanBox("RoomPlan-" + surface.category, surface.position, dimensions,
                surface.transformColumnMajor, material, floor);
        }
    }

    void CreateScanBox(
        string objectName,
        float[] position,
        float[] dimensions,
        float[] transform,
        Material material,
        bool floor)
    {
        var box = GameObject.CreatePrimitive(PrimitiveType.Cube);
        box.name = objectName;
        box.transform.SetParent(mapRoot, false);
        box.transform.localPosition = ToUnity(position);
        box.transform.localRotation = ToUnityRotation(transform, floor);
        box.transform.localScale = new Vector3(
            Mathf.Max(0.02f, Mathf.Abs(dimensions[0])),
            Mathf.Max(0.02f, Mathf.Abs(dimensions[1])),
            Mathf.Max(0.02f, Mathf.Abs(dimensions[2])));
        box.GetComponent<Renderer>().sharedMaterial = material;
        Destroy(box.GetComponent<Collider>());
        SetLayer(box, MapLayer);
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

    void BuildGraph(Pathfinding.Graph graph)
    {
        if (graph == null) return;
        foreach (var node in graph.Nodes)
        {
            if (node.position == null || node.position.Length != 3) continue;
            var marker = GameObject.CreatePrimitive(node.type == "destination" ? PrimitiveType.Cylinder : PrimitiveType.Sphere);
            marker.name = "MapNode-" + node.id;
            marker.transform.SetParent(mapRoot, false);
            marker.transform.localPosition = ToUnity(node.position) + Vector3.up * 0.12f;
            marker.transform.localScale = node.type == "destination" ? new Vector3(0.22f, 0.34f, 0.22f) : Vector3.one * 0.1f;
            Destroy(marker.GetComponent<Collider>());
            marker.GetComponent<Renderer>().sharedMaterial = graphMaterial;
            SetLayer(marker, MapLayer);
        }
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

        compactCard = CreateRect("MiniMap", canvasObject.transform, new Vector2(1, 1), new Vector2(1, 1), new Vector2(-354, -430), new Vector2(-28, -104));
        var compactGroup = compactCard.gameObject.AddComponent<CanvasGroup>();
        compactGroup.interactable = true;
        compactGroup.blocksRaycasts = true;
        var compactBackground = compactCard.gameObject.AddComponent<Image>();
        compactBackground.color = new Color(0.025f, 0.06f, 0.1f, 0.93f);
        compactBackground.raycastTarget = true;
        AddMapImage(compactCard, new Vector2(12, 12), new Vector2(-12, -50));
        AddText(compactCard, "LIVE POSITION · TAP TO EXPAND", 18, new Vector2(14, 8), new Vector2(-14, 40), new Color(0.45f, 0.83f, 0.95f), font);
        var compactButton = compactCard.gameObject.AddComponent<Button>();
        compactButton.targetGraphic = compactBackground;
        compactButton.interactable = true;
        compactButton.onClick.AddListener(OpenExpandedModel);

        expandedCard = CreateRect("ExpandedMap", canvasObject.transform, Vector2.zero, Vector2.one, new Vector2(26, 120), new Vector2(-26, -110));
        expandedCard.gameObject.AddComponent<Image>().color = new Color(0.015f, 0.035f, 0.06f, 0.98f);
        AddMapImage(expandedCard, new Vector2(20, 20), new Vector2(-20, -94));
        AddText(expandedCard, "NAVIGATION MAP  ·  YOUR POSITION IS MINT", 25, new Vector2(28, 14), new Vector2(-190, 74), new Color(0.45f, 0.83f, 0.95f), font);
        expandedMessage = AddText(expandedCard, "", 30, new Vector2(36, 110), new Vector2(-36, 250), Color.white, font, true);
        var close = CreateRect("Close", expandedCard, new Vector2(1, 0), new Vector2(1, 0), new Vector2(-150, 14), new Vector2(-24, 74));
        close.gameObject.AddComponent<Image>().color = new Color(0.12f, 0.31f, 0.4f, 1f);
        close.gameObject.AddComponent<Button>().onClick.AddListener(() => expandedCard.gameObject.SetActive(false));
        AddText(close, "×  CLOSE", 22, Vector2.zero, Vector2.zero, Color.white, font, true);
        expandedCard.gameObject.SetActive(false);

        if (FindAnyObjectByType<EventSystem>() == null)
        {
#if ENABLE_INPUT_SYSTEM
            new GameObject("MapEventSystem", typeof(EventSystem), typeof(InputSystemUIInputModule));
#else
            new GameObject("MapEventSystem", typeof(EventSystem), typeof(StandaloneInputModule));
#endif
        }
    }

    void OpenExpandedModel()
    {
#if UNITY_IOS && !UNITY_EDITOR
        var missing = new List<string>();
        if (string.IsNullOrEmpty(appleModelPath) || !File.Exists(appleModelPath)) missing.Add("structure.usdz");
        if (string.IsNullOrEmpty(buildingJsonPath) || !File.Exists(buildingJsonPath)) missing.Add("building.json");
        if (string.IsNullOrEmpty(scanJsonPath) || !File.Exists(scanJsonPath)) missing.Add("scan-features.json");
        if (missing.Count == 0)
        {
            GnarlyShowRoomModel(appleModelPath, buildingJsonPath, scanJsonPath, gameObject.name);
            return;
        }
        var error = "The interactive map package is incomplete: missing " + string.Join(", ", missing) + ". Re-upload this scan from the mapper.";
        Debug.LogError("[Gnarly] " + error);
        if (expandedMessage != null) expandedMessage.text = error;
#endif
        // Editor fallback keeps the same map visible for layout inspection; iPhone uses RealityKit.
        expandedCard.gameObject.SetActive(true);
    }

    void AddMapImage(RectTransform parent, Vector2 insetMin, Vector2 insetMax)
    {
        var image = CreateRect("MapImage", parent, Vector2.zero, Vector2.one, insetMin, insetMax).gameObject.AddComponent<RawImage>();
        image.texture = renderTexture;
        image.color = Color.white;
        image.raycastTarget = false;
    }

    static Text AddText(RectTransform parent, string text, int size, Vector2 offsetMin, Vector2 offsetMax, Color color, Font font, bool centered = false)
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
        label.raycastTarget = false;
        return label;
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

    static bool ValidVector(float[] vector) => vector != null && vector.Length >= 3;

    static Quaternion ToUnityRotation(float[] transform, bool floor)
    {
        if (transform == null || transform.Length != 16)
            return floor ? Quaternion.identity : Quaternion.identity;
        var up = new Vector3(transform[4], transform[5], -transform[6]);
        var forward = new Vector3(transform[8], transform[9], -transform[10]);
        if (up.sqrMagnitude < 0.0001f || forward.sqrMagnitude < 0.0001f) return Quaternion.identity;
        return Quaternion.LookRotation(forward.normalized, up.normalized);
    }

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
        if (graphMaterial != null) Destroy(graphMaterial);
        if (routeMaterial != null) Destroy(routeMaterial);
        if (wallMaterial != null) Destroy(wallMaterial);
        if (floorMaterial != null) Destroy(floorMaterial);
        if (openingMaterial != null) Destroy(openingMaterial);
        if (objectMaterial != null) Destroy(objectMaterial);
        mapRoot = null;
        mapCamera = null;
        compactCard = null;
        expandedCard = null;
        renderTexture = null;
    }

    void OnDestroy() => Clear();
}
