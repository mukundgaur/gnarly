using UnityEngine;
using UnityEngine.UI;

/// <summary>Shared palette and runtime uGUI builders for the map and route planner.</summary>
public static class MapUi
{
    public static readonly Color Sheet = new Color(0.97f, 0.98f, 1f, 1f);
    public static readonly Color Surface = Color.white;
    public static readonly Color SurfaceRaised = new Color(0.91f, 0.94f, 0.98f, 1f);
    public static readonly Color SurfaceActive = new Color(0.83f, 0.9f, 1f, 1f);
    public static readonly Color MapBackground = new Color(0.015f, 0.035f, 0.06f, 1f);
    public static readonly Color Accent = new Color(0.1f, 0.37f, 0.83f, 1f);
    public static readonly Color AccentText = Color.white;
    public static readonly Color TextPrimary = new Color(0.1f, 0.16f, 0.24f, 1f);
    public static readonly Color TextSecondary = new Color(0.39f, 0.46f, 0.55f, 1f);
    public static readonly Color Eyebrow = new Color(0.33f, 0.43f, 0.55f, 1f);
    public static readonly Color Warning = new Color(0.78f, 0.24f, 0.15f, 1f);
    public static readonly Color Start = new Color(0.18f, 0.58f, 0.35f, 1f);
    public static readonly Color Destination = new Color(0.79f, 0.22f, 0.34f, 1f);
    public static readonly Color User = new Color(0.1f, 0.44f, 0.92f, 1f);
    public static readonly Color PlaceDestination = new Color(0.87f, 0.53f, 0.1f, 1f);
    public static readonly Color PlaceRoom = new Color(0.45f, 0.4f, 0.7f, 1f);
    public static readonly Color PlaceStairs = new Color(0.26f, 0.44f, 0.75f, 1f);
    public static readonly Color PlaceEntrance = new Color(0.24f, 0.56f, 0.36f, 1f);
    public static readonly Color PlaceMinor = new Color(0.42f, 0.55f, 0.64f, 0.9f);
    public static readonly Color Preview = new Color(0.25f, 0.62f, 1f, 0.96f);

    const int RoundedTextureSize = 96;
    const int RoundedRadius = 32;
    static Sprite rounded;
    static Sprite circle;
    static Font font;

    public static Font Font => font != null ? font : font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");

    /// <summary>9-sliced rounded rectangle; corner radius is set per image through pixelsPerUnitMultiplier.</summary>
    public static Sprite Rounded
    {
        get
        {
            if (rounded != null) return rounded;
            var texture = new Texture2D(RoundedTextureSize, RoundedTextureSize, TextureFormat.RGBA32, false)
            {
                wrapMode = TextureWrapMode.Clamp,
                filterMode = FilterMode.Bilinear
            };
            var pixels = new Color32[RoundedTextureSize * RoundedTextureSize];
            for (var y = 0; y < RoundedTextureSize; y++)
            for (var x = 0; x < RoundedTextureSize; x++)
            {
                var cx = Mathf.Clamp(x + 0.5f, RoundedRadius, RoundedTextureSize - RoundedRadius);
                var cy = Mathf.Clamp(y + 0.5f, RoundedRadius, RoundedTextureSize - RoundedRadius);
                var distance = Vector2.Distance(new Vector2(x + 0.5f, y + 0.5f), new Vector2(cx, cy));
                var alpha = Mathf.Clamp01(RoundedRadius - distance + 0.5f);
                pixels[y * RoundedTextureSize + x] = new Color32(255, 255, 255, (byte)(alpha * 255));
            }
            texture.SetPixels32(pixels);
            texture.Apply();
            rounded = Sprite.Create(texture, new Rect(0, 0, RoundedTextureSize, RoundedTextureSize), new Vector2(0.5f, 0.5f),
                100f, 0, SpriteMeshType.FullRect, new Vector4(RoundedRadius, RoundedRadius, RoundedRadius, RoundedRadius));
            return rounded;
        }
    }

