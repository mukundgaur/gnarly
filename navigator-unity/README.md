# Unity navigator

Unity 6000.6.0f1 iOS app (URP, AR Foundation 6.6.2, Apple ARKit XR Plug-in 6.6.2). It signs in to Firebase, downloads the active building graph, normalized RoomPlan scan, USDZ structure, and zone ARWorldMap, caches them for offline use, relocalizes, and draws a path to the destination.

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
- `buildings/{buildingId}/versions/{versionId}.structurePath`
- `buildings/{buildingId}/versions/{versionId}/zones/{zoneId}.worldMapPath`

It requires the paths to match:

- `buildings/{buildingId}/{versionId}/building.json`
- `buildings/{buildingId}/{versionId}/scan.json`
- `buildings/{buildingId}/{versionId}/scan-features.json`
- `buildings/{buildingId}/{versionId}/structure.usdz`
- `buildings/{buildingId}/{versionId}/worldmaps/{zoneId}.bin`

All five files are downloaded to `Application.persistentDataPath/navigation-cache`. A staging directory and cache manifest prevent incomplete downloads from replacing the last complete package. Firestore and Storage are never accessed before email/password authentication succeeds. Versions uploaded before the interactive-map change do not contain the scan-features/USDZ pair and must be uploaded again from the mapper.

`scan.json` remains the raw wrapped RoomPlan `CapturedRoom`; `scan-features.json` is its normalized geometry for Unity and selectable map nodes. `test-anchor.json` and `route.json` remain optional local development inputs.

## Package files

| File | Required | Use |
| --- | --- | --- |
| `worldmap-zone-a.bin` | Yes | Downloaded from Storage and applied to ARKit for relocalization |
| `test-anchor.json` | No | Optional POC cube position ([schema](../shared/test-anchor.schema.json)) |
| `scan.json` | Yes | Raw wrapped RoomPlan `CapturedRoom` retained for package fidelity |
| `scan-features.json` | Yes | Normalized RoomPlan walls/doors/rooms used for the compact map and selectable nodes |
| `building.json` | Yes | Graph nodes/edges plus destination labels ([schema](../shared/building.schema.json)) |
| `structure.usdz` | Yes | Original RoomPlan building geometry rendered in the expanded iPhone map |
| `route.json` | No | Fallback polyline if A* has no destination ([schema](../shared/route.schema.json)) |

The mapper exports `scan-features.json` and a visibility `building.json`. Record a destination node (for example Room 204) so A* has a goal. `route.json` is only a fallback walk-order path.

## Multi-zone routes (floors and stairs)

A zone is one scan with its own ARWorldMap; a staircase is its own zone. To route between zones, place each zone's package in its own folder and add `zone-connections.json` ([schema](../shared/zone-connections.schema.json)):

```text
Assets/StreamingAssets/
  zone-connections.json
  floor-1/   worldmap-floor-1.bin, building.json, scan-features.json, …
  stairs-a/  worldmap-stairs-a.bin, building.json, …
  floor-2/   …
```

The `Zone Id` field on `RelocalizationController` is the zone the user starts in. The app:

1. Builds each zone's graph, merges them under `zoneId/nodeId` keys, and adds every connection as a bidirectional edge with weight 1 (`Pathfinding.ZoneTransferCost`). The A* heuristic is straight-line distance within a zone and 0 across zones, because coordinates from different world maps are not comparable.
2. Starts A* from the nearest node in the current zone. Destinations from every zone are listed, labeled with their zone.
3. Splits the path into one leg per zone and draws only the current leg. On arriving at the leg's connector node, it applies the next zone's world map, shows **Entering &lt;zone&gt;… Look around**, and draws the next leg after relocalizing. **Reset map** relocalizes in the current zone and resumes the route.

With Firebase (`useFirebasePackages`, on by default), choosing a scan from the library downloads that zone and also tries every other zone of the same building into the offline cache. Other zones are then read from that cache. Connections are read from `buildings/{buildingId}/{versionId}/zone-connections.json` in Storage when present, otherwise from a bundled `StreamingAssets/zone-connections.json`. A zone that fails to download, for example because its version's `building.json` belongs to another zone, is logged and left out of routing. With Firebase off, every zone is read from `StreamingAssets/<zoneId>/`.

## Behavior

1. Firebase login and active-package download, or selection of a previously downloaded offline package.
2. **Starting camera…** until ARKit tracks.
3. **Locating…** after the world map is applied, until ARKit reports it has relocalized.
4. Unity builds a graph from `building.json`, runs A* from the nearest node to the chosen destination, and draws that path. If a local test anchor exists, its cube is also shown. If tracking is lost, the path is hidden until tracking recovers. **Retry** resets the session and reapplies the cached map.

The compact map card is a real Unity `Button` with raycasts enabled. On iPhone it opens the existing RealityKit RoomPlan view. One finger orbits, pinching zooms, and two fingers pan. Tap a colored map marker, set it as Start or Destination, and tap **Show Route**; the native view returns the original node IDs to `RelocalizationController`, which runs the existing A* graph and sends the resulting route back to the 3D view. Green marks Start, pink marks Destination, and yellow marks the currently tapped node. **Reset View** reframes the building and **Back** closes the view.

ARKit positions are converted to Unity by negating Z (right-handed to left-handed).

## Scripts

- `Assets/Scripts/RelocalizationController.cs`: session flow, map loading, cube placement, status UI. `skipWorldMap` is a debug toggle that skips relocalization so route coordinates are relative to where the app starts.
- `Assets/Scripts/FirebaseNavigationPackageRepository.cs`: Firebase email/password authentication, Firestore metadata reads, Storage downloads, path validation, and atomic offline cache.
- `Assets/Scripts/FirebaseNavigationPackageLoader.cs`: login/building/zone UI and offline-package selection.
- `Assets/Scripts/RouteNavigator.cs`: path ribbon, waypoint markers, off-screen turn arrow.
- `Assets/Scripts/LidarPulseView.cs`: **LiDAR** button (bottom left). Turns on ARKit scene depth via an `AROcclusionManager` with occlusion disabled, accumulates a 5 cm voxel point cloud in session space, and draws it as dark green dots (`Assets/Resources/GnarlyLidarPoints.shader`) that brighten as a pulse sweeps out from the user every 1.6 s. Unlike feature points, LiDAR depth works in the dark. The cloud is cleared on relocalization and **Reset map**.
- `Assets/Scripts/Pathfinding.cs`: RoomPlan visibility connections, multi-zone graph merging, and A*.

Commit `Assets/`, `Packages/`, and `ProjectSettings/` only.
