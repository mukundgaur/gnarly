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
| `surface-colors.json` + `.jpg` | No | Real photo colors for the minimap walls, floors, doors and objects ([schema](../shared/surface-colors.schema.json)); downloaded from the zone folder when present |
| `stairs.json` | No | Separate stair zones, with `prev`/`next` floors and the floor lookup ([schema](../shared/stairs.schema.json)) |

The mapper exports `scan-features.json` and a visibility `building.json`. Record a destination node (for example Room 204) so A* has a goal. `route.json` is only a fallback walk-order path.

## Multi-floor routes

A building is divided into zones. Each zone has its own scan, graph, and ARWorldMap. Matching elevator nodes connect floors, while continuation nodes connect adjacent scans on the same floor. Both are stored in `zone-connections.json` ([schema](../shared/zone-connections.schema.json)):

```text
Assets/StreamingAssets/
  zone-connections.json
  floor-1/   worldmap-floor-1.bin, building.json, scan-features.json, …
  floor-2/   worldmap-floor-2.bin, building.json, scan-features.json, …
  floor-3/   …
```

The `Zone Id` field on `RelocalizationController` is the zone the user starts in. The app:

1. Builds each zone's graph and merges them under `zoneId/nodeId` keys. Elevator-to-elevator links connect floors; each ride is one bidirectional edge whose A* weight is a boarding cost plus a per-story cost, so a two-story ride costs more than a one-story ride. Continuation-to-continuation links connect adjacent scans on the same floor with weight 1 and are not doors. The heuristic uses straight-line distance inside a zone and a conservative cross-zone estimate because coordinates from different world maps are not comparable.
2. Starts A* from the chosen start point, or from the node nearest to you when the start is **My location**. The start must be in the current zone. Destinations can be in any zone; the route planner's list includes places from every zone, labeled with their zone.
3. Splits the path into one leg per zone and draws only the current leg. A cross-floor leg ends at the elevator waypoint; a same-floor handoff ends at the continuation connector. On arrival, it applies the next zone's world map, shows **Entering &lt;zone&gt;… Look around**, and draws the next leg after relocalizing. **Reset map** relocalizes in the current zone and resumes the route. Continuations are ordinary map handoffs, not doors. Legacy stair-zone links use the same mechanism.

With Firebase (`useFirebasePackages`, on by default), choosing a scan from the library downloads that zone and also tries every other zone of the same building into the offline cache. Other zones are then read from that cache. Connections are read from `buildings/{buildingId}/{versionId}/zone-connections.json` in Storage when present, otherwise from a bundled `StreamingAssets/zone-connections.json`. A zone that fails to download, for example because its version's `building.json` belongs to another zone, is logged and left out of routing. With Firebase off, every zone is read from `StreamingAssets/<zoneId>/`.

The web editor may also save `buildings/{buildingId}/{versionId}/building-layout.json`. It is display-only placement metadata (floor, X/Z, rotation); Firebase downloads cache it alongside each zone. It must not be used to transform ARKit tracking or route coordinates.

## Behavior

1. Firebase login and active-package download, or selection of a previously downloaded offline package.
2. **Starting camera…** until ARKit tracks.
3. **Locating…** after the world map is applied, until ARKit reports it has relocalized.
4. Once located, the **route planner** opens (see below). After you start navigation, Unity draws the A* path in AR. If a local test anchor exists, its cube is also shown. If tracking is lost, the path is hidden until tracking recovers. **Retry** resets the session and reapplies the cached map.

### Route planner (choosing start and destination)

Tap the minimap (top right, below the status card) at any time to open the full-screen planner. It works in the Editor and on iPhone.

- **From / To**: two rows at the top. Tap a row to choose which end the next pick sets; the highlighted row is active. **From** defaults to **My location**. After you pick a start, **My location** switches it back. **×** clears the destination and **SWAP** reverses the route.
- **Map**: a top-down view of the scan. Tap a dot to assign it to the active row; picking a start moves you on to choosing the destination. Drag to pan, and pinch or scroll to zoom. **+ / −** zoom and **ME** recenters on you. Named places have labels. Colors: mint is you, green is the start, pink is the destination, amber is a recorded destination, violet is a room, blue is stairs, and small teal dots are doors and openings.
- **Places**: a list of named places (destinations, entrances, rooms, stairs). It includes places in other zones, so you can choose a destination on another floor. A start in another zone is rejected because the start must be where you are now.
- **Preview**: every change runs A* immediately. The map draws the route in white, and the footer shows distance, walking time and zone changes, or why no route exists. **Start navigation** (or **Update route** while navigating) begins AR guidance; **Clear** resets both ends.
- **3D view** (iPhone only, when `structure.usdz` is in the package): opens the RealityKit RoomPlan view with the planner's selection. One finger orbits, pinching zooms, and two fingers pan. Tap a dot, then **Set as Start** or **Set as Destination**. **My Location**, **Swap** and **Clear** work as in the planner. **Start Navigation** sends local node IDs back to `RelocalizationController` through `OnIndoorMapRouteRequested`, with an empty `startId` meaning my location.

When you start from a point other than your location, the AR ribbon still guides you from where you are to the nearest point on that route, then along it.

A stair on the floor is a portal into another world map. Choosing it, or arriving there, opens that stair zone only when `StreamingAssets/<stair-zone>/worldmap-<stair-zone>.bin` exists. The stair map draws the landing below and the landing above. **Down** and **Up** follow `prev` and `next`, and the floor you land on comes from `floorIndex`. Each of those floors is its own scanned map.

ARKit positions are converted to Unity by negating Z (right-handed to left-handed).

## Scripts

- `Assets/Scripts/RelocalizationController.cs`: session flow, map loading, cube placement, status UI. `skipWorldMap` is a debug toggle that skips relocalization so route coordinates are relative to where the app starts.
- `Assets/Scripts/FirebaseNavigationPackageRepository.cs`: Firebase email/password authentication, Firestore metadata reads, Storage downloads, path validation, and atomic offline cache.
- `Assets/Scripts/FirebaseNavigationPackageLoader.cs`: login/building/zone UI and offline-package selection.
- `Assets/Scripts/RouteNavigator.cs`: path ribbon, waypoint markers, off-screen turn arrow.
- `Assets/Scripts/LidarPulseView.cs`: **LiDAR** button (bottom left). Turns on ARKit scene depth via an `AROcclusionManager` with occlusion disabled, casts 1,200 random rays per depth frame out to 6 m and keeps the newest 300,000 hits in session space (rays are uniform across the view, so near surfaces are dense and far ones sparse), and draws it as dark green dots (`Assets/Resources/GnarlyLidarPoints.shader`) that brighten as a pulse sweeps out from the user every 1.6 s. Unlike feature points, LiDAR depth works in the dark. The cloud is cleared on relocalization and **Reset map**.
- `Assets/Scripts/Pathfinding.cs`: RoomPlan visibility connections, multi-zone graph merging, and A*.
- `Assets/Scripts/IndoorMapOverlay.cs`: minimap card, top-down map rendering (scan geometry, place markers, start and destination pins, routes), and the bridge to the native 3D view. `IndoorMapOverlay.Planner.cs` holds the route-planner screen; `MapViewportInput.cs` handles tap, pan and pinch on the map; `MapUi.cs` has shared colors and uGUI builders.
- `Assets/Plugins/iOS/AppleRoomModelPreview.swift`: RealityKit 3D view of `structure.usdz` with marker selection.

Commit `Assets/`, `Packages/`, and `ProjectSettings/` only.
