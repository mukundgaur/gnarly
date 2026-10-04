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
    surface-colors.json   optional, with surface-colors.jpg
    manifest.json
  floor-2/              another floor zone, same file set
  zone-connections.json building-level elevator and continuation links
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
- `surface-colors.json` / `surface-colors.jpg` (optional): real-world colors. During the scan the mapper keeps up to 320 camera photos with their poses, then projects them onto every wall, door, window, floor and object face, rejecting occluded samples with LiDAR depth. The JPEG is a texture atlas and the JSON gives each face's atlas rect and average color, keyed by the RoomPlan identifiers in `scan-features.json`. Schema: [surface-colors.schema.json](surface-colors.schema.json). Storage path: `buildings/{buildingId}/{versionId}/zones/{zoneId}/`.
- `zone-connections.json`: links matching nodes in separate zones. `elevator` links change floors and are weighted by a boarding cost plus a per-story cost; each elevator is the waypoint onto the next floor. `continuation` links join a zone end to the next zone's beginning on the same floor without representing a door and have A* weight 1. Links are bidirectional. Schema: [zone-connections.schema.json](zone-connections.schema.json). Example: [examples/zone-connections.example.json](examples/zone-connections.example.json). Legacy untyped and stair-zone links remain readable, but are not used as floor connectors.
- `building-layout.json`: an optional, web-authored display layout. It assigns each independently captured zone a display floor, X/Z placement, and yaw so the building overview/minimap can be arranged correctly. It never changes a scan's ARKit coordinates, graph, or relocalization. Schema: [building-layout.schema.json](building-layout.schema.json).
- Positions are in meters in the **restored ARKit world coordinate system** used during capture. Each zone has its own coordinate system, so positions from different zones are never compared.
- `zoneId` identifies the specific world map. The Unity app must never use an anchor or route from a different zone.

The serialization/deserialization bridge is intentionally undecided until the compatibility spike succeeds. Record the chosen approach in [../docs/integration-notes.md](../docs/integration-notes.md).
