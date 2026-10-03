import RoomPlan
import simd
import SwiftUI

/// Top-down snapshot of the RoomPlan scan. Stairs are included whenever RoomPlan reports that object.
struct ScanPlan: Equatable {
    enum Kind: Equatable {
        case floor
        case wall
        case door
        case opening
        case window
        case stairs
    }

    struct Shape: Equatable {
        var kind: Kind
        /// Four corners in ARKit floor coordinates, x then z.
        var corners: [SIMD2<Float>]
    }

    var shapes: [Shape] = []

    static let empty = ScanPlan()

    init() {}

    init(room: CapturedRoom) {
        var shapes: [Shape] = []
        shapes += room.floors.map { Shape(kind: .floor, corners: Self.surfaceFootprint($0, floorPlane: true)) }
        shapes += room.walls.map { Shape(kind: .wall, corners: Self.surfaceFootprint($0, floorPlane: false)) }
        shapes += room.doors.map { Shape(kind: .door, corners: Self.surfaceFootprint($0, floorPlane: false)) }
        shapes += room.openings.map { Shape(kind: .opening, corners: Self.surfaceFootprint($0, floorPlane: false)) }
        shapes += room.windows.map { Shape(kind: .window, corners: Self.surfaceFootprint($0, floorPlane: false)) }
        shapes += room.objects
            .filter { $0.category == .stairs }
            .map { Shape(kind: .stairs, corners: Self.objectFootprint($0)) }
        self.shapes = shapes.filter { $0.corners.count == 4 }
    }

    private static func surfaceFootprint(_ surface: CapturedRoom.Surface, floorPlane: Bool) -> [SIMD2<Float>] {
        if floorPlane {
            return corners(
                transform: surface.transform,
                halfX: surface.dimensions.x * 0.5,
                halfOther: surface.dimensions.y * 0.5,
                otherIsLocalY: true
            )
        }
        return corners(
            transform: surface.transform,
            halfX: surface.dimensions.x * 0.5,
            halfOther: max(surface.dimensions.z, 0.08) * 0.5,
            otherIsLocalY: false
        )
    }

    private static func objectFootprint(_ object: CapturedRoom.Object) -> [SIMD2<Float>] {
        corners(
            transform: object.transform,
            halfX: max(object.dimensions.x, 0.4) * 0.5,
            halfOther: max(object.dimensions.z, 0.4) * 0.5,
            otherIsLocalY: false
        )
    }

    /// Floor surfaces lie in local X/Y. Walls and stair objects use local X for width and local Z for depth.
    private static func corners(
        transform: simd_float4x4,
        halfX: Float,
        halfOther: Float,
        otherIsLocalY: Bool
    ) -> [SIMD2<Float>] {
        let local: [SIMD3<Float>] = otherIsLocalY
            ? [
                SIMD3(-halfX, -halfOther, 0),
                SIMD3(halfX, -halfOther, 0),
                SIMD3(halfX, halfOther, 0),
                SIMD3(-halfX, halfOther, 0)
            ]
            : [
                SIMD3(-halfX, 0, -halfOther),
                SIMD3(halfX, 0, -halfOther),
                SIMD3(halfX, 0, halfOther),
                SIMD3(-halfX, 0, halfOther)
            ]
        return local.map { point in
            let world = transform * SIMD4<Float>(point.x, point.y, point.z, 1)
            return SIMD2<Float>(world.x, world.z)
        }
    }
}

struct ScanMinimapCard: View {
    let plan: ScanPlan

    var body: some View {
        Canvas { context, size in
            let projected = project(plan.shapes, into: size)
            for shape in projected where shape.kind == .floor {
                context.fill(polygon(shape.points), with: .color(Color(red: 0.07, green: 0.16, blue: 0.2)))
            }
            for shape in projected where shape.kind == .wall {
                context.fill(polygon(shape.points), with: .color(Color(red: 0.72, green: 0.82, blue: 0.86)))
            }
            for shape in projected where shape.kind == .door || shape.kind == .opening || shape.kind == .window {
                context.fill(polygon(shape.points), with: .color(Color(red: 0.24, green: 0.72, blue: 0.9).opacity(0.85)))
            }
            for shape in projected where shape.kind == .stairs {
                context.fill(polygon(shape.points), with: .color(Color(red: 0.45, green: 0.6, blue: 1).opacity(0.92)))
                drawTreads(shape.points, in: &context)
            }
        }
        .frame(width: 148, height: 148)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityLabel("Scan map")
    }

    private struct ProjectedShape {
        var kind: ScanPlan.Kind
        var points: [CGPoint]
    }

    private func project(_ shapes: [ScanPlan.Shape], into size: CGSize) -> [ProjectedShape] {
        let corners = shapes.flatMap(\.corners)
        guard let first = corners.first else { return [] }
        var minX = first.x
        var maxX = first.x
        var minZ = first.y
        var maxZ = first.y
        for corner in corners {
            minX = min(minX, corner.x)
            maxX = max(maxX, corner.x)
            minZ = min(minZ, corner.y)
            maxZ = max(maxZ, corner.y)
        }
        let span = max(maxX - minX, maxZ - minZ, 1)
        let scale = (min(size.width, size.height) - 20) / CGFloat(span)
        let center = SIMD2<Float>((minX + maxX) * 0.5, (minZ + maxZ) * 0.5)
        return shapes.map { shape in
            ProjectedShape(
                kind: shape.kind,
                points: shape.corners.map { corner in
                    CGPoint(
                        x: size.width * 0.5 + CGFloat(corner.x - center.x) * scale,
                        y: size.height * 0.5 + CGFloat(corner.y - center.y) * scale
                    )
                }
            )
        }
    }

    private func polygon(_ points: [CGPoint]) -> Path {
        var path = Path()
        guard let first = points.first else { return path }
        path.move(to: first)
        for point in points.dropFirst() {
            path.addLine(to: point)
        }
        path.closeSubpath()
        return path
    }

    private func drawTreads(_ points: [CGPoint], in context: inout GraphicsContext) {
        guard points.count == 4 else { return }
        let steps = 5
        for index in 1..<steps {
            let t = CGFloat(index) / CGFloat(steps)
            var path = Path()
            path.move(to: mix(points[0], points[3], t))
            path.addLine(to: mix(points[1], points[2], t))
            context.stroke(path, with: .color(.white.opacity(0.9)), lineWidth: 1.5)
        }
    }

    private func mix(_ a: CGPoint, _ b: CGPoint, _ t: CGFloat) -> CGPoint {
        CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
    }
}
