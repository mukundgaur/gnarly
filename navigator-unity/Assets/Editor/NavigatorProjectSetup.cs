using System.IO;
using System.Linq;
using Unity.XR.CoreUtils;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEditor.XR.ARKit;
using UnityEditor.XR.Management;
using UnityEditor.XR.Management.Metadata;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.UI;
using UnityEngine.InputSystem.XR;
using UnityEngine.Rendering.Universal;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.Management;

/// <summary>
/// One-click, re-runnable configuration of the navigator's AR scene and iOS settings.
/// Run from the menu, or in batch mode with -executeMethod NavigatorProjectSetup.ConfigureAll.
/// </summary>
public static class NavigatorProjectSetup
{
    const string ScenePath = "Assets/Scenes/Navigator.unity";
    const string BundleId = "com.gnarly.navigator";
    const string ARKitLoaderType = "UnityEngine.XR.ARKit.ARKitLoader";
    static readonly string[] RendererPaths = { "Assets/Settings/Mobile_Renderer.asset", "Assets/Settings/PC_Renderer.asset" };

    [MenuItem("Gnarly/Configure Navigator Project")]
    public static void ConfigureAll()
    {
        ConfigurePlayerSettings();
        ConfigureARKit();
        ConfigureRenderers();
        CreateScene();
        EnsureStreamingAssetsFolder();
        CopyFirebaseConfig();
        AssetDatabase.SaveAssets();
        Debug.Log("[Gnarly] Navigator project configured. Switch the build profile to iOS before building.");
    }

