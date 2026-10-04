# Native mapper workspace

This is the native Swift/SwiftUI mapper proof-of-concept app. See [SETUP.md](SETUP.md) to generate the Xcode project and run it on a LiDAR iPhone.

## POC responsibility

- Use a shared ARKit `ARSession` for RoomPlan and mapping.
- Scan one connected, visually distinctive test area.
- Persist the `ARWorldMap` from that session.
- Export one known test position in the same coordinate system.
- Record navigation-graph nodes (entrance, hallway turns, stairs, destinations) in that same session.
- Export RoomPlan geometry as `scan.json` / `scan-features.json` and a starter `building.json`.
- Export a package from the app’s Documents directory and share it with the Unity engineer. After transfer, they may place a copy in `../shared/local-packages/zone-a/` for their local Unity build.

Target a LiDAR-capable iPhone running iOS 17 or later. Before testing, record the selected Xcode/iOS versions in [../docs/integration-notes.md](../docs/integration-notes.md).

## Scan workflow

1. Start a scan in a distinctive room or hallway.
2. As you walk, RoomPlan captures doors, openings, stairs, and room sections. Optionally tap **Add node** only to label an entrance or a destination such as `Room 204`.
3. Tap **Finish room** when RoomPlan has the space.
4. Stand at the Unity cube test point and tap **Mark test anchor** (optional if you already recorded a node).
5. Export and share the package.

Do not restart the AR session between scanning, recording nodes, and exporting one map. A stairwell is a different map: finish the floor, then start a stair scan, which resets tracking so the stair zone gets its own `ARWorldMap`.

## Stairs

RoomPlan’s stair object becomes a separate zone. The floor graph keeps that object as a portal node. `prev` is the floor below and `next` is the floor above. Export writes `zone-connections.json`, which the navigator’s multi-zone A* already follows: the floor node links to `landing-below` or `landing-above` in the stair zone.

Tap **Stairs** after the floor scan. That starts a new world map for the stairwell. On the other floor, pick the same stair zone and mark that floor as above or below before exporting. Upload each zone; the stair links upload with the package.

## Export checklist

- `worldmap-zone-a.bin` exists and is non-empty.
- `test-anchor.json` validates against [../shared/test-anchor.schema.json](../shared/test-anchor.schema.json).
- `scan.json` contains the wrapped RoomPlan `CapturedRoom`.
- `scan-features.json` validates against [../shared/scan-features.schema.json](../shared/scan-features.schema.json).
- `building.json` validates against [../shared/building.schema.json](../shared/building.schema.json).
- If two or more nodes were recorded, `route.json` validates against [../shared/route.schema.json](../shared/route.schema.json).
- If a stair was detected or linked, `stairs.json` validates against [../shared/stairs.schema.json](../shared/stairs.schema.json).
- The anchor, route, and graph use the same `zoneId` as the world map.
- Share the generated package directory; do not commit real capture artifacts.

Uploading from the mapper publishes raw `scan.json`, normalized `scan-features.json`, `structure.usdz`, `building.json`, and the zone ARWorldMap. The navigator requires all five files for a complete interactive-map package. Re-upload scans whose active Firebase version predates this package format.

## Multi-floor buildings

A building owns one version, and each floor is uploaded as its own zone/file set with its own `building.json`, scan files, structure, and ARWorldMap (for example `floor-1`, `floor-2`, `floor-3`). Label the same physical elevator as an `elevator` node in each floor graph. The web editor writes links between those nodes to `zone-connections.json` ([schema](../shared/zone-connections.schema.json), [example](../shared/examples/zone-connections.example.json)). The Unity navigator treats each link as bidirectional and plans A* across floors.

The mapper’s manual waypoint type picker includes **Elevator**. Record or add the elevator point on each floor, upload every floor under the same building version, and connect the matching points in the web editor. Existing stair-zone packages remain compatible, but stairs are no longer the primary multi-floor workflow.

Firebase stores the shared connection file at `buildings/{buildingId}/{versionId}/zone-connections.json` and each floor graph under `buildings/{buildingId}/{versionId}/zones/{floorZoneId}/building.json`.

`building.json` nodes are primarily RoomPlan doors, openings, stairs, and sections. Visibility edges connect nodes whose floor-plane line of sight does not cross a wall except at a door or opening. Optional recorded taps add entrance and destination labels for A*.
