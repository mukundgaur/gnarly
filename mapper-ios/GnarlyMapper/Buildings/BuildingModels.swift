import Foundation
import simd
import UIKit

/// Display height between stacked floors, in meters. Matches `FLOOR_GAP` in the web explorer.
let buildingFloorGap: Float = 4

/// `building-layout.json`: where each zone sits in the building, shared with the web explorer.
struct BuildingLayoutDocument: Codable, Equatable {
    struct ZoneEntry: Codable, Equatable, Hashable {
        var zoneId: String
        var floor: Int
        var x: Double
        var z: Double
        var rotationDegrees: Double
    }

    struct FloorName: Codable, Equatable, Hashable {
        var floor: Int
        var name: String
    }

    var schemaVersion = 1
    var zones: [ZoneEntry] = []
    var floors: [FloorName]?
    var notes: String?

    func entry(for zoneId: String) -> ZoneEntry? {
        zones.first { $0.zoneId == zoneId }
    }

    func floorName(_ level: Int) -> String? {
        floors?.first { $0.floor == level }?.name
    }

    mutating func upsert(_ entry: ZoneEntry) {
        zones.removeAll { $0.zoneId == entry.zoneId }
        zones.append(entry)
    }

    mutating func shiftFloor(_ level: Int, x: Double, z: Double) {
        for index in zones.indices where zones[index].floor == level {
            zones[index].x += x
            zones[index].z += z
        }
    }

    mutating func rotateFloor(_ level: Int, by degrees: Double) {
        let members = zones.filter { $0.floor == level }
        guard !members.isEmpty else { return }
        let centerX = members.map(\.x).reduce(0, +) / Double(members.count)
        let centerZ = members.map(\.z).reduce(0, +) / Double(members.count)
        let radians = degrees * .pi / 180
        let c = cos(radians), s = sin(radians)
        for index in zones.indices where zones[index].floor == level {
            let dx = zones[index].x - centerX
            let dz = zones[index].z - centerZ
            zones[index].x = dx * c + dz * s + centerX
            zones[index].z = -dx * s + dz * c + centerZ
            zones[index].rotationDegrees = normalizeDegrees(zones[index].rotationDegrees + degrees)
        }
    }

    mutating func setFloorName(_ name: String, for level: Int) {
        var names = (floors ?? []).filter { $0.floor != level }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { names.append(FloorName(floor: level, name: trimmed)) }
        floors = names.isEmpty ? nil : names.sorted { $0.floor < $1.floor }
    }
}

/// A building the signed-in account owns, as listed on the home screen.
struct OwnedBuilding: Identifiable, Hashable {
    let id: String
    var name: String
    var status: RecordStatus
    var activeVersion: String?
    var latitude: Double?
    var longitude: Double?
    var mapHeadingDegrees: Double
    var updatedAt: Date?

    var hasLocation: Bool { latitude != nil && longitude != nil }

    init(_ building: Building, id: String) {
        self.id = id
        name = building.name
        status = building.status
        activeVersion = building.activeVersion
        latitude = building.latitude
        longitude = building.longitude
        mapHeadingDegrees = building.mapHeadingDegrees ?? 0
        updatedAt = building.updatedAt
    }
}

/// A zone document plus the Storage paths needed to draw it.
struct ZoneRecord: Hashable {
    let id: String
    var name: String
    var floorId: String
    var scanFeaturesPath: String?
    var surfaceColorsPath: String?
    var surfaceColorAtlasPath: String?
}

/// Axis-aligned bounds on the floor plane (x, z).
struct FloorBounds: Equatable, Hashable {
    var minX: Float
    var maxX: Float
    var minZ: Float
    var maxZ: Float

    var center: SIMD2<Float> { SIMD2((minX + maxX) / 2, (minZ + maxZ) / 2) }
    var width: Float { maxX - minX }
    var depth: Float { maxZ - minZ }

    init(minX: Float, maxX: Float, minZ: Float, maxZ: Float) {
        self.minX = minX
        self.maxX = maxX
        self.minZ = minZ
        self.maxZ = maxZ
    }

