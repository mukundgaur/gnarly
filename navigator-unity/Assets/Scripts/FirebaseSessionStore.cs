using System;
using System.Runtime.InteropServices;

/// <summary>
/// Keeps the Firebase refresh token in the iOS Keychain. PlayerPrefs is deliberately not used
/// for credentials; it continues to store only the selected building and zone.
/// </summary>
internal static class FirebaseSessionStore
{
#if UNITY_IOS && !UNITY_EDITOR
    [DllImport("__Internal")]
    static extern IntPtr GnarlyFirebaseLoadRefreshToken();
    [DllImport("__Internal")]
    static extern void GnarlyFirebaseFreeString(IntPtr value);
    [DllImport("__Internal")]
    static extern void GnarlyFirebaseSaveRefreshToken(string token);
    [DllImport("__Internal")]
    static extern void GnarlyFirebaseClearRefreshToken();

    public static bool HasRefreshToken => !string.IsNullOrEmpty(LoadRefreshToken());

    public static string LoadRefreshToken()
    {
        var pointer = GnarlyFirebaseLoadRefreshToken();
        if (pointer == IntPtr.Zero) return null;
        try { return Marshal.PtrToStringAnsi(pointer); }
        finally { GnarlyFirebaseFreeString(pointer); }
    }

    public static void SaveRefreshToken(string token)
    {
        if (!string.IsNullOrEmpty(token)) GnarlyFirebaseSaveRefreshToken(token);
    }

    public static void ClearRefreshToken() => GnarlyFirebaseClearRefreshToken();
#else
    public static bool HasRefreshToken => false;
    public static string LoadRefreshToken() => null;
    public static void SaveRefreshToken(string token) { }
    public static void ClearRefreshToken() { }
#endif
}
