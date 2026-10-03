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
```

## Getting started

1. Read [docs/poc-success-criteria.md](docs/poc-success-criteria.md).
2. The mapper engineer follows [mapper-ios/README.md](mapper-ios/README.md).
3. The Unity engineer follows [docs/unity-agent-handoff.md](docs/unity-agent-handoff.md), then [navigator-unity/README.md](navigator-unity/README.md).
4. Exchange generated test artifacts only through the ignored `shared/local-packages/` directory; commit only schema and redacted examples.

## Guardrail

Do not begin Firebase, graph routing, multi-floor transfers, or production UI until the same map can be captured, saved, loaded in Unity, relocalized, and used to place the test cube in the original physical location.
