using System.Collections.Generic;
using Unity.XR.CoreUtils;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.UI;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.ARSubsystems;

/// <summary>
/// Night-vision LiDAR view: samples ARKit scene depth into a persistent session-space point cloud and
/// draws it as dark green dots that brighten as a pulse sweeps outward from the user.
/// Depth is used instead of ARKit feature points because feature points need visible texture and
/// disappear in the dark; the LiDAR sensor does not.
/// While a route is active, the same depth is read even if the point cloud is hidden. Samples that
/// fall in the walking corridor drive haptics: a closer, denser obstacle vibrates harder.
/// </summary>
public class LidarPulseView : MonoBehaviour
{
    [SerializeField] XROrigin origin;
    [SerializeField] Color baseColor = new Color(0f, 0.42f, 0.12f);
    [SerializeField] Color pulseColor = new Color(0.2f, 1f, 0.4f);
    [Tooltip("Maximum stored points; the oldest are replaced first.")]
    [SerializeField] int capacity = 250000;
    [Tooltip("Edge length (m) of the grid used to keep at most one point per cell.")]
    [SerializeField] float voxelSize = 0.025f;
    [Tooltip("Dot radius (m).")]
    [SerializeField] float pointSize = 0.005f;
    [SerializeField] float minDepth = 0.2f;
    [SerializeField] float maxDepth = 6f;
    [Tooltip("Pixel spacing between samples of the 256×192 depth image.")]
    [SerializeField] int sampleStep = 2;
    [SerializeField] float captureInterval = 0.1f;
    [SerializeField] float pulsePeriod = 1.6f;
    [Tooltip("Pulse front speed (m/s).")]
    [SerializeField] float pulseSpeed = 6f;
    [SerializeField] float pulseWidth = 0.35f;
    [Tooltip("Distance (m) over which a point fades back to the base color after the pulse passes.")]
    [SerializeField] float pulseTrail = 1.5f;
    [Tooltip("Seconds a newly captured point stays highlighted.")]
    [SerializeField] float freshSeconds = 0.6f;
    [SerializeField] RouteNavigator navigator;
    [Header("Path obstacle haptics")]
    [Tooltip("Half-width (m) of the walking corridor around the route. Depth samples inside it can vibrate.")]
    [SerializeField] float corridorHalfWidth = 0.4f;
    [Tooltip("Height above the path (m) where a return counts as an obstacle rather than the floor.")]
    [SerializeField] float minObstacleHeight = 0.25f;
    [Tooltip("Returns higher than this above the path (m) are treated as ceiling and ignored.")]
    [SerializeField] float maxObstacleHeight = 1.75f;
    [Tooltip("How far ahead along the route (m) obstacles are felt.")]
    [SerializeField] float pathLookAhead = 3.5f;
    [Tooltip("LiDAR distance (m) that maps to the strongest vibration. Anything closer stays at full strength.")]
    [SerializeField] float nearDistance = 0.45f;
    [Tooltip("LiDAR distance (m) that maps to silence. Farther obstacles do not vibrate.")]
    [SerializeField] float farDistance = 3.2f;

    const int MinBlockingHits = 16;
    const int DenseHitCount = 70;
    const float DensityQuiet = 0.07f;
    const float DensityFull = 0.32f;
    const float MaxHapticStrength = 0.9f;
    const float PathStartSkip = 0.2f;

    static readonly int PointsId = Shader.PropertyToID("_Points");
    static readonly int SessionToWorldId = Shader.PropertyToID("_SessionToWorld");
    static readonly int BaseColorId = Shader.PropertyToID("_BaseColor");
    static readonly int PulseColorId = Shader.PropertyToID("_PulseColor");
    static readonly int PulseOriginId = Shader.PropertyToID("_PulseOrigin");
    static readonly int PulseRadiusId = Shader.PropertyToID("_PulseRadius");
    static readonly int PulseWidthId = Shader.PropertyToID("_PulseWidth");
    static readonly int PulseTrailId = Shader.PropertyToID("_PulseTrail");
    static readonly int PointSizeId = Shader.PropertyToID("_PointSize");
    static readonly int NowId = Shader.PropertyToID("_Now");
    static readonly int FreshSecondsId = Shader.PropertyToID("_FreshSeconds");

    AROcclusionManager occlusion;
    bool isOn;
    bool unavailable;
    float nextCaptureAt;
    float pulseStartedAt;
    int pulseIndex = -1;
    Vector3 pulseOrigin;

