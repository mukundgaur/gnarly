import Foundation

/// A floor map that a stair zone connects to.
struct FloorPointer: Codable, Equatable {
    let floorID: String
    let zoneID: String
    let story: Int
    /// Node id in this floor zone's building.json. RoomPlan stair objects use `stairs-` plus the identifier prefix.
    let nodeID: String?

    enum CodingKeys: String, CodingKey {
        case floorID = "floorId"
        case zoneID = "zoneId"
        case story
        case nodeID = "nodeId"
    }

    init(floorID: String, zoneID: String, story: Int, nodeID: String? = nil) {
        self.floorID = floorID
        self.zoneID = zoneID
        self.story = story
        self.nodeID = nodeID
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        floorID = try container.decode(String.self, forKey: .floorID)
        zoneID = try container.decode(String.self, forKey: .zoneID)
        story = try container.decode(Int.self, forKey: .story)
        nodeID = try container.decodeIfPresent(String.self, forKey: .nodeID)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(floorID, forKey: .floorID)
        try container.encode(zoneID, forKey: .zoneID)
        try container.encode(story, forKey: .story)
        try container.encodeIfPresent(nodeID, forKey: .nodeID)
    }
}

/// The navigator's zone-connections.json. One link joins a floor stair node to a landing in the stair zone.
struct NavigatorNodeRef: Codable, Equatable {
    let zoneID: String
    let nodeID: String

    enum CodingKeys: String, CodingKey {
        case zoneID = "zoneId"
        case nodeID = "nodeId"
    }
}

struct NavigatorZoneConnection: Codable, Equatable {
    let from: NavigatorNodeRef
    let to: NavigatorNodeRef
}

struct NavigatorZoneConnections: Codable {
    let schemaVersion: Int
    let connections: [NavigatorZoneConnection]
    let notes: String
}

enum StairDirection: String, Codable {
    case up
    case down
}

enum StairEnd: String {
    /// `prev` on the stair zone: the floor below.
    case below
    /// `next` on the stair zone: the floor above.
    case above
}

/// Stairs detected in a floor scan. The id is also the stair zone's world-map id.
struct DetectedStair: Identifiable, Equatable {
    let id: String
    let roomPlanIdentifier: String
    let position: [Float]
    let dimensions: [Float]
    let up: [Float]
    let forward: [Float]
    let story: Int
}

/// One stairwell. `prev` and `next` are the linked floors below and above.
/// The stair zone has its own world map and is not part of either floor map.
struct StairZoneNode: Codable, Identifiable, Equatable {
    var id: String
    var zoneID: String
    var roomPlanIdentifier: String?
    var detectedOnFloorID: String?
    var detectedOnZoneID: String?
    var position: [Float]
    var prev: FloorPointer?
    var next: FloorPointer?
    var scanned: Bool
    var landingBelow: [Float]?
    var landingAbove: [Float]?

    enum CodingKeys: String, CodingKey {
        case id
        case zoneID = "zoneId"
        case roomPlanIdentifier
        case detectedOnFloorID = "detectedOnFloorId"
        case detectedOnZoneID = "detectedOnZoneId"
        case position, prev, next, scanned, landingBelow, landingAbove
    }

    func pointer(going direction: StairDirection) -> FloorPointer? {
        switch direction {
        case .up: return next
        case .down: return prev
        }
    }
}

/// Hash map from a stair zone and a direction to the floor that exit lands on.
struct StairFloorIndex {
    private let floors: [String: FloorPointer]
    private let records: [(stairID: String, direction: StairDirection, floor: FloorPointer)]

    init(stairs: [StairZoneNode]) {
        var floors: [String: FloorPointer] = [:]
        var records: [(stairID: String, direction: StairDirection, floor: FloorPointer)] = []
        for stair in stairs {
            if let prev = stair.prev {
                let direction = StairDirection.down
                floors[Self.key(stairID: stair.id, direction: direction)] = prev
                records.append((stair.id, direction, prev))
            }
            if let next = stair.next {
                let direction = StairDirection.up
                floors[Self.key(stairID: stair.id, direction: direction)] = next
                records.append((stair.id, direction, next))
            }
        }
        self.floors = floors
        self.records = records
    }

    static func key(stairID: String, direction: StairDirection) -> String {
        "\(stairID):\(direction.rawValue)"
    }

    func floor(stairID: String, direction: StairDirection) -> FloorPointer? {
        floors[Self.key(stairID: stairID, direction: direction)]
    }

    func entries() -> [StairFloorEntry] {
        records
            .map { record in
                StairFloorEntry(
                    stairID: record.stairID,
                    direction: record.direction.rawValue,
                    floorID: record.floor.floorID,
                    zoneID: record.floor.zoneID,
                    story: record.floor.story
                )
            }
            .sorted { lhs, rhs in
                lhs.stairID == rhs.stairID ? lhs.direction < rhs.direction : lhs.stairID < rhs.stairID
            }
    }
}

