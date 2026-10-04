using System.Runtime.InteropServices;

/// <summary>
/// Drives the iPhone Taptic Engine for navigation. A direction-scaled cue confirms
/// that the phone faces the next route segment; a closeness-scaled pulse means a
/// LiDAR obstacle is in the way.
/// </summary>
public static class PathObstacleHaptics
{
#if UNITY_IOS && !UNITY_EDITOR
    [DllImport("__Internal")]
    static extern void GnarlyHapticsSetRouteCue(float alignment);

    [DllImport("__Internal")]
    static extern void GnarlyHapticsSetObstaclePulse(float closeness);

    [DllImport("__Internal")]
    static extern void GnarlyHapticsStop();
#endif

    /// <param name="alignment">0 when pointing away from the route, 1 when aligned with it.</param>
    public static void PlayDirectionCue(float alignment)
    {
#if UNITY_IOS && !UNITY_EDITOR
        GnarlyHapticsSetRouteCue(UnityEngine.Mathf.Clamp01(alignment));
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
