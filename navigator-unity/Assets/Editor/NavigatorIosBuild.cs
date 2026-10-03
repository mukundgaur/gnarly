using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;

/// <summary>Repeatable local iOS export used by the team after Navigator source changes.</summary>
public static class NavigatorIosBuild
{
    const string DefaultOutput = "Build/iOS-navigator";

    [MenuItem("Gnarly/Build iOS Navigator")]
    public static void Build()
    {
        var output = Environment.GetEnvironmentVariable("GNARLY_NAVIGATOR_IOS_OUTPUT");
        if (string.IsNullOrWhiteSpace(output))
            output = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), DefaultOutput));

        var enabledScenes = EditorBuildSettings.scenes
            .Where(scene => scene.enabled)
            .Select(scene => scene.path)
            .ToArray();
        if (enabledScenes.Length == 0)
            throw new BuildFailedException("Navigator has no enabled scenes in Build Settings.");

        var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
        {
            scenes = enabledScenes,
            locationPathName = output,
            target = BuildTarget.iOS,
            options = BuildOptions.None
        });
        if (report.summary.result != BuildResult.Succeeded)
            throw new BuildFailedException($"iOS export failed: {report.summary.result}.");

        UnityEngine.Debug.Log($"[Gnarly] iOS Navigator export created at {output}.");
    }
}
