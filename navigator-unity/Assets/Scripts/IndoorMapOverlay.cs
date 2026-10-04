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

/// <summary>A selectable graph node shown in the route planner.</summary>
public sealed class MapPlace
{
    /// <summary>Combined-graph key (<see cref="Pathfinding.ZoneKey"/>).</summary>
    public string key;
    public string localId;
    public string zone;
    public string name;
    /// <summary>destination, entrance, room, elevator, continuation, stairs, door, opening, or waypoint.</summary>
    public string kind;
    /// <summary>Named places are listed and labelled; minor ones (doors, openings) are only map dots.</summary>
    public bool major;
    public bool inCurrentZone;
    /// <summary>Unity session-space position; only meaningful when <see cref="inCurrentZone"/>.</summary>
    public Vector3 sessionPosition;
    /// <summary>
    /// Authored building-layout position used only by the full-screen picker. This deliberately
    /// never participates in ARKit relocalization or AR guidance coordinates.
    /// </summary>
    public Vector3 plannerPosition;
    public bool hasPlannerPosition;

    public string KindLabel => kind switch
    {
        "destination" => "Destination",
        "entrance" => "Entrance",
        "room" => "Room",
        "elevator" => "Elevator",
        "continuation" => "Zone connector",
        "stairs" => "Stairs",
        "door" => "Door",
        "opening" => "Opening",
        _ => "Point"
    };

    public Color Color => kind switch
    {
        "destination" => MapUi.PlaceDestination,
        "entrance" => MapUi.PlaceEntrance,
        "room" => MapUi.PlaceRoom,
        "elevator" => MapUi.PlaceElevator,
        "continuation" => MapUi.PlaceEntrance,
        "stairs" => MapUi.PlaceStairs,
        _ => MapUi.PlaceMinor
    };
}

/// <summary>The controller's A* answer for the planner's current start/destination.</summary>
public sealed class RoutePreview
{
    public bool ok;
    public string error;
    /// <summary>The part of the route inside the zone shown on the map, or null.</summary>
    public Route mapRoute;
    /// <summary>
    /// Connector on the zone shown on the map. Set when the destination is in another zone:
    /// an elevator onto the next floor, or a continuation into another scan of the same space.
    /// The route leads here, and this node is the waypoint out of the zone being shown.
    /// </summary>
    public string waypointKey;
    public string summary;
    public string details;
}

/// <summary>
/// Top-right minimap plus a full-screen route planner for choosing start and destination points.
///
/// Both render normalized RoomPlan geometry into a Unity RenderTexture. On iPhone, the planner can also
/// open the original structure.usdz in RealityKit, which reports its selection back to the controller.
/// </summary>
public partial class IndoorMapOverlay : MonoBehaviour
{
    const int MapLayer = 30;
    const int CompactTextureSize = 768;
    const int MarkerQueue = 3200;
    const int RouteQueue = 3100;
    const float CompactPitch = 61f;

    Transform sessionSpace;
    Camera arCamera;
    Transform mapRoot;
    Transform markerRoot;
    Camera mapCamera;
    RenderTexture compactTexture;
    RectTransform canvasRoot;
    RectTransform compactCard;
    Text compactCaption;
    Button compactModeButton;
    Transform activeRouteRoot;
    Transform previewRouteRoot;
    Transform userMarker;
    Transform startPin;
    Transform destinationPin;
    readonly List<Material> materials = new List<Material>();
    readonly Dictionary<Color, Material> markerMaterials = new Dictionary<Color, Material>();
    readonly List<(Transform marker, float scale)> scaledMarkers = new List<(Transform, float)>();
    readonly List<LineRenderer> routeLines = new List<LineRenderer>();
    Material routeMaterial;
    Material previewMaterial;
    Material wallMaterial;
    Material floorMaterial;
    Material openingMaterial;
    Material objectMaterial;
    SurfaceColors surfaceColors;
    Material photoMaterial;
    readonly List<Mesh> photoMeshes = new List<Mesh>();
    readonly Dictionary<Color32, Material> surfaceMaterials = new Dictionary<Color32, Material>();
    Vector3 center;
    float span = 8f;
    float markerSize = 0.2f;
    float lineWidth = 0.1f;
    Vector3 compactCenter;
    float compactSpan;
    bool showingBuildingPlanner;
    Vector3 currentZonePlannerOffset;
    float currentZonePlannerRotation;
    string appleModelPath;
    string buildingJsonPath;
    string scanJsonPath;

