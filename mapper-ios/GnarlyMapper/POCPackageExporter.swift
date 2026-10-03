import ARKit
import Foundation
import RoomPlan

enum POCPackageExporter {
    static func export(
        room: CapturedRoom,
        worldMap: ARWorldMap,
        anchor: TestAnchor,
        recordedNodes: [RecordedGraphNode],
        floorID: String,
        map: ExportedMap = .floor,
        stairs: StairCatalog? = nil
    ) throws -> URL {
        let documentsDirectory = try FileManager.default.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let safeZoneID = anchor.zoneID.replacingOccurrences(of: "/", with: "-")
        let capturedAt = ISO8601DateFormatter().string(from: Date())
        let folderTimestamp = capturedAt.replacingOccurrences(of: ":", with: "-")
        let packageURL = documentsDirectory
            .appendingPathComponent("POCExports", isDirectory: true)
            .appendingPathComponent("\(folderTimestamp)-\(safeZoneID)", isDirectory: true)

        try FileManager.default.createDirectory(at: packageURL, withIntermediateDirectories: true)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601

        let mapData = try NSKeyedArchiver.archivedData(withRootObject: worldMap, requiringSecureCoding: true)
        try mapData.write(to: packageURL.appendingPathComponent("worldmap-\(safeZoneID).bin"), options: .atomic)

        try encoder.encode(anchor).write(to: packageURL.appendingPathComponent("test-anchor.json"), options: .atomic)

        let scan = ScanDocument(
            schemaVersion: 1,
            zoneID: safeZoneID,
            coordinateSystem: "arkit-world-meters",
            capturedAt: capturedAt,
            notes: "Raw RoomPlan CapturedRoom in the same ARKit coordinate system as the world map.",
            room: room
        )
        try encoder.encode(scan).write(to: packageURL.appendingPathComponent("scan.json"), options: .atomic)

        let features = RoomPlanScanExtractor.features(from: room, zoneID: safeZoneID, capturedAt: capturedAt)
        try encoder.encode(features).write(to: packageURL.appendingPathComponent("scan-features.json"), options: .atomic)

        let graph = graph(
            map: map,
            zoneID: safeZoneID,
            floorID: floorID,
            capturedAt: capturedAt,
            room: room,
            recordedNodes: recordedNodes,
            stairs: stairs
        )
        try encoder.encode(graph).write(to: packageURL.appendingPathComponent("building.json"), options: .atomic)

        if let stairs, !stairs.stairs.isEmpty {
            let document = stairs.document(capturedAt: capturedAt)
            try encoder.encode(document).write(to: packageURL.appendingPathComponent("stairs.json"), options: .atomic)
            let zoneConnections = stairs.navigatorZoneConnections()
            if !zoneConnections.connections.isEmpty {
                try encoder.encode(zoneConnections).write(to: packageURL.appendingPathComponent("zone-connections.json"), options: .atomic)
            }
        }

        if let route = BuildingGraphBuilder.route(from: graph, recordedCount: recordedNodes.count) {
            try encoder.encode(route).write(to: packageURL.appendingPathComponent("route.json"), options: .atomic)
        }

        let usdzURL = packageURL.appendingPathComponent("structure.usdz")
        let metadataURL = packageURL.appendingPathComponent("structure-metadata.json")
        try room.export(to: usdzURL, metadataURL: metadataURL, modelProvider: nil, exportOptions: .parametric)

        var files = [
            "worldmap-\(safeZoneID).bin",
            "test-anchor.json",
            "scan.json",
            "scan-features.json",
            "building.json",
            "structure.usdz",
            "structure-metadata.json"
        ]
        if recordedNodes.count >= 2 {
            files.append("route.json")
        }
        if let stairs, !stairs.stairs.isEmpty {
            files.append("stairs.json")
            if !stairs.navigatorZoneConnections().connections.isEmpty {
                files.append("zone-connections.json")
            }
        }

        let manifest = PackageManifest(
            schemaVersion: 1,
            zoneID: safeZoneID,
            capturedAt: capturedAt,
            files: files.sorted(),
            notes: "LiDAR mapper package for relocalization and navigation-graph work."
        )
        try encoder.encode(manifest).write(to: packageURL.appendingPathComponent("manifest.json"), options: .atomic)

        return packageURL
    }

    private static func graph(
        map: ExportedMap,
        zoneID: String,
        floorID: String,
        capturedAt: String,
        room: CapturedRoom,
        recordedNodes: [RecordedGraphNode],
        stairs: StairCatalog?
    ) -> BuildingGraph {
        switch map {
        case .floor:
            let floorGraph = BuildingGraphBuilder.build(
                zoneID: zoneID,
                floorID: floorID,
                capturedAt: capturedAt,
                room: room,
                recorded: recordedNodes
            )
            guard let stairs else { return floorGraph }
            return StairPortalAlignment.align(graph: floorGraph, catalog: stairs, floorID: floorID)
        case .stairZone(let id):
            let stair = stairs?.stair(id: id) ?? StairZoneNode(
                id: id,
                zoneID: id,
                roomPlanIdentifier: nil,
                detectedOnFloorID: nil,
                detectedOnZoneID: nil,
                position: [0, 0, 0],
                prev: nil,
                next: nil,
                scanned: true,
                landingBelow: nil,
                landingAbove: nil
            )
            let landings = landings(for: stair, recorded: recordedNodes)
            return BuildingGraphBuilder.buildStairZone(
                stair: stair,
                capturedAt: capturedAt,
                recorded: recordedNodes,
                landingBelow: stair.landingBelow ?? landings.below,
                landingAbove: stair.landingAbove ?? landings.above
            )
        }
    }

    private static func landings(
        for stair: StairZoneNode,
        recorded: [RecordedGraphNode]
    ) -> (below: [Float], above: [Float]) {
        if let below = stair.landingBelow, let above = stair.landingAbove {
            return (below, above)
        }
        let center = recorded.first?.position ?? stair.position
        return StairLandings.positions(
            center: center,
            dimensions: [1.2, 3, 2.5],
            up: [0, 1, 0],
            forward: [0, 0, 1]
        )
    }
}
