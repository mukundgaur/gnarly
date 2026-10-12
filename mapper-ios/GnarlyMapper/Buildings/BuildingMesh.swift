import SceneKit
import SwiftUI
import UIKit
import simd

enum SurfacePalette {
    static func color(for kind: BakeSurface.Kind) -> UIColor {
        switch kind {
        case .wall: return UIColor(red: 0.62, green: 0.70, blue: 0.78, alpha: 1)
        case .floor: return UIColor(red: 0.22, green: 0.26, blue: 0.30, alpha: 1)
        case .door: return UIColor(red: 0.95, green: 0.72, blue: 0.32, alpha: 1)
        case .window: return UIColor(red: 0.45, green: 0.78, blue: 0.95, alpha: 0.55)
        case .opening: return UIColor(red: 0.20, green: 0.90, blue: 0.78, alpha: 0.35)
        case .object: return UIColor(red: 0.55, green: 0.48, blue: 0.70, alpha: 1)
        }
    }
}

/// Builds SceneKit rooms from RoomPlan surfaces, optionally textured with the color-splat atlas.
enum BuildingMesh {
    static func node(
        surfaces: [BakeSurface],
        colors: SurfaceColorDocument? = nil,
        atlas: UIImage? = nil,
        highlighted: Bool = false,
        dimmed: Bool = false
    ) -> SCNNode {
        let root = SCNNode()
        let byID = Dictionary(uniqueKeysWithValues: (colors?.surfaces ?? []).map { ($0.identifier, $0) })
        for surface in surfaces where surface.kind != .opening {
            let child = mesh(surface, color: byID[surface.identifier], atlas: atlas)
            child.opacity = dimmed ? 0.22 : (surface.kind == .window ? 0.72 : 1)
            if highlighted {
                child.geometry?.firstMaterial?.emission.contents = UIColor(red: 0.15, green: 0.55, blue: 0.70, alpha: 1)
            }
            root.addChildNode(child)
        }
        return root
    }

    static func ground(of surfaces: [BakeSurface]) -> Float {
        surfaces.filter { $0.kind == .floor }.map { $0.transform.columns.3.y }.min() ?? 0
    }

    static func bounds(of surfaces: [BakeSurface]) -> FloorBounds? {
        var points: [SIMD2<Float>] = []
        for surface in surfaces {
            let t = surface.transform
            let half = simd_abs(surface.dimensions) / 2
            for u in [-half.x, half.x] {
                for v in [-half.z, half.z] {
                    let p = t * SIMD4<Float>(u, 0, v, 1)
                    points.append(SIMD2(p.x, p.z))
                }
            }
        }
        return FloorBounds(points: points)
    }

    private static func mesh(_ surface: BakeSurface, color: SurfaceColorDocument.Surface?, atlas: UIImage?) -> SCNNode {
        let node = SCNNode()
        node.simdTransform = surface.transform
        let d = simd_abs(surface.dimensions)
        let faces = color?.faces ?? []
        if surface.kind == .object {
            for (name, offset, u, v, w, h) in objectFaces(d) {
                node.addChildNode(quad(offset: offset, u: u, v: v, width: w, height: h, face: faces.first { $0.face == name }, atlas: atlas, fallback: SurfacePalette.color(for: .object)))
            }
        } else {
            node.addChildNode(quad(offset: .zero, u: SIMD3(1, 0, 0), v: SIMD3(0, 1, 0), width: d.x, height: d.y, face: faces.first { $0.face == "pz" }, atlas: atlas, fallback: SurfacePalette.color(for: surface.kind)))
            node.addChildNode(quad(offset: .zero, u: SIMD3(-1, 0, 0), v: SIMD3(0, 1, 0), width: d.x, height: d.y, face: faces.first { $0.face == "nz" }, atlas: atlas, fallback: SurfacePalette.color(for: surface.kind)))
        }
        return node
    }