    // Camera framing. The compact card uses an oblique overview; the planner uses a pannable top-down view.
    bool topDown = true;
    bool compactTopDown = true;
    Vector3 cameraFocus;
    float zoom = 1f;

#if UNITY_IOS && !UNITY_EDITOR
    [DllImport("__Internal")]
    static extern void GnarlyShowRoomModel(
        string absolutePath,
        string buildingPath,
        string scanPath,
        string callbackObjectName,
        string selectionJson);
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

    public void Configure(
        Pathfinding.ScanFeatures scan,
        Pathfinding.Graph graph,
        Transform sessionTransform,
        Camera camera,
        SurfaceColors colors = null)
    {
        Clear();
        surfaceColors = colors;
        sessionSpace = sessionTransform;
        arCamera = camera;
        topDown = compactTopDown;
        // The map model lives at true scale in session space; only the map camera may draw it.
        if (arCamera != null) arCamera.cullingMask &= ~(1 << MapLayer);
        BuildMapRoot();
        CalculateMapBounds(scan);
        BuildScanGeometry(scan);
        BuildUserMarker();
        BuildSelectionPins();
        BuildCamera();
        BuildUi();
    }

    /// <summary>Sets the active zone's authored display transform for the full-screen building map.</summary>
    public void SetPlannerCurrentZoneTransform(Vector3 offset, float rotationDegrees)
    {
        currentZonePlannerOffset = offset;
        currentZonePlannerRotation = rotationDegrees;
    }

    /// <summary>The route being followed in AR, drawn on both map views and the native model.</summary>
    public void SetRoute(Route route)
    {
        if (activeRouteRoot == null) return;
        DrawRoute(activeRouteRoot, route, routeMaterial, 1f, null);
#if UNITY_IOS && !UNITY_EDITOR
        if (route != null) GnarlySetRoomModelRoute(JsonUtility.ToJson(route));
#endif
    }

    public void SetExpandedStatus(string message)
    {
#if UNITY_IOS && !UNITY_EDITOR
        GnarlySetRoomModelStatus(message ?? "");
#endif
        if (!string.IsNullOrEmpty(message) && IsPlannerOpen) ShowPlannerHint(message, true);
    }

    /// <summary>One-line caption under the minimap, e.g. the active destination.</summary>
    public void SetCompactCaption(string caption)
    {
        if (compactCaption != null)
            compactCaption.text = string.IsNullOrEmpty(caption) ? "MAP  ·  TAP TO PLAN A ROUTE" : caption;
    }

    void Update()
    {
        if (userMarker == null || sessionSpace == null || arCamera == null) return;
        var position = sessionSpace.InverseTransformPoint(arCamera.transform.position);
        var localMapPosition = new Vector3(position.x, FloorHeight(position.y), position.z);
        userMarker.localPosition = showingBuildingPlanner
            ? Quaternion.Euler(0f, currentZonePlannerRotation, 0f) * localMapPosition + currentZonePlannerOffset
            : localMapPosition;
#if UNITY_IOS && !UNITY_EDITOR
        // RoomPlan/USDZ uses ARKit's right-handed Z axis; Unity mirrors Z on import.
        GnarlyUpdateRoomModelPosition(position.x, position.y, -position.z);
#endif
        var forward = sessionSpace.InverseTransformDirection(arCamera.transform.forward);
        forward.y = 0f;
        if (forward.sqrMagnitude > 0.001f)
            userMarker.localRotation = Quaternion.Euler(0f, showingBuildingPlanner ? currentZonePlannerRotation : 0f, 0f) *
                Quaternion.LookRotation(forward.normalized, Vector3.up);
    }

