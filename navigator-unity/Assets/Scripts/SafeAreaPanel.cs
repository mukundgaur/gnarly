using UnityEngine;

/// <summary>Keeps a screen-space panel inside the iPhone's notch and home-indicator insets.</summary>
public sealed class SafeAreaPanel : MonoBehaviour
{
    RectTransform rect;
    Rect lastSafeArea;
    Vector2Int lastScreenSize;

    void Awake()
    {
        rect = (RectTransform)transform;
        Apply();
    }

    void LateUpdate()
    {
        if (lastSafeArea != Screen.safeArea || lastScreenSize.x != Screen.width || lastScreenSize.y != Screen.height)
            Apply();
    }

    void Apply()
    {
        if (Screen.width <= 0 || Screen.height <= 0) return;
        lastSafeArea = Screen.safeArea;
        lastScreenSize = new Vector2Int(Screen.width, Screen.height);
        rect.anchorMin = new Vector2(lastSafeArea.xMin / Screen.width, lastSafeArea.yMin / Screen.height);
        rect.anchorMax = new Vector2(lastSafeArea.xMax / Screen.width, lastSafeArea.yMax / Screen.height);
        rect.offsetMin = Vector2.zero;
        rect.offsetMax = Vector2.zero;
    }
}