    private static func objectFaces(_ d: SIMD3<Float>) -> [(String, SIMD3<Float>, SIMD3<Float>, SIMD3<Float>, Float, Float)] {
        [
            ("px", SIMD3(d.x / 2, 0, 0), SIMD3(0, 0, -1), SIMD3(0, 1, 0), d.z, d.y),
            ("nx", SIMD3(-d.x / 2, 0, 0), SIMD3(0, 0, 1), SIMD3(0, 1, 0), d.z, d.y),
            ("py", SIMD3(0, d.y / 2, 0), SIMD3(1, 0, 0), SIMD3(0, 0, -1), d.x, d.z),
            ("pz", SIMD3(0, 0, d.z / 2), SIMD3(1, 0, 0), SIMD3(0, 1, 0), d.x, d.y),
            ("nz", SIMD3(0, 0, -d.z / 2), SIMD3(-1, 0, 0), SIMD3(0, 1, 0), d.x, d.y),
        ]
    }

    private static func quad(offset: SIMD3<Float>, u: SIMD3<Float>, v: SIMD3<Float>, width: Float, height: Float, face: SurfaceColorDocument.Face?, atlas: UIImage?, fallback: UIColor) -> SCNNode {
        let hu = u * (width / 2), hv = v * (height / 2)
        let corners = [offset - hu - hv, offset + hu - hv, offset + hu + hv, offset - hu + hv]
        let positions: [SCNVector3] = corners.map { SCNVector3($0.x, $0.y, $0.z) }
        let n = simd_normalize(simd_cross(u, v))
        let normals = [SCNVector3](repeating: SCNVector3(n.x, n.y, n.z), count: 4)
        var uvs = [CGPoint(x: 0, y: 1), CGPoint(x: 1, y: 1), CGPoint(x: 1, y: 0), CGPoint(x: 0, y: 0)]
        if let rect = face?.rect, let atlas, atlas.size.width > 0, rect.count == 4 {
            let w = atlas.size.width, h = atlas.size.height
            let x = CGFloat(rect[0]) / w, y = CGFloat(rect[1]) / h
            let rw = CGFloat(rect[2]) / w, rh = CGFloat(rect[3]) / h
            uvs = [CGPoint(x: x, y: y + rh), CGPoint(x: x + rw, y: y + rh), CGPoint(x: x + rw, y: y), CGPoint(x: x, y: y)]
        }
        let indices: [Int32] = [0, 1, 2, 0, 2, 3]
        let sources = [
            SCNGeometrySource(vertices: positions),
            SCNGeometrySource(normals: normals),
            SCNGeometrySource(textureCoordinates: uvs),
        ]
        let element = SCNGeometryElement(indices: indices, primitiveType: .triangles)
        let geometry = SCNGeometry(sources: sources, elements: [element])
        let material = SCNMaterial()
        material.lightingModel = .physicallyBased
        material.roughness.contents = 0.72
        material.metalness.contents = 0.04
        if let atlas, face?.rect != nil {
            material.diffuse.contents = atlas
            material.diffuse.wrapS = .clamp
            material.diffuse.wrapT = .clamp
        } else if let average = face?.color, average.count == 3 {
            material.diffuse.contents = UIColor(red: CGFloat(average[0]), green: CGFloat(average[1]), blue: CGFloat(average[2]), alpha: 1)
        } else {
            material.diffuse.contents = fallback
        }
        material.isDoubleSided = true
        geometry.materials = [material]
        return SCNNode(geometry: geometry)
    }
}

final class BuildingSceneController: ObservableObject {
    let scene = SCNScene()
    private let root = SCNNode()
    private let cameraNode = SCNNode()