    void LateUpdate()
    {
        if (mapCamera == null || sessionSpace == null) return;
        ApplyCamera();

        // Keep markers and lines a constant on-screen size while zooming the planner.
        var markerScale = topDown ? Mathf.Clamp(1f / zoom, 0.3f, 1.2f) : 1f;
        foreach (var (marker, scale) in scaledMarkers)
            if (marker != null) marker.localScale = new Vector3(scale * markerScale, marker.localScale.y, scale * markerScale);
        foreach (var line in routeLines)
            if (line != null) line.widthMultiplier = lineWidth * markerScale;

        var pulse = 1f + 0.18f * Mathf.Sin(Time.unscaledTime * 4f);
        if (startPin != null && startPin.gameObject.activeSelf)
            startPin.localScale = Vector3.one * (pulse * markerScale);
        if (destinationPin != null && destinationPin.gameObject.activeSelf)
            destinationPin.localScale = Vector3.one * (pulse * markerScale);

        UpdatePlannerOverlays();
    }

    float FloorHeight(float fallback) => float.IsNaN(mapFloorY) ? fallback : mapFloorY + 0.05f;
    float mapFloorY = float.NaN;

    void BuildMapRoot()
    {
        mapRoot = new GameObject("IndoorMapModel").transform;
        mapRoot.SetParent(sessionSpace, false);
        SetLayer(mapRoot.gameObject, MapLayer);
        markerRoot = Child("Places", mapRoot);
        activeRouteRoot = Child("ActiveRoute", mapRoot);
        previewRouteRoot = Child("PreviewRoute", mapRoot);

        routeMaterial = MakeMaterial(MapUi.Accent, RouteQueue);
        previewMaterial = MakeMaterial(MapUi.Preview, RouteQueue + 1);
        wallMaterial = MakeMaterial(new Color(0.66f, 0.76f, 0.82f, 0.9f));
        floorMaterial = MakeMaterial(new Color(0.11f, 0.2f, 0.25f, 1f));
        openingMaterial = MakeMaterial(new Color(0.24f, 0.72f, 0.9f, 0.72f));
        objectMaterial = MakeMaterial(new Color(0.35f, 0.48f, 0.55f, 0.88f));
    }

    Transform Child(string name, Transform parent)
    {
        var child = new GameObject(name).transform;
        child.SetParent(parent, false);
        child.gameObject.layer = MapLayer;
        return child;
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
        if (scan.objects != null)
        {
            foreach (var item in scan.objects)
            {
                if (!ValidVector(item.position) || !ValidVector(item.dimensions)) continue;
                CreateScanBox("RoomPlanObject-" + item.category, item.position, item.dimensions,
                    item.transformColumnMajor, SurfaceMaterial(item.identifier, objectMaterial), false);
                AddPhotoFaces(item.identifier, item.position, item.dimensions, item.transformColumnMajor, true, 0f);
            }
        }
    }

    /// <summary>The surface's real average color when the mapper baked one; otherwise the default palette.</summary>
    Material SurfaceMaterial(string identifier, Material fallback)
    {
        var average = SurfaceColors.Average(surfaceColors?.Find(identifier));
        if (average == null) return fallback;
        Color32 key = average.Value;
        if (!surfaceMaterials.TryGetValue(key, out var material))
        {
            material = MakeMaterial(average.Value);
            surfaceMaterials[key] = material;
        }
        return material;
    }

