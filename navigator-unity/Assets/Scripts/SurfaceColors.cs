using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;

/// <summary>
/// Real-world colors baked by the mapper from scan photos (surface-colors.json + surface-colors.jpg).
/// Faces follow the three.js BoxGeometry names in the RoomPlan feature's local ARKit frame; see
/// shared/surface-colors.schema.json.
/// </summary>
public sealed class SurfaceColors
{
    public const string JsonFileName = "surface-colors.json";
    public const string AtlasFileName = "surface-colors.jpg";

    [Serializable]
    public class Document
    {
        public int schemaVersion;
        public string zoneId;
        public int atlasWidth;
        public int atlasHeight;
        public Surface[] surfaces;
    }

    [Serializable]
    public class Surface
    {
        public string identifier;
        public string kind;
        public Face[] faces;
    }

    [Serializable]
    public class Face
    {
        public string face;
        public float[] color;
        public float coverage;
        public int[] rect;

        public bool HasRect => rect != null && rect.Length == 4 && rect[2] > 0 && rect[3] > 0;
        public Color32 Color32 => color != null && color.Length >= 3
            ? new Color32(ToByte(color[0]), ToByte(color[1]), ToByte(color[2]), 255)
            : new Color32(128, 128, 128, 255);

        static byte ToByte(float value) => (byte)Mathf.Clamp(Mathf.RoundToInt(value * 255f), 0, 255);
    }

    public Document document;
    public Texture2D atlas;
    readonly Dictionary<string, Surface> byIdentifier = new Dictionary<string, Surface>();

    public static Document Parse(string json)
    {
        var document = JsonUtility.FromJson<Document>(json);
        return document?.surfaces == null ? null : document;
    }

    /// <summary>Loads the optional color files from a cached zone package; null when absent or unreadable.</summary>
    public static SurfaceColors Load(string directory)
    {
        try
        {
            var jsonPath = Path.Combine(directory, JsonFileName);
            if (!File.Exists(jsonPath)) return null;
            var document = Parse(File.ReadAllText(jsonPath));
            if (document == null) return null;
            var result = new SurfaceColors { document = document };
            foreach (var surface in document.surfaces)
                if (!string.IsNullOrEmpty(surface?.identifier)) result.byIdentifier[surface.identifier] = surface;

            var atlasPath = Path.Combine(directory, AtlasFileName);
            if (document.atlasWidth > 0 && document.atlasHeight > 0 && File.Exists(atlasPath))
            {
                var texture = new Texture2D(2, 2, TextureFormat.RGB24, true) { name = "SurfaceColorAtlas" };
                if (texture.LoadImage(File.ReadAllBytes(atlasPath), true))
                {
                    texture.wrapMode = TextureWrapMode.Clamp;
                    texture.filterMode = FilterMode.Trilinear;
                    texture.anisoLevel = 4;
                    result.atlas = texture;
                }
                else
                {
                    UnityEngine.Object.Destroy(texture);
                }
            }
            return result;
        }
        catch (Exception exception)
        {
            Debug.LogWarning($"[Gnarly] Ignoring unreadable surface colors in {directory}: {exception.Message}");
            return null;
        }
    }

    public Surface Find(string identifier) =>
        identifier != null && byIdentifier.TryGetValue(identifier, out var surface) ? surface : null;

    /// <summary>Coverage-weighted average of every baked face, for geometry drawn with a single color.</summary>
    public static Color? Average(Surface surface)
    {
        if (surface?.faces == null || surface.faces.Length == 0) return null;
        var sum = Vector3.zero;
        var total = 0f;
        foreach (var face in surface.faces)
        {
            if (face?.color == null || face.color.Length < 3) continue;
            var weight = Mathf.Max(face.coverage, 0.001f);
            sum += new Vector3(face.color[0], face.color[1], face.color[2]) * weight;
            total += weight;
        }
        if (total <= 0f) return null;
        sum /= total;
        return new Color(sum.x, sum.y, sum.z, 1f);
    }

    /// <summary>Face-local UV (0..1, v up) to atlas UV. Rects are pixels from the atlas top-left.</summary>
    public Vector2 AtlasUV(Face face, float u, float v)
    {
        u = Mathf.Clamp01(u);
        v = Mathf.Clamp01(v);
        return new Vector2(
            (face.rect[0] + u * face.rect[2]) / document.atlasWidth,
            1f - (face.rect[1] + (1f - v) * face.rect[3]) / document.atlasHeight);
    }

    public void Dispose()
    {
        if (atlas != null) UnityEngine.Object.Destroy(atlas);
        atlas = null;
    }
}
