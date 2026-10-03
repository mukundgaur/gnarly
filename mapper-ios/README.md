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

Do not restart the AR session between scanning, recording nodes, and exporting.

## Export checklist

- `worldmap-zone-a.bin` exists and is non-empty.
- `test-anchor.json` validates against [../shared/test-anchor.schema.json](../shared/test-anchor.schema.json).
- `scan.json` contains the wrapped RoomPlan `CapturedRoom`.
- `scan-features.json` validates against [../shared/scan-features.schema.json](../shared/scan-features.schema.json).
- `building.json` validates against [../shared/building.schema.json](../shared/building.schema.json).
- If two or more nodes were recorded, `route.json` validates against [../shared/route.schema.json](../shared/route.schema.json).
- The anchor, route, and graph use the same `zoneId` as the world map.
- Share the generated package directory; do not commit real capture artifacts.

`building.json` nodes are primarily RoomPlan doors, openings, stairs, and sections. Visibility edges connect nodes whose floor-plane line of sight does not cross a wall except at a door or opening. Optional recorded taps add entrance and destination labels for A*.
