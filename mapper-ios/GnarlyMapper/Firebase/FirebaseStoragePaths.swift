import Foundation

enum FirebaseStoragePaths {
    static let diagnosticText = "buildings/firebase-test/test.txt"

    static func buildingJSON(buildingId: String, versionId: String) throws -> String {
        try base(buildingId: buildingId, versionId: versionId) + "/building.json"
    }

    static func zoneBuildingJSON(buildingId: String, versionId: String, zoneId: String) throws -> String {
        try validate(zoneId, field: "zoneId")
        return try base(buildingId: buildingId, versionId: versionId) + "/zones/\(zoneId)/building.json"
    }

    static func zoneConnections(buildingId: String, versionId: String) throws -> String {
        try base(buildingId: buildingId, versionId: versionId) + "/zone-connections.json"
    }

    static func scanJSON(buildingId: String, versionId: String) throws -> String {
        try base(buildingId: buildingId, versionId: versionId) + "/scan.json"
    }

    static func structure(buildingId: String, versionId: String) throws -> String {
        try base(buildingId: buildingId, versionId: versionId) + "/structure.usdz"
    }

    static func worldMap(buildingId: String, versionId: String, zoneId: String) throws -> String {
        try validate(zoneId, field: "zoneId")
        return try base(buildingId: buildingId, versionId: versionId) + "/worldmaps/\(zoneId).bin"
    }

    static func validate(_ value: String, field: String) throws {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains("/") else {
            throw FirebaseDataError.invalidIdentifier(field: field)
        }
    }

    private static func base(buildingId: String, versionId: String) throws -> String {
        try validate(buildingId, field: "buildingId")
        try validate(versionId, field: "versionId")
        return "buildings/\(buildingId)/\(versionId)"
    }
}
