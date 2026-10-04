using System.Runtime.InteropServices;

/// <summary>
/// Drives the iPhone Taptic Engine for navigation. A faint rumble means the user
/// is on the route; a closeness-scaled pulse means a LiDAR obstacle is in the way.
/// </summary>
public static class PathObstacleHaptics
{
#if UNITY_IOS && !UNITY_EDITOR
    [DllImport("__Internal")]
    static extern void GnarlyHapticsSetRouteCue();

    [DllImport("__Internal")]
    static extern void GnarlyHapticsSetObstaclePulse(float closeness);

    [DllImport("__Internal")]
    static extern void GnarlyHapticsStop();
#endif

    public static void PlayRouteCue()
    {
#if UNITY_IOS && !UNITY_EDITOR
        GnarlyHapticsSetRouteCue();
#endif
    }

    public static void PlayObstaclePulse(float closeness)
    {
#if UNITY_IOS && !UNITY_EDITOR
        GnarlyHapticsSetObstaclePulse(closeness);
#endif
    }

    public static void Stop()
    {
#if UNITY_IOS && !UNITY_EDITOR
        GnarlyHapticsStop();
#endif
    }
}
