# Unity navigator

Unity 6000.6.0f1 iOS app (URP, AR Foundation 6.6.2, Apple ARKit XR Plug-in 6.6.2). It signs in to Firebase, downloads the active `building.json` and zone ARWorldMap, caches them for offline use, relocalizes, and draws a path to the destination.

## Project setup

Run **Gnarly → Configure Navigator Project** once after cloning, or after changing settings by hand. It can be re-run safely; it rebuilds the scene from scratch. It:

- builds `Assets/Scenes/Navigator.unity` with an AR Session, an XR Origin whose camera has the AR camera manager, background, and tracked pose driver, an EventSystem, and a `Navigator` object holding `RelocalizationController` and `RouteNavigator`. This becomes the only scene in the build. `SampleScene` is left from the template and is not used.
- turns on the Apple ARKit loader for iOS and sets ARKit to **Required** (`iOSRequireARKit`).
- sets bundle ID `com.gnarly.navigator`, the camera usage description, iOS 16.0 minimum, iPhone only, and Device SDK.
- adds the AR Background Renderer Feature to the URP renderers so the camera feed is visible.
- creates the Git-ignored `Assets/StreamingAssets/zone-a/` folder and copies the navigator's local `FirebaseConfig/GoogleService-Info.plist` when available.

Batch mode: `Unity -batchmode -quit -projectPath navigator-unity -executeMethod NavigatorProjectSetup.ConfigureAll`.

Then build:

1. In the existing Firebase project, register a second iOS app whose bundle ID matches the Unity navigator (`com.gnarly.navigator` by default). Put its downloaded `GoogleService-Info.plist` in `navigator-unity/FirebaseConfig/`. **Gnarly → Configure Navigator Project** copies it into `Assets/StreamingAssets`; both locations are ignored by Git.
2. In **File → Build Profiles**, choose **iOS**, click **Switch Platform**, then **Build**. This requires the iOS Build Support module.
3. On a Mac, open `Unity-iPhone.xcodeproj`. Under **Signing & Capabilities**, choose your Team. If the default bundle ID is unavailable, change it in Unity Player Settings first, register that exact ID in Firebase, and use its matching plist before rebuilding. Run on the LiDAR iPhone and watch the Xcode console for `[Gnarly]` lines.
4. In the navigator, enter a Firebase email/password plus the Firestore building and zone document IDs. Credentials are held in memory only. Choose **Use downloaded package offline** on later launches when the network is unavailable.

## Firebase package source

The navigator reads:

- `buildings/{buildingId}.activeVersion`
- `buildings/{buildingId}/versions/{versionId}.buildingJsonPath`
- `buildings/{buildingId}/versions/{versionId}/zones/{zoneId}.worldMapPath`

It requires the paths to match:

- `buildings/{buildingId}/{versionId}/building.json`
- `buildings/{buildingId}/{versionId}/worldmaps/{zoneId}.bin`

Both files are downloaded to `Application.persistentDataPath/navigation-cache`. A staging directory and cache manifest prevent incomplete downloads from replacing the last complete package. Firestore and Storage are never accessed before email/password authentication succeeds.

`test-anchor.json`, `scan-features.json`, and `route.json` remain optional local development inputs. The Firebase package requires only `building.json` and the ARWorldMap.

## Package files

| File | Required | Use |
| --- | --- | --- |
| `worldmap-zone-a.bin` | Yes | Downloaded from Storage and applied to ARKit for relocalization |
| `test-anchor.json` | No | Optional POC cube position ([schema](../shared/test-anchor.schema.json)) |
| `scan-features.json` | No | RoomPlan walls/doors used to build the visibility graph |
| `building.json` | Yes | Graph nodes/edges plus destination labels ([schema](../shared/building.schema.json)) |
| `route.json` | No | Fallback polyline if A* has no destination ([schema](../shared/route.schema.json)) |

The mapper exports `scan-features.json` and a visibility `building.json`. Record a destination node (for example Room 204) so A* has a goal. `route.json` is only a fallback walk-order path.

## Behavior

1. Firebase login and active-package download, or selection of a previously downloaded offline package.
2. **Starting camera…** until ARKit tracks.
3. **Locating…** after the world map is applied, until ARKit reports it has relocalized.
4. Unity builds a graph from `building.json`, runs A* from the nearest node to the chosen destination, and draws that path. If a local test anchor exists, its cube is also shown. If tracking is lost, the path is hidden until tracking recovers. **Retry** resets the session and reapplies the cached map.

ARKit positions are converted to Unity by negating Z (right-handed to left-handed).

## Scripts

- `Assets/Scripts/RelocalizationController.cs`: session flow, map loading, cube placement, status UI. `skipWorldMap` is a debug toggle that skips relocalization so route coordinates are relative to where the app starts.
- `Assets/Scripts/FirebaseNavigationPackageRepository.cs`: Firebase email/password authentication, Firestore metadata reads, Storage downloads, path validation, and atomic offline cache.
- `Assets/Scripts/FirebaseNavigationPackageLoader.cs`: login/building/zone UI and offline-package selection.
- `Assets/Scripts/RouteNavigator.cs`: path ribbon, waypoint markers, off-screen turn arrow.
- `Assets/Scripts/Pathfinding.cs`: RoomPlan visibility connections and A*.

Commit `Assets/`, `Packages/`, and `ProjectSettings/` only.
