# Native mapper workspace

This is the native Swift/SwiftUI mapper proof-of-concept app. See [SETUP.md](SETUP.md) to generate the Xcode project and run it on a LiDAR iPhone.

## POC responsibility

- Use a shared ARKit `ARSession` for RoomPlan and mapping.
- Scan one connected, visually distinctive test area.
- Persist the `ARWorldMap` from that session.
- Export one known test position in the same coordinate system.
- Export a package from the app’s Documents directory and share it with the Unity engineer. After transfer, they may place a copy in `../shared/local-packages/zone-a/` for their local Unity build.

Target a LiDAR-capable iPhone running iOS 16 or later. Before testing, record the selected Xcode/iOS versions in [../docs/integration-notes.md](../docs/integration-notes.md).

## Export checklist

- `worldmap-zone-a.bin` exists and is non-empty.
- `test-anchor.json` validates against [../shared/test-anchor.schema.json](../shared/test-anchor.schema.json).
- The anchor describes an intentionally chosen physical point.
- Both files came from the same AR session/zone.
- Share the generated package directory with the Unity engineer; do not commit real capture artifacts.

## Still to do: route recording (`route.json`)

The Unity navigator can now draw a highlighted path through waypoints and show a turn arrow when the next waypoint is off-screen. It reads an optional `route.json`, but the mapper does not export one yet; until it does, the Unity side is tested with hand-written routes. To produce one:

1. **Record waypoints in the same session.** Add an **Add waypoint** button (plus **Undo last waypoint**) that appends the current camera position, exactly like `markTestAnchor()` does with `frame.camera.transform.columns.3`. Waypoints must come from the same `ARSession` as the exported world map; do not restart the session between scanning, recording, and exporting.
2. **Walk the route in order.** Tap at the start, at every turn, and every 3–5 m on straight stretches. The last waypoint is the destination. Keep the whole route inside the scanned area—the navigator can only relocalize where the map has features.
3. **Export `route.json`** next to `test-anchor.json` in `POCPackageExporter.export`, following [../shared/route.schema.json](../shared/route.schema.json) (example: [../shared/examples/route.example.json](../shared/examples/route.example.json)):
   - `zoneId` must match the world map's zone ID.
   - `coordinateSystem` is `"arkit-world-meters"`; positions are raw ARKit `[x, y, z]`—Unity handles the axis conversion.
   - Set `heightReference` to `"device"` for raw camera positions; Unity lowers them about 1.3 m to the floor. If you later project waypoints onto the detected floor plane, use `"floor"`.
4. **Show progress in the UI**, for example "Waypoints: 4", and disable export of a route with fewer than two waypoints.

Route export checklist:

- `route.json` validates against [../shared/route.schema.json](../shared/route.schema.json) and has at least two waypoints.
- Its `zoneId` matches `worldmap-<zone-id>.bin` and `test-anchor.json`.
- The scan covered the full walked route.
