import Foundation
import simd

/// A saved scan photo reduced to the pose and lens used to judge splat coverage.
struct CoverageCamera: Sendable, Equatable {
    var transform: simd_float4x4
    var focal: SIMD2<Float>
    var principal: SIMD2<Float>
    var width: Float
    var height: Float

    var position: SIMD3<Float> {
        SIMD3(transform.columns.3.x, transform.columns.3.y, transform.columns.3.z)
    }
}

enum CoverageGrade: Int, Sendable, Equatable, Comparable {
    case unseen = 0
    case thin = 1
    case good = 2

    static func < (lhs: CoverageGrade, rhs: CoverageGrade) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// One spot on a scanned surface. `good` has a close, head-on photo. `thin` was only grazed or seen from far away.
struct CoverageSample: Sendable, Equatable, Identifiable {
    var id: String
    var surfaceID: String
    var kind: String
    var world: SIMD3<Float>
    var normal: SIMD3<Float>
    /// Walls and floors count from either side. Object and stair faces only count when the camera faces the normal.
    var eitherSide: Bool
    var grade: CoverageGrade
}

struct CoverageSnapshot: Sendable, Equatable {
    var samples: [CoverageSample]
    var cameraCount: Int
    var surfaceCount: Int

    static let empty = CoverageSnapshot(samples: [], cameraCount: 0, surfaceCount: 0)

    var weakCount: Int { samples.filter { $0.grade != .good }.count }

    var weakSurfaceCount: Int {
        Set(samples.filter { $0.grade != .good }.map(\.surfaceID)).count
    }
}

/// Estimates whether each part of the live room has a photo the color bake can splat cleanly.
enum ColorCoverage {
    /// Closer than this, and facing the surface, counts as a usable splat.
    static let goodDistance: Float = 4.2
    static let goodCosine: Float = 0.40
    /// The bake still accepts these, but the color comes out soft or stretched.
    static let thinDistance: Float = 7
    static let thinCosine: Float = 0.18

    static func grade(surfaces: [BakeSurface], cameras: [CoverageCamera]) -> CoverageSnapshot {
        let scored = surfaces.filter { $0.kind != .opening && !$0.isPassable }
        let spots = samples(on: scored)
        let blockers = scored.filter { $0.kind == .wall }.map(Occluder.init)
        let graded = spots.map { spot -> CoverageSample in
            var best = CoverageGrade.unseen
            for camera in cameras {
                let quality = viewGrade(of: spot, from: camera, blockers: blockers)
                if quality > best { best = quality }
                if best == .good { break }
            }
            var spot = spot
            spot.grade = best
            return spot
        }
        return CoverageSnapshot(
            samples: graded,
            cameraCount: cameras.count,
            surfaceCount: Set(graded.map(\.surfaceID)).count
        )
    }

    static func hint(kind: String, grade: CoverageGrade) -> String {
        switch (kind, grade) {
        case (_, .good):
            return "This spot has a close, head-on photo. The splat should hold here."
        case ("floor", _):
            return "Point the camera down and walk across this part of the floor."
        case ("wall", .thin):
            return "This part of the wall was only seen from the side or from far away. Turn to face it, step closer, and tilt from the floor to the ceiling."
        case ("wall", _):
            return "No sharp photo of this part of the wall yet. Face it and sweep from the floor to the ceiling."
        case ("stairs", _):
            return "Stand where you can see the steps straight on, then sweep up the flight."
        case ("door", _), ("window", _):
            return "Hold the phone still and face this opening so the frame is sharp."
        default:
            return "Move closer and look at this straight on. A glancing angle leaves a stretched splat."
        }
    }

    // MARK: - Samples

    private static func samples(on surfaces: [BakeSurface]) -> [CoverageSample] {
        surfaces.flatMap { surface -> [CoverageSample] in
            let transform = surface.transform
            let x = axis(transform.columns.0)
            let y = axis(transform.columns.1)
            let z = axis(transform.columns.2)
            let origin = SIMD3<Float>(transform.columns.3.x, transform.columns.3.y, transform.columns.3.z)
            let dimensions = simd_abs(surface.dimensions)
            let faces: [LocalFace]
            if surface.kind == .stairs {
                faces = StairSteps.faces(dimensions: dimensions).map { face in
                    LocalFace(
                        name: face.name,
                        center: face.center,
                        normal: simd_normalize(simd_cross(face.axisU, face.axisV)),
                        axisU: face.axisU,
                        axisV: face.axisV,
                        width: face.width,
                        height: face.height,
                        eitherSide: false
                    )
                }
            } else if surface.kind == .object {
                faces = objectFaces(dimensions)
            } else {
                faces = [LocalFace(
                    name: "face",
                    center: .zero,
                    normal: SIMD3(0, 0, 1),
                    axisU: SIMD3(1, 0, 0),
                    axisV: SIMD3(0, 1, 0),
                    width: dimensions.x,
                    height: dimensions.y,
                    eitherSide: true
                )]
            }
            return faces.flatMap { face -> [CoverageSample] in
                guard face.width > 0.12, face.height > 0.12 else { return [] }
                let columns = gridCount(face.width, limit: surface.kind == .object || surface.kind == .stairs ? 1 : 5, spacing: 0.85)
                let rows = gridCount(face.height, limit: surface.kind == .object || surface.kind == .stairs ? 1 : 4, spacing: 0.75)
                return (0 ..< rows).flatMap { row in
                    (0 ..< columns).map { column in
                        let u = (Float(column) + 0.5) / Float(columns) - 0.5
                        let v = (Float(row) + 0.5) / Float(rows) - 0.5
                        let local = face.center + face.axisU * (u * face.width) + face.axisV * (v * face.height)
                        let world = origin + x * local.x + y * local.y + z * local.z
                        let normal = simd_normalize(x * face.normal.x + y * face.normal.y + z * face.normal.z)
                        return CoverageSample(
                            id: "\(surface.identifier)-\(face.name)-\(row)-\(column)",
                            surfaceID: surface.identifier,
                            kind: surface.kind.rawValue,
                            world: world,
                            normal: normal,
                            eitherSide: face.eitherSide,
                            grade: .unseen
                        )
                    }
                }
            }
        }
    }

