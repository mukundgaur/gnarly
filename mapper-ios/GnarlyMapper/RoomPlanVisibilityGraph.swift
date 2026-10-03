import Foundation
import RoomPlan
import simd

/// Connects RoomPlan portals (doors, openings, stairs) when a floor-plane line of sight
/// does not cross a wall except at a door or opening.
enum RoomPlanVisibilityGraph {
    static let maxEdgeMeters: Float = 18
    static let portalClearance: Float = 0.45

    static func edges(nodes: [BuildingNode], room: CapturedRoom) -> [BuildingEdge] {
        let walls = room.walls.map { Segment.xz(from: $0) }
        let portals = (room.doors + room.openings).map { Segment.xz(from: $0) }

        var edges: [BuildingEdge] = []
        for i in 0 ..< nodes.count {
            for j in (i + 1) ..< nodes.count {
                let a = nodes[i]
                let b = nodes[j]
                guard a.floor == b.floor else { continue }
                let meters = distance(a.position, b.position)
                guard meters > 0.2, meters <= maxEdgeMeters else { continue }
                guard isClear(
                    from: xz(a.position),
                    to: xz(b.position),
                    walls: walls,
                    portals: portals
                ) else { continue }

                edges.append(
                    BuildingEdge(
                        from: a.id,
                        to: b.id,
                        kind: edgeKind(from: a, to: b),
                        meters: meters,
                        source: "visibility"
                    )
                )
            }
        }
        return edges
    }

    static func isClear(from start: SIMD2<Float>, to end: SIMD2<Float>, walls: [Segment], portals: [Segment]) -> Bool {
        for wall in walls {
            guard let hit = wall.intersection(start, end) else { continue }
            let nearEndpoint = min(simd_distance(hit, start), simd_distance(hit, end)) < portalClearance
            let throughPortal = portals.contains { $0.distance(to: hit) <= portalClearance }
            if nearEndpoint || throughPortal { continue }
            return false
        }
        return true
    }

    static func xz(_ position: [Float]) -> SIMD2<Float> {
        SIMD2(position[0], position[2])
    }

    static func distance(_ a: [Float], _ b: [Float]) -> Float {
        let dx = a[0] - b[0]
        let dy = a[1] - b[1]
        let dz = a[2] - b[2]
        return sqrt(dx * dx + dy * dy + dz * dz)
    }

    static func edgeKind(from: BuildingNode, to: BuildingNode) -> String {
        from.type == GraphNodeType.stairs.rawValue && to.type == GraphNodeType.stairs.rawValue
            ? "stairs"
            : "hallway"
    }

    struct Segment {
        let a: SIMD2<Float>
        let b: SIMD2<Float>

        static func xz(from surface: CapturedRoom.Surface) -> Segment {
            let half = surface.dimensions.x / 2
            let start = surface.transform * SIMD4<Float>(-half, 0, 0, 1)
            let end = surface.transform * SIMD4<Float>(half, 0, 0, 1)
            return Segment(a: SIMD2(start.x, start.z), b: SIMD2(end.x, end.z))
        }

        func intersection(_ p: SIMD2<Float>, _ q: SIMD2<Float>) -> SIMD2<Float>? {
            let r = b - a
            let s = q - p
            let den = r.x * s.y - r.y * s.x
            if abs(den) < 1e-5 { return nil }
            let qp = p - a
            let t = (qp.x * s.y - qp.y * s.x) / den
            let u = (r.x * qp.y - r.y * qp.x) / den
            guard t > 0.02, t < 0.98, u > 0.02, u < 0.98 else { return nil }
            return a + t * r
        }

        func distance(to point: SIMD2<Float>) -> Float {
            let ab = b - a
            let length = simd_length(ab)
            if length < 1e-5 { return simd_distance(point, a) }
            let t = max(0, min(1, simd_dot(point - a, ab) / (length * length)))
            return simd_distance(point, a + ab * t)
        }
    }
}
