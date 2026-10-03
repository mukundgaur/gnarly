# Unity navigator

Unity 6000.6.0f1 iOS app (URP, AR Foundation 6.6.2, Apple ARKit XR Plug-in 6.6.2). It loads the mapper's ARWorldMap, relocalizes, places the test cube, and—if a route is supplied—draws a path to the destination.

## Project setup

Run **Gnarly → Configure Navigator Project** once after cloning, or after changing settings by hand. It can be re-run safely; it rebuilds the scene from scratch. It:

- builds `Assets/Scenes/Navigator.unity` with an AR Session, an XR Origin whose camera has the AR camera manager, background, and tracked pose driver, an EventSystem, and a `Navigator` object holding `RelocalizationController` and `RouteNavigator`. This becomes the only scene in the build. `SampleScene` is left from the template and is not used.
- turns on the Apple ARKit loader for iOS and sets ARKit to **Required** (`iOSRequireARKit`).
- sets bundle ID `com.gnarly.navigator`, the camera usage description, iOS 16.0 minimum, iPhone only, and Device SDK.
- adds the AR Background Renderer Feature to the URP renderers so the camera feed is visible.
- creates the Git-ignored `Assets/StreamingAssets/zone-a/` folder.

Batch mode: `Unity -batchmode -quit -projectPath navigator-unity -executeMethod NavigatorProjectSetup.ConfigureAll`.

Then build:

1. Copy the mapper package into `Assets/StreamingAssets/zone-a/`. Do not commit it.
2. In **File → Build Profiles**, choose **iOS**, click **Switch Platform**, then **Build**. This requires the iOS Build Support module.
3. On a Mac, open `Unity-iPhone.xcodeproj`. Under **Signing & Capabilities**, choose your Personal Team and change the bundle ID if it is already taken. Run on the LiDAR iPhone, and watch the Xcode console for `[Gnarly]` lines.

## Inputs

Copy the mapper's files into `Assets/StreamingAssets/zone-a/` before building. The folder is Git-ignored because real maps encode building imagery.

| File | Required | Use |
| --- | --- | --- |
| `worldmap-zone-a.bin` | Yes | Applied to ARKit for relocalization |
| `test-anchor.json` | Yes | Position of the test cube ([schema](../shared/test-anchor.schema.json)) |
| `route.json` | No | Waypoints for path guidance ([schema](../shared/route.schema.json)) |

The mapper does not export `route.json` yet (see [../mapper-ios/README.md](../mapper-ios/README.md)); hand-write one from [../shared/examples/route.example.json](../shared/examples/route.example.json) to test.

## Behavior

1. **Starting camera…** until ARKit tracks.
2. **Locating…** after the world map is applied, until ARKit reports it has relocalized.
3. The cube appears at the test anchor. With a route, a pulsing path is drawn on the floor from the user through the remaining waypoints, with a pillar at the destination. When the next waypoint is off-screen, an edge arrow with "Turn left/right/around" points toward it. The status shows the remaining distance, then "You have arrived".
4. If tracking is lost, the path is hidden until tracking recovers. **Retry** resets the session and reapplies the map.

ARKit positions are converted to Unity by negating Z (right-handed to left-handed).

## Scripts

- `Assets/Scripts/RelocalizationController.cs`: session flow, map loading, cube placement, status UI. `skipWorldMap` is a debug toggle that skips relocalization so route coordinates are relative to where the app starts.
- `Assets/Scripts/RouteNavigator.cs`: path ribbon, waypoint markers, off-screen turn arrow.
- `Assets/Scripts/TestAnchor.cs`, `Assets/Scripts/Route.cs`: JSON contracts.

Commit `Assets/`, `Packages/`, and `ProjectSettings/` only.
