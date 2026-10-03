import Foundation
import RoomPlan
import simd

enum BuildingGraphBuilder {
    static func build(
        zoneID: String,
        floorID: String,
        capturedAt: String,
        room: CapturedRoom,
        recorded: [RecordedGraphNode]
    ) -> BuildingGraph {
        let story = room.story
        let elevation = room.floors.first.map { $0.transform.columns.3.y } ?? 0
        let floor = BuildingFloor(id: floorID, story: story, elevation: elevation)

        var usedIDs = Set<String>()
        var nodes: [BuildingNode] = []

        for (index, record) in recorded.enumerated() {
            let id = uniqueID(preferred: recordedID(record, index: index), used: &usedIDs)
            nodes.append(
                BuildingNode(
                    id: id,
                    floor: floorID,
                    type: record.type.rawValue,
                    position: record.position,
                    source: "recorded",
                    label: record.label,
                    roomPlanIdentifier: nil
                )
            )
        }

        for door in room.doors {
            let id = uniqueID(preferred: "door-\(shortID(door.identifier))", used: &usedIDs)
            nodes.append(
                BuildingNode(
                    id: id,
                    floor: floorID,
                    type: GraphNodeType.door.rawValue,
                    position: translation(door.transform),
                    source: "roomplan-hint",
                    label: RoomPlanScanExtractor.surfaceCategoryName(door.category),
                    roomPlanIdentifier: door.identifier.uuidString
                )
            )
        }

        for opening in room.openings {
            let id = uniqueID(preferred: "opening-\(shortID(opening.identifier))", used: &usedIDs)
            nodes.append(
                BuildingNode(
                    id: id,
                    floor: floorID,
                    type: GraphNodeType.opening.rawValue,
                    position: translation(opening.transform),
                    source: "roomplan-hint",
                    label: "opening",
                    roomPlanIdentifier: opening.identifier.uuidString
                )
            )
        }

        for object in room.objects where object.category == .stairs {
            let id = uniqueID(preferred: "stairs-\(shortID(object.identifier))", used: &usedIDs)
            nodes.append(
                BuildingNode(
                    id: id,
                    floor: floorID,
                    type: GraphNodeType.stairs.rawValue,
                    position: translation(object.transform),
                    source: "roomplan-hint",
                    label: "stairs",
                    roomPlanIdentifier: object.identifier.uuidString
                )
            )
        }

        for section in room.sections where section.label != .unidentified {
            let id = uniqueID(preferred: "section-\(section.label.rawValue)", used: &usedIDs)
            nodes.append(
                BuildingNode(
                    id: id,
                    floor: floorID,
                    type: GraphNodeType.hallway.rawValue,
                    position: [section.center.x, section.center.y, section.center.z],
                    source: "roomplan-hint",
                    label: section.label.rawValue,
                    roomPlanIdentifier: nil
                )
            )
        }

        var edges = RoomPlanVisibilityGraph.edges(nodes: nodes, room: room)

        let recordedNodes = nodes.filter { $0.source == "recorded" }
        if recordedNodes.count >= 2 {
            for index in 0 ..< (recordedNodes.count - 1) {
                let from = recordedNodes[index]
                let to = recordedNodes[index + 1]
                edges.append(
                    BuildingEdge(
                        from: from.id,
                        to: to.id,
                        kind: edgeKind(from: from, to: to),
                        meters: distance(from.position, to.position),
                        source: "recorded"
                    )
                )
            }
        }

        return BuildingGraph(
            schemaVersion: 1,
            zoneID: zoneID,
            coordinateSystem: "arkit-world-meters",
            heightReference: "device",
            capturedAt: capturedAt,
            floors: [floor],
            nodes: nodes,
            edges: edges,
            notes: "Primary nodes are RoomPlan doors, openings, stairs, and sections. Visibility edges skip walls except at portals. Optional recorded taps add entrance/destination labels."
        )
    }

    static func route(from graph: BuildingGraph, recordedCount: Int) -> RouteDocument? {
        let waypoints = graph.nodes.filter { $0.source == "recorded" }
        guard waypoints.count >= 2, recordedCount >= 2 else { return nil }
        return RouteDocument(
            schemaVersion: 1,
            zoneID: graph.zoneID,
            coordinateSystem: graph.coordinateSystem,
            heightReference: graph.heightReference,
            waypoints: waypoints.map { RouteDocument.Waypoint(id: $0.id, position: $0.position) },
            capturedAt: graph.capturedAt,
            notes: "Fallback walk-order path. Unity prefers A* over visibility edges in building.json / scan-features.json."
        )
    }

    private static func recordedID(_ record: RecordedGraphNode, index: Int) -> String {
        if let label = record.label, let slug = slug(label), !slug.isEmpty {
            return slug
        }
        return "\(record.type.rawValue)-\(index + 1)"
    }

    private static func slug(_ value: String) -> String? {
        let lowered = value.lowercased()
        let scalars = lowered.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : "-" }
        let collapsed = String(scalars)
            .split(separator: "-")
            .joined(separator: "-")
        return collapsed.isEmpty ? nil : collapsed
    }

    private static func uniqueID(preferred: String, used: inout Set<String>) -> String {
        var candidate = preferred
        var suffix = 2
        while used.contains(candidate) {
            candidate = "\(preferred)-\(suffix)"
            suffix += 1
        }
        used.insert(candidate)
        return candidate
    }

    private static func shortID(_ uuid: UUID) -> String {
        String(uuid.uuidString.prefix(8)).lowercased()
    }

    private static func translation(_ transform: simd_float4x4) -> [Float] {
        let column = transform.columns.3
        return [column.x, column.y, column.z]
    }

    private static func distance(_ a: [Float], _ b: [Float]) -> Float {
        guard a.count == 3, b.count == 3 else { return 0 }
        let dx = a[0] - b[0]
        let dy = a[1] - b[1]
        let dz = a[2] - b[2]
        return sqrt(dx * dx + dy * dy + dz * dz)
    }

    private static func edgeKind(from: BuildingNode, to: BuildingNode) -> String {
        from.type == GraphNodeType.stairs.rawValue && to.type == GraphNodeType.stairs.rawValue
            ? "stairs"
            : "hallway"
    }
}