struct StairFloorEntry: Codable, Equatable {
    let stairID: String
    let direction: String
    let floorID: String
    let zoneID: String
    let story: Int

    enum CodingKeys: String, CodingKey {
        case stairID = "stairId"
        case direction
        case floorID = "floorId"
        case zoneID = "zoneId"
        case story
    }
}

/// Link between a floor map and a stair zone. They stay separate objects.
struct ZoneConnection: Codable, Equatable {
    let fromZoneID: String
    let fromFloorID: String
    let fromNodeID: String
    let toZoneID: String
    let toFloorID: String?
    let kind: String

    enum CodingKeys: String, CodingKey {
        case fromZoneID = "fromZoneId"
        case fromFloorID = "fromFloorId"
        case fromNodeID = "fromNodeId"
        case toZoneID = "toZoneId"
        case toFloorID = "toFloorId"
        case kind
    }
}

struct StairsDocument: Codable {
    let schemaVersion: Int
    let capturedAt: String
    let stairs: [StairZoneNode]
    let floorIndex: [StairFloorEntry]
    let connections: [ZoneConnection]
    let notes: String
}

struct StairCatalog: Codable {
    var schemaVersion: Int = 1
    var stairs: [StairZoneNode] = []

    func stair(id: String) -> StairZoneNode? {
        stairs.first { $0.id == id }
    }

    /// Walk the linked list: up leaves the floor below, down leaves the floor above.
    func stair(from floorID: String, going direction: StairDirection) -> StairZoneNode? {
        switch direction {
        case .up:
            return stairs.first { $0.prev?.floorID == floorID }
        case .down:
            return stairs.first { $0.next?.floorID == floorID }
        }
    }

    func floor(on stairID: String, going direction: StairDirection) -> FloorPointer? {
        StairFloorIndex(stairs: stairs).floor(stairID: stairID, direction: direction)
    }

    func story(forFloor floorID: String) -> Int? {
        for stair in stairs {
            if stair.prev?.floorID == floorID { return stair.prev?.story }
            if stair.next?.floorID == floorID { return stair.next?.story }
        }
        return nil
    }

    mutating func upsert(detection: DetectedStair, on floor: FloorPointer) {
        if let index = stairs.firstIndex(where: { $0.id == detection.id || $0.roomPlanIdentifier == detection.roomPlanIdentifier }) {
            stairs[index].position = detection.position
            stairs[index].roomPlanIdentifier = detection.roomPlanIdentifier
            stairs[index].detectedOnFloorID = floor.floorID
            stairs[index].detectedOnZoneID = floor.zoneID
            return
        }

        stairs.append(
            StairZoneNode(
                id: detection.id,
                zoneID: detection.id,
                roomPlanIdentifier: detection.roomPlanIdentifier,
                detectedOnFloorID: floor.floorID,
                detectedOnZoneID: floor.zoneID,
                position: detection.position,
                prev: nil,
                next: nil,
                scanned: false,
                landingBelow: nil,
                landingAbove: nil
            )
        )
    }

    mutating func link(stairID: String, floor: FloorPointer, as end: StairEnd) {
        guard let index = stairs.firstIndex(where: { $0.id == stairID }) else { return }
        switch end {
        case .below: stairs[index].prev = floor
        case .above: stairs[index].next = floor
        }
    }

    mutating func markScanned(
        id: String,
        prev: FloorPointer?,
        next: FloorPointer?,
        landingBelow: [Float],
        landingAbove: [Float]
    ) {
        if let index = stairs.firstIndex(where: { $0.id == id }) {
            stairs[index].zoneID = id
            stairs[index].scanned = true
            if let prev { stairs[index].prev = merged(new: prev, existing: stairs[index].prev) }
            if let next { stairs[index].next = merged(new: next, existing: stairs[index].next) }
            stairs[index].landingBelow = landingBelow
            stairs[index].landingAbove = landingAbove
            return
        }

        stairs.append(
            StairZoneNode(
                id: id,
                zoneID: id,
                roomPlanIdentifier: nil,
                detectedOnFloorID: prev?.floorID ?? next?.floorID,
                detectedOnZoneID: prev?.zoneID ?? next?.zoneID,
                position: landingBelow,
                prev: prev,
                next: next,
                scanned: true,
                landingBelow: landingBelow,
                landingAbove: landingAbove
            )
        )
    }

