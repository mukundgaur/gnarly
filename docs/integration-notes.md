# POC integration notes

Record decisions and findings here as the two workstreams meet. This prevents a device-specific ARKit/Unity issue from being rediscovered later.

| Date | Owner | Finding / decision | Impact | Follow-up |
| --- | --- | --- | --- | --- |
| 2026-10-02 | Unity | Unity 6000.6.0f1 with AR Foundation 6.6.2 and Apple ARKit XR Plug-in 6.6.2. Map applied via `ARWorldMap.TryDeserialize` and `ARKitSessionSubsystem.ApplyWorldMap`; both sides use `NSKeyedArchiver`, so no native bridge is expected. | Bridge only needed if deserialization fails on device | Confirm on device |
| 2026-10-02 | Unity | Relocalization is ready when tracking returns to normal after ARKit has reported `Relocalizing`. | Defines when the cube and path appear | Confirm on device |
| 2026-10-02 | Unity | ARKit `[x, y, z]` becomes Unity `(x, y, -z)`, placed under `XROrigin.TrackablesParent`. | Applies to anchor and route positions | — |
| 2026-10-02 | Unity | Route guidance started ahead of the cube proof: optional `route.json` ([schema](../shared/route.schema.json)) is drawn as a floor path with an off-screen turn arrow. | Mapper must export `route.json` (see `mapper-ios/README.md`) | Mapper: add waypoint recording |
| 2026-10-02 | Mapper | Mapper records graph nodes during the scan and exports `scan.json`, `scan-features.json`, `building.json`, and `route.json`. RoomPlan doors/openings/stairs are unconnected `roomplan-hint` nodes. | Graph work can start from a LiDAR package without waiting on Unity | Confirm on a LiDAR iPhone; connect remaining edges by hand |
| 2026-10-03 | Unity | Navigator reads the active version from Firestore and downloads `building.json` plus the zone ARWorldMap from Storage after Firebase email/password authentication. Downloads are staged and cached under `Application.persistentDataPath`; a complete cache can run offline. The client uses Firebase's authenticated HTTPS APIs so no custom backend or additional Unity SDK package is required. | Removes the `StreamingAssets` package-transfer step for normal use while preserving offline navigation | Populate one published building/version/zone and verify on the LiDAR iPhone |
| 2026-10-03 | Mapper | RoomPlan `stairs` objects are separate stair zones. The mapper writes `zone-connections.json` from those objects: a floor node links to `landing-below` or `landing-above`, and `prev`/`next` record which floor that landing is. The navigator's existing multi-zone A* follows that file. | Stair mapping no longer depends on a hand-written connection file | Scan a floor with a staircase, scan the stairwell, upload both zones and the generated connections |
| 2026-10-03 | Web | Each building version uses one zone/file set per floor. The editor labels elevator waypoints and connects matching elevator points between floor files through `zone-connections.json`; existing stair data remains readable. | Multi-floor navigation follows the building → floors → elevator-links model | Verify a real elevator route across two floor scans on device |
| 2026-10-03 | Web | The building explorer stacks every floor file in one orbit/zoom 3D overview. Explicit elevator links align the otherwise independent floor coordinate systems and render as dotted vertical guides. Dropping the person resolves the pick back to that floor's local coordinates before entering walk mode. | Users can understand and enter a multi-floor building without merging AR coordinate systems | Replace the illustrative sample with two real linked floor scans |
| 2026-10-03 | Web / shared contract | Zones may expose `continuation` waypoints at their beginning and end. A typed continuation link joins adjacent scans on the same floor without calling the handoff a door; elevator and legacy stair links remain compatible. | Large floors can be mapped as several scan files and routed as one continuous space | Verify a route across two adjacent real scans and relocalize at the shared continuation point |
| 2026-10-03 | Web / shared contract | The website now routes across the whole building. Zones are assigned to floors and placed in a shared per-floor frame (`x`, `z`, `rotationDegrees`) by `building-layout.json`. Continuation pairs align zones automatically: one pair sets translation, two or more set rotation as well. Elevator links are floor-to-floor teleports costing 30 + 6 per floor, the same as Unity `Pathfinding.cs`, and never affect alignment (this replaces the earlier entry where elevator links aligned floors). Node keys are `zoneId/nodeId`. `building-layout.json` gains an optional, additive `floors: [{ floor, name }]`. Recorded/walked edges are always routable; when the scan disagrees with one, it gets a `warning` status instead of being blocked. | The navigator can read the same layout to place zones; older layout files stay valid | Unity: decide whether to honor `rotationDegrees` and the elevator shaft cost when merging zones; verify on two real adjacent scans |

## Decisions to record

- Tested iPhone model and iOS version
- Xcode version
- Unity editor version
- AR Foundation and Apple ARKit XR Plug-in versions
- How the Swift-generated `ARWorldMap` bytes reach Unity
- How Unity decides that relocalization is ready
- ARKit coordinate-axis/units assumptions