    Material material;
    GraphicsBuffer buffer;
    Vector4[] points;
    long[] slotKeys;
    readonly Dictionary<long, int> voxels = new Dictionary<long, int>();
    int count;
    int next;

    Image buttonBackground;
    Text buttonLabel;

    readonly List<Vector3> upcomingPath = new List<Vector3>();
    int blockingHits;
    int clearPathHits;
    float closenessSum;
    float peakCloseness;
    float targetIntensity;
    float smoothedIntensity;
    float lastObstacleSampleAt = float.NegativeInfinity;
    bool hapticsSilent = true;
    int lastSentHaptic = -1;
    float lastHapticSentAt = float.NegativeInfinity;
    const float HapticKeepAliveInterval = 0.25f;

    public bool IsOn => isOn;

    bool RouteSensing => navigator != null && navigator.IsActive && !navigator.HasArrived;

    void Awake()
    {
        if (origin == null) origin = FindAnyObjectByType<XROrigin>();
        if (navigator == null) navigator = GetComponent<RouteNavigator>();
        if (navigator == null) navigator = FindAnyObjectByType<RouteNavigator>();
        BuildUi();
        UpdateButton();
    }

    public void Toggle() => SetOn(!isOn);

    public void SetOn(bool on)
    {
        if (on && !EnsureResources()) on = false;
        isOn = on;
        if (on)
        {
            pulseStartedAt = Time.time;
            pulseIndex = -1;
            nextCaptureAt = 0f;
            if (occlusion.descriptor?.environmentDepthImageSupported == Supported.Unsupported)
            {
                Debug.LogWarning("[Gnarly] LiDAR depth is not supported on this device.");
                unavailable = true;
                isOn = false;
            }
        }
        UpdateButton();
    }

    /// <summary>Session-space coordinates change when ARKit relocalizes or resets, so old points would be misplaced.</summary>
    public void ClearPoints()
    {
        voxels.Clear();
        count = 0;
        next = 0;
        if (points == null) return;
        for (var i = 0; i < points.Length; i++) points[i] = new Vector4(0, 0, 0, -1);
        buffer.SetData(points);
    }

    bool EnsureOcclusion()
    {
        if (origin == null || origin.Camera == null) return false;
        if (occlusion != null) return true;

        var cameraObject = origin.Camera.gameObject;
        occlusion = cameraObject.GetComponent<AROcclusionManager>();
        if (occlusion == null) occlusion = cameraObject.AddComponent<AROcclusionManager>();
        occlusion.requestedEnvironmentDepthMode = EnvironmentDepthMode.Medium;
        occlusion.environmentDepthTemporalSmoothingRequested = true;
        // Depth is only read on the CPU; leave the camera background and route rendering unoccluded.
        occlusion.requestedOcclusionPreferenceMode = OcclusionPreferenceMode.NoOcclusion;
        return true;
    }

    bool EnsureResources()
    {
        if (!EnsureOcclusion()) return false;
        if (material == null)
        {
            var shader = Resources.Load<Shader>("GnarlyLidarPoints");
            if (shader == null)
            {
                Debug.LogError("[Gnarly] GnarlyLidarPoints shader is missing from Resources.");
                return false;
            }
            material = new Material(shader);
        }

        if (buffer == null)
        {
            points = new Vector4[capacity];
            slotKeys = new long[capacity];
            buffer = new GraphicsBuffer(GraphicsBuffer.Target.Structured, capacity, sizeof(float) * 4);
            material.SetBuffer(PointsId, buffer);
            ClearPoints();
        }

        return true;
    }

    void Update()
    {
        if (unavailable)
        {
            StopObstacleHaptics();
            return;
        }

        var senseRoute = RouteSensing;
        if (!isOn && !senseRoute)
        {
            if (occlusion != null) occlusion.enabled = false;
            StopObstacleHaptics();
            return;
        }

        if ((isOn && !EnsureResources()) || (!isOn && !EnsureOcclusion()))
        {
            StopObstacleHaptics();
            return;
        }

        if (occlusion.descriptor?.environmentDepthImageSupported == Supported.Unsupported)
        {
            Debug.LogWarning("[Gnarly] LiDAR depth is not supported on this device.");
            unavailable = true;
            isOn = false;
            occlusion.enabled = false;
            StopObstacleHaptics();
            UpdateButton();
            return;
        }

        occlusion.enabled = true;

        if (Time.unscaledTime >= nextCaptureAt)
        {
            nextCaptureAt = Time.unscaledTime + captureInterval;
            if (ARSession.state == ARSessionState.SessionTracking && ARSession.notTrackingReason == NotTrackingReason.None)
                Capture();
        }

        if (!senseRoute || Time.unscaledTime - lastObstacleSampleAt > 0.35f)
            targetIntensity = 0f;

        if (isOn)
        {
            UpdatePulse();
            Render();
        }

        if (senseRoute) ApplyObstacleHaptics();
        else StopObstacleHaptics();
    }

