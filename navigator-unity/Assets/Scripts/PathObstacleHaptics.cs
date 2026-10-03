using System.Runtime.InteropServices;

/// <summary>
/// Drives the iPhone Taptic Engine. Strength is continuous: 0 is silent and 1 is the strongest rumble.
/// </summary>
public static class PathObstacleHaptics
{
#if UNITY_IOS && !UNITY_EDITOR
    [DllImport("__Internal")]
    static extern void GnarlyHapticsSetIntensity(float intensity);

    [DllImport("__Internal")]
    static extern void GnarlyHapticsStop();
#endif

    public static void SetIntensity(float intensity)
    {
#if UNITY_IOS && !UNITY_EDITOR
        GnarlyHapticsSetIntensity(intensity);
#endif
    }

    public static void Stop()
    {
#if UNITY_IOS && !UNITY_EDITOR
        GnarlyHapticsStop();
#endif
    }
}