    init?(points: [SIMD2<Float>]) {
        guard let first = points.first else { return nil }
        var bounds = FloorBounds(minX: first.x, maxX: first.x, minZ: first.y, maxZ: first.y)
        for point in points.dropFirst() { bounds.include(point) }
        self = bounds
    }

    mutating func include(_ point: SIMD2<Float>) {
        minX = min(minX, point.x)
        maxX = max(maxX, point.x)
        minZ = min(minZ, point.y)
        maxZ = max(maxZ, point.y)
    }

    func union(_ other: FloorBounds) -> FloorBounds {
        FloorBounds(minX: min(minX, other.minX), maxX: max(maxX, other.maxX), minZ: min(minZ, other.minZ), maxZ: max(maxZ, other.maxZ))
    }
}

/// Same convention as the web explorer's `toWorld`: rotate about Y, then translate.
func layoutToWorld(_ entry: BuildingLayoutDocument.ZoneEntry, _ point: SIMD2<Float>) -> SIMD2<Float> {
    let radians = Float(entry.rotationDegrees) * .pi / 180
    let c = cos(radians)
    let s = sin(radians)
    return SIMD2(point.x * c + point.y * s + Float(entry.x), -point.x * s + point.y * c + Float(entry.z))
}

/// One zone ready to draw: its surfaces in ARKit coordinates plus where the layout places it.
struct BuildingZone: Identifiable {
    let record: ZoneRecord
    var placement: BuildingLayoutDocument.ZoneEntry
    var surfaces: [BakeSurface]
    var floorPolygons: [String: [SIMD2<Float>]]
    var colors: SurfaceColorDocument?
    var atlas: UIImage?
    /// ARKit y of the zone's walking surface.
    var ground: Float
    /// Bounds of the zone's surfaces in its own ARKit frame.
    var localBounds: FloorBounds?
    var loadIssue: String?

    var id: String { record.id }
    var name: String { record.name }
    var level: Int { placement.floor }

    var worldBounds: FloorBounds? {
        guard let localBounds else { return nil }
        let corners = [
            SIMD2(localBounds.minX, localBounds.minZ), SIMD2(localBounds.maxX, localBounds.minZ),
            SIMD2(localBounds.maxX, localBounds.maxZ), SIMD2(localBounds.minX, localBounds.maxZ),
        ].map { layoutToWorld(placement, $0) }
        return FloorBounds(points: corners)
    }
}

struct BuildingLevel: Identifiable, Hashable {
    let level: Int
    var name: String
    var zoneIDs: [String]
    var id: Int { level }
}

/// Everything the building screen draws.
struct BuildingMap {
    var building: OwnedBuilding
    var versionId: String?
    var layout: BuildingLayoutDocument
    var zones: [BuildingZone]

    var levels: [BuildingLevel] {
        let numbers = Set(zones.map(\.level)).union(layout.floors?.map(\.floor) ?? [])
        return numbers.sorted(by: >).map { level in
            BuildingLevel(level: level, name: levelName(level), zoneIDs: zones.filter { $0.level == level }.map(\.id))
        }
    }

    func levelName(_ level: Int) -> String {
        layout.floorName(level) ?? defaultLevelName(level)
    }

    func zone(_ id: String) -> BuildingZone? {
        zones.first { $0.id == id }
    }

    func bounds(level: Int) -> FloorBounds? {
        zones.filter { $0.level == level }.compactMap(\.worldBounds).reduce(nil) { partial, bounds in
            partial.map { $0.union(bounds) } ?? bounds
        }
    }

    var bounds: FloorBounds? {
        zones.compactMap(\.worldBounds).reduce(nil) { partial, bounds in partial.map { $0.union(bounds) } ?? bounds }
    }

    func applying(building: OwnedBuilding, layout: BuildingLayoutDocument) -> BuildingMap {
        var next = self
        next.building = building
        next.layout = layout
        next.zones = zones.map { zone in
            var copy = zone
            if let entry = layout.entry(for: zone.id) { copy.placement = entry }
            return copy
        }
        return next
    }
}