    void UpdatePulse()
    {
        var elapsed = Time.time - pulseStartedAt;
        var index = Mathf.FloorToInt(elapsed / pulsePeriod);
        if (index != pulseIndex)
        {
            pulseIndex = index;
            pulseOrigin = origin.Camera.transform.position;
        }
        material.SetVector(PulseOriginId, pulseOrigin);
        material.SetFloat(PulseRadiusId, (elapsed - index * pulsePeriod) * pulseSpeed);
    }

    void Render()
    {
        if (count == 0) return;
        material.SetMatrix(SessionToWorldId, origin.TrackablesParent.localToWorldMatrix);
        material.SetColor(BaseColorId, baseColor);
        material.SetColor(PulseColorId, pulseColor);
        material.SetFloat(PulseWidthId, pulseWidth);
        material.SetFloat(PulseTrailId, pulseTrail);
        material.SetFloat(PointSizeId, pointSize);
        material.SetFloat(NowId, Time.time);
        material.SetFloat(FreshSecondsId, freshSeconds);

        var camera = origin.Camera;
        var renderParams = new RenderParams(material)
        {
            camera = camera,
            layer = camera.gameObject.layer,
            worldBounds = new Bounds(camera.transform.position, Vector3.one * 1000f),
            shadowCastingMode = ShadowCastingMode.Off,
            receiveShadows = false
        };
        Graphics.RenderPrimitives(renderParams, MeshTopology.Triangles, count * 6);
    }

    void Capture()
    {
        if (!occlusion.TryAcquireEnvironmentDepthCpuImage(out var depthImage)) return;
        var hasConfidence = occlusion.TryAcquireEnvironmentDepthConfidenceCpuImage(out var confidenceImage);
        try
        {
            if (depthImage.format != XRCpuImage.Format.DepthFloat32) return;
            var useConfidence = hasConfidence &&
                                confidenceImage.format == XRCpuImage.Format.OneComponent8 &&
                                confidenceImage.dimensions == depthImage.dimensions;
            AddPoints(depthImage, confidenceImage, useConfidence);
        }
        finally
        {
            depthImage.Dispose();
            if (hasConfidence) confidenceImage.Dispose();
        }
    }

    /// <summary>
    /// The depth image is in the camera sensor's landscape orientation and is aspect-filled onto the
    /// screen, which is also how ARKit derives the camera's projection matrix. Each sample is mapped to
    /// the viewport, then unprojected with that matrix at its LiDAR depth.
    /// </summary>
    void AddPoints(XRCpuImage depthImage, XRCpuImage confidenceImage, bool useConfidence)
    {
        var depthPlane = depthImage.GetPlane(0);
        var depth = depthPlane.data.Reinterpret<float>(1);
        var depthRowStride = depthPlane.rowStride / sizeof(float);
        var confidence = useConfidence ? confidenceImage.GetPlane(0) : default;

        var width = depthImage.width;
        var height = depthImage.height;
        var camera = origin.Camera;
        var projection = camera.projectionMatrix;
        var cameraToSession = origin.TrackablesParent.worldToLocalMatrix * camera.cameraToWorldMatrix;

        var orientation = Screen.orientation;
        var portrait = orientation == ScreenOrientation.Portrait || orientation == ScreenOrientation.PortraitUpsideDown;
        var imageAspect = portrait ? height / (float)width : width / (float)height;
        var screenAspect = camera.pixelWidth / (float)camera.pixelHeight;
        var cropX = imageAspect > screenAspect ? imageAspect / screenAspect : 1f;
        var cropY = imageAspect > screenAspect ? 1f : screenAspect / imageAspect;

        var now = Time.time;
        var start = next;
        var written = 0;
        var step = Mathf.Max(1, sampleStep);
        var hasPath = navigator != null && navigator.CopyUpcomingPath(upcomingPath);
        blockingHits = 0;
        clearPathHits = 0;
        closenessSum = 0f;
        peakCloseness = 0f;
        var sessionToWorld = hasPath ? origin.TrackablesParent.localToWorldMatrix : default;

        for (var y = step / 2; y < height; y += step)
        {
            for (var x = step / 2; x < width; x += step)
            {
                var d = depth[y * depthRowStride + x];
                if (!(d >= minDepth && d <= maxDepth)) continue;
                if (useConfidence && confidence.data[y * confidence.rowStride + x] < 1) continue;

                var u = (x + 0.5f) / width;
                var v = (y + 0.5f) / height;
                Vector2 viewport = orientation switch
                {
                    ScreenOrientation.LandscapeLeft => new Vector2(u, 1f - v),
                    ScreenOrientation.LandscapeRight => new Vector2(1f - u, v),
                    ScreenOrientation.PortraitUpsideDown => new Vector2(v, u),
                    _ => new Vector2(1f - v, 1f - u)
                };
                var ndcX = (viewport.x - 0.5f) * 2f * cropX;
                var ndcY = (viewport.y - 0.5f) * 2f * cropY;
                var cameraPoint = new Vector3(
                    (ndcX + projection.m02) * d / projection.m00,
                    (ndcY + projection.m12) * d / projection.m11,
                    -d);
                var sessionPoint = cameraToSession.MultiplyPoint3x4(cameraPoint);
                if (hasPath)
                    ConsiderPathObstacle(sessionToWorld.MultiplyPoint3x4(sessionPoint), d);
                if (points == null) continue;

                var key = VoxelKey(sessionPoint);
                if (voxels.ContainsKey(key)) continue;

                var slot = next;
                next = (next + 1) % capacity;
                if (count < capacity) count++;
                else voxels.Remove(slotKeys[slot]);
                slotKeys[slot] = key;
                voxels[key] = slot;
                points[slot] = new Vector4(sessionPoint.x, sessionPoint.y, sessionPoint.z, now);
                written++;
            }
        }

        PublishObstacleIntensity(hasPath);

        if (written == 0) return;
        var firstRun = Mathf.Min(written, capacity - start);
        buffer.SetData(points, start, start, firstRun);
        if (written > firstRun) buffer.SetData(points, 0, 0, written - firstRun);
    }

