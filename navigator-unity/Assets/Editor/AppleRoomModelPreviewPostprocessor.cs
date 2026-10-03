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
        project.AddFrameworkToProject(project.GetUnityFrameworkTargetGuid(), "RealityKit.framework", false);
        project.WriteToFile(projectPath);
    }
}
#endif
