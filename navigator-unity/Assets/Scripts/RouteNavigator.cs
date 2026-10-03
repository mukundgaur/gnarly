using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;

/// <summary>
/// Draws a highlighted path through the route's waypoints and, when the next waypoint is off-screen,
/// an arrow at the screen edge pointing toward it.
/// </summary>
public class RouteNavigator : MonoBehaviour
{
    [SerializeField] Color pathColor = new Color(0.1f, 0.9f, 1f, 0.85f);
    [SerializeField] float pathWidth = 0.25f;
    [Tooltip("Height change (m) applied when route.json uses heightReference \"device\", to move phone-height waypoints down to the floor.")]
    [SerializeField] float deviceHeightToFloor = -1.3f;
    [Tooltip("Horizontal distance (m) at which an intermediate waypoint counts as reached.")]
    [SerializeField] float reachRadius = 0.3f;
    [Tooltip("Horizontal distance (m) to the final waypoint that counts as arrival.")]
    [SerializeField] float arriveRadius = 0.75f;
    [Tooltip("Fraction of the screen edge treated as out of view.")]
    [SerializeField] float viewportMargin = 0.1f;

    // Old scenes serialized this at 1 m. Never allow a saved value to make the generated
    // sub-metre guidance points get skipped at runtime.
    const float MaximumIntermediateReachRadius = 0.35f;

    Route route;
    Transform sessionSpace;
    Camera arCamera;
    int targetIndex;
    bool visible = true;
    float heightOffset;

    Material material;
    LineRenderer line;
    readonly List<GameObject> markers = new List<GameObject>();
    readonly List<Vector3> linePoints = new List<Vector3>();

    RectTransform canvasRect;
    RectTransform arrow;
    RectTransform arrowBackdrop;
    RectTransform arrowLabelRect;
    Text arrowLabel;

    public bool IsActive => route != null;
    public bool HasArrived { get; private set; }
    public string StatusMessage { get; private set; } = "";

    public void Begin(Route route, Transform sessionSpace, Camera arCamera)
    {
        Clear();
        this.route = route;
        this.sessionSpace = sessionSpace;
        this.arCamera = arCamera;
        HasArrived = false;
        visible = true;
        heightOffset = route.IsDeviceHeight ? deviceHeightToFloor : 0f;

        material = new Material(Shader.Find("Sprites/Default"));
        BuildPath();
        BuildArrowUi();
        targetIndex = NearestWaypointIndex(arCamera.transform.position);
    }

    public void SetVisible(bool isVisible)
    {
        visible = isVisible;
        if (line != null) line.enabled = isVisible;
        foreach (var marker in markers) marker.SetActive(isVisible);
        if (!isVisible) SetArrowActive(false);
    }

    /// <summary>
    /// Copies the world-space polyline still ahead of the user, starting at their position on the path.
    /// Empty when navigation is inactive or the destination has been reached.
    /// </summary>
    public bool CopyUpcomingPath(List<Vector3> destination)
    {
        destination.Clear();
        if (route == null || !visible || HasArrived || linePoints.Count < 2) return false;
        destination.AddRange(linePoints);
        return true;
    }

    public void Clear()
    {
        route = null;
        foreach (var marker in markers) Destroy(marker);
        markers.Clear();
        if (line != null) Destroy(line.gameObject);
        if (canvasRect != null) Destroy(canvasRect.gameObject);
        if (material != null) Destroy(material);
        StatusMessage = "";
    }

    void OnDestroy() => Clear();

    void Update()
    {
        if (route == null || !visible) return;

        var cameraPosition = arCamera.transform.position;
        AdvanceTarget(cameraPosition);
        UpdateLine(cameraPosition);
        UpdateArrow(WaypointWorld(targetIndex));
        UpdateStatus(cameraPosition);

        var pulse = 0.75f + 0.25f * Mathf.Sin(Time.time * 4f);
        var color = new Color(pathColor.r, pathColor.g, pathColor.b, pathColor.a * pulse);
        line.startColor = color;
        line.endColor = color;
    }

    Vector3 WaypointWorld(int index) =>
        sessionSpace.TransformPoint(route.SessionSpacePosition(index) + Vector3.up * heightOffset);

    static float HorizontalDistance(Vector3 a, Vector3 b) =>
        Vector2.Distance(new Vector2(a.x, a.z), new Vector2(b.x, b.z));