    private static func gridCount(_ length: Float, limit: Int, spacing: Float) -> Int {
        min(limit, max(1, Int((length / spacing).rounded(.up))))
    }

    private static func objectFaces(_ dimensions: SIMD3<Float>) -> [LocalFace] {
        let d = dimensions
        return [
            LocalFace(name: "px", center: SIMD3(d.x / 2, 0, 0), normal: SIMD3(1, 0, 0), axisU: SIMD3(0, 0, -1), axisV: SIMD3(0, 1, 0), width: d.z, height: d.y, eitherSide: false),
            LocalFace(name: "nx", center: SIMD3(-d.x / 2, 0, 0), normal: SIMD3(-1, 0, 0), axisU: SIMD3(0, 0, 1), axisV: SIMD3(0, 1, 0), width: d.z, height: d.y, eitherSide: false),
            LocalFace(name: "py", center: SIMD3(0, d.y / 2, 0), normal: SIMD3(0, 1, 0), axisU: SIMD3(1, 0, 0), axisV: SIMD3(0, 0, -1), width: d.x, height: d.z, eitherSide: false),
            LocalFace(name: "pz", center: SIMD3(0, 0, d.z / 2), normal: SIMD3(0, 0, 1), axisU: SIMD3(1, 0, 0), axisV: SIMD3(0, 1, 0), width: d.x, height: d.y, eitherSide: false),
            LocalFace(name: "nz", center: SIMD3(0, 0, -d.z / 2), normal: SIMD3(0, 0, -1), axisU: SIMD3(-1, 0, 0), axisV: SIMD3(0, 1, 0), width: d.x, height: d.y, eitherSide: false),
        ]
    }

    private static func axis(_ column: simd_float4) -> SIMD3<Float> {
        simd_normalize(SIMD3(column.x, column.y, column.z))
    }

    // MARK: - Visibility

    private struct LocalFace {
        var name: String
        var center: SIMD3<Float>
        var normal: SIMD3<Float>
        var axisU: SIMD3<Float>
        var axisV: SIMD3<Float>
        var width: Float
        var height: Float
        /// Walls, floors, doors, and windows are photographed from whichever side faces the room.
        var eitherSide: Bool
    }

    private struct Occluder {
        var surfaceID: String
        var center: SIMD3<Float>
        var xAxis: SIMD3<Float>
        var yAxis: SIMD3<Float>
        var normal: SIMD3<Float>
        var halfX: Float
        var halfY: Float

        init(_ surface: BakeSurface) {
            let transform = surface.transform
            surfaceID = surface.identifier
            center = SIMD3(transform.columns.3.x, transform.columns.3.y, transform.columns.3.z)
            xAxis = ColorCoverage.axis(transform.columns.0)
            yAxis = ColorCoverage.axis(transform.columns.1)
            normal = ColorCoverage.axis(transform.columns.2)
            let size = simd_abs(surface.dimensions)
            halfX = size.x / 2
            halfY = size.y / 2
        }

        func blocks(origin: SIMD3<Float>, target: SIMD3<Float>) -> Bool {
            let travel = target - origin
            let distance = simd_length(travel)
            guard distance > 0.2 else { return false }
            let direction = travel / distance
            let denominator = simd_dot(direction, normal)
            guard abs(denominator) > 1e-4 else { return false }
            let t = simd_dot(center - origin, normal) / denominator
            guard t > 0.15, t < distance - 0.28 else { return false }
            let hit = origin + direction * t - center
            return abs(simd_dot(hit, xAxis)) <= halfX && abs(simd_dot(hit, yAxis)) <= halfY
        }
    }

    private static func viewGrade(of sample: CoverageSample, from camera: CoverageCamera, blockers: [Occluder]) -> CoverageGrade {
        let toCamera = camera.position - sample.world
        let distance = simd_length(toCamera)
        guard distance > 0.2, distance <= thinDistance else { return .unseen }
        let facing = simd_dot(toCamera / distance, sample.normal)
        let cosine = sample.eitherSide ? abs(facing) : facing
        guard cosine >= thinCosine else { return .unseen }
        guard projectsInside(sample.world, camera: camera) else { return .unseen }
        guard !blockers.contains(where: { $0.surfaceID != sample.surfaceID && $0.blocks(origin: camera.position, target: sample.world) }) else {
            return .unseen
        }
        if distance <= goodDistance, cosine >= goodCosine { return .good }
        return .thin
    }

    /// Same pinhole as the color bake: ARKit cameras look down local -Z.
    private static func projectsInside(_ world: SIMD3<Float>, camera: CoverageCamera) -> Bool {
        let local = camera.transform.inverse * SIMD4<Float>(world.x, world.y, world.z, 1)
        let depth = -local.z
        guard depth > 0.15 else { return false }
        let px = camera.focal.x * local.x / depth + camera.principal.x
        let py = camera.focal.y * (-local.y) / depth + camera.principal.y
        let insetX = camera.width * 0.04
        let insetY = camera.height * 0.04
        return px > insetX && py > insetY && px < camera.width - insetX && py < camera.height - insetY
    }
}