    [MenuItem("Gnarly/Configure iOS Player Settings")]
    public static void ConfigurePlayerSettings()
    {
        PlayerSettings.SetApplicationIdentifier(NamedBuildTarget.iOS, BundleId);
        PlayerSettings.iOS.cameraUsageDescription = "The camera is used to locate you in the building and show directions.";
        PlayerSettings.iOS.targetOSVersionString = "16.0";
        PlayerSettings.iOS.targetDevice = iOSTargetDevice.iPhoneOnly;
        PlayerSettings.iOS.sdkVersion = iOSSdkVersion.DeviceSDK;

        var playerSettings = new SerializedObject(AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/ProjectSettings.asset")[0]);
        playerSettings.FindProperty("iOSRequireARKit").boolValue = true;
        playerSettings.ApplyModifiedPropertiesWithoutUndo();
    }

    [MenuItem("Gnarly/Configure ARKit Loader")]
    public static void ConfigureARKit()
    {
        var perTarget = FindOrCreateXRSettings();
        if (!perTarget.HasManagerSettingsForBuildTarget(BuildTargetGroup.iOS))
            perTarget.CreateDefaultManagerSettingsForBuildTarget(BuildTargetGroup.iOS);

        var general = perTarget.SettingsForBuildTarget(BuildTargetGroup.iOS);
        general.InitManagerOnStart = true;
        if (!XRPackageMetadataStore.IsLoaderAssigned(ARKitLoaderType, BuildTargetGroup.iOS))
            XRPackageMetadataStore.AssignLoader(general.Manager, ARKitLoaderType, BuildTargetGroup.iOS);
        EditorUtility.SetDirty(perTarget);

        var arkit = ARKitSettings.currentSettings;
        if (arkit == null)
        {
            var guid = AssetDatabase.FindAssets("t:ARKitSettings").FirstOrDefault();
            arkit = guid != null ? AssetDatabase.LoadAssetAtPath<ARKitSettings>(AssetDatabase.GUIDToAssetPath(guid)) : null;
            if (arkit == null)
            {
                arkit = ScriptableObject.CreateInstance<ARKitSettings>();
                Directory.CreateDirectory("Assets/XR/Settings");
                AssetDatabase.CreateAsset(arkit, "Assets/XR/Settings/ARKitSettings.asset");
            }
            ARKitSettings.currentSettings = arkit;
        }
        arkit.requirement = ARKitSettings.Requirement.Required;
        arkit.faceTracking = false;
        EditorUtility.SetDirty(arkit);
    }

    static XRGeneralSettingsPerBuildTarget FindOrCreateXRSettings()
    {
        if (EditorBuildSettings.TryGetConfigObject(XRGeneralSettings.settingsKey, out XRGeneralSettingsPerBuildTarget existing) && existing != null)
            return existing;

        var guid = AssetDatabase.FindAssets("t:XRGeneralSettingsPerBuildTarget").FirstOrDefault();
        var settings = guid != null
            ? AssetDatabase.LoadAssetAtPath<XRGeneralSettingsPerBuildTarget>(AssetDatabase.GUIDToAssetPath(guid))
            : null;
        if (settings == null)
        {
            settings = ScriptableObject.CreateInstance<XRGeneralSettingsPerBuildTarget>();
            Directory.CreateDirectory("Assets/XR");
            AssetDatabase.CreateAsset(settings, "Assets/XR/XRGeneralSettingsPerBuildTarget.asset");
        }
        EditorBuildSettings.AddConfigObject(XRGeneralSettings.settingsKey, settings, true);
        return settings;
    }

    [MenuItem("Gnarly/Add AR Background Renderer Feature")]
    public static void ConfigureRenderers()
    {
        foreach (var path in RendererPaths)
        {
            var data = AssetDatabase.LoadAssetAtPath<ScriptableRendererData>(path);
            if (data == null || data.rendererFeatures.Any(f => f is ARBackgroundRendererFeature))
                continue;

            var feature = ScriptableObject.CreateInstance<ARBackgroundRendererFeature>();
            feature.name = nameof(ARBackgroundRendererFeature);
            AssetDatabase.AddObjectToAsset(feature, data);
            AssetDatabase.TryGetGUIDAndLocalFileIdentifier(feature, out _, out long localId);

            // Mirrors what URP's renderer inspector does when a feature is added.
            var serialized = new SerializedObject(data);
            var features = serialized.FindProperty("m_RendererFeatures");
            var map = serialized.FindProperty("m_RendererFeatureMap");
            features.arraySize++;
            features.GetArrayElementAtIndex(features.arraySize - 1).objectReferenceValue = feature;
            map.arraySize++;
            map.GetArrayElementAtIndex(map.arraySize - 1).longValue = localId;
            serialized.ApplyModifiedPropertiesWithoutUndo();
            EditorUtility.SetDirty(data);
        }
    }

    [MenuItem("Gnarly/Rebuild Navigator Scene")]
    public static void CreateScene()
    {
        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

        var light = new GameObject("Directional Light").AddComponent<Light>();
        light.type = LightType.Directional;
        light.transform.rotation = Quaternion.Euler(50f, -30f, 0f);

        var session = new GameObject("AR Session", typeof(ARSession), typeof(ARInputManager)).GetComponent<ARSession>();
        var origin = CreateXROrigin();

        new GameObject("EventSystem", typeof(EventSystem), typeof(InputSystemUIInputModule));

        var navigatorObject = new GameObject("Navigator", typeof(RouteNavigator), typeof(RelocalizationController), typeof(LidarPulseView));
        var controller = new SerializedObject(navigatorObject.GetComponent<RelocalizationController>());
        controller.FindProperty("session").objectReferenceValue = session;
        controller.FindProperty("origin").objectReferenceValue = origin;
        controller.FindProperty("navigator").objectReferenceValue = navigatorObject.GetComponent<RouteNavigator>();
        controller.ApplyModifiedPropertiesWithoutUndo();

        Directory.CreateDirectory(Path.GetDirectoryName(ScenePath));
        EditorSceneManager.SaveScene(scene, ScenePath);
        EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
    }

    /// <summary>Matches AR Foundation's GameObject > XR > XR Origin (Mobile AR) menu item.</summary>
    static XROrigin CreateXROrigin()
    {
        var originObject = new GameObject("XR Origin", typeof(XROrigin));
        var offset = new GameObject("Camera Offset");
        offset.transform.SetParent(originObject.transform, false);

        var cameraObject = new GameObject("Main Camera",
            typeof(Camera), typeof(AudioListener), typeof(ARCameraManager), typeof(ARCameraBackground), typeof(TrackedPoseDriver));
        cameraObject.transform.SetParent(offset.transform, false);
        cameraObject.tag = "MainCamera";

        var camera = cameraObject.GetComponent<Camera>();
        camera.clearFlags = CameraClearFlags.Color;
        camera.backgroundColor = Color.black;
        camera.nearClipPlane = 0.1f;
        camera.farClipPlane = 20f;

        var positionAction = new InputAction("Position", binding: "<XRHMD>/centerEyePosition", expectedControlType: "Vector3");
        positionAction.AddBinding("<HandheldARInputDevice>/devicePosition");
        var rotationAction = new InputAction("Rotation", binding: "<XRHMD>/centerEyeRotation", expectedControlType: "Quaternion");
        rotationAction.AddBinding("<HandheldARInputDevice>/deviceRotation");
        var poseDriver = cameraObject.GetComponent<TrackedPoseDriver>();
        poseDriver.positionInput = new InputActionProperty(positionAction);
        poseDriver.rotationInput = new InputActionProperty(rotationAction);

        var origin = originObject.GetComponent<XROrigin>();
        origin.CameraFloorOffsetObject = offset;
        origin.Camera = camera;
        return origin;
    }

    static void EnsureStreamingAssetsFolder()
    {
        Directory.CreateDirectory("Assets/StreamingAssets/zone-a");
        AssetDatabase.Refresh();
    }

    [MenuItem("Gnarly/Copy Firebase Config")]
    public static void CopyFirebaseConfig()
    {
        Directory.CreateDirectory("Assets/StreamingAssets");
        var destination = Path.GetFullPath("Assets/StreamingAssets/GoogleService-Info.plist");
        if (File.Exists(destination))
        {
            Debug.Log($"[Gnarly] Keeping existing Firebase config at {destination}.");
            return;
        }

        var source = Path.GetFullPath("FirebaseConfig/GoogleService-Info.plist");
        if (!File.Exists(source))
        {
            Debug.LogWarning(
                "[Gnarly] Firebase config was not found. Register the navigator's bundle ID in Firebase, " +
                "then place its GoogleService-Info.plist in navigator-unity/FirebaseConfig or " +
                "Assets/StreamingAssets before building.");
            return;
        }

        File.Copy(source, destination, false);
        AssetDatabase.ImportAsset("Assets/StreamingAssets/GoogleService-Info.plist");
        Debug.Log($"[Gnarly] Copied Firebase config to {destination}. This local file is ignored by Git.");
    }
}

public sealed class NavigatorFirebaseBuildValidator : IPreprocessBuildWithReport
{
    public int callbackOrder => 0;

    public void OnPreprocessBuild(BuildReport report)
    {
        if (report.summary.platform != BuildTarget.iOS) return;
        NavigatorProjectSetup.CopyFirebaseConfig();
        if (!File.Exists("Assets/StreamingAssets/GoogleService-Info.plist"))
        {
            Debug.LogWarning(
                "[Gnarly] Firebase configuration is missing. Building with the packaged local scan; " +
                "Firebase package loading remains unavailable until GoogleService-Info.plist is added.");
            return;
        }
        if (!FirebaseNavigationPackageRepository.TryLoadConfig(out _, out var error))
            throw new BuildFailedException(error);
    }
}