    /// Links the navigator already routes across. The floor side uses the RoomPlan stair node's id.
    func navigatorZoneConnections() -> NavigatorZoneConnections {
        var connections: [NavigatorZoneConnection] = []
        for stair in stairs {
            if let prev = stair.prev {
                connections.append(
                    NavigatorZoneConnection(
                        from: NavigatorNodeRef(zoneID: prev.zoneID, nodeID: prev.nodeID ?? stair.id),
                        to: NavigatorNodeRef(zoneID: stair.zoneID, nodeID: "landing-below")
                    )
                )
            }
            if let next = stair.next {
                connections.append(
                    NavigatorZoneConnection(
                        from: NavigatorNodeRef(zoneID: stair.zoneID, nodeID: "landing-above"),
                        to: NavigatorNodeRef(zoneID: next.zoneID, nodeID: next.nodeID ?? stair.id)
                    )
                )
            }
        }
        return NavigatorZoneConnections(
            schemaVersion: 1,
            connections: connections,
            notes: "Generated from RoomPlan stair objects. Each link joins that object’s node on a floor map to landing-below or landing-above in the separate stair-zone map."
        )
    }

    func navigatorZoneConnectionsJSON() -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(navigatorZoneConnections()) else {
            return "{\n  \"schemaVersion\": 1,\n  \"connections\": []\n}"
        }
        return String(decoding: data, as: UTF8.self)
    }

    private func merged(new: FloorPointer, existing: FloorPointer?) -> FloorPointer {
        let keptNodeID = new.nodeID ?? (existing?.floorID == new.floorID && existing?.zoneID == new.zoneID ? existing?.nodeID : nil)
        return FloorPointer(floorID: new.floorID, zoneID: new.zoneID, story: new.story, nodeID: keptNodeID)
    }

    func document(capturedAt: String) -> StairsDocument {
        let index = StairFloorIndex(stairs: stairs)
        return StairsDocument(
            schemaVersion: 1,
            capturedAt: capturedAt,
            stairs: stairs,
            floorIndex: index.entries(),
            connections: connections(),
            notes: "Stair zones are separate world maps from the floor that detected them. prev and next point at the floor below and the floor above. floorIndex maps a stair id and direction to the floor you land on. A stair zone renders only after its world map has been scanned."
        )
    }

    private func connections() -> [ZoneConnection] {
        var links: [ZoneConnection] = []
        for stair in stairs {
            if let floorID = stair.detectedOnFloorID, let zoneID = stair.detectedOnZoneID {
                append(
                    ZoneConnection(
                        fromZoneID: zoneID,
                        fromFloorID: floorID,
                        fromNodeID: stair.id,
                        toZoneID: stair.zoneID,
                        toFloorID: nil,
                        kind: "floor-to-stairs"
                    ),
                    to: &links
                )
            }
            if let prev = stair.prev {
                append(
                    ZoneConnection(
                        fromZoneID: prev.zoneID,
                        fromFloorID: prev.floorID,
                        fromNodeID: prev.nodeID ?? stair.id,
                        toZoneID: stair.zoneID,
                        toFloorID: nil,
                        kind: "floor-to-stairs"
                    ),
                    to: &links
                )
                append(
                    ZoneConnection(
                        fromZoneID: stair.zoneID,
                        fromFloorID: prev.floorID,
                        fromNodeID: "landing-below",
                        toZoneID: prev.zoneID,
                        toFloorID: prev.floorID,
                        kind: "stairs-to-floor"
                    ),
                    to: &links
                )
            }
            if let next = stair.next {
                append(
                    ZoneConnection(
                        fromZoneID: next.zoneID,
                        fromFloorID: next.floorID,
                        fromNodeID: next.nodeID ?? stair.id,
                        toZoneID: stair.zoneID,
                        toFloorID: nil,
                        kind: "floor-to-stairs"
                    ),
                    to: &links
                )
                append(
                    ZoneConnection(
                        fromZoneID: stair.zoneID,
                        fromFloorID: next.floorID,
                        fromNodeID: "landing-above",
                        toZoneID: next.zoneID,
                        toFloorID: next.floorID,
                        kind: "stairs-to-floor"
                    ),
                    to: &links
                )
            }
        }
        return links
    }

    private func append(_ link: ZoneConnection, to links: inout [ZoneConnection]) {
        let exists = links.contains {
            $0.fromZoneID == link.fromZoneID
                && $0.fromNodeID == link.fromNodeID
                && $0.toZoneID == link.toZoneID
                && $0.kind == link.kind
        }
        if !exists { links.append(link) }
    }
}

