using System;
using UnityEngine;

/// <summary>Mirrors shared/route.schema.json.</summary>
[Serializable]
public class Route
{
    [Serializable]
    public class Waypoint
    {
        public string id;
        public float[] position;
    }

    public int schemaVersion;
    public string zoneId;
    public string coordinateSystem;
    /// <summary>"floor" (default) or "device": whether waypoint heights are on the floor or at phone height.</summary>
    public string heightReference;
    public Waypoint[] waypoints;

    public bool IsDeviceHeight => heightReference == "device";

    public static Route Parse(string json, string expectedZoneId)
    {
        var route = JsonUtility.FromJson<Route>(json);
        if (route == null)
            throw new FormatException("route.json is empty or invalid.");
        if (route.schemaVersion != 1)
            throw new FormatException($"Unsupported route schemaVersion {route.schemaVersion}.");
        if (route.coordinateSystem != "arkit-world-meters")
            throw new FormatException($"Unsupported route coordinateSystem '{route.coordinateSystem}'.");
        if (route.zoneId != expectedZoneId)
            throw new FormatException($"Route is for zone '{route.zoneId}', expected '{expectedZoneId}'.");
        if (!string.IsNullOrEmpty(route.heightReference) && route.heightReference != "floor" && !route.IsDeviceHeight)
            throw new FormatException($"Unsupported heightReference '{route.heightReference}'.");
        if (route.waypoints == null || route.waypoints.Length < 2)
            throw new FormatException("A route needs at least two waypoints.");
        foreach (var waypoint in route.waypoints)
        {
            if (waypoint.position == null || waypoint.position.Length != 3)
                throw new FormatException($"Waypoint '{waypoint.id}' position must be [x, y, z].");
        }
        return route;
    }

    /// <summary>ARKit is right-handed and Unity is left-handed; the ARKit XR Plug-in converts by negating Z.</summary>
    public Vector3 SessionSpacePosition(int index)
    {
        var p = waypoints[index].position;
        return new Vector3(p[0], p[1], -p[2]);
    }
}
