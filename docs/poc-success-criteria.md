# First technical proof: saved ARWorldMap → Unity cube

## Goal

Prove this sequence on a physical LiDAR-capable iPhone:

1. The native mapper scans one small, visually distinctive area.
2. It saves an ARKit `ARWorldMap` and one known world-space test position.
3. A Unity iOS build loads the same world map.
4. ARKit relocalizes after the user looks around the original area.
5. Unity places a cube at the saved position in the correct physical location.

## Explicitly out of scope

- Firebase, Firestore, uploads, or authentication
- Automatic RoomPlan-to-route conversion
- A* routing, destination search, minimap, or route arrows
- Multi-zone or multi-floor transitions
- Production visuals

## Test environment

- One LiDAR-capable iPhone used for capture and navigation testing
- A compact, feature-rich room or hallway—avoid blank or repetitive spaces
- A stable physical test point that is not likely to move

## Completion checklist

- [ ] Mapper can create `worldmap-zone-a.bin`.
- [ ] Mapper can create a matching `test-anchor.json`.
- [ ] Unity can access both files in an iOS build.
- [ ] Unity shows a locating state before relocalization.
- [ ] The cube appears only after localization is adequate for the test.
- [ ] The cube remains spatially stable while walking around it.
- [ ] The result has been demonstrated after restarting the navigation app.
- [ ] Compatibility decisions and any bridge limitation are recorded in [integration-notes.md](integration-notes.md).