func normalizeDegrees(_ value: Double) -> Double {
    var degrees = value.truncatingRemainder(dividingBy: 360)
    if degrees <= -180 { degrees += 360 }
    if degrees > 180 { degrees -= 360 }
    return degrees
}

func defaultLevelName(_ level: Int) -> String {
    switch level {
    case 0: return "Ground floor"
    case ..<0: return "Basement \(-level)"
    default: return "Floor \(level)"
    }
}

/// What the next scan updates, chosen before the camera starts.
struct ZoneScanTarget: Identifiable, Hashable {
    enum Kind: Hashable {
        case existingZone
        case newZone
    }

    let kind: Kind
    let buildingID: String
    let buildingName: String
    /// The version new zones are added to; nil when the building has no published map yet.
    let versionID: String?
    let zoneID: String
    let zoneName: String
    /// Graph floor id written into building.json.
    let floorID: String
    let level: Int
    let levelName: String
    let isNewLevel: Bool
    /// The zone's current placement, kept when it is rescanned.
    let previousPlacement: BuildingLayoutDocument.ZoneEntry?
    /// World bounds of the zone being replaced, so its rescan lands in the same spot.
    let previousWorldBounds: FloorBounds?
    /// World bounds of the zones already on this level; a new zone is placed beside them.
    let levelBounds: FloorBounds?

    var id: String { buildingID + "/" + zoneID }
    var isNewZone: Bool { kind == .newZone }
}

extension BuildingLayoutDocument.ZoneEntry {
    /// Places a new zone just past the right edge of whatever is already on this floor.
    static func beside(levelBounds: FloorBounds?, zoneId: String, level: Int, gap: Float = 2) -> Self {
        let x = Double((levelBounds?.maxX ?? 0) + (levelBounds == nil ? 0 : gap))
        let z = Double(levelBounds?.center.y ?? 0)
        return Self(zoneId: zoneId, floor: level, x: x, z: z, rotationDegrees: 0)
    }
}

func floorIdentifier(level: Int, existing: String? = nil) -> String {
    if let existing, !existing.isEmpty { return existing }
    return level == 0 ? "ground" : "level-\(level)"
}

/// Column-major 4×4 from `scan-features.json`, matching RoomPlan's export.
func scanTransform(_ columns: [Float]) -> simd_float4x4? {
    guard columns.count == 16 else { return nil }
    return simd_float4x4(
        SIMD4(columns[0], columns[1], columns[2], columns[3]),
        SIMD4(columns[4], columns[5], columns[6], columns[7]),
        SIMD4(columns[8], columns[9], columns[10], columns[11]),
        SIMD4(columns[12], columns[13], columns[14], columns[15])
    )
}

/// Rotate about Y, then translate, matching `layoutToWorld`.
func placementMatrix(_ entry: BuildingLayoutDocument.ZoneEntry, ground: Float) -> simd_float4x4 {
    let radians = Float(entry.rotationDegrees) * .pi / 180
    let c = cos(radians), s = sin(radians)
    return simd_float4x4(
        SIMD4(c, 0, -s, 0),
        SIMD4(0, 1, 0, 0),
        SIMD4(s, 0, c, 0),
        SIMD4(Float(entry.x), Float(entry.floor) * buildingFloorGap - ground, Float(entry.z), 1)
    )
}

enum ZoneIdentifier {
    /// A Storage- and Firestore-safe id from a display name, unique among `existing`.
    static func make(from name: String, existing: Set<String>) -> String {
        var words: [String] = []
        var current = ""
        for scalar in name.lowercased().unicodeScalars {
            if scalar.isASCII, CharacterSet.alphanumerics.contains(scalar) {
                current.unicodeScalars.append(scalar)
            } else if !current.isEmpty {
                words.append(current)
                current = ""
            }
        }
        if !current.isEmpty { words.append(current) }
        let base = words.isEmpty ? "zone" : words.joined(separator: "-")
        var candidate = String(base.prefix(40))
        var suffix = 2
        while existing.contains(candidate) {
            candidate = String(base.prefix(36)) + "-\(suffix)"
            suffix += 1
        }
        return candidate
    }
}
