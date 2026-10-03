# Gnarly — LiDAR Indoor AR Navigation

An iOS indoor-navigation proof of concept: scan a physical space with a LiDAR iPhone, save an ARKit world map, then relocalize in Unity and place a fixed virtual object at a saved position.

## Proof-of-concept scope

This repository starts with two independent workstreams that meet through one shared package contract:

| Owner | Workspace | First deliverable |
| --- | --- | --- |
| Mapper engineer | `mapper-ios/` | A RoomPlan/ARKit scan and exported `ARWorldMap` |
| Unity engineer | `navigator-unity/` | A Unity iOS app that loads the map, relocalizes, and displays a test cube |

The only success criterion for this phase is documented in [docs/poc-success-criteria.md](docs/poc-success-criteria.md).

## Repository layout

```text
mapper-ios/             Native Swift/Xcode mapper workspace
navigator-unity/        Unity navigator workspace
shared/                 Versioned package schema and example data
docs/                   Setup, handoff, and integration notes
firebase/               Firestore and Cloud Storage security rules
```

## Getting started

1. Read [docs/poc-success-criteria.md](docs/poc-success-criteria.md).
2. The mapper engineer follows [mapper-ios/README.md](mapper-ios/README.md).
3. The Unity engineer follows [docs/unity-agent-handoff.md](docs/unity-agent-handoff.md), then [navigator-unity/README.md](navigator-unity/README.md).
4. Exchange generated test artifacts only through the ignored `shared/local-packages/` directory; commit only schema and redacted examples.

## Guardrail

Keep Firebase, graph routing, multi-floor transfers, and production UI decoupled from the core relocalization proof. The mapper now has a Firebase data layer, but local capture/export and Unity relocalization must continue to work without it.

Exception: the mapper exports `scan.json`, `scan-features.json`, `building.json`, and optional `route.json` so navigation-graph work can proceed from a LiDAR scan. Automatic hallway inference and A* are still out of the cube-proof scope.
