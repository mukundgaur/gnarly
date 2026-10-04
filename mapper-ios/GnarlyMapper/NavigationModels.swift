import Foundation

struct TestAnchor: Codable {
    let schemaVersion: Int
    let zoneID: String
    let position: [Float]
    let coordinateSystem: String
    let capturedAt: String
    let notes: String

    enum CodingKeys: String, CodingKey {
        case schemaVersion
        case zoneID = "zoneId"
        case position, coordinateSystem, capturedAt, notes
    }

    func withZoneID(_ zoneID: String) -> TestAnchor {
        TestAnchor(
            schemaVersion: schemaVersion,
            zoneID: zoneID,
            position: position,
            coordinateSystem: coordinateSystem,
            capturedAt: capturedAt,
            notes: notes
        )
    }
}

enum GraphNodeType: String, Codable, CaseIterable, Identifiable {
    case entrance
    case hallway
    case elevator
    case continuation
    case stairs
    case destination
    case door
    case opening
    case waypoint

    var id: String { rawValue }

    var title: String {
        switch self {
        case .entrance: return "Entrance"
        case .hallway: return "Hallway"
        case .elevator: return "Elevator"
        case .continuation: return "Zone continuation"
        case .stairs: return "Stairs"
        case .destination: return "Destination"
        case .door: return "Door"
        case .opening: return "Opening"
        case .waypoint: return "Waypoint"
        }
    }
}

struct RecordedGraphNode {
    let type: GraphNodeType
    let label: String?
    let position: [Float]
    let capturedAt: String
}

struct BuildingFloor: Codable {
    let id: String
    let story: Int
    let elevation: Float
}

struct BuildingNode: Codable {
    let id: String
    let floor: String
    let type: String
    let position: [Float]
    let source: String
    let label: String?
    let roomPlanIdentifier: String?
}

struct BuildingEdge: Codable {
    let from: String
    let to: String
    let kind: String
    let meters: Float
    let source: String
}

struct BuildingGraph: Codable {
    let schemaVersion: Int
    let zoneID: String
    let coordinateSystem: String
    let heightReference: String
    let capturedAt: String
    let floors: [BuildingFloor]
    let nodes: [BuildingNode]
    let edges: [BuildingEdge]
    let notes: String

    enum CodingKeys: String, CodingKey {
        case schemaVersion
        case zoneID = "zoneId"
        case coordinateSystem, heightReference, capturedAt, floors, nodes, edges, notes
    }
}

struct RouteDocument: Codable {
    struct Waypoint: Codable {
        let id: String
        let position: [Float]
    }

    let schemaVersion: Int
    let zoneID: String
    let coordinateSystem: String
    let heightReference: String
    let waypoints: [Waypoint]
    let capturedAt: String
    let notes: String

    enum CodingKeys: String, CodingKey {
        case schemaVersion
        case zoneID = "zoneId"
        case coordinateSystem, heightReference, waypoints, capturedAt, notes
    }
}

struct ScanFeatureSurface: Codable {
    let identifier: String
    let category: String
    let confidence: String
    let story: Int
    let dimensions: [Float]
    let position: [Float]
    let transformColumnMajor: [Float]
    let polygonCorners: [[Float]]
    let parentIdentifier: String?
}

struct ScanFeatureObject: Codable {
    let identifier: String
    let category: String
    let confidence: String
    let story: Int
    let dimensions: [Float]
    let position: [Float]
    let transformColumnMajor: [Float]
    let parentIdentifier: String?
}

struct ScanFeatureSection: Codable {
    let label: String
    let story: Int
    let center: [Float]
}

struct ScanFeatures: Codable {
    let schemaVersion: Int
    let zoneID: String
    let coordinateSystem: String
    let capturedAt: String
    let roomIdentifier: String
    let story: Int
    let walls: [ScanFeatureSurface]
    let doors: [ScanFeatureSurface]
    let openings: [ScanFeatureSurface]
    let windows: [ScanFeatureSurface]
    let floors: [ScanFeatureSurface]
    let objects: [ScanFeatureObject]
    let sections: [ScanFeatureSection]
    let notes: String

    enum CodingKeys: String, CodingKey {
        case schemaVersion
        case zoneID = "zoneId"
        case coordinateSystem, capturedAt, roomIdentifier, story
        case walls, doors, openings, windows, floors, objects, sections, notes
    }
}

struct PackageManifest: Codable {
    let schemaVersion: Int
    let zoneID: String
    let capturedAt: String
    let files: [String]
    let notes: String

    enum CodingKeys: String, CodingKey {
        case schemaVersion
        case zoneID = "zoneId"
        case capturedAt, files, notes
    }
}

struct ScanDocument<Room: Encodable>: Encodable {
    let schemaVersion: Int
    let zoneID: String
    let coordinateSystem: String
    let capturedAt: String
    let notes: String
    let room: Room

    enum CodingKeys: String, CodingKey {
        case schemaVersion
        case zoneID = "zoneId"
        case coordinateSystem, capturedAt, notes, room
    }
}
