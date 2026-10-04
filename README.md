# Gnarly — LiDAR Indoor AR Navigation

Gnarly turns a LiDAR iPhone scan into an indoor AR navigation experience. Map a space, publish it, relocalize inside it, then follow a live route through one or many zones.

## What’s working

- **LiDAR mapper:** RoomPlan geometry, ARKit world maps, walked-path graphs, named waypoints, and optional manual anchors.
- **Cloud map library:** publish scans to Firebase and choose/download a building from the Navigator—no Unity rebuild for each new map.
- **Multi-zone buildings:** arrange scans in the web editor, join same-floor zones, and connect floors with elevator waypoints.
- **AR guidance:** a dense, floor-aligned route renders directly in the camera view; same-floor handoffs stay in session, while elevator rides re-localize on arrival.
- **Live spatial feedback:** LiDAR watches the route corridor for obstacles, and iPhone haptics act as a tactile compass when the phone faces the right direction.

## Repository layout

```text
mapper-ios/             Native Swift/Xcode mapper workspace
navigator-unity/        Unity navigator workspace
web/                    React web companion and route preview
shared/                 Versioned package schema and example data
docs/                   Setup, handoff, and integration notes
firebase/               Firestore and Cloud Storage security rules
```

## Getting started

1. Map with [mapper-ios/README.md](mapper-ios/README.md).
2. Run the [Navigator](navigator-unity/README.md).
3. Use [web/README.md](web/README.md) to organize zones, floors, elevators, and destinations.
4. Exchange local test artifacts only through the ignored `shared/local-packages/` directory.

## Guardrail

Local capture/export and Unity relocalization also work without Firebase. The shared package keeps mapper, Navigator, and web data compatible: `scan.json`, `scan-features.json`, `building.json`, optional `route.json`, AR world maps, zone connections, and building layout.