    /// <summary>
    /// Classifies one LiDAR return against the route corridor. Floor returns inside the corridor
    /// dilute the density; solid obstacles raise it. Closer returns contribute more closeness.
    /// </summary>
    void ConsiderPathObstacle(Vector3 world, float depth)
    {
        if (upcomingPath.Count < 2) return;
        var originFlat = new Vector2(upcomingPath[0].x, upcomingPath[0].z);
        var flat = new Vector2(world.x, world.z) - originFlat;
        var reach = pathLookAhead + corridorHalfWidth;
        if (flat.sqrMagnitude > reach * reach) return;

        var bestLateral = float.MaxValue;
        var bestAlong = 0f;
        var bestY = 0f;
        var along = 0f;
        for (var i = 0; i < upcomingPath.Count - 1; i++)
        {
            var a = upcomingPath[i];
            var b = upcomingPath[i + 1];
            var ab = new Vector2(b.x - a.x, b.z - a.z);
            var length = ab.magnitude;
            if (length < 1e-4f) continue;
            var t = Mathf.Clamp01(Vector2.Dot(new Vector2(world.x, world.z) - new Vector2(a.x, a.z), ab) / (length * length));
            var closest = new Vector2(a.x, a.z) + ab * t;
            var lateral = Vector2.Distance(new Vector2(world.x, world.z), closest);
            if (lateral < bestLateral)
            {
                bestLateral = lateral;
                bestAlong = along + length * t;
                bestY = Mathf.Lerp(a.y, b.y, t);
            }
            along += length;
        }

        if (bestLateral > corridorHalfWidth) return;
        if (bestAlong < PathStartSkip || bestAlong > pathLookAhead) return;

        var height = world.y - bestY;
        if (height < -0.15f || height > maxObstacleHeight) return;
        if (height < minObstacleHeight)
        {
            clearPathHits++;
            return;
        }

        var closeness = Mathf.Clamp01(Mathf.InverseLerp(farDistance, nearDistance, depth));
        blockingHits++;
        closenessSum += closeness;
        if (closeness > peakCloseness) peakCloseness = closeness;
    }

    void PublishObstacleIntensity(bool hasPath)
    {
        lastObstacleSampleAt = Time.unscaledTime;
        targetIntensity = hasPath
            ? ObstacleIntensity(blockingHits, clearPathHits, closenessSum, peakCloseness)
            : 0f;
    }