enum StairPortalAlignment {
    /// Keeps a floor map's stair portal on the same id as the separate stair zone.
    static func align(graph: BuildingGraph, catalog: StairCatalog, floorID: String) -> BuildingGraph {
        var idMap: [String: String] = [:]
        var claimed = Set<String>()
        let stairNodes = graph.nodes.filter { $0.type == GraphNodeType.stairs.rawValue }

        for node in stairNodes {
            guard let match = catalog.stairs.first(where: {
                !claimed.contains($0.id) && ($0.id == node.id || $0.roomPlanIdentifier == node.roomPlanIdentifier)
            }) else { continue }
            idMap[node.id] = match.id
            claimed.insert(match.id)
        }

        let linked = catalog.stairs.filter { stair in
            !claimed.contains(stair.id) && (
                stair.prev?.floorID == floorID ||
                stair.next?.floorID == floorID ||
                stair.detectedOnFloorID == floorID
            )
        }
        var linkedIndex = 0
        for node in stairNodes where idMap[node.id] == nil {
            guard linkedIndex < linked.count else { continue }
            idMap[node.id] = linked[linkedIndex].id
            linkedIndex += 1
        }

        let changes = idMap.contains { $0.key != $0.value }
        guard changes else { return graph }

        let nodes = graph.nodes.map { node -> BuildingNode in
            guard let renamed = idMap[node.id], renamed != node.id else { return node }
            return BuildingNode(
                id: renamed,
                floor: node.floor,
                type: node.type,
                position: node.position,
                source: node.source,
                label: node.label,
                roomPlanIdentifier: node.roomPlanIdentifier
            )
        }
        let edges = graph.edges.map { edge in
            BuildingEdge(
                from: idMap[edge.from] ?? edge.from,
                to: idMap[edge.to] ?? edge.to,
                kind: edge.kind,
                meters: edge.meters,
                source: edge.source
            )
        }
        return BuildingGraph(
            schemaVersion: graph.schemaVersion,
            zoneID: graph.zoneID,
            coordinateSystem: graph.coordinateSystem,
            heightReference: graph.heightReference,
            capturedAt: graph.capturedAt,
            floors: graph.floors,
            nodes: nodes,
            edges: edges,
            notes: graph.notes
        )
    }
}

enum StairZoneID {
    static func make(roomPlanIdentifier: String) -> String {
        let prefix = roomPlanIdentifier.prefix(8).lowercased()
        return "stairs-\(prefix)"
    }

    static func sanitize(_ zoneID: String) -> String {
        zoneID
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/", with: "-")
    }
}

enum StairLandings {
    /// Places one end at the floor below and one at the floor above, along the stair volume.
    static func positions(
        center: [Float],
        dimensions: [Float],
        up: [Float],
        forward: [Float]
    ) -> (below: [Float], above: [Float]) {
        let height = dimensions.count > 1 ? abs(dimensions[1]) : 3
        let depth = dimensions.count > 2 ? abs(dimensions[2]) : 2
        let halfHeight = max(height, 1) / 2
        let halfDepth = max(depth, 1) / 2
        let upAxis = unit(up, fallback: [0, 1, 0])
        let forwardAxis = unit(forward, fallback: [0, 0, 1])
        let below = add(add(center, scaled(upAxis, -halfHeight)), scaled(forwardAxis, -halfDepth))
        let above = add(add(center, scaled(upAxis, halfHeight)), scaled(forwardAxis, halfDepth))
        return (below, above)
    }

    private static func add(_ lhs: [Float], _ rhs: [Float]) -> [Float] {
        guard lhs.count == 3, rhs.count == 3 else { return lhs }
        return [lhs[0] + rhs[0], lhs[1] + rhs[1], lhs[2] + rhs[2]]
    }

    private static func scaled(_ value: [Float], _ scale: Float) -> [Float] {
        guard value.count == 3 else { return value }
        return [value[0] * scale, value[1] * scale, value[2] * scale]
    }

    private static func unit(_ value: [Float], fallback: [Float]) -> [Float] {
        guard value.count == 3 else { return fallback }
        let length = sqrt(value[0] * value[0] + value[1] * value[1] + value[2] * value[2])
        guard length > 0.0001 else { return fallback }
        return scaled(value, 1 / length)
    }
}

enum StairCatalogStore {
    static func load() -> StairCatalog {
        guard let url = try? fileURL(),
              let data = try? Data(contentsOf: url),
              let catalog = try? JSONDecoder().decode(StairCatalog.self, from: data) else {
            return StairCatalog()
        }
        return catalog
    }

    static func save(_ catalog: StairCatalog) throws {
        let url = try fileURL()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try encoder.encode(catalog).write(to: url, options: .atomic)
    }

    private static func fileURL() throws -> URL {
        let documents = try FileManager.default.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return documents
            .appendingPathComponent("GnarlyCatalog", isDirectory: true)
            .appendingPathComponent("stairs-catalog.json")
    }
}

enum ExportedMap {
    case floor
    case stairZone(id: String)
}
