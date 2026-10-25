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

    func testStairStepsAreSingleRisersClimbingTowardNegativeZ() {
        let steps = StairSteps.boxes(dimensions: SIMD3(1.2, 1.8, 3))
        XCTAssertEqual(steps.count, 10)
        let first = steps[0]
        let top = steps[steps.count - 1]
        XCTAssertEqual(first.size.y, 0.18, accuracy: 0.0001)
        XCTAssertEqual(top.size.y, first.size.y, accuracy: 0.0001)
        XCTAssertLessThan(first.size.y, 1.8)
        XCTAssertEqual(first.center.y - first.size.y / 2, -0.9, accuracy: 0.0001)
        XCTAssertEqual(first.center.z + first.size.z / 2, 1.5, accuracy: 0.0001)
        XCTAssertEqual(top.center.y + top.size.y / 2, 0.9, accuracy: 0.0001)
        XCTAssertEqual(top.center.z - top.size.z / 2, -1.5, accuracy: 0.0001)
        XCTAssertEqual(top.size.x, 1.2, accuracy: 0.0001)

        let faces = StairSteps.faces(dimensions: SIMD3(1.2, 1.8, 3))
        let tread = faces.first { $0.name == "tread-0" }
        let riser = faces.first { $0.name == "riser-0" }
        XCTAssertEqual(tread?.center.y ?? 0, first.center.y + first.size.y / 2, accuracy: 0.0001)
        XCTAssertEqual(riser?.center.z ?? 0, first.center.z + first.size.z / 2, accuracy: 0.0001)
        XCTAssertEqual(riser?.axisV ?? .zero, SIMD3(0, 1, 0))
    }

    func testUpperLandingMatchesTheTopOfTheFlight() {
        let landings = StairLandings.positions(
            center: [0, 1, 0],
            dimensions: [1.2, 2, 4],
            up: [0, 1, 0],
            forward: [0, 0, 1]
        )
        XCTAssertEqual(landings.below[1], 0, accuracy: 0.0001)
        XCTAssertEqual(landings.below[2], 2, accuracy: 0.0001)
        XCTAssertEqual(landings.above[1], 2, accuracy: 0.0001)
        XCTAssertEqual(landings.above[2], -2, accuracy: 0.0001)
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

    func testAFlightKeepsTheBottomFloorAndAddsTheLandingItClimbsTo() {
        let stair = stairVolume(id: "up", center: .zero, dimensions: SIMD3(1.2, 2, 4))
        let bottom = levelFloor(id: "bottom", center: SIMD3(0, -1, 0), width: 20, depth: 20)
        let recovered = LandingFloors.recovered(kept: [bottom], seen: [], stairs: [stair])
        XCTAssertEqual(recovered.count, 1)
        XCTAssertEqual(recovered[0].center.y, 1, accuracy: 0.001)
        XCTAssertEqual(recovered[0].center.z, -3, accuracy: 0.001)
        XCTAssertLessThan(recovered[0].center.z, -2)
    }

    func testFloorsSeenOnOtherLevelsComeBackWhenOnlyTheBottomRemains() {
        let bottom = levelFloor(id: "bottom", center: SIMD3(0, -3, 0), width: 12, depth: 12)
        let middle = levelFloor(id: "middle", center: SIMD3(0, 0, 0), width: 6, depth: 6)
        let top = levelFloor(id: "top", center: SIMD3(0, 3, 0), width: 6, depth: 6)
        let duplicate = levelFloor(id: "bottom-again", center: SIMD3(0.2, -2.9, 0.2), width: 8, depth: 8)
        let recovered = LandingFloors.recovered(kept: [bottom], seen: [bottom, middle, top, duplicate], stairs: [])
        XCTAssertEqual(Set(recovered.map(\.identifier)), ["middle", "top"])
    }

    func testALevelWalkRestoresTheFloorBetweenFlightsAndAClimbDoesNot() {
        let stair = stairVolume(id: "well", center: .zero, dimensions: SIMD3(1.2, 6, 4))
        let bottom = levelFloor(id: "bottom", center: SIMD3(0, -3, 2), width: 10, depth: 10)
        let onBottom = [SIMD3<Float>(0, -1.60, 2), SIMD3(0.4, -1.58, 2.3), SIMD3(-0.3, -1.62, 1.7)]
        let onMiddle = [SIMD3<Float>(2.2, 1.40, 0), SIMD3(2.8, 1.42, 0.4), SIMD3(2.4, 1.38, 0.9)]
        let recovered = LandingFloors.recovered(kept: [bottom], seen: [], stairs: [stair], walked: onBottom + onMiddle)
        let heights = recovered.map(\.center.y).sorted()
        XCTAssertEqual(heights.count, 2)
        XCTAssertEqual(heights[0], 0, accuracy: 0.05)
        XCTAssertEqual(heights[1], 3, accuracy: 0.05)

        let climbing = [SIMD3<Float>(0, -1.6, 2), SIMD3(0, -0.9, 2.5), SIMD3(0, -0.1, 3.0), SIMD3(0, 0.8, 3.5)]
        let stepsOnly = LandingFloors.recovered(kept: [bottom], seen: [], stairs: [], walked: climbing)
        XCTAssertTrue(stepsOnly.isEmpty)
    }

    func testOpeningTheScanOnALandingKeepsThatFloorAfterTheClimb() {
        let stair = stairVolume(id: "well", center: .zero, dimensions: SIMD3(1.2, 6, 4))
        let bottom = levelFloor(id: "bottom", center: SIMD3(0, -3, 2), width: 8, depth: 8)
        let walked = [SIMD3<Float>(1.8, 1.35, 0.2), SIMD3(1.1, 2.05, 0.2), SIMD3(0.4, 2.75, 0.2), SIMD3(0, 3.5, 0.2)]
        let recovered = LandingFloors.recovered(kept: [bottom], seen: [], stairs: [stair], walked: walked)
        let heights = recovered.map(\.center.y).sorted()
        XCTAssertEqual(heights.count, 2)
        XCTAssertEqual(heights[0], 0, accuracy: 0.05)
        XCTAssertEqual(heights[1], 3, accuracy: 0.05)
        XCTAssertTrue(recovered.contains { $0.identifier == "walked-landing-start" })
    }

    private func levelFloor(id: String, center: SIMD3<Float>, width: Float, depth: Float) -> FloorSlab {
        var transform = matrix_identity_float4x4
        transform.columns.0 = SIMD4(1, 0, 0, 0)
        transform.columns.1 = SIMD4(0, 0, 1, 0)
        transform.columns.2 = SIMD4(0, 1, 0, 0)
        transform.columns.3 = SIMD4(center.x, center.y, center.z, 1)
        return FloorSlab(identifier: id, transform: transform, dimensions: SIMD3(width, depth, 0.05), story: 0)
    }

    private func stairVolume(id: String, center: SIMD3<Float>, dimensions: SIMD3<Float>) -> StairVolume {
        var transform = matrix_identity_float4x4
        transform.columns.3 = SIMD4(center.x, center.y, center.z, 1)
        return StairVolume(identifier: id, transform: transform, dimensions: dimensions, story: 0)
    }

    func testHeadOnPhotoMarksAWallCovered() {
        let wall = coveragePlane(id: "wall", kind: .wall, center: SIMD3(0, 1.5, 0), normal: SIMD3(0, 0, 1), width: 0.5, height: 0.5)
        let camera = coverageCamera(eye: SIMD3(0, 1.5, 2), target: SIMD3(0, 1.5, 0))
        let snapshot = ColorCoverage.grade(surfaces: [wall], cameras: [camera])
        XCTAssertEqual(snapshot.samples.count, 1)
        XCTAssertEqual(snapshot.samples[0].grade, .good)
        XCTAssertEqual(snapshot.weakSurfaceCount, 0)
    }

    func testGlancingAndDistantPhotosStayThin() {
        let wall = coveragePlane(id: "wall", kind: .wall, center: SIMD3(0, 1.5, 0), normal: SIMD3(0, 0, 1), width: 0.5, height: 0.5)
        let glancing = coverageCamera(eye: SIMD3(2.4, 1.5, 0.7), target: SIMD3(0, 1.5, 0))
        let far = coverageCamera(eye: SIMD3(0, 1.5, 6), target: SIMD3(0, 1.5, 0))
        XCTAssertEqual(ColorCoverage.grade(surfaces: [wall], cameras: [glancing]).samples[0].grade, .thin)
        XCTAssertEqual(ColorCoverage.grade(surfaces: [wall], cameras: [far]).samples[0].grade, .thin)
        let tooFar = coverageCamera(eye: SIMD3(0, 1.5, 8), target: SIMD3(0, 1.5, 0))
        XCTAssertEqual(ColorCoverage.grade(surfaces: [wall], cameras: [tooFar]).samples[0].grade, .unseen)
    }

    func testAWallBetweenTheCameraAndTheSurfaceBlocksCoverage() {
        let hidden = coveragePlane(id: "hidden", kind: .wall, center: SIMD3(0, 1.5, 0), normal: SIMD3(0, 0, 1), width: 0.5, height: 0.5)
        let blocker = coveragePlane(id: "blocker", kind: .wall, center: SIMD3(0, 1.5, 1), normal: SIMD3(0, 0, 1), width: 2, height: 2)
        let camera = coverageCamera(eye: SIMD3(0, 1.5, 2), target: SIMD3(0, 1.5, 0))
        let snapshot = ColorCoverage.grade(surfaces: [hidden, blocker], cameras: [camera])
        XCTAssertTrue(snapshot.samples.filter { $0.surfaceID == "hidden" }.allSatisfy { $0.grade == .unseen })
        XCTAssertTrue(snapshot.samples.contains { $0.surfaceID == "blocker" && $0.grade == .good })
    }

    func testTheBackOfAnObjectDoesNotCountAsCovered() {
        let object = BakeSurface(
            identifier: "table",
            kind: .object,
            transform: matrix_identity_float4x4,
            dimensions: SIMD3(1, 1, 1),
            parentIdentifier: nil,
            isPassable: false
        )
        let behind = coverageCamera(eye: SIMD3(0, 0, -2), target: .zero)
        let snapshot = ColorCoverage.grade(surfaces: [object], cameras: [behind])
        XCTAssertEqual(snapshot.samples.first { $0.id.contains("-nz-") }?.grade, .good)
        XCTAssertEqual(snapshot.samples.first { $0.id.contains("-pz-") }?.grade, .unseen)
    }

    func testPlacementMatrixMatchesLayoutToWorld() {
        let entry = BuildingLayoutDocument.ZoneEntry(zoneId: "a", floor: 1, x: 3, z: -1, rotationDegrees: 0)
        let matrix = placementMatrix(entry, ground: 0)
        XCTAssertEqual(matrix.columns.3.x, 3, accuracy: 0.001)
        XCTAssertEqual(matrix.columns.3.y, buildingFloorGap, accuracy: 0.001)
        XCTAssertEqual(matrix.columns.3.z, -1, accuracy: 0.001)
    }
}

