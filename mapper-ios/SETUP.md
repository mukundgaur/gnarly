# Create and run the mapper app

This project is defined with [XcodeGen](https://github.com/yonaskolb/XcodeGen) so the Xcode project is reproducible and does not need to be committed.

## Prerequisites

- Xcode 15+ on macOS
- A LiDAR-capable iPhone running iOS 16+
- XcodeGen (`brew install xcodegen`), or create an equivalent SwiftUI iOS app manually using the settings in `project.yml`

## Generate and run

```sh
cd mapper-ios
xcodegen generate
open GnarlyMapper.xcodeproj
```

In Xcode, choose your development team and a physical LiDAR iPhone. The simulator cannot run RoomPlan scanning.

## Export behavior

The app writes each capture to its own sandboxed Documents folder:

```text
Documents/POCExports/<timestamp>-<zone-id>/
  worldmap-zone-a.bin
  test-anchor.json
  structure.usdz
```

Use the app’s share action to transfer that directory to the Unity engineer. Do not commit a real `ARWorldMap` to this repository.
