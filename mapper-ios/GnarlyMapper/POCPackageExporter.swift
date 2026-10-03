import ARKit
import Foundation
import RoomPlan

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

enum POCPackageExporter {
    static func export(room: CapturedRoom, worldMap: ARWorldMap, anchor: TestAnchor) throws -> URL {
        let documentsDirectory = try FileManager.default.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let safeZoneID = anchor.zoneID.replacingOccurrences(of: "/", with: "-")
        let timestamp = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
        let packageURL = documentsDirectory
            .appendingPathComponent("POCExports", isDirectory: true)
            .appendingPathComponent("\(timestamp)-\(safeZoneID)", isDirectory: true)

        try FileManager.default.createDirectory(at: packageURL, withIntermediateDirectories: true)

        let mapData = try NSKeyedArchiver.archivedData(withRootObject: worldMap, requiringSecureCoding: true)
        try mapData.write(to: packageURL.appendingPathComponent("worldmap-\(safeZoneID).bin"), options: .atomic)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(anchor).write(to: packageURL.appendingPathComponent("test-anchor.json"), options: .atomic)

        // This USDZ is a RoomPlan output for inspection/minimap work; Unity's POC uses the map and anchor above.
        try room.export(to: packageURL.appendingPathComponent("structure.usdz"), exportOptions: .parametric)
        return packageURL
    }
}
