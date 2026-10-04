# Shared POC package contract

The mapper produces a local package for the Unity navigator and for navigation-graph work. The committed schema exists to keep the two workstreams compatible; real captured maps are deliberately ignored.

## Local exchange layout

```text
shared/local-packages/
  floor-1/
    worldmap-floor-1.bin
    test-anchor.json
    scan.json
    scan-features.json
    building.json
    route.json
    stairs.json
    structure.usdz
    structure-metadata.json
    manifest.json
  floor-2/              another floor zone, same file set
  zone-connections.json building-level elevator links between floors
```

`shared/local-packages/` is ignored by Git. It may contain real building imagery/features encoded in ARKit data and should be transferred only to teammates who need it.

## Contract

- `worldmap-zone-a.bin`: opaque byte representation of the saved ARKit `ARWorldMap`.
- `test-anchor.json`: schema described in [test-anchor.schema.json](test-anchor.schema.json).
- `scan.json`: wrapped RoomPlan `CapturedRoom` JSON in the same ARKit coordinate system.
- `scan-features.json`: normalized walls, doors, openings, windows, floors, objects, and sections. Schema: [scan-features.schema.json](scan-features.schema.json). Example: [examples/scan-features.example.json](examples/scan-features.example.json).
- `building.json`: navigation graph. RoomPlan doors/openings/stairs/sections plus visibility edges; optional recorded entrance/destination labels. Schema: [building.schema.json](building.schema.json). Example: [examples/building.example.json](examples/building.example.json). Stair nodes on a floor are portals into a separate stair zone.
- `stairs.json`: stair zones, each with its own world map. `prev` / `next` point at the floor below and the floor above. `floorIndex` maps a stair id and direction to the floor that exit lands on. The mapper turns those links into `zone-connections.json`, which is what the navigator loads. Schema: [stairs.schema.json](stairs.schema.json). Example: [examples/stairs.example.json](examples/stairs.example.json).
- `route.json`: ordered waypoints from recorded nodes, described in [route.schema.json](route.schema.json). See [examples/route.example.json](examples/route.example.json).
- `structure.usdz` / `structure-metadata.json`: RoomPlan mesh plus identifier mapping for later minimap work.
- `surface-colors.json` / `surface-colors.jpg` (optional): real-world colors projected from camera frames onto RoomPlan faces. Schema: [surface-colors.schema.json](surface-colors.schema.json). Storage path: `buildings/{buildingId}/{versionId}/zones/{zoneId}/`.
- `zone-connections.json`: links matching elevator nodes in separate floor zones (for example `floor-1/elevator-east` to `floor-2/elevator-east`). Bidirectional, A* weight 1. Schema: [zone-connections.schema.json](zone-connections.schema.json). Example: [examples/zone-connections.example.json](examples/zone-connections.example.json). Legacy stair-zone links remain readable.
- Positions are in meters in the **restored ARKit world coordinate system** used during capture. Each zone has its own coordinate system, so positions from different zones are never compared.
- `zoneId` identifies the specific world map. The Unity app must never use an anchor or route from a different zone.

The serialization/deserialization bridge is intentionally undecided until the compatibility spike succeeds. Record the chosen approach in [../docs/integration-notes.md](../docs/integration-notes.md).
