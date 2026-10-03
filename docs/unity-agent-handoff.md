# Unity agent handoff — AR relocalization proof

## Your mission

Build the visitor-side Unity iOS proof of concept. Given one ARKit world map captured by the mapper app, restart in the same physical space, relocalize, and show a cube at a saved real-world position.

You own the Unity app only; the mapper team owns RoomPlan, scanning, ARKit world-map capture, and production of the files below.

## What you will receive

The mapper will make this local package available at `shared/local-packages/zone-a/`:

```text
worldmap-zone-a.bin   Saved ARKit ARWorldMap bytes
test-anchor.json      One cube position in the map's ARKit coordinates
```

`test-anchor.json` follows [../shared/test-anchor.schema.json](../shared/test-anchor.schema.json). Its `position` is `[x, y, z]`, measured in meters in the ARKit world coordinate system used while the map was captured. Only use an anchor with its matching `zoneId` world map.

## Build in this order

1. Create the Unity iOS project in `navigator-unity/`.
2. Add AR Foundation and Apple ARKit XR Plug-in, then confirm basic camera tracking on the test iPhone.
3. Add a visible **Locating…** state and a retry/tracking-loss state.
4. Solve the compatibility spike: load and apply `worldmap-zone-a.bin` to ARKit from Unity.
5. After relocalization, read `test-anchor.json` and place one cube at its saved position.
6. Restart the app in the original physical area and verify the cube is stable and correctly located.

## Important constraint

Do not assume a Swift-saved `ARWorldMap` can be applied directly by Unity. Test that first. If AR Foundation's public API cannot consume the saved bytes, create the smallest possible iOS-native bridge within the Unity iOS build. Keep the bridge scoped to map loading/application; Unity should continue to own UI and object placement.

## Done means

- The Unity app runs on the LiDAR test iPhone.
- It loads the mapper's map and enters a locating state.
- It relocalizes after the user looks around the original scanned space.
- The cube appears at the position from `test-anchor.json`.
- The cube stays fixed in the physical environment while the user moves.
- The behavior still works after restarting the Unity app.

## Not part of this task

No Firebase, destination search, routing, RoomPlan parsing, navigation arrows, minimap, two-floor behavior, or visual polish. Record tested versions, bridge approach, and any blockers in [integration-notes.md](integration-notes.md).
