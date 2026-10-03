# Firebase data layer setup

The mapper uses Cloud Firestore for building metadata and Cloud Storage for package files. It does not require a custom backend. Firebase initialization is optional at launch so RoomPlan scanning still works when the local configuration file is absent; creating `FirebaseDataRepository` reports a configuration error until Firebase is configured.

## One-time console setup

You do **not** need another Google or Firebase account if you already own the Firebase project.

1. In **Firebase Console → Project settings → Your apps**, register an iOS app with bundle ID `com.grantlin.gnarly.mapper` if that exact app is not already registered.
2. Download `GoogleService-Info.plist` and place it at `mapper-ios/GnarlyMapper/GoogleService-Info.plist`. It is intentionally ignored by Git. After regenerating the project, verify that it belongs to the `GnarlyMapper` target.
3. In **Build → Firestore Database**, create the database. Pick the production location carefully because it cannot be changed later.
4. Upgrade the project to the **Blaze** pay-as-you-go plan and configure a billing budget alert. Firebase requires Blaze for Cloud Storage access as of February 3, 2026, although no-cost Storage usage is still available within its allowance.
5. In **Build → Storage**, create the default Cloud Storage bucket.
6. Deploy the rules in `firebase/firestore.rules` and `firebase/storage.rules`. They are configured for mapper administrator UID `WwvbXcl5hpQgdl8KO79JwcThYJd2`.

The checked-in rules require authentication for reads and permit writes only to that admin UID. The mapper includes an email/password administrator sign-in screen; it does not include account creation and does not store credentials in source code.

## Generate the project

Firebase is installed with Swift Package Manager through XcodeGen. Firebase Apple SDK 12.19.2 requires a current Xcode toolchain.

```sh
cd mapper-ios
xcodegen generate
open GnarlyMapper.xcodeproj
```

The linked Firebase products are `FirebaseCore`, `FirebaseAuth`, `FirebaseFirestore`, and `FirebaseStorage`.

## Verify the live connection

1. Run the mapper on an iOS 17 or newer device.
2. Tap **Connect Firebase**.
3. Enter the existing Firebase administrator email and password, then tap **Sign In**.
4. Confirm the displayed UID is `WwvbXcl5hpQgdl8KO79JwcThYJd2`.
5. Tap **Run Firebase Test**.

The four rows should turn green. The diagnostic writes and reads `buildings/firebase-test`, then uploads and downloads `buildings/firebase-test/test.txt`. Each run uses a new token and verifies the server response, so a stale local file cannot produce a false success. These two diagnostic artifacts can be deleted from the Firebase Console after testing.

## Repository usage

Create metadata first, upload assets, and publish the version last:

```swift
let repository = try FirebaseDataRepository()

try await repository.createBuilding(
    Building(
        id: "demo-building",
        name: "Demo Building",
        activeVersion: nil,
        status: .draft,
        createdAt: nil,
        updatedAt: nil
    )
)

try await repository.saveVersion(
    BuildingVersion(
        id: "v1",
        versionNumber: 1,
        status: .draft,
        buildingJsonPath: nil,
        structurePath: nil,
        createdAt: nil,
        publishedAt: nil
    ),
    buildingId: "demo-building"
)

try await repository.saveZone(
    Zone(
        id: "zone-a",
        name: "Entrance",
        floorId: "ground",
        worldMapPath: nil,
        relocalizationHint: "Look around the entrance doors.",
        startNodeId: "entrance"
    ),
    buildingId: "demo-building",
    versionId: "v1"
)

try await repository.uploadWorldMap(
    from: worldMapFileURL,
    buildingId: "demo-building",
    versionId: "v1",
    zoneId: "zone-a"
)

try await repository.uploadBuildingJSON(
    from: buildingJSONFileURL,
    buildingId: "demo-building",
    versionId: "v1"
)

try await repository.saveVersion(
    BuildingVersion(
        id: "v1",
        versionNumber: 1,
        status: .published,
        buildingJsonPath: nil,
        structurePath: nil,
        createdAt: nil,
        publishedAt: Date()
    ),
    buildingId: "demo-building"
)

try await repository.updateBuilding(
    Building(
        id: "demo-building",
        name: "Demo Building",
        activeVersion: "v1",
        status: .active,
        createdAt: nil,
        updatedAt: nil
    )
)
```

Download and cache the active package with:

```swift
let package = try await repository.downloadActivePackage(
    buildingId: "demo-building",
    zoneId: "zone-a"
)

// package.buildingJSONURL and package.worldMapURL are durable local files.
```

Cached files are stored under the app's Application Support directory using the same relative hierarchy as Cloud Storage. Because version IDs are part of every path, published versions should be treated as immutable. A repeat request returns the cached file without requiring the network.

## Firestore documents

```text
buildings/{buildingId}
buildings/{buildingId}/versions/{versionId}
buildings/{buildingId}/versions/{versionId}/floors/{floorId}
buildings/{buildingId}/versions/{versionId}/zones/{zoneId}
buildings/{buildingId}/versions/{versionId}/destinations/{destinationId}
buildings/{buildingId}/versions/{versionId}/nodes/{nodeId}
buildings/{buildingId}/versions/{versionId}/edges/{edgeId}
```

`Floor` uses the specification's semantic fields `name`, `story`, and `elevation`, since the requested hierarchy did not enumerate floor fields.

## Storage objects

```text
buildings/{buildingId}/{versionId}/building.json
buildings/{buildingId}/{versionId}/scan.json
buildings/{buildingId}/{versionId}/structure.usdz
buildings/{buildingId}/{versionId}/worldmaps/{zoneId}.bin
```

This implementation currently uploads `building.json` and zone world maps. Paths for `scan.json` and `structure.usdz` are defined for the planned upload flow, but those uploads are outside the requested methods.

## Tests

Run the `GnarlyMapper` scheme's unit tests in Xcode, or:

```sh
xcodebuild test \
  -project GnarlyMapper.xcodeproj \
  -scheme GnarlyMapper \
  -destination 'platform=iOS Simulator,name=iPhone 17'
```

The unit tests cover path generation, identifier rejection, nested coordinate encoding, and local-cache behavior. The first live smoke test should additionally verify that:

1. The world map appears at the expected Storage path.
2. The zone document receives `worldMapPath`.
3. `building.json` appears in Storage.
4. The version document receives `buildingJsonPath`.
5. After one successful download, disabling the network still returns both cached file URLs.