    /// <summary>
    /// Adds photo-textured quads for each baked face. Corners are computed in ARKit space and then
    /// mirrored with ToUnity, so the handedness flip never touches the UV layout.
    /// </summary>
    void AddPhotoFaces(string identifier, float[] position, float[] dimensions, float[] transform, bool solid, float halfDepth)
    {
        if (surfaceColors?.atlas == null || transform == null || transform.Length != 16 || dimensions == null || dimensions.Length < 2) return;
        var surface = surfaceColors.Find(identifier);
        if (surface?.faces == null) return;
        var x = new Vector3(transform[0], transform[1], transform[2]).normalized;
        var y = new Vector3(transform[4], transform[5], transform[6]).normalized;
        var z = new Vector3(transform[8], transform[9], transform[10]).normalized;
        var center = new Vector3(position[0], position[1], position[2]);
        var d = new Vector3(Mathf.Abs(dimensions[0]), Mathf.Abs(dimensions[1]), dimensions.Length > 2 ? Mathf.Abs(dimensions[2]) : 0f);
        const float lift = 0.004f;
        foreach (var face in surface.faces)
        {
            if (face == null || !face.HasRect) continue;
            Vector3 offset, u, v;
            float width, height;
            switch (face.face)
            {
                case "px" when solid: offset = x * (d.x / 2 + lift); u = -z; v = y; width = d.z; height = d.y; break;
                case "nx" when solid: offset = -x * (d.x / 2 + lift); u = z; v = y; width = d.z; height = d.y; break;
                case "py" when solid: offset = y * (d.y / 2 + lift); u = x; v = -z; width = d.x; height = d.z; break;
                case "pz": offset = z * ((solid ? d.z / 2 : halfDepth) + lift); u = x; v = y; width = d.x; height = d.y; break;
                case "nz": offset = -z * ((solid ? d.z / 2 : halfDepth) + lift); u = -x; v = y; width = d.x; height = d.y; break;
                default: continue;
            }
            if (width < 0.01f || height < 0.01f) continue;
            // One renderer per face: Sprites/Default skips depth writes, so each face must sort
            // against the scan boxes by its own center.
            var faceCenter = center + offset;
            var vertices = new Vector3[4];
            var uvs = new Vector2[4];
            for (var corner = 0; corner < 4; corner++)
            {
                var cu = corner == 1 || corner == 2 ? 1f : 0f;
                var cv = corner >= 2 ? 1f : 0f;
                var arkit = u * ((cu - 0.5f) * width) + v * ((cv - 0.5f) * height);
                vertices[corner] = new Vector3(arkit.x, arkit.y, -arkit.z);
                uvs[corner] = surfaceColors.AtlasUV(face, cu, cv);
            }
            var mesh = new Mesh { name = "RoomPlanPhoto-" + face.face, vertices = vertices, uv = uvs, triangles = new[] { 0, 1, 2, 0, 2, 3 } };
            mesh.RecalculateBounds();
            photoMeshes.Add(mesh);
            if (photoMaterial == null)
            {
                photoMaterial = MakeMaterial(Color.white);
                photoMaterial.mainTexture = surfaceColors.atlas;
            }
            var photo = new GameObject(mesh.name);
            photo.transform.SetParent(mapRoot, false);
            photo.transform.localPosition = new Vector3(faceCenter.x, faceCenter.y, -faceCenter.z);
            photo.AddComponent<MeshFilter>().sharedMesh = mesh;
            photo.AddComponent<MeshRenderer>().sharedMaterial = photoMaterial;
            SetLayer(photo, MapLayer);
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
                // RoomPlan floor surfaces span local X/Y; local Z is the surface normal.
                // Keeping Y as the scanned depth prevents a floor from becoming a tall slab.
                dimensions[2] = 0.04f;
            }
            else if (dimensions[2] < 0.04f)
            {
                dimensions[2] = 0.06f;
            }
            CreateScanBox("RoomPlan-" + surface.category, surface.position, dimensions,
                surface.transformColumnMajor, SurfaceMaterial(surface.identifier, material), floor);
            AddPhotoFaces(surface.identifier, surface.position, surface.dimensions, surface.transformColumnMajor, false, dimensions[2] / 2f);
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
                var height = wall.dimensions != null && wall.dimensions.Length > 1 ? wall.dimensions[1] : 2.4f;
                var axis = WallAxis(wall.transformColumnMajor);
                points.Add(position + axis * (width * 0.5f));
                points.Add(position - axis * (width * 0.5f));
                var bottom = position.y - height * 0.5f;
                mapFloorY = float.IsNaN(mapFloorY) ? bottom : Mathf.Min(mapFloorY, bottom);
            }
        }

        if (points.Count == 0)
        {
            center = Vector3.zero;
            span = 8f;
        }
        else
        {
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
        if (!float.IsNaN(mapFloorY)) center.y = mapFloorY;
        markerSize = Mathf.Clamp(span * 0.024f, 0.16f, 0.5f);
        lineWidth = Mathf.Clamp(span * 0.012f, 0.07f, 0.24f);
    }

    void BuildUserMarker()
    {
        userMarker = Child("YourPosition", mapRoot);
        var halo = Primitive(PrimitiveType.Cylinder, "Halo", userMarker, MarkerMaterial(MapUi.WithAlpha(MapUi.User, 0.28f), 0));
        halo.localScale = new Vector3(markerSize * 2.6f, 0.01f, markerSize * 2.6f);
        var body = Primitive(PrimitiveType.Cylinder, "Body", userMarker, MarkerMaterial(MapUi.User, 2));
        body.localScale = new Vector3(markerSize * 1.4f, 0.02f, markerSize * 1.4f);
        var nose = Primitive(PrimitiveType.Cube, "Heading", userMarker, MarkerMaterial(MapUi.User, 2));
        nose.localPosition = new Vector3(0f, 0f, markerSize * 1.05f);
        nose.localRotation = Quaternion.Euler(0f, 45f, 0f);
        nose.localScale = new Vector3(markerSize * 0.75f, 0.02f, markerSize * 0.75f);
    }

    void BuildSelectionPins()
    {
        startPin = BuildPin("StartPin", MapUi.Start);
        destinationPin = BuildPin("DestinationPin", MapUi.Destination);
    }

    Transform BuildPin(string name, Color color)
    {
        var pin = Child(name, mapRoot);
        var ring = Primitive(PrimitiveType.Cylinder, "Ring", pin, MarkerMaterial(MapUi.WithAlpha(color, 0.3f), 3));
        ring.localScale = new Vector3(markerSize * 3.2f, 0.01f, markerSize * 3.2f);
        var core = Primitive(PrimitiveType.Sphere, "Core", pin, MarkerMaterial(color, 4));
        core.localScale = Vector3.one * (markerSize * 1.5f);
        var dot = Primitive(PrimitiveType.Sphere, "Center", pin, MarkerMaterial(Color.white, 5));
        dot.localScale = Vector3.one * (markerSize * 0.55f);
        dot.localPosition = Vector3.up * markerSize;
        pin.gameObject.SetActive(false);
        return pin;
    }

    Transform Primitive(PrimitiveType type, string name, Transform parent, Material material)
    {
        var primitive = GameObject.CreatePrimitive(type);
        primitive.name = name;
        primitive.transform.SetParent(parent, false);
        Destroy(primitive.GetComponent<Collider>());
        primitive.GetComponent<Renderer>().sharedMaterial = material;
        SetLayer(primitive, MapLayer);
        return primitive.transform;
    }

    /// <summary>Unlit transparent materials do not write depth, so draw order is set by render queue.</summary>
    Material MarkerMaterial(Color color, int queueOffset)
    {
        var key = new Color(color.r, color.g, color.b, color.a + queueOffset * 10f);
        if (markerMaterials.TryGetValue(key, out var material)) return material;
        material = MakeMaterial(color, MarkerQueue + queueOffset);
        markerMaterials[key] = material;
        return material;
    }

    void BuildPlaceMarkers(IReadOnlyList<MapPlace> places)
    {
        if (markerRoot == null) return;
        foreach (Transform child in markerRoot) Destroy(child.gameObject);
        scaledMarkers.Clear();
        if (places == null) return;
        foreach (var place in places)
        {
            if (!place.inCurrentZone && (!showingBuildingPlanner || !place.hasPlannerPosition)) continue;
            var size = place.major ? markerSize : markerSize * 0.6f;
            var marker = Primitive(PrimitiveType.Cylinder, "Place-" + place.localId, markerRoot,
                MarkerMaterial(place.Color, place.major ? 1 : 0));
            marker.localPosition = MapPosition(place);
            marker.localScale = new Vector3(size, 0.02f, size);
            scaledMarkers.Add((marker, size));
        }
    }

    Vector3 MarkerPosition(MapPlace place)
    {
        var position = place.sessionPosition;
        position.y = FloorHeight(position.y);
        return position;
    }

    /// <summary>Position in the map's current presentation mode: local AR zone or authored building plan.</summary>
    Vector3 MapPosition(MapPlace place)
    {
        if (showingBuildingPlanner && place.hasPlannerPosition) return place.plannerPosition;
        return MarkerPosition(place);
    }

    void DrawRoute(Transform root, Route route, Material material, float widthScale, Vector3? prefix)
    {
        foreach (Transform child in root) Destroy(child.gameObject);
        routeLines.RemoveAll(line => line == null || line.transform.parent == root);
        if (route?.waypoints == null || route.waypoints.Length == 0) return;

        var points = new List<Vector3>();
        if (prefix.HasValue) points.Add(prefix.Value);
        for (var i = 0; i < route.waypoints.Length; i++)
        {
            var point = route.SessionSpacePosition(i);
            point.y = FloorHeight(point.y) + 0.02f;
            points.Add(point);
        }

        var lineObject = new GameObject("Line");
        lineObject.transform.SetParent(root, false);
        lineObject.layer = MapLayer;
        var line = lineObject.AddComponent<LineRenderer>();
        line.useWorldSpace = false;
        line.widthMultiplier = lineWidth * widthScale;
        line.numCornerVertices = 4;
        line.numCapVertices = 4;
        line.sharedMaterial = material;
        line.positionCount = points.Count;
        line.SetPositions(points.ToArray());
        routeLines.Add(line);
    }

    void BuildCamera()
    {
        var cameraObject = new GameObject("IndoorMapCamera");
        mapCamera = cameraObject.AddComponent<Camera>();
        mapCamera.cullingMask = 1 << MapLayer;
        mapCamera.clearFlags = CameraClearFlags.SolidColor;
        mapCamera.backgroundColor = MapUi.MapBackground;
        mapCamera.orthographic = true;
        mapCamera.nearClipPlane = 0.01f;
        mapCamera.farClipPlane = 200f;
        compactTexture = new RenderTexture(CompactTextureSize, CompactTextureSize, 16, RenderTextureFormat.ARGB32);
        mapCamera.targetTexture = compactTexture;
        cameraFocus = center;
        ApplyCamera();
    }

    void ApplyCamera()
    {
        if (topDown)
        {
            mapCamera.orthographicSize = span * 0.58f / zoom;
            mapCamera.transform.SetPositionAndRotation(
                sessionSpace.TransformPoint(cameraFocus + Vector3.up * (span + 20f)),
                sessionSpace.rotation * Quaternion.Euler(90f, 0f, 0f));
        }
        else
        {
            mapCamera.orthographicSize = span * 0.62f / zoom;
            var offset = Quaternion.Euler(CompactPitch, 0f, 0f) * Vector3.back * (span + 20f);
            mapCamera.transform.SetPositionAndRotation(
                sessionSpace.TransformPoint(cameraFocus + offset),
                sessionSpace.rotation * Quaternion.Euler(CompactPitch, 0f, 0f));
        }
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
        canvasRoot = MapUi.Stretch("SafeArea", canvasObject.transform);
        canvasRoot.gameObject.AddComponent<SafeAreaPanel>();

        // The map stays below the guidance card and inside the device safe area.
        compactCard = MapUi.Rect("MiniMap", canvasRoot, Vector2.one, Vector2.one, new Vector2(-352, -632), new Vector2(-22, -220));
        var compactBackground = MapUi.Panel(compactCard, new Color(1f, 1f, 1f, 0.96f), 30f, true);
        var mapFrame = MapUi.Rect("MapFrame", compactCard, Vector2.zero, Vector2.one, new Vector2(12, 70), new Vector2(-12, -12));
        mapFrame.gameObject.AddComponent<RectMask2D>();
        var image = MapUi.Stretch("MapImage", mapFrame).gameObject.AddComponent<RawImage>();
        image.texture = compactTexture;
        image.raycastTarget = false;
        compactModeButton = MapUi.Button(MapUi.Rect("MapMode", mapFrame, new Vector2(0, 1), new Vector2(0, 1),
                new Vector2(14, -78), new Vector2(114, -14)), "3D", MapUi.Surface,
            MapUi.TextPrimary, 29, ToggleCompactMode, 25f);
        compactCaption = MapUi.Label(MapUi.Rect("Caption", compactCard, Vector2.zero, new Vector2(1, 0), new Vector2(18, 8), new Vector2(-18, 66)),
            "", 20, MapUi.Eyebrow, TextAnchor.MiddleCenter, FontStyle.Bold);
        SetCompactCaption(null);
        var compactButton = compactCard.gameObject.AddComponent<Button>();
        compactButton.targetGraphic = compactBackground;
        compactButton.onClick.AddListener(() => OpenPlanner(true));

        BuildPlanner();

        if (FindAnyObjectByType<EventSystem>() == null)
        {
#if ENABLE_INPUT_SYSTEM
            new GameObject("MapEventSystem", typeof(EventSystem), typeof(InputSystemUIInputModule));
#else
            new GameObject("MapEventSystem", typeof(EventSystem), typeof(StandaloneInputModule));
#endif
        }
    }

    void ToggleCompactMode()
    {
        compactTopDown = !compactTopDown;
        if (!IsPlannerOpen) topDown = compactTopDown;
        var label = MapUi.ButtonLabel(compactModeButton);
        if (label != null) label.text = compactTopDown ? "3D" : "2D";
    }

    /// <summary>Opens the RealityKit model with the planner's current selection. Returns an error, or null.</summary>
    string OpenNativeModel(string selectionJson)
    {
        Debug.Log("[Gnarly] Minimap tapped; opening expanded model.");
#if UNITY_IOS && !UNITY_EDITOR
        var missing = MissingNativeFiles();
        if (missing.Count > 0)
        {
            var error = "The 3D model package is incomplete: missing " + string.Join(", ", missing) + ". Re-upload this scan from the mapper.";
            Debug.LogError("[Gnarly] " + error);
            return error;
        }
        GnarlyShowRoomModel(appleModelPath, buildingJsonPath, scanJsonPath, gameObject.name, selectionJson ?? "");
        return null;
#else
        return "The 3D model view is only available on iPhone.";
#endif
    }

    List<string> MissingNativeFiles()
    {
        var missing = new List<string>();
        if (string.IsNullOrEmpty(appleModelPath) || !File.Exists(appleModelPath)) missing.Add("structure.usdz");
        if (string.IsNullOrEmpty(buildingJsonPath) || !File.Exists(buildingJsonPath)) missing.Add("building.json");
        if (string.IsNullOrEmpty(scanJsonPath) || !File.Exists(scanJsonPath)) missing.Add("scan-features.json");
        return missing;
    }

    bool NativeModelAvailable
    {
        get
        {
#if UNITY_IOS && !UNITY_EDITOR
            return !string.IsNullOrEmpty(appleModelPath) && File.Exists(appleModelPath);
#else
            return false;
#endif
        }
    }

    Material MakeMaterial(Color color, int renderQueue = -1)
    {
        var material = new Material(Shader.Find("Sprites/Default")) { color = color };
        if (renderQueue > 0) material.renderQueue = renderQueue;
        materials.Add(material);
        return material;
    }

    static Vector3 ToUnity(float[] arkit) => new Vector3(arkit[0], arkit[1], -arkit[2]);

    static bool ValidVector(float[] vector) => vector != null && vector.Length >= 3;

    static Quaternion ToUnityRotation(float[] transform, bool floor)
    {
        if (transform == null || transform.Length != 16) return Quaternion.identity;
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
        if (canvasRoot != null) Destroy(canvasRoot.parent != null ? canvasRoot.parent.gameObject : canvasRoot.gameObject);
        if (compactTexture != null) compactTexture.Release();
        ReleasePlannerTexture();
        foreach (var material in materials)
            if (material != null) Destroy(material);
        materials.Clear();
        markerMaterials.Clear();
        surfaceMaterials.Clear();
        photoMaterial = null;
        foreach (var mesh in photoMeshes)
            if (mesh != null) Destroy(mesh);
        photoMeshes.Clear();
        surfaceColors?.Dispose();
        surfaceColors = null;
        scaledMarkers.Clear();
        routeLines.Clear();
        mapRoot = null;
        markerRoot = null;
        mapCamera = null;
        canvasRoot = null;
        compactCard = null;
        compactCaption = null;
        compactTexture = null;
        userMarker = null;
        startPin = null;
        destinationPin = null;
        mapFloorY = float.NaN;
        topDown = false;
        zoom = 1f;
        ResetPlannerUi();
    }

    void OnDestroy() => Clear();
}