    int NearestWaypointIndex(Vector3 position)
    {
        var nearest = 0;
        var nearestDistance = float.MaxValue;
        for (var i = 0; i < route.waypoints.Length; i++)
        {
            var distance = HorizontalDistance(position, WaypointWorld(i));
            if (distance < nearestDistance)
            {
                nearest = i;
                nearestDistance = distance;
            }
        }
        return nearest;
    }

    void AdvanceTarget(Vector3 cameraPosition)
    {
        var last = route.waypoints.Length - 1;
        var intermediateReachRadius = Mathf.Clamp(reachRadius, 0.1f, MaximumIntermediateReachRadius);
        while (targetIndex < last && HorizontalDistance(cameraPosition, WaypointWorld(targetIndex)) < intermediateReachRadius)
            targetIndex++;

        if (targetIndex == last && HorizontalDistance(cameraPosition, WaypointWorld(last)) < arriveRadius)
            HasArrived = true;
    }

    void UpdateLine(Vector3 cameraPosition)
    {
        linePoints.Clear();
        var target = WaypointWorld(targetIndex);
        linePoints.Add(new Vector3(cameraPosition.x, target.y, cameraPosition.z));
        for (var i = targetIndex; i < route.waypoints.Length; i++)
            linePoints.Add(WaypointWorld(i));

        line.positionCount = linePoints.Count;
        line.SetPositions(linePoints.ToArray());
    }

    void UpdateStatus(Vector3 cameraPosition)
    {
        if (HasArrived)
        {
            StatusMessage = "You have arrived";
            return;
        }

        var remaining = HorizontalDistance(cameraPosition, WaypointWorld(targetIndex));
        for (var i = targetIndex; i < route.waypoints.Length - 1; i++)
            remaining += Vector3.Distance(WaypointWorld(i), WaypointWorld(i + 1));
        StatusMessage = $"Follow the path · {remaining:0.0} m to go";
    }

    void UpdateArrow(Vector3 targetWorld)
    {
        var local = arCamera.transform.InverseTransformPoint(targetWorld);
        var viewport = arCamera.WorldToViewportPoint(targetWorld);
        var onScreen = local.z > 0 &&
                       viewport.x > viewportMargin && viewport.x < 1 - viewportMargin &&
                       viewport.y > viewportMargin && viewport.y < 1 - viewportMargin;

        if (HasArrived || onScreen)
        {
            SetArrowActive(false);
            return;
        }

        // Behind the user only left/right is meaningful.
        var direction = new Vector2(local.x, local.z < 0 ? 0 : local.y);
        if (direction.sqrMagnitude < 1e-4f) direction = Vector2.right;
        direction.Normalize();

        var half = canvasRect.rect.size * 0.5f - new Vector2(120, 220);
        var scale = Mathf.Min(
            Mathf.Abs(direction.x) > 1e-4f ? half.x / Mathf.Abs(direction.x) : float.MaxValue,
            Mathf.Abs(direction.y) > 1e-4f ? half.y / Mathf.Abs(direction.y) : float.MaxValue);
        var edgePosition = direction * scale;

        arrow.anchoredPosition = edgePosition;
        arrowBackdrop.anchoredPosition = edgePosition;
        arrow.localEulerAngles = new Vector3(0, 0, Mathf.Atan2(direction.y, direction.x) * Mathf.Rad2Deg);
        arrowLabelRect.anchoredPosition = edgePosition - direction * 170f;

        var yaw = Mathf.Atan2(local.x, local.z) * Mathf.Rad2Deg;
        if (Mathf.Abs(yaw) > 135f) arrowLabel.text = "Turn around";
        else if (Mathf.Abs(direction.x) >= Mathf.Abs(direction.y)) arrowLabel.text = direction.x > 0 ? "Turn right" : "Turn left";
        else arrowLabel.text = direction.y > 0 ? "Look up" : "Look down";

        SetArrowActive(true);
    }

    void SetArrowActive(bool active)
    {
        if (arrow != null) arrow.gameObject.SetActive(active);
        if (arrowBackdrop != null) arrowBackdrop.gameObject.SetActive(active);
        if (arrowLabelRect != null) arrowLabelRect.gameObject.SetActive(active);
    }

