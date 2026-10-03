# Shared POC package contract

The mapper produces a local package for the Unity navigator. The committed schema exists to keep the two workstreams compatible; real captured maps are deliberately ignored.

## Local exchange layout

```text
shared/local-packages/
  zone-a/
    worldmap-zone-a.bin
    test-anchor.json
    route.json          optional; not exported by the mapper yet
```

`shared/local-packages/` is ignored by Git. It may contain real building imagery/features encoded in ARKit data and should be transferred only to teammates who need it.

## Contract

- `worldmap-zone-a.bin`: opaque byte representation of the saved ARKit `ARWorldMap`.
- `test-anchor.json`: schema described in [test-anchor.schema.json](test-anchor.schema.json).
- `route.json` (optional): ordered waypoints from start to destination, described in [route.schema.json](route.schema.json). See [examples/route.example.json](examples/route.example.json).
- Positions are in meters in the **restored ARKit world coordinate system** used during capture.
- `zoneId` identifies the specific world map. The Unity app must never use an anchor or route from a different zone.

The serialization/deserialization bridge is intentionally undecided until the compatibility spike succeeds. Record the chosen approach in [../docs/integration-notes.md](../docs/integration-notes.md).
