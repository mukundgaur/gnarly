using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.EventSystems;

/// <summary>
/// Turns pointer input on the planner's map image into tap, pan, and pinch/scroll zoom.
/// Positions are normalized to the image rect (0..1), which equals the map camera's viewport.
/// </summary>
public sealed class MapViewportInput : MonoBehaviour,
    IPointerDownHandler, IPointerUpHandler, IPointerClickHandler, IBeginDragHandler, IDragHandler, IEndDragHandler, IScrollHandler
{
    const float TapSlopPixels = 18f;

    public event Action<Vector2> Tapped;
    /// <summary>Pan delta in normalized viewport units (positive x = content moved right).</summary>
    public event Action<Vector2> Panned;
    /// <summary>Zoom factor: &gt;1 zooms in.</summary>
    public event Action<float> Zoomed;

    readonly Dictionary<int, Vector2> pointers = new Dictionary<int, Vector2>();
    RectTransform rect;
    Vector2 pressPosition;
    bool moved;
    float pinchDistance;

    void Awake() => rect = (RectTransform)transform;

    public void OnPointerDown(PointerEventData eventData)
    {
        pointers[eventData.pointerId] = eventData.position;
        if (pointers.Count == 1)
        {
            pressPosition = eventData.position;
            moved = false;
        }
        else
        {
            moved = true;
            pinchDistance = CurrentPinchDistance();
        }
    }

    public void OnPointerUp(PointerEventData eventData)
    {
        var wasSingle = pointers.Count == 1;
        pointers.Remove(eventData.pointerId);
        if (pointers.Count == 1) pinchDistance = 0f;
        if (!wasSingle || moved) return;
        if (TryNormalize(eventData.position, eventData.pressEventCamera, out var normalized))
            Tapped?.Invoke(normalized);
    }

    /// <summary>Taps are reported through <see cref="Tapped"/>; this keeps a click from also reaching a parent button.</summary>
    public void OnPointerClick(PointerEventData eventData) { }

    public void OnBeginDrag(PointerEventData eventData) { }

    public void OnDrag(PointerEventData eventData)
    {
        pointers[eventData.pointerId] = eventData.position;
        if (!moved && Vector2.Distance(eventData.position, pressPosition) > TapSlopPixels) moved = true;
        if (!moved) return;

        if (pointers.Count >= 2)
        {
            var distance = CurrentPinchDistance();
            if (pinchDistance > 1f && distance > 1f) Zoomed?.Invoke(distance / pinchDistance);
            pinchDistance = distance;
            return;
        }

        var size = ScreenSize(eventData.pressEventCamera);
        if (size.x > 1f && size.y > 1f)
            Panned?.Invoke(new Vector2(eventData.delta.x / size.x, eventData.delta.y / size.y));
    }

    public void OnEndDrag(PointerEventData eventData) { }

    public void OnScroll(PointerEventData eventData)
    {
        if (Mathf.Abs(eventData.scrollDelta.y) > 0.01f)
            Zoomed?.Invoke(Mathf.Pow(1.12f, eventData.scrollDelta.y));
    }

    void OnDisable()
    {
        pointers.Clear();
        pinchDistance = 0f;
    }

    float CurrentPinchDistance()
    {
        if (pointers.Count < 2) return 0f;
        using var enumerator = pointers.Values.GetEnumerator();
        enumerator.MoveNext();
        var a = enumerator.Current;
        enumerator.MoveNext();
        return Vector2.Distance(a, enumerator.Current);
    }

    bool TryNormalize(Vector2 screenPosition, Camera eventCamera, out Vector2 normalized)
    {
        normalized = default;
        if (!RectTransformUtility.ScreenPointToLocalPointInRectangle(rect, screenPosition, eventCamera, out var local))
            return false;
        var r = rect.rect;
        normalized = new Vector2((local.x - r.xMin) / r.width, (local.y - r.yMin) / r.height);
        return normalized.x >= 0f && normalized.x <= 1f && normalized.y >= 0f && normalized.y <= 1f;
    }

    Vector2 ScreenSize(Camera eventCamera)
    {
        var corners = new Vector3[4];
        rect.GetWorldCorners(corners);
        var min = RectTransformUtility.WorldToScreenPoint(eventCamera, corners[0]);
        var max = RectTransformUtility.WorldToScreenPoint(eventCamera, corners[2]);
        return max - min;
    }
}