private func coverageCamera(eye: SIMD3<Float>, target: SIMD3<Float>) -> CoverageCamera {
    let forward = simd_normalize(target - eye)
    let zAxis = -forward
    let up = SIMD3<Float>(0, 1, 0)
    var xAxis = simd_cross(up, zAxis)
    if simd_length(xAxis) < 0.001 { xAxis = SIMD3(1, 0, 0) }
    xAxis = simd_normalize(xAxis)
    let yAxis = simd_normalize(simd_cross(zAxis, xAxis))
    var transform = matrix_identity_float4x4
    transform.columns.0 = SIMD4(xAxis.x, xAxis.y, xAxis.z, 0)
    transform.columns.1 = SIMD4(yAxis.x, yAxis.y, yAxis.z, 0)
    transform.columns.2 = SIMD4(zAxis.x, zAxis.y, zAxis.z, 0)
    transform.columns.3 = SIMD4(eye.x, eye.y, eye.z, 1)
    return CoverageCamera(transform: transform, focal: SIMD2(900, 900), principal: SIMD2(500, 500), width: 1000, height: 1000)
}

private func coveragePlane(
    id: String,
    kind: BakeSurface.Kind,
    center: SIMD3<Float>,
    normal: SIMD3<Float>,
    width: Float,
    height: Float
) -> BakeSurface {
    let z = simd_normalize(normal)
    let up = abs(z.y) > 0.9 ? SIMD3<Float>(1, 0, 0) : SIMD3<Float>(0, 1, 0)
    let x = simd_normalize(simd_cross(up, z))
    let y = simd_normalize(simd_cross(z, x))
    var transform = matrix_identity_float4x4
    transform.columns.0 = SIMD4(x.x, x.y, x.z, 0)
    transform.columns.1 = SIMD4(y.x, y.y, y.z, 0)
    transform.columns.2 = SIMD4(z.x, z.y, z.z, 0)
    transform.columns.3 = SIMD4(center.x, center.y, center.z, 1)
    let depth: Float = kind == .object ? 1 : 0.1
    return BakeSurface(
        identifier: id,
        kind: kind,
        transform: transform,
        dimensions: SIMD3(width, height, depth),
        parentIdentifier: nil,
        isPassable: false
    )
}