    static float ObstacleIntensity(int hits, int clearHits, float closenessSum, float peakCloseness)
    {
        if (hits < MinBlockingHits) return 0f;
        var density = hits / (float)(hits + clearHits);
        var densityFactor = Mathf.SmoothStep(DensityQuiet, DensityFull, density);
        var support = Mathf.Clamp01(Mathf.InverseLerp(MinBlockingHits, DenseHitCount, hits));
        var mean = closenessSum / hits;
        var closeness = Mathf.Lerp(mean, peakCloseness, 0.65f);
        return Mathf.Clamp01(closeness * densityFactor * Mathf.Lerp(0.4f, 1f, support)) * MaxHapticStrength;
    }

    void ApplyObstacleHaptics()
    {
        var blend = 1f - Mathf.Exp(-10f * Time.unscaledDeltaTime);
        smoothedIntensity = Mathf.Lerp(smoothedIntensity, targetIntensity, blend);

        if (hapticsSilent)
        {
            if (smoothedIntensity < 0.06f) return;
            hapticsSilent = false;
        }
        else if (smoothedIntensity < 0.03f)
        {
            StopObstacleHaptics();
            return;
        }

        var milli = Mathf.RoundToInt(smoothedIntensity * 100f);
        // Core Haptics can stop while the app is interrupted or the engine is reset. Keep sending
        // a steady obstacle intensity a few times per second so the native player can restart,
        // even when the measured value has not changed.
        if (milli == lastSentHaptic && Time.unscaledTime - lastHapticSentAt < HapticKeepAliveInterval) return;
        lastSentHaptic = milli;
        lastHapticSentAt = Time.unscaledTime;
        PathObstacleHaptics.SetIntensity(milli / 100f);
    }

    void StopObstacleHaptics()
    {
        targetIntensity = 0f;
        smoothedIntensity = 0f;
        lastSentHaptic = -1;
        lastHapticSentAt = float.NegativeInfinity;
        if (hapticsSilent) return;
        hapticsSilent = true;
        PathObstacleHaptics.Stop();
    }

    long VoxelKey(Vector3 p)
    {
        const int bias = 1 << 20;
        const long mask = (1L << 21) - 1;
        var x = (Mathf.FloorToInt(p.x / voxelSize) + bias) & mask;
        var y = (Mathf.FloorToInt(p.y / voxelSize) + bias) & mask;
        var z = (Mathf.FloorToInt(p.z / voxelSize) + bias) & mask;
        return (x << 42) | (y << 21) | z;
    }

    void UpdateButton()
    {
        if (buttonLabel == null) return;
        buttonLabel.text = unavailable ? "LIDAR\nUNAVAILABLE" : isOn ? "LIDAR\nON" : "LIDAR\nOFF";
        buttonLabel.color = isOn ? new Color(0.45f, 1f, 0.55f) : Color.white;
        buttonBackground.color = isOn
            ? new Color(0.02f, 0.26f, 0.08f, 0.95f)
            : new Color(0.05f, 0.12f, 0.18f, 0.92f);
    }

    void BuildUi()
    {
        var canvasObject = new GameObject("LidarCanvas", typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
        var canvas = canvasObject.GetComponent<Canvas>();
        canvas.renderMode = RenderMode.ScreenSpaceOverlay;
        canvas.sortingOrder = 15;
        var scaler = canvasObject.GetComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = new Vector2(1170, 2532);

        var button = new GameObject("LidarButton", typeof(RectTransform)).GetComponent<RectTransform>();
        button.SetParent(canvasObject.transform, false);
        button.anchorMin = new Vector2(0.5f, 0);
        button.anchorMax = new Vector2(0.5f, 0);
        button.offsetMin = new Vector2(-565, 88);
        button.offsetMax = new Vector2(-210, 190);
        buttonBackground = button.gameObject.AddComponent<Image>();
        button.gameObject.AddComponent<Button>().onClick.AddListener(Toggle);

        var labelRect = new GameObject("Label", typeof(RectTransform)).GetComponent<RectTransform>();
        labelRect.SetParent(button, false);
        labelRect.anchorMin = Vector2.zero;
        labelRect.anchorMax = Vector2.one;
        labelRect.offsetMin = Vector2.zero;
        labelRect.offsetMax = Vector2.zero;
        buttonLabel = labelRect.gameObject.AddComponent<Text>();
        buttonLabel.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        buttonLabel.fontSize = 30;
        buttonLabel.fontStyle = FontStyle.Bold;
        buttonLabel.alignment = TextAnchor.MiddleCenter;
        buttonLabel.raycastTarget = false;
    }

    void OnDestroy()
    {
        StopObstacleHaptics();
        buffer?.Release();
        buffer = null;
        if (material != null) Destroy(material);
    }

    void OnApplicationPause(bool paused)
    {
        if (paused) StopObstacleHaptics();
    }
}
