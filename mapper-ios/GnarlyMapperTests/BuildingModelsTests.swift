import simd
import XCTest
@testable import GnarlyMapper

final class BuildingModelsTests: XCTestCase {
    func testZoneIdentifierStaysUniqueAndSafe() {
        XCTAssertEqual(ZoneIdentifier.make(from: "Floor 1 West", existing: []), "floor-1-west")
        XCTAssertEqual(ZoneIdentifier.make(from: "Floor 1 West", existing: ["floor-1-west"]), "floor-1-west-2")
        XCTAssertFalse(ZoneIdentifier.make(from: "A/B", existing: []).contains("/"))
    }

    func testLayoutToWorldRotatesThenTranslates() {
        let placement = BuildingLayoutDocument.ZoneEntry(zoneId: "a", floor: 0, x: 10, z: 4, rotationDegrees: 90)
        let world = layoutToWorld(placement, SIMD2(1, 0))
        XCTAssertEqual(world.x, 10, accuracy: 0.001)
        XCTAssertEqual(world.y, 3, accuracy: 0.001)
    }

    func testNewZoneSitsBesideExistingBounds() {
        let bounds = FloorBounds(minX: 0, maxX: 8, minZ: -2, maxZ: 2)
        let entry = BuildingLayoutDocument.ZoneEntry.beside(levelBounds: bounds, zoneId: "next", level: 1)
        XCTAssertEqual(entry.x, 10, accuracy: 0.001)
        XCTAssertEqual(entry.floor, 1)
        XCTAssertEqual(floorIdentifier(level: 0), "ground")
        XCTAssertEqual(inferredLevel("level-2"), 2)
        XCTAssertEqual(inferredLevel("ground"), 0)
    }

    func testFloorShiftAndRotateMoveEveryZoneOnThatLevel() {
        var layout = BuildingLayoutDocument(zones: [
            .init(zoneId: "a", floor: 0, x: 0, z: 0, rotationDegrees: 0),
            .init(zoneId: "b", floor: 0, x: 4, z: 0, rotationDegrees: 0),
            .init(zoneId: "up", floor: 1, x: 0, z: 0, rotationDegrees: 0),
        ])
        layout.shiftFloor(0, x: 2, z: -1)
        XCTAssertEqual(layout.entry(for: "a")?.x, 2)
        XCTAssertEqual(layout.entry(for: "a")?.z, -1)
        XCTAssertEqual(layout.entry(for: "b")?.x, 6)
        XCTAssertEqual(layout.entry(for: "up")?.x, 0)

        layout.rotateFloor(0, by: 90)
        XCTAssertEqual(layout.entry(for: "a")?.rotationDegrees ?? 0, 90, accuracy: 0.001)
        XCTAssertEqual(layout.entry(for: "b")?.rotationDegrees ?? 0, 90, accuracy: 0.001)
        XCTAssertEqual(layout.entry(for: "up")?.rotationDegrees ?? 0, 0, accuracy: 0.001)
    }

    func testWallPanelsCutADoorwayOutOfTheWall() {
        let panels = WallLayout.panels(width: 4, height: 2.5, cutouts: [
            .init(minX: -0.45, maxX: 0.45, minY: -1.25, maxY: 0.3),
        ])
        XCTAssertFalse(panels.contains { $0.centerX > -0.45 && $0.centerX < 0.45 && $0.centerY > -1.25 && $0.centerY < 0.3 })
        XCTAssertTrue(panels.contains { $0.centerY > 0.3 })
        XCTAssertTrue(panels.contains { $0.centerX < -0.45 })
        XCTAssertTrue(panels.contains { $0.centerX > 0.45 })
    }

    func testWallWithoutCutoutsIsOneSolidPanel() {
        let panels = WallLayout.panels(width: 3, height: 2, cutouts: [])
        XCTAssertEqual(panels.count, 1)
        XCTAssertEqual(panels[0].width, 3, accuracy: 0.001)
        XCTAssertEqual(panels[0].height, 2, accuracy: 0.001)
    }

    func testStairStepsFillTheDetectedVolume() {
        let steps = StairSteps.boxes(dimensions: SIMD3(1.2, 1.8, 3))
        XCTAssertEqual(steps.count, 10)
        let first = steps[0]
        let top = steps[steps.count - 1]
        XCTAssertEqual(first.center.y - first.size.y / 2, -0.9, accuracy: 0.0001)
        XCTAssertEqual(first.center.z - first.size.z / 2, -1.5, accuracy: 0.0001)
        XCTAssertEqual(top.center.y + top.size.y / 2, 0.9, accuracy: 0.0001)
        XCTAssertEqual(top.center.z + top.size.z / 2, 1.5, accuracy: 0.0001)
        XCTAssertEqual(top.size.x, 1.2, accuracy: 0.0001)
    }

    func testRecoveredStairsAreKeptOnlyWhenProcessingDropsThem() {
        let stair = StairVolume(
            identifier: "abc",
            transform: matrix_identity_float4x4,
            dimensions: SIMD3(1, 2, 3),
            story: 0
        )
        XCTAssertEqual(StairVolume.recovered(roomKeptStairs: false, seen: [stair]).map(\.identifier), ["abc"])
        XCTAssertTrue(StairVolume.recovered(roomKeptStairs: true, seen: [stair]).isEmpty)
    }

    func testPlacementMatrixMatchesLayoutToWorld() {
        let entry = BuildingLayoutDocument.ZoneEntry(zoneId: "a", floor: 1, x: 3, z: -1, rotationDegrees: 0)
        let matrix = placementMatrix(entry, ground: 0)
        XCTAssertEqual(matrix.columns.3.x, 3, accuracy: 0.001)
        XCTAssertEqual(matrix.columns.3.y, buildingFloorGap, accuracy: 0.001)
        XCTAssertEqual(matrix.columns.3.z, -1, accuracy: 0.001)
    }
}