    void BuildPath()
    {
        var lineObject = new GameObject("RoutePath");
        // TransformZ alignment with Z pointing up makes the ribbon lie flat on the floor.
        lineObject.transform.rotation = Quaternion.Euler(-90f, 0f, 0f);
        line = lineObject.AddComponent<LineRenderer>();
        line.useWorldSpace = true;
        line.alignment = LineAlignment.TransformZ;
        line.widthMultiplier = pathWidth;
        line.numCornerVertices = 4;
        line.numCapVertices = 4;
        line.sharedMaterial = material;
        line.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        line.receiveShadows = false;

        var last = route.waypoints.Length - 1;
        for (var i = 0; i <= last; i++)
        {
            var isDestination = i == last;
            var isGuidancePoint = Route.IsGuidanceWaypoint(route.waypoints[i]);
            // Interpolated guidance points make the arrow and corridor precise without filling
            // the room with a visible marble every half metre.
            if (isGuidancePoint && !isDestination) continue;
            var marker = GameObject.CreatePrimitive(isDestination ? PrimitiveType.Cylinder : PrimitiveType.Sphere);
            marker.name = isDestination ? "RouteDestination" : $"Waypoint-{route.waypoints[i].id}";
            Destroy(marker.GetComponent<Collider>());
            marker.transform.SetParent(sessionSpace, false);

            var basePosition = route.SessionSpacePosition(i) + Vector3.up * heightOffset;
            if (isDestination)
            {
                marker.transform.localScale = new Vector3(0.3f, 0.6f, 0.3f);
                marker.transform.localPosition = basePosition + Vector3.up * 0.6f;
            }
            else
            {
                marker.transform.localScale = Vector3.one * 0.12f;
                marker.transform.localPosition = basePosition;
            }

            var renderer = marker.GetComponent<Renderer>();
            renderer.sharedMaterial = material;
            renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            markers.Add(marker);
        }
    }

    void BuildArrowUi()
    {
        var canvasObject = new GameObject("RouteArrowCanvas", typeof(Canvas), typeof(CanvasScaler));
        var canvas = canvasObject.GetComponent<Canvas>();
        canvas.renderMode = RenderMode.ScreenSpaceOverlay;
        canvas.sortingOrder = 10;
        var scaler = canvasObject.GetComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = new Vector2(1170, 2532);
        canvasRect = (RectTransform)canvasObject.transform;

        arrowBackdrop = new GameObject("TurnArrowBackdrop", typeof(RectTransform)).GetComponent<RectTransform>();
        arrowBackdrop.SetParent(canvasRect, false);
        arrowBackdrop.sizeDelta = new Vector2(220, 220);
        arrowBackdrop.gameObject.AddComponent<Image>().color = new Color(0.02f, 0.08f, 0.12f, 0.86f);

        arrow = new GameObject("TurnArrow", typeof(RectTransform)).GetComponent<RectTransform>();
        arrow.SetParent(canvasRect, false);
        arrow.sizeDelta = new Vector2(180, 180);
        var arrowImage = arrow.gameObject.AddComponent<Image>();
        arrowImage.sprite = CreateArrowSprite();
        arrowImage.color = pathColor;
        arrowImage.raycastTarget = false;
        arrow.gameObject.AddComponent<Outline>().effectColor = new Color(0f, 0f, 0f, 0.75f);

        arrowLabelRect = new GameObject("TurnLabel", typeof(RectTransform)).GetComponent<RectTransform>();
        arrowLabelRect.SetParent(canvasRect, false);
        arrowLabelRect.sizeDelta = new Vector2(400, 100);
        arrowLabel = arrowLabelRect.gameObject.AddComponent<Text>();
        arrowLabel.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        arrowLabel.fontSize = 52;
        arrowLabel.fontStyle = FontStyle.Bold;
        arrowLabel.alignment = TextAnchor.MiddleCenter;
        arrowLabel.color = Color.white;
        arrowLabel.raycastTarget = false;
        arrowLabelRect.gameObject.AddComponent<Outline>().effectColor = new Color(0, 0, 0, 0.8f);

        SetArrowActive(false);
    }

    /// <summary>A right-pointing triangle, so the arrow's rotation equals the screen-space direction angle.</summary>
    static Sprite CreateArrowSprite()
    {
        const int size = 128;
        var texture = new Texture2D(size, size, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Clamp };
        var pixels = new Color32[size * size];
        for (var y = 0; y < size; y++)
        {
            var halfHeight = (size - 1) * 0.5f;
            var distanceFromCenter = Mathf.Abs(y - halfHeight);
            for (var x = 0; x < size; x++)
            {
                var inside = distanceFromCenter <= halfHeight * (1f - x / (float)(size - 1));
                pixels[y * size + x] = inside ? new Color32(255, 255, 255, 255) : new Color32(0, 0, 0, 0);
            }
        }
        texture.SetPixels32(pixels);
        texture.Apply();
        return Sprite.Create(texture, new Rect(0, 0, size, size), new Vector2(0.5f, 0.5f));
    }
}
