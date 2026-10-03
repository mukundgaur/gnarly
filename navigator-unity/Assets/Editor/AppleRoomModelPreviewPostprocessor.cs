#if UNITY_IOS
using UnityEditor;
using UnityEditor.Callbacks;
using UnityEditor.iOS.Xcode;

public static class AppleRoomModelPreviewPostprocessor
{
    [PostProcessBuild(1000)]
    public static void AddQuickLookFramework(BuildTarget target, string buildPath)
    {
        if (target != BuildTarget.iOS) return;

        var projectPath = PBXProject.GetPBXProjectPath(buildPath);
        var project = new PBXProject();
        project.ReadFromFile(projectPath);
        var frameworkTarget = project.GetUnityFrameworkTargetGuid();
        project.AddFrameworkToProject(frameworkTarget, "RealityKit.framework", false);
        project.AddFrameworkToProject(frameworkTarget, "CoreHaptics.framework", false);
        project.WriteToFile(projectPath);
    }
}
#endif
