# Shared POC package contract

The mapper produces a local package for the Unity navigator and for navigation-graph work. The committed schema exists to keep the two workstreams compatible; real captured maps are deliberately ignored.

## Local exchange layout

```text
shared/local-packages/
  zone-a/
    worldmap-zone-a.bin
    test-anchor.json
    scan.json
    scan-features.json
    building.json
    route.json
    structure.usdz
    structure-metadata.json
    manifest.json
```

`shared/local-packages/` is ignored by Git. It may contain real building imagery/features encoded in ARKit data and should be transferred only to teammates who need it.

## Contract

- `worldmap-zone-a.bin`: opaque byte representation of the saved ARKit `ARWorldMap`.
- `test-anchor.json`: schema described in [test-anchor.schema.json](test-anchor.schema.json).
- `scan.json`: wrapped RoomPlan `CapturedRoom` JSON in the same ARKit coordinate system.
- `scan-features.json`: normalized walls, doors, openings, windows, floors, objects, and sections. Schema: [scan-features.schema.json](scan-features.schema.json). Example: [examples/scan-features.example.json](examples/scan-features.example.json).
- `building.json`: navigation graph. RoomPlan doors/openings/stairs/sections plus visibility edges; optional recorded entrance/destination labels. Schema: [building.schema.json](building.schema.json). Example: [examples/building.example.json](examples/building.example.json).
- `route.json`: ordered waypoints from recorded nodes, described in [route.schema.json](route.schema.json). See [examples/route.example.json](examples/route.example.json).
- `structure.usdz` / `structure-metadata.json`: RoomPlan mesh plus identifier mapping for later minimap work.
- Positions are in meters in the **restored ARKit world coordinate system** used during capture.
- `zoneId` identifies the specific world map. The Unity app must never use an anchor or route from a different zone.

The serialization/deserialization bridge is intentionally undecided until the compatibility spike succeeds. Record the chosen approach in [../docs/integration-notes.md](../docs/integration-notes.md).
