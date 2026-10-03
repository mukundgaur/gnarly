# Unity navigator workspace

This directory is reserved for the Unity iOS project owned by the Unity engineer.

## POC responsibility

- Configure AR Foundation and the Apple ARKit XR Plug-in.
- Obtain `worldmap-zone-a.bin` and `test-anchor.json` from `../shared/local-packages/zone-a/` during local development.
- Apply the saved map through the selected Unity/native bridge.
- Display a clear locating/recovery state until relocalization is ready.
- Place a fixed cube at the test-anchor position after successful relocalization.

## Expected Unity project layout

```text
navigator-unity/
  Assets/
  Packages/
  ProjectSettings/
```

Create those Unity-owned files from the Unity editor when implementation starts. Commit `Assets/`, `Packages/`, and `ProjectSettings/`; do not commit generated `Library/`, `Temp/`, build output, or user settings.

## Compatibility spike

Do not assume Swift and Unity serialize `ARWorldMap` bytes interchangeably. The first implementation task is to determine whether the ARKit XR Plug-in can apply the native map directly or whether an iOS bridge is required. Record the result in [../docs/integration-notes.md](../docs/integration-notes.md).
