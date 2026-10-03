import Foundation
import RoomPlan
import simd

enum RoomPlanScanExtractor {
    static func features(from room: CapturedRoom, zoneID: String, capturedAt: String) -> ScanFeatures {
        ScanFeatures(
            schemaVersion: 1,
            zoneID: zoneID,
            coordinateSystem: "arkit-world-meters",
            capturedAt: capturedAt,
            roomIdentifier: room.identifier.uuidString,
            story: room.story,
            walls: room.walls.map(surfaceFeature),
            doors: room.doors.map(surfaceFeature),
            openings: room.openings.map(surfaceFeature),
            windows: room.windows.map(surfaceFeature),
            floors: room.floors.map(surfaceFeature),
            objects: room.objects.map(objectFeature),
            sections: room.sections.map { section in
                ScanFeatureSection(
                    label: section.label.rawValue,
                    story: section.story,
                    center: [section.center.x, section.center.y, section.center.z]
                )
            },
            notes: "Normalized RoomPlan surfaces and objects in the shared ARKit world. Use this file for graph work; scan.json is the raw CapturedRoom dump."
        )
    }

    private static func surfaceFeature(_ surface: CapturedRoom.Surface) -> ScanFeatureSurface {
        ScanFeatureSurface(
            identifier: surface.identifier.uuidString,
            category: surfaceCategoryName(surface.category),
            confidence: confidenceName(surface.confidence),
            story: surface.story,
            dimensions: vector3(surface.dimensions),
            position: translation(surface.transform),
            transformColumnMajor: columnMajor(surface.transform),
            polygonCorners: surface.polygonCorners.map(vector3),
            parentIdentifier: surface.parentIdentifier?.uuidString
        )
    }

    private static func objectFeature(_ object: CapturedRoom.Object) -> ScanFeatureObject {
        ScanFeatureObject(
            identifier: object.identifier.uuidString,
            category: objectCategoryName(object.category),
            confidence: confidenceName(object.confidence),
            story: object.story,
            dimensions: vector3(object.dimensions),
            position: translation(object.transform),
            transformColumnMajor: columnMajor(object.transform),
            parentIdentifier: object.parentIdentifier?.uuidString
        )
    }

    static func surfaceCategoryName(_ category: CapturedRoom.Surface.Category) -> String {
        switch category {
        case .wall: return "wall"
        case .opening: return "opening"
        case .window: return "window"
        case .door(let isOpen): return isOpen ? "door-open" : "door-closed"
        case .floor: return "floor"
        @unknown default: return "unknown"
        }
    }

    static func objectCategoryName(_ category: CapturedRoom.Object.Category) -> String {
        switch category {
        case .storage: return "storage"
        case .refrigerator: return "refrigerator"
        case .stove: return "stove"
        case .bed: return "bed"
        case .sink: return "sink"
        case .washerDryer: return "washerDryer"
        case .toilet: return "toilet"
        case .bathtub: return "bathtub"
        case .oven: return "oven"
        case .dishwasher: return "dishwasher"
        case .table: return "table"
        case .sofa: return "sofa"
        case .chair: return "chair"
        case .fireplace: return "fireplace"
        case .television: return "television"
        case .stairs: return "stairs"
        @unknown default: return "unknown"
        }
    }

    private static func confidenceName(_ confidence: CapturedRoom.Confidence) -> String {
        switch confidence {
        case .high: return "high"
        case .medium: return "medium"
        case .low: return "low"
        @unknown default: return "unknown"
        }
    }

    private static func translation(_ transform: simd_float4x4) -> [Float] {
        let column = transform.columns.3
        return [column.x, column.y, column.z]
    }

    private static func columnMajor(_ transform: simd_float4x4) -> [Float] {
        [
            transform.columns.0.x, transform.columns.0.y, transform.columns.0.z, transform.columns.0.w,
            transform.columns.1.x, transform.columns.1.y, transform.columns.1.z, transform.columns.1.w,
            transform.columns.2.x, transform.columns.2.y, transform.columns.2.z, transform.columns.2.w,
            transform.columns.3.x, transform.columns.3.y, transform.columns.3.z, transform.columns.3.w
        ]
    }

    private static func vector3(_ value: simd_float3) -> [Float] {
        [value.x, value.y, value.z]
    }
}
