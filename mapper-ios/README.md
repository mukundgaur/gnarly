# Native mapper workspace

This directory is reserved for the Xcode project owned by the mapper engineer.

## POC responsibility

- Use a shared ARKit `ARSession` for RoomPlan and mapping.
- Scan one connected, visually distinctive test area.
- Persist the `ARWorldMap` from that session.
- Export one known test position in the same coordinate system.
- Put local test output in `../shared/local-packages/zone-a/`.

## Create the app project

Create the Xcode project here when implementation starts:

```text
mapper-ios/
  GnarlyMapper.xcodeproj/
  GnarlyMapper/
  GnarlyMapperTests/
```

Target a LiDAR-capable iPhone and select a deployment target compatible with the ARKit and RoomPlan APIs the team chooses. Before code is written, record the selected Xcode/iOS versions in [../docs/integration-notes.md](../docs/integration-notes.md).

## Export checklist

- `worldmap-zone-a.bin` exists and is non-empty.
- `test-anchor.json` validates against [../shared/test-anchor.schema.json](../shared/test-anchor.schema.json).
- The anchor describes an intentionally chosen physical point.
- Both files came from the same AR session/zone.
