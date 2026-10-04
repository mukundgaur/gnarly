using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// Draws a highlighted path through the route's waypoints.
/// </summary>
public class RouteNavigator : MonoBehaviour
{
    [SerializeField] Color pathColor = new Color(0.1f, 0.9f, 1f, 0.85f);
    [SerializeField] float pathWidth = 0.25f;
    [Tooltip("Height change (m) applied when route.json uses heightReference \"device\", to move phone-height waypoints down to the floor.")]
    [SerializeField] float deviceHeightToFloor = -1.3f;
    [Tooltip("Horizontal distance (m) at which an intermediate waypoint counts as reached.")]
    [SerializeField] float reachRadius = 0.15f;
    [Tooltip("Horizontal distance (m) from the walked route segment that advances nearby intermediate anchors.")]
    [SerializeField] float pathRecognitionRadius = 1.25f;
    [Tooltip("Horizontal distance (m) to the final waypoint that counts as arrival.")]
    [SerializeField] float arriveRadius = 0.75f;
    // Old scenes serialized this at 1 m. Never allow a saved value to make the generated
    // sub-metre guidance points get skipped at runtime.
    const float MaximumIntermediateReachRadius = 0.18f;

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

    public bool IsActive => route != null;
    public bool HasArrived { get; private set; }
    public string TargetWaypointId =>
        route?.waypoints == null || route.waypoints.Length == 0
            ? null
            : route.waypoints[Mathf.Clamp(targetIndex, 0, route.waypoints.Length - 1)].id;
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
        targetIndex = NextWaypointAfterClosestPathPoint(arCamera.transform.position);
    }

    public void SetVisible(bool isVisible)
    {
        visible = isVisible;
        if (line != null) line.enabled = isVisible;
        foreach (var marker in markers) marker.SetActive(isVisible);
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

    /// <summary>
    /// Starts guidance at the point after the user's nearest location on the route polyline,
    /// rather than at the nearest vertex. A dense point that is a few centimetres behind the user
    /// would otherwise make the first instruction say "Turn around" and draw a triangle back over
    /// an already-walked segment.
    /// </summary>
    int NextWaypointAfterClosestPathPoint(Vector3 position)
    {
        if (route.waypoints.Length < 2) return 0;

        var next = 1;
        var nearestDistanceSquared = float.MaxValue;
        var flatPosition = new Vector2(position.x, position.z);
        for (var i = 0; i < route.waypoints.Length - 1; i++)
        {
            var a = WaypointWorld(i);
            var b = WaypointWorld(i + 1);
            var segment = new Vector2(b.x - a.x, b.z - a.z);
            var lengthSquared = segment.sqrMagnitude;
            if (lengthSquared < 1e-6f) continue;

            var t = Mathf.Clamp01(Vector2.Dot(flatPosition - new Vector2(a.x, a.z), segment) / lengthSquared);
            var closest = new Vector2(a.x, a.z) + segment * t;
            var distanceSquared = (flatPosition - closest).sqrMagnitude;
            if (distanceSquared < nearestDistanceSquared)
            {
                nearestDistanceSquared = distanceSquared;
                next = i + 1;
            }
        }
        return next;
    }

    void AdvanceTarget(Vector3 cameraPosition)
    {
        var last = route.waypoints.Length - 1;
        var intermediateReachRadius = Mathf.Clamp(reachRadius, 0.1f, MaximumIntermediateReachRadius);
        var corridorRadius = Mathf.Clamp(pathRecognitionRadius, intermediateReachRadius, 2.5f);
        // Guidance points are dense visual anchors, not spots the user must step directly on.
        // Once the user is inside the corridor around the segment leading to an anchor, hide that
        // already-walked portion of the blue path and continue toward the next anchor.
        while (targetIndex < last && IsAtOrNearPathSegment(cameraPosition, targetIndex, corridorRadius))
            targetIndex++;

        if (targetIndex == last && HorizontalDistance(cameraPosition, WaypointWorld(last)) < arriveRadius)
            HasArrived = true;
    }

    bool IsAtOrNearPathSegment(Vector3 position, int endpointIndex, float corridorRadius)
    {
        if (endpointIndex <= 0) return false;
        return HorizontalDistanceToSegment(position, WaypointWorld(endpointIndex - 1), WaypointWorld(endpointIndex)) < corridorRadius;
    }

    static float HorizontalDistanceToSegment(Vector3 point, Vector3 start, Vector3 end)
    {
        var flatPoint = new Vector2(point.x, point.z);
        var flatStart = new Vector2(start.x, start.z);
        var segment = new Vector2(end.x - start.x, end.z - start.z);
        var lengthSquared = segment.sqrMagnitude;
        if (lengthSquared < 1e-6f) return Vector2.Distance(flatPoint, flatStart);

        var t = Mathf.Clamp01(Vector2.Dot(flatPoint - flatStart, segment) / lengthSquared);
        return Vector2.Distance(flatPoint, flatStart + segment * t);
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
                // Fine route targets are breadcrumbs, not the larger graph/place nodes. Showing
                // them makes the 20 cm guidance route readable without filling the room.
                marker.transform.localScale = Vector3.one * (isGuidancePoint ? 0.045f : 0.12f);
                marker.transform.localPosition = basePosition + Vector3.up * 0.06f;
            }

            var renderer = marker.GetComponent<Renderer>();
            renderer.sharedMaterial = material;
            renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            markers.Add(marker);
        }
    }

}