    init() {
        scene.background.contents = UIColor(red: 0.04, green: 0.06, blue: 0.09, alpha: 1)
        scene.rootNode.addChildNode(root)
        let camera = SCNCamera()
        camera.zFar = 400
        camera.fieldOfView = 42
        camera.wantsHDR = true
        cameraNode.camera = camera
        scene.rootNode.addChildNode(cameraNode)
        let sun = SCNNode()
        sun.light = SCNLight()
        sun.light?.type = .directional
        sun.light?.intensity = 900
        sun.eulerAngles = SCNVector3(-0.7, 0.6, 0)
        scene.rootNode.addChildNode(sun)
        let ambient = SCNNode()
        ambient.light = SCNLight()
        ambient.light?.type = .ambient
        ambient.light?.intensity = 280
        scene.rootNode.addChildNode(ambient)
    }

    func show(map: BuildingMap, highlight zoneID: String?, satellite: UIImage?) {
        root.childNodes.forEach { $0.removeFromParentNode() }
        if let satellite, let bounds = map.bounds {
            root.addChildNode(satellitePlane(image: satellite, bounds: bounds, heading: map.building.mapHeadingDegrees))
        }
        for zone in map.zones {
            let node = BuildingMesh.node(
                surfaces: zone.surfaces,
                colors: zone.colors,
                atlas: zone.atlas,
                highlighted: zone.id == zoneID,
                dimmed: zoneID != nil && zone.id != zoneID
            )
            node.simdTransform = placementMatrix(zone.placement, ground: zone.ground)
            node.name = zone.id
            root.addChildNode(node)
        }
        frame(highlight: zoneID.flatMap { map.zone($0) } ?? map.zones.first)
    }

    func showPreview(surfaces: [BakeSurface], colors: SurfaceColorDocument?, atlas: UIImage?) {
        root.childNodes.forEach { $0.removeFromParentNode() }
        let node = BuildingMesh.node(surfaces: surfaces, colors: colors, atlas: atlas)
        root.addChildNode(node)
        frame(surfaces: surfaces)
    }

    private func satellitePlane(image: UIImage, bounds: FloorBounds, heading: Double) -> SCNNode {
        let width = CGFloat(max(bounds.width, 8) + 24)
        let depth = CGFloat(max(bounds.depth, 8) + 24)
        let plane = SCNPlane(width: width, height: depth)
        plane.firstMaterial?.diffuse.contents = image
        plane.firstMaterial?.isDoubleSided = true
        plane.firstMaterial?.lightingModel = .constant
        let node = SCNNode(geometry: plane)
        node.eulerAngles.x = -.pi / 2
        node.eulerAngles.y = Float(-heading * .pi / 180)
        node.position = SCNVector3(bounds.center.x, -0.05, bounds.center.y)
        return node
    }

    private func frame(highlight zone: BuildingZone?) {
        let bounds = zone?.worldBounds ?? zone?.localBounds
        frame(center: bounds.map { SIMD3($0.center.x, Float(zone?.level ?? 0) * buildingFloorGap + 1.4, $0.center.y) } ?? SIMD3(0, 2, 0), radius: max(bounds?.width ?? 12, bounds?.depth ?? 12))
    }

    private func frame(surfaces: [BakeSurface]) {
        let points = surfaces.map { SIMD3<Float>($0.transform.columns.3.x, $0.transform.columns.3.y, $0.transform.columns.3.z) }
        let center = points.reduce(SIMD3<Float>(repeating: 0), +) / Float(max(points.count, 1))
        frame(center: center, radius: 10)
    }

    private func frame(center: SIMD3<Float>, radius: Float) {
        let distance = max(8, radius * 1.6)
        cameraNode.simdPosition = center + SIMD3(distance * 0.85, distance * 0.7, distance)
        cameraNode.look(at: SCNVector3(center.x, center.y, center.z))
    }
}

struct BuildingSceneView: UIViewRepresentable {
    @ObservedObject var controller: BuildingSceneController

    func makeUIView(context: Context) -> SCNView {
        let view = SCNView()
        view.scene = controller.scene
        view.allowsCameraControl = true
        view.antialiasingMode = .multisampling4X
        view.backgroundColor = .clear
        view.autoenablesDefaultLighting = false
        return view
    }

    func updateUIView(_ uiView: SCNView, context: Context) {
        uiView.scene = controller.scene
    }
}
