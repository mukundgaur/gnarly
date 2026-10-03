import FirebaseFirestore
import Foundation

enum RecordStatus: String, Codable, CaseIterable {
    case scanning
    case draft
    case published
    case active
    case retired
    case archived
}

struct Building: Codable, Identifiable {
    @DocumentID var id: String?
    var name: String
    var activeVersion: String?
    var status: RecordStatus
    var createdAt: Date?
    var updatedAt: Date?
}

struct BuildingVersion: Codable, Identifiable {
    @DocumentID var id: String?
    var versionNumber: Int
    var status: RecordStatus
    var buildingJsonPath: String?
    var structurePath: String?
    var createdAt: Date?
    var publishedAt: Date?
}

struct Floor: Codable, Identifiable {
    @DocumentID var id: String?
    var name: String
    var story: Int
    var elevation: Double
}

struct Zone: Codable, Identifiable {
    @DocumentID var id: String?
    var name: String
    var floorId: String
    var worldMapPath: String?
    var buildingJsonPath: String?
    var relocalizationHint: String
    var startNodeId: String
}

struct Destination: Codable, Identifiable {
    @DocumentID var id: String?
    var name: String
    var aliases: [String]
    var floorId: String
    var nodeId: String
    var category: String
    var searchable: Bool
}

struct Position3D: Codable, Equatable {
    var x: Double
    var y: Double
    var z: Double
}

struct NavigationNode: Codable, Identifiable {
    @DocumentID var id: String?
    var floorId: String
    var zoneId: String
    var type: String
    var position: Position3D
}

struct NavigationEdge: Codable, Identifiable {
    @DocumentID var id: String?
    var from: String
    var to: String
    var kind: String
    var meters: Double
    var bidirectional: Bool
    var accessible: Bool
}

struct ActiveBuildingVersion {
    let building: Building
    let version: BuildingVersion

    var buildingId: String { building.id ?? "" }
    var versionId: String { version.id ?? "" }
}

struct DownloadedNavigationPackage {
    let buildingId: String
    let versionId: String
    let zoneId: String
    let buildingJSONURL: URL
    let worldMapURL: URL
}
