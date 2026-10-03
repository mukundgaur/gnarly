import XCTest
@testable import GnarlyMapper

final class FirebaseStoragePathsTests: XCTestCase {
    func testExpectedPaths() throws {
        XCTAssertEqual(
            FirebaseStoragePaths.diagnosticText,
            "buildings/firebase-test/test.txt"
        )
        XCTAssertEqual(
            try FirebaseStoragePaths.buildingJSON(buildingId: "demo", versionId: "v1"),
            "buildings/demo/v1/building.json"
        )
        XCTAssertEqual(
            try FirebaseStoragePaths.worldMap(buildingId: "demo", versionId: "v1", zoneId: "upper"),
            "buildings/demo/v1/worldmaps/upper.bin"
        )
    }

    func testRejectsPathSeparatorsInIDs() {
        XCTAssertThrowsError(
            try FirebaseStoragePaths.worldMap(buildingId: "demo/other", versionId: "v1", zoneId: "upper")
        )
    }
}