    public static Sprite Circle
    {
        get
        {
            if (circle != null) return circle;
            const int size = 64;
            var texture = new Texture2D(size, size, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Clamp };
            var pixels = new Color32[size * size];
            var radius = size * 0.5f;
            for (var y = 0; y < size; y++)
            for (var x = 0; x < size; x++)
            {
                var distance = Vector2.Distance(new Vector2(x + 0.5f, y + 0.5f), new Vector2(radius, radius));
                pixels[y * size + x] = new Color32(255, 255, 255, (byte)(Mathf.Clamp01(radius - distance) * 255));
            }
            texture.SetPixels32(pixels);
            texture.Apply();
            circle = Sprite.Create(texture, new Rect(0, 0, size, size), new Vector2(0.5f, 0.5f));
            return circle;
        }
    }

    public static RectTransform Rect(string name, Transform parent, Vector2 anchorMin, Vector2 anchorMax, Vector2 offsetMin, Vector2 offsetMax)
    {
        var rect = new GameObject(name, typeof(RectTransform)).GetComponent<RectTransform>();
        rect.SetParent(parent, false);
        rect.anchorMin = anchorMin;
        rect.anchorMax = anchorMax;
        rect.offsetMin = offsetMin;
        rect.offsetMax = offsetMax;
        return rect;
    }

    public static RectTransform Stretch(string name, Transform parent, float inset = 0f) =>
        Rect(name, parent, Vector2.zero, Vector2.one, new Vector2(inset, inset), new Vector2(-inset, -inset));

    /// <summary>A fixed-size rect positioned by its center relative to an anchor.</summary>
    public static RectTransform Sized(string name, Transform parent, Vector2 anchor, Vector2 size, Vector2 position)
    {
        var rect = new GameObject(name, typeof(RectTransform)).GetComponent<RectTransform>();
        rect.SetParent(parent, false);
        rect.anchorMin = anchor;
        rect.anchorMax = anchor;
        rect.pivot = new Vector2(0.5f, 0.5f);
        rect.sizeDelta = size;
        rect.anchoredPosition = position;
        return rect;
    }

    public static Image Panel(RectTransform rect, Color color, float radius = 32f, bool raycast = false)
    {
        var image = rect.gameObject.AddComponent<Image>();
        image.sprite = Rounded;
        image.type = Image.Type.Sliced;
        image.pixelsPerUnitMultiplier = radius > 0f ? RoundedRadius / radius : 1000f;
        image.color = color;
        image.raycastTarget = raycast;
        return image;
    }

    public static Image Dot(RectTransform rect, Color color)
    {
        var image = rect.gameObject.AddComponent<Image>();
        image.sprite = Circle;
        image.color = color;
        image.raycastTarget = false;
        return image;
    }

    public static Text Label(RectTransform rect, string text, int size, Color color,
        TextAnchor alignment = TextAnchor.MiddleLeft, FontStyle style = FontStyle.Normal)
    {
        var label = rect.gameObject.AddComponent<Text>();
        label.font = Font;
        label.fontSize = size;
        label.fontStyle = style;
        label.alignment = alignment;
        label.color = color;
        label.text = text;
        label.raycastTarget = false;
        label.horizontalOverflow = HorizontalWrapMode.Wrap;
        label.verticalOverflow = VerticalWrapMode.Truncate;
        return label;
    }

    /// <summary>Rounded button with a centered label. Returns the button; its label is the first child Text.</summary>
    public static Button Button(RectTransform rect, string text, Color background, Color foreground,
        int fontSize, System.Action onClick, float radius = 28f)
    {
        var image = Panel(rect, background, radius, true);
        var button = rect.gameObject.AddComponent<Button>();
        button.targetGraphic = image;
        var colors = button.colors;
        colors.normalColor = Color.white;
        colors.highlightedColor = new Color(1f, 1f, 1f, 0.92f);
        colors.pressedColor = new Color(0.78f, 0.78f, 0.78f, 1f);
        colors.disabledColor = new Color(1f, 1f, 1f, 0.35f);
        colors.fadeDuration = 0.08f;
        button.colors = colors;
        if (onClick != null) button.onClick.AddListener(() => onClick());
        Label(Stretch("Label", rect), text, fontSize, foreground, TextAnchor.MiddleCenter, FontStyle.Bold);
        return button;
    }

    public static Text ButtonLabel(Button button) => button.GetComponentInChildren<Text>();

    public static Color WithAlpha(Color color, float alpha) => new Color(color.r, color.g, color.b, alpha);
}
