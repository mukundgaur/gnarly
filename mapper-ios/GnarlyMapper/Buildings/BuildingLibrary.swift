import Foundation
import MapKit
import UIKit

@MainActor
final class BuildingLibrary: ObservableObject {
    @Published private(set) var buildings: [OwnedBuilding] = []
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    func refresh(ownerUid: String? = nil) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            buildings = try await FirebaseDataRepository().listBuildings()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func replace(_ building: OwnedBuilding) {
        if let index = buildings.firstIndex(where: { $0.id == building.id }) {
            buildings[index] = building
        } else {
            buildings.insert(building, at: 0)
        }
    }

    func saveAlignment(building: OwnedBuilding, layout: BuildingLayoutDocument) async throws {
        let repository = try FirebaseDataRepository()
        try await repository.updateBuildingPlacement(
            buildingId: building.id,
            latitude: building.latitude,
            longitude: building.longitude,
            heading: building.mapHeadingDegrees
        )
        if let versionId = building.activeVersion, !versionId.isEmpty {
            _ = try await repository.uploadBuildingLayout(layout, buildingId: building.id, versionId: versionId)
        }
        replace(building)
    }

    func createBuilding(name: String, latitude: Double?, longitude: Double?, heading: Double, ownerUid: String) async throws -> OwnedBuilding {
        let existing = Set(buildings.map(\.id))
        let id = ZoneIdentifier.make(from: name, existing: existing)
        let building = Building(
            id: id,
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            activeVersion: nil,
            status: .draft,
            createdAt: nil,
            updatedAt: nil,
            ownerUid: ownerUid,
            latitude: latitude,
            longitude: longitude,
            mapHeadingDegrees: heading
        )
        try await FirebaseDataRepository().createBuilding(building)
        let owned = OwnedBuilding(building, id: id)
        buildings.insert(owned, at: 0)
        return owned
    }

    func loadMap(for building: OwnedBuilding) async throws -> BuildingMap {
        let repository = try FirebaseDataRepository()
        guard let versionId = building.activeVersion, !versionId.isEmpty else {
            return BuildingMap(building: building, versionId: nil, layout: BuildingLayoutDocument(), zones: [])
        }
        let records = try await repository.listZones(buildingId: building.id, versionId: versionId)
        var layout = try await repository.downloadBuildingLayout(buildingId: building.id, versionId: versionId) ?? BuildingLayoutDocument()
        var zones: [BuildingZone] = []
        for zone in records {
            guard let zoneId = zone.id else { continue }
            if layout.entry(for: zoneId) == nil {
                let level = inferredLevel(zone.floorId)
                let siblings = layout.zones.filter { $0.floor == level }
                let siblingBounds = siblings.isEmpty ? nil : FloorBounds(
                    minX: Float(siblings.map(\.x).min() ?? 0),
                    maxX: Float(siblings.map(\.x).max() ?? 0),
                    minZ: Float(siblings.map(\.z).min() ?? 0),
                    maxZ: Float(siblings.map(\.z).max() ?? 0)
                )
                layout.upsert(.beside(levelBounds: siblingBounds, zoneId: zoneId, level: level))
            }
            let features = try await loadFeatures(zone: zone, buildingId: building.id, versionId: versionId, repository: repository)
            let surfaces = features.map(BakeSurface.from) ?? []
            let colors = try await loadColors(zone: zone, repository: repository)
            let ground = BuildingMesh.ground(of: surfaces)
            let placement = layout.entry(for: zoneId) ?? .beside(levelBounds: nil, zoneId: zoneId, level: inferredLevel(zone.floorId))
            zones.append(BuildingZone(
                record: ZoneRecord(
                    id: zoneId,
                    name: zone.name,
                    floorId: zone.floorId,
                    scanFeaturesPath: zone.scanFeaturesPath,
                    surfaceColorsPath: zone.surfaceColorsPath,
                    surfaceColorAtlasPath: zone.surfaceColorAtlasPath
                ),
                placement: placement,
                surfaces: surfaces,
                floorPolygons: [:],
                colors: colors.document,
                atlas: colors.atlas,
                ground: ground,
                localBounds: BuildingMesh.bounds(of: surfaces),
                loadIssue: features == nil && zone.scanFeaturesPath != nil ? "This zone has no drawable scan yet." : nil
            ))
        }
        return BuildingMap(building: building, versionId: versionId, layout: layout, zones: zones)
    }

    func satelliteImage(for building: OwnedBuilding, bounds: FloorBounds?) async -> UIImage? {
        guard let latitude = building.latitude, let longitude = building.longitude else { return nil }
        let meters = Double(max(bounds?.width ?? 40, bounds?.depth ?? 40) + 30)
        let snapshot = MKMapSnapshotter(options: {
            let options = MKMapSnapshotter.Options()
            options.region = MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: latitude, longitude: longitude), latitudinalMeters: meters, longitudinalMeters: meters)
            options.mapType = .satellite
            options.size = CGSize(width: 1024, height: 1024)
            options.traitCollection = UITraitCollection(userInterfaceStyle: .dark)
            return options
        }())
        return try? await snapshot.start().image
    }

    private func loadFeatures(zone: Zone, buildingId: String, versionId: String, repository: FirebaseDataRepository) async throws -> ScanFeatures? {
        let path = zone.scanFeaturesPath ?? (try? FirebaseStoragePaths.zoneScanFeatures(buildingId: buildingId, versionId: versionId, zoneId: zone.id ?? ""))
        guard let path, let url = try await repository.downloadOptional(storagePath: path) else { return nil }
        return try JSONDecoder().decode(ScanFeatures.self, from: Data(contentsOf: url))
    }

    private func loadColors(zone: Zone, repository: FirebaseDataRepository) async throws -> (document: SurfaceColorDocument?, atlas: UIImage?) {
        guard let jsonPath = zone.surfaceColorsPath, let atlasPath = zone.surfaceColorAtlasPath else { return (nil, nil) }
        guard let jsonURL = try await repository.downloadOptional(storagePath: jsonPath) else { return (nil, nil) }
        let document = try JSONDecoder().decode(SurfaceColorDocument.self, from: Data(contentsOf: jsonURL))
        var atlas: UIImage?
        if let atlasURL = try await repository.downloadOptional(storagePath: atlasPath) {
            atlas = UIImage(data: try Data(contentsOf: atlasURL))
        }
        return (document, atlas)
    }
}

func inferredLevel(_ floorId: String) -> Int {
    let lower = floorId.lowercased()
    if lower.contains("ground") || lower.contains("lobby") { return 0 }
    if lower.contains("basement") {
        return -(Int(lower.filter(\.isNumber)) ?? 1)
    }
    if let number = Int(lower.filter(\.isNumber)), number != 0 || lower.contains("0") {
        return number
    }
    return 0
}
