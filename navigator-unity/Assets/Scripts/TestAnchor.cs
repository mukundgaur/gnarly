using System;
using UnityEngine;

/// <summary>Mirrors shared/test-anchor.schema.json.</summary>
[Serializable]
public class TestAnchor
{
    public int schemaVersion;
    public string zoneId;
    public float[] position;
    public string coordinateSystem;
    public string capturedAt;
    public string notes;

    public static TestAnchor Parse(string json, string expectedZoneId)
    {
        var anchor = JsonUtility.FromJson<TestAnchor>(json);
        if (anchor == null)
            throw new FormatException("test-anchor.json is empty or invalid.");
        if (anchor.schemaVersion != 1)
            throw new FormatException($"Unsupported schemaVersion {anchor.schemaVersion}.");
        if (anchor.coordinateSystem != "arkit-world-meters")
            throw new FormatException($"Unsupported coordinateSystem '{anchor.coordinateSystem}'.");
        if (anchor.zoneId != expectedZoneId)
            throw new FormatException($"Anchor is for zone '{anchor.zoneId}', expected '{expectedZoneId}'.");
        if (anchor.position == null || anchor.position.Length != 3)
            throw new FormatException("position must be [x, y, z].");
        return anchor;
    }

    /// <summary>
    /// ARKit is right-handed and Unity is left-handed; the ARKit XR Plug-in converts by negating Z.
    /// </summary>
    public Vector3 ToUnitySessionSpace() => new Vector3(position[0], position[1], -position[2]);
}
