import SceneKit
import SwiftUI
import UIKit
import simd

enum SurfacePalette {
    static func color(for kind: BakeSurface.Kind) -> UIColor {
        switch kind {
        case .wall: return UIColor(red: 0.78, green: 0.81, blue: 0.84, alpha: 1)
        case .floor: return UIColor(red: 0.30, green: 0.34, blue: 0.38, alpha: 1)
        case .door: return UIColor(red: 0.72, green: 0.55, blue: 0.36, alpha: 1)
        case .window: return UIColor(red: 0.62, green: 0.82, blue: 0.90, alpha: 1)
        case .opening: return UIColor(red: 0.20, green: 0.90, blue: 0.78, alpha: 1)
        case .object: return UIColor(red: 0.55, green: 0.50, blue: 0.62, alpha: 1)
        case .stairs: return UIColor(red: 0.79, green: 0.64, blue: 0.42, alpha: 1)
        }
    }
}

/// Rectangles cut out of a wall, in the wall's local X/Y plane (meters, origin at the wall center).
enum WallLayout {
    struct Cutout: Equatable {
        var minX: Float
        var maxX: Float
        var minY: Float
        var maxY: Float
    }

    struct Panel: Equatable {
        var minX: Float
        var maxX: Float
        var minY: Float
        var maxY: Float

        var centerX: Float { (minX + maxX) / 2 }
        var centerY: Float { (minY + maxY) / 2 }
        var width: Float { maxX - minX }
        var height: Float { maxY - minY }
    }

    /// Solid pieces of a wall after doors, windows, and openings are removed.
    static func panels(width: Float, height: Float, cutouts: [Cutout]) -> [Panel] {
        let halfW = width / 2
        let halfH = height / 2
        let holes = clipped(cutouts, halfW: halfW, halfH: halfH)
        guard !holes.isEmpty else {
            return [Panel(minX: -halfW, maxX: halfW, minY: -halfH, maxY: halfH)]
        }
        var xs = [-halfW, halfW]
        var ys = [-halfH, halfH]
        for hole in holes {
            xs.append(contentsOf: [hole.minX, hole.maxX])
            ys.append(contentsOf: [hole.minY, hole.maxY])
        }
        xs = merged(xs)
        ys = merged(ys)
        var panels: [Panel] = []
        for x in 0 ..< xs.count - 1 {
            for y in 0 ..< ys.count - 1 {
                let minX = xs[x], maxX = xs[x + 1]
                let minY = ys[y], maxY = ys[y + 1]
                guard maxX - minX > 0.008, maxY - minY > 0.008 else { continue }
                let cx = (minX + maxX) / 2
                let cy = (minY + maxY) / 2
                if holes.contains(where: { cx > $0.minX && cx < $0.maxX && cy > $0.minY && cy < $0.maxY }) { continue }
                panels.append(Panel(minX: minX, maxX: maxX, minY: minY, maxY: maxY))
            }
        }
        return panels.isEmpty ? [Panel(minX: -halfW, maxX: halfW, minY: -halfH, maxY: halfH)] : panels
    }

    static func clipped(_ cutouts: [Cutout], halfW: Float, halfH: Float) -> [Cutout] {
        cutouts.compactMap { cut in
            let minX = max(-halfW, cut.minX)
            let maxX = min(halfW, cut.maxX)
            let minY = max(-halfH, cut.minY)
            let maxY = min(halfH, cut.maxY)
            guard maxX - minX > 0.01, maxY - minY > 0.01 else { return nil }
            return Cutout(minX: minX, maxX: maxX, minY: minY, maxY: maxY)
        }
    }

    private static func merged(_ values: [Float]) -> [Float] {
        var result: [Float] = []
        for value in values.sorted() {
            if let last = result.last, abs(value - last) < 0.004 { continue }
            result.append(value)
        }
        return result
    }
}

/// Builds SceneKit rooms from RoomPlan surfaces, optionally textured with the color-splat atlas.
enum BuildingMesh {
    /// Photo textures only replace a face when most of it was actually seen. Otherwise the face stays one solid color.
    private static let atlasCoverage: Float = 0.42

    static func node(
        surfaces: [BakeSurface],
        colors: SurfaceColorDocument? = nil,
        atlas: UIImage? = nil,
        highlighted: Bool = false,
        dimmed: Bool = false
    ) -> SCNNode {
        let root = SCNNode()
        let byID = Dictionary(uniqueKeysWithValues: (colors?.surfaces ?? []).map { ($0.identifier, $0) })
        let portals = surfaces.filter { $0.kind == .door || $0.kind == .window || $0.kind == .opening }
        for surface in surfaces {
            switch surface.kind {
            case .opening:
                continue
            case .wall:
                let holes = portals.compactMap { cutout(wall: surface, portal: $0) }
                root.addChildNode(wallNode(surface, holes: holes, colors: byID[surface.identifier], atlas: atlas))
            case .door:
                if surface.isPassable { continue }
                root.addChildNode(slabNode(surface, colors: byID[surface.identifier], atlas: atlas, depth: max(abs(surface.dimensions.z), 0.04)))
            case .window:
                let window = slabNode(surface, colors: byID[surface.identifier], atlas: atlas, depth: max(abs(surface.dimensions.z), 0.02), transparency: 0.55)
                root.addChildNode(window)
            case .floor:
                root.addChildNode(slabNode(surface, colors: byID[surface.identifier], atlas: atlas, depth: max(abs(surface.dimensions.z), 0.05)))
            case .object:
                root.addChildNode(objectNode(surface, colors: byID[surface.identifier], atlas: atlas))
            case .stairs:
                root.addChildNode(stairNode(surface, colors: byID[surface.identifier], atlas: atlas))
            }
        }
        root.opacity = dimmed ? 0.3 : 1
        if highlighted {
            root.enumerateChildNodes { child, _ in
                child.geometry?.materials.forEach {
                    $0.emission.contents = UIColor(red: 0.10, green: 0.45, blue: 0.62, alpha: 1)
                    $0.emission.intensity = 0.4
                }
            }
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

    // MARK: - Walls

    private static func cutout(wall: BakeSurface, portal: BakeSurface) -> WallLayout.Cutout? {
        if let parent = portal.parentIdentifier, parent != wall.identifier { return nil }
        let toWall = simd_inverse(wall.transform) * portal.transform
        let onThisWall = portal.parentIdentifier == wall.identifier || abs(toWall.columns.3.z) < 0.4
        guard onThisWall, abs(toWall.columns.3.z) < max(0.45, abs(wall.dimensions.z) * 3) else { return nil }
        let half = simd_abs(portal.dimensions) / 2
        let corners = [
            SIMD3<Float>(-half.x, -half.y, 0), SIMD3(half.x, -half.y, 0),
            SIMD3(half.x, half.y, 0), SIMD3(-half.x, half.y, 0),
        ].map { toWall * SIMD4($0, 1) }
        let xs = corners.map(\.x)
        let ys = corners.map(\.y)
        guard let minX = xs.min(), let maxX = xs.max(), let minY = ys.min(), let maxY = ys.max() else { return nil }
        return WallLayout.Cutout(minX: minX, maxX: maxX, minY: minY, maxY: maxY)
    }

    private static func wallNode(_ wall: BakeSurface, holes: [WallLayout.Cutout], colors: SurfaceColorDocument.Surface?, atlas: UIImage?) -> SCNNode {
        let node = SCNNode()
        node.simdTransform = wall.transform
        let d = simd_abs(wall.dimensions)
        let depth = max(d.z, 0.12)
        let halfW = d.x / 2
        let halfH = d.y / 2
        let clipped = WallLayout.clipped(holes, halfW: halfW, halfH: halfH)
        let panels = WallLayout.panels(width: d.x, height: d.y, cutouts: clipped)
        let front = colors?.faces.first { $0.face == "pz" }
        let back = colors?.faces.first { $0.face == "nz" }
        let frontColor = uiColor(front, fallback: SurfacePalette.color(for: .wall))
        let edge = shade(uiColor(front ?? back, fallback: frontColor), 0.8)
        for panel in panels {
            node.addChildNode(faceQuad(
                center: SIMD3(panel.centerX, panel.centerY, depth / 2),
                axisU: SIMD3(1, 0, 0), axisV: SIMD3(0, 1, 0),
                width: panel.width, height: panel.height,
                faceName: "pz", faceSize: SIMD2(d.x, d.y),
                face: front, atlas: atlas, fallback: frontColor
            ))
            node.addChildNode(faceQuad(
                center: SIMD3(panel.centerX, panel.centerY, -depth / 2),
                axisU: SIMD3(-1, 0, 0), axisV: SIMD3(0, 1, 0),
                width: panel.width, height: panel.height,
                faceName: "nz", faceSize: SIMD2(d.x, d.y),
                face: back, atlas: atlas, fallback: uiColor(back, fallback: frontColor)
            ))
        }
        addRim(to: node, minX: -halfW, maxX: halfW, minY: -halfH, maxY: halfH, depth: depth, color: edge, holes: clipped, outward: true)
        for hole in clipped {
            addRim(to: node, minX: hole.minX, maxX: hole.maxX, minY: hole.minY, maxY: hole.maxY, depth: depth, color: edge, holes: [], outward: false, skipOuter: (halfW, halfH))
        }
        return node
    }

    /// Thickness around a rectangle. Hole edges that land on the wall boundary are left open.
    private static func addRim(
        to node: SCNNode,
        minX: Float, maxX: Float, minY: Float, maxY: Float,
        depth: Float, color: UIColor,
        holes: [WallLayout.Cutout],
        outward: Bool,
        skipOuter: (Float, Float)? = nil
    ) {
        let flush: Float = 0.02
        func blockedX(at yEdge: Float, side: Float) -> [(Float, Float)] {
            holes.compactMap { hole in
                let touches = side < 0 ? hole.minY <= yEdge + flush : hole.maxY >= yEdge - flush
                return touches ? (hole.minX, hole.maxX) : nil
            }
        }
        func blockedY(at xEdge: Float, side: Float) -> [(Float, Float)] {
            holes.compactMap { hole in
                let touches = side < 0 ? hole.minX <= xEdge + flush : hole.maxX >= xEdge - flush
                return touches ? (hole.minY, hole.maxY) : nil
            }
        }
        let skipBottom = skipOuter.map { minY <= -$0.1 + flush } ?? false
        let skipTop = skipOuter.map { maxY >= $0.1 - flush } ?? false
        let skipLeft = skipOuter.map { minX <= -$0.0 + flush } ?? false
        let skipRight = skipOuter.map { maxX >= $0.0 - flush } ?? false
        if !skipBottom {
            for span in gaps(fullMin: minX, fullMax: maxX, blocked: blockedX(at: minY, side: -1)) {
                node.addChildNode(rimQuad(SIMD3(span.0, minY, 0), SIMD3(span.1, minY, 0), depth: depth, axis: SIMD3(0, outward ? -1 : 1, 0), color: color))
            }
        }
        if !skipTop {
            for span in gaps(fullMin: minX, fullMax: maxX, blocked: blockedX(at: maxY, side: 1)) {
                node.addChildNode(rimQuad(SIMD3(span.0, maxY, 0), SIMD3(span.1, maxY, 0), depth: depth, axis: SIMD3(0, outward ? 1 : -1, 0), color: color))
            }
        }
        if !skipLeft {
            for span in gaps(fullMin: minY, fullMax: maxY, blocked: blockedY(at: minX, side: -1)) {
                node.addChildNode(rimQuad(SIMD3(minX, span.0, 0), SIMD3(minX, span.1, 0), depth: depth, axis: SIMD3(outward ? -1 : 1, 0, 0), color: color))
            }
        }
        if !skipRight {
            for span in gaps(fullMin: minY, fullMax: maxY, blocked: blockedY(at: maxX, side: 1)) {
                node.addChildNode(rimQuad(SIMD3(maxX, span.0, 0), SIMD3(maxX, span.1, 0), depth: depth, axis: SIMD3(outward ? 1 : -1, 0, 0), color: color))
            }
        }
    }

    private static func gaps(fullMin: Float, fullMax: Float, blocked: [(Float, Float)]) -> [(Float, Float)] {
        var cursor = fullMin
        var result: [(Float, Float)] = []
        for block in blocked.map({ (min($0.0, $0.1), max($0.0, $0.1)) }).sorted(by: { $0.0 < $1.0 }) {
            let start = max(fullMin, block.0)
            let end = min(fullMax, block.1)
            if start > cursor + 0.01 { result.append((cursor, start)) }
            cursor = max(cursor, end)
            if cursor >= fullMax { return result }
        }
        if fullMax > cursor + 0.01 { result.append((cursor, fullMax)) }
        return result
    }

    /// A strip of wall thickness. `along` is the edge; `axis` is the outward normal in the wall plane.
    private static func rimQuad(_ start: SIMD3<Float>, _ end: SIMD3<Float>, depth: Float, axis: SIMD3<Float>, color: UIColor) -> SCNNode {
        let z = depth / 2
        let a = SIMD3(start.x, start.y, -z)
        let b = SIMD3(end.x, end.y, -z)
        let c = SIMD3(end.x, end.y, z)
        let d = SIMD3(start.x, start.y, z)
        let normal = simd_normalize(axis)
        // Wind so the geometric normal matches `axis` (cross of the first edge with the depth edge).
        let corners = simd_dot(simd_cross(b - a, c - b), normal) > 0 ? [a, b, c, d] : [a, d, c, b]
        return quad(corners: corners, uvs: [.zero, .zero, .zero, .zero], material: solidMaterial(color))
    }

    // MARK: - Other surfaces

    private static func slabNode(_ surface: BakeSurface, colors: SurfaceColorDocument.Surface?, atlas: UIImage?, depth: Float, transparency: CGFloat = 1) -> SCNNode {
        let node = SCNNode()
        node.simdTransform = surface.transform
        let d = simd_abs(surface.dimensions)
        let kindColor = SurfacePalette.color(for: surface.kind)
        let front = colors?.faces.first { $0.face == "pz" }
        let back = colors?.faces.first { $0.face == "nz" }
        let frontColor = uiColor(front, fallback: kindColor)
        let edge = shade(frontColor, 0.82)
        node.addChildNode(faceQuad(
            center: SIMD3(0, 0, depth / 2), axisU: SIMD3(1, 0, 0), axisV: SIMD3(0, 1, 0),
            width: d.x, height: d.y, faceName: "pz", faceSize: SIMD2(d.x, d.y),
            face: front, atlas: atlas, fallback: frontColor, transparency: transparency
        ))
        node.addChildNode(faceQuad(
            center: SIMD3(0, 0, -depth / 2), axisU: SIMD3(-1, 0, 0), axisV: SIMD3(0, 1, 0),
            width: d.x, height: d.y, faceName: "nz", faceSize: SIMD2(d.x, d.y),
            face: back, atlas: atlas, fallback: uiColor(back, fallback: frontColor), transparency: transparency
        ))
        addRim(to: node, minX: -d.x / 2, maxX: d.x / 2, minY: -d.y / 2, maxY: d.y / 2, depth: depth, color: edge, holes: [], outward: true)
        return node
    }

    /// Treads and risers take the photo splat. The other faces of each one-riser block stay a solid color.
    private static func stairNode(_ surface: BakeSurface, colors: SurfaceColorDocument.Surface?, atlas: UIImage?) -> SCNNode {
        let node = SCNNode()
        node.name = surface.identifier
        node.simdTransform = surface.transform
        let treadFallback = SurfacePalette.color(for: .stairs)
        let riserFallback = shade(treadFallback, 0.72)
        let side = solidMaterial(shade(treadFallback, 0.88))
        for face in StairSteps.faces(dimensions: surface.dimensions) {
            let baked = colors?.faces.first { $0.face == face.name }
            let fallback = face.name.hasPrefix("riser") ? riserFallback : treadFallback
            node.addChildNode(faceQuad(
                center: face.center,
                axisU: face.axisU,
                axisV: face.axisV,
                width: face.width,
                height: face.height,
                faceName: face.name,
                faceSize: SIMD2(face.width, face.height),
                face: baked,
                atlas: atlas,
                fallback: uiColor(baked, fallback: fallback),
                fullFace: true
            ))
        }
        for step in StairSteps.boxes(dimensions: surface.dimensions) {
            addStepShell(to: node, step: step, material: side)
        }
        return node
    }

    /// Sides, back, and underside of one step. The tread and riser are drawn separately so they can carry the splat.
    private static func addStepShell(to node: SCNNode, step: StairStepBox, material: SCNMaterial) {
        let c = step.center
        let s = step.size
        func panel(_ center: SIMD3<Float>, _ u: SIMD3<Float>, _ v: SIMD3<Float>, _ width: Float, _ height: Float) {
            node.addChildNode(quad(
                corners: [
                    center - u * (width / 2) - v * (height / 2),
                    center + u * (width / 2) - v * (height / 2),
                    center + u * (width / 2) + v * (height / 2),
                    center - u * (width / 2) + v * (height / 2),
                ],
                uvs: [.zero, .zero, .zero, .zero],
                material: material
            ))
        }
        panel(c + SIMD3(-s.x / 2, 0, 0), SIMD3(0, 0, 1), SIMD3(0, 1, 0), s.z, s.y)
        panel(c + SIMD3(s.x / 2, 0, 0), SIMD3(0, 0, -1), SIMD3(0, 1, 0), s.z, s.y)
        panel(c + SIMD3(0, 0, -s.z / 2), SIMD3(-1, 0, 0), SIMD3(0, 1, 0), s.x, s.y)
        panel(c + SIMD3(0, -s.y / 2, 0), SIMD3(1, 0, 0), SIMD3(0, 0, 1), s.x, s.z)
    }

    private static func objectNode(_ surface: BakeSurface, colors: SurfaceColorDocument.Surface?, atlas: UIImage?) -> SCNNode {
        let node = SCNNode()
        node.simdTransform = surface.transform
        let d = simd_abs(surface.dimensions)
        let fallback = uiColor(nil, fallback: SurfacePalette.color(for: .object))
        for (name, offset, u, v, w, h) in objectFaces(d) {
            let face = colors?.faces.first { $0.face == name }
            node.addChildNode(faceQuad(
                center: offset, axisU: u, axisV: v, width: w, height: h,
                faceName: name, faceSize: SIMD2(w, h),
                face: face, atlas: atlas,
                fallback: uiColor(face, fallback: fallback),
                fullFace: true
            ))
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
            ("ny", SIMD3(0, -d.y / 2, 0), SIMD3(1, 0, 0), SIMD3(0, 0, 1), d.x, d.z),
        ]
    }

    // MARK: - Geometry

    private static func faceQuad(
        center: SIMD3<Float>,
        axisU: SIMD3<Float>,
        axisV: SIMD3<Float>,
        width: Float,
        height: Float,
        faceName: String,
        faceSize: SIMD2<Float>,
        face: SurfaceColorDocument.Face?,
        atlas: UIImage?,
        fallback: UIColor,
        transparency: CGFloat = 1,
        fullFace: Bool = false
    ) -> SCNNode {
        let hu = axisU * (width / 2)
        let hv = axisV * (height / 2)
        let corners = [center - hu - hv, center + hu - hv, center + hu + hv, center - hu + hv]
        let textured = usesAtlas(face, atlas: atlas)
        let uvs: [CGPoint] = corners.enumerated().map { index, corner in
            guard textured, let face, let rect = face.rect, let atlas else { return .zero }
            let baker: SIMD2<Float>
            if fullFace {
                let u: Float = index == 0 || index == 3 ? 0 : 1
                let v: Float = index >= 2 ? 1 : 0
                baker = SIMD2(u, v)
            } else {
                baker = bakerUV(localX: corner.x, localY: corner.y, face: faceName, size: faceSize)
            }
            return atlasPoint(baker, rect: rect, atlas: atlas)
        }
        let material = textured ? textureMaterial(atlas!, transparency: transparency) : solidMaterial(fallback, transparency: transparency)
        return quad(corners: corners, uvs: uvs, material: material)
    }

    /// Baker face UV. Planar pz/nz use the surface's local X/Y; object faces pass `fullFace` instead.
    private static func bakerUV(localX: Float, localY: Float, face: String, size: SIMD2<Float>) -> SIMD2<Float> {
        let u: Float
        if face == "nz" || face == "nx" {
            u = 0.5 - localX / max(size.x, 0.001)
        } else {
            u = localX / max(size.x, 0.001) + 0.5
        }
        let v = localY / max(size.y, 0.001) + 0.5
        return SIMD2(min(1, max(0, u)), min(1, max(0, v)))
    }

    private static func atlasPoint(_ uv: SIMD2<Float>, rect: [Int], atlas: UIImage) -> CGPoint {
        let insetU = 0.5 / Float(max(rect[2], 1))
        let insetV = 0.5 / Float(max(rect[3], 1))
        let u = min(1 - insetU, max(insetU, uv.x))
        let v = min(1 - insetV, max(insetV, uv.y))
        let w = atlas.size.width
        let h = atlas.size.height
        let x = CGFloat(rect[0]) / w
        let y = CGFloat(rect[1]) / h
        let rw = CGFloat(rect[2]) / w
        let rh = CGFloat(rect[3]) / h
        return CGPoint(x: x + CGFloat(u) * rw, y: y + (1 - CGFloat(v)) * rh)
    }

    private static func usesAtlas(_ face: SurfaceColorDocument.Face?, atlas: UIImage?) -> Bool {
        guard let atlas, atlas.size.width > 1, atlas.size.height > 1,
              let face, face.coverage >= atlasCoverage,
              let rect = face.rect, rect.count == 4, rect[2] > 1, rect[3] > 1 else { return false }
        return true
    }

    private static func quad(corners: [SIMD3<Float>], uvs: [CGPoint], material: SCNMaterial) -> SCNNode {
        let positions = corners.map { SCNVector3($0.x, $0.y, $0.z) }
        let n = simd_normalize(simd_cross(corners[1] - corners[0], corners[2] - corners[0]))
        let normals = [SCNVector3](repeating: SCNVector3(n.x, n.y, n.z), count: 4)
        let sources = [
            SCNGeometrySource(vertices: positions),
            SCNGeometrySource(normals: normals),
            SCNGeometrySource(textureCoordinates: uvs),
        ]
        let element = SCNGeometryElement(indices: [Int32](arrayLiteral: 0, 1, 2, 0, 2, 3), primitiveType: .triangles)
        let geometry = SCNGeometry(sources: sources, elements: [element])
        geometry.materials = [material]
        return SCNNode(geometry: geometry)
    }

    private static func solidMaterial(_ color: UIColor, transparency: CGFloat = 1) -> SCNMaterial {
        let material = SCNMaterial()
        material.lightingModel = .constant
        material.diffuse.contents = color
        material.isDoubleSided = false
        material.transparency = transparency
        return material
    }

    private static func textureMaterial(_ atlas: UIImage, transparency: CGFloat) -> SCNMaterial {
        let material = SCNMaterial()
        material.lightingModel = .constant
        material.diffuse.contents = atlas
        material.diffuse.wrapS = .clamp
        material.diffuse.wrapT = .clamp
        material.diffuse.mipFilter = .linear
        material.diffuse.minificationFilter = .linear
        material.diffuse.magnificationFilter = .linear
        material.isDoubleSided = false
        material.transparency = transparency
        return material
    }

    private static func uiColor(_ face: SurfaceColorDocument.Face?, fallback: UIColor) -> UIColor {
        guard let color = face?.color, color.count >= 3 else { return fallback }
        return UIColor(red: CGFloat(color[0]), green: CGFloat(color[1]), blue: CGFloat(color[2]), alpha: 1)
    }

    private static func shade(_ color: UIColor, _ factor: CGFloat) -> UIColor {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        guard color.getRed(&r, green: &g, blue: &b, alpha: &a) else { return color }
        return UIColor(red: r * factor, green: g * factor, blue: b * factor, alpha: a)
    }
}

/// Box the walk camera is allowed to occupy. The floor keeps the eye off the satellite plane.
struct PreviewLimits: Equatable {
    var minimum: SIMD3<Float>
    var maximum: SIMD3<Float>
    var groundY: Float
    var eyeClearance: Float

    static let clearance: Float = 0.45
}

/// Where the preview camera is, and which way it looks. The camera looks down its local -Z axis.
struct PreviewRig: Equatable {
    static let verticalFovDegrees: Float = 58
    static let maxPitch: Float = 1.15
    static let minPitch: Float = -1.05
    /// Three-quarter establishing view, a little above the model.
    static let homeDirection = simd_normalize(SIMD3<Float>(0.72, 0.42, 1))

    var eye: SIMD3<Float>
    var yaw: Float
    var pitch: Float

    var forward: SIMD3<Float> {
        let cp = cos(pitch)
        return SIMD3(sin(yaw) * cp, sin(pitch), -cos(yaw) * cp)
    }

    var right: SIMD3<Float> {
        let side = simd_cross(forward, SIMD3<Float>(0, 1, 0))
        let length = simd_length(side)
        if length < 1e-4 { return SIMD3(1, 0, 0) }
        return side / length
    }

    /// Up on screen. Perpendicular to `forward`, so sliding along it cannot dive through the view ray.
    var screenUp: SIMD3<Float> {
        simd_normalize(simd_cross(right, forward))
    }

    var lookRotation: simd_quatf {
        let zAxis = -forward
        var xAxis = simd_cross(SIMD3<Float>(0, 1, 0), zAxis)
        let length = simd_length(xAxis)
        if length < 1e-4 {
            xAxis = SIMD3(1, 0, 0)
        } else {
            xAxis /= length
        }
        let yAxis = simd_cross(zAxis, xAxis)
        return simd_quatf(simd_float3x3(columns: (xAxis, yAxis, simd_normalize(zAxis))))
    }

    static func looking(from eye: SIMD3<Float>, at target: SIMD3<Float>) -> PreviewRig {
        let direction = target - eye
        let length = simd_length(direction)
        let forward = length > 0.0001 ? direction / length : SIMD3<Float>(0, 0, -1)
        let pitch = min(maxPitch, max(minPitch, asin(max(-1, min(1, forward.y)))))
        let yaw = atan2(forward.x, -forward.z)
        return PreviewRig(eye: eye, yaw: yaw, pitch: pitch)
    }

    /// Eye sits just outside a model whose center of mass is the origin, aimed back at that center.
    static func framing(worldMin: SIMD3<Float>, worldMax: SIMD3<Float>, comOffset: Float, aspect: Float, groundY: Float) -> PreviewFrame {
        let extent = simd_max(worldMax - worldMin, SIMD3(repeating: 1))
        let fovY = verticalFovDegrees * .pi / 180
        let fovX = 2 * atan(tan(fovY / 2) * max(aspect, 0.5))
        let horizontal = hypot(extent.x, extent.z)
        let distance = max(
            (extent.y * 0.55 + comOffset) / tan(fovY / 2),
            (horizontal * 0.55 + comOffset) / tan(fovX / 2),
            2.5
        ) * 1.2
        var eye = homeDirection * distance
        eye.y = max(eye.y, groundY + PreviewLimits.clearance + 0.35)
        let rig = looking(from: eye, at: .zero)
        let pad = SIMD3<Float>(
            max(2, extent.x * 0.55),
            max(1.8, extent.y * 0.6),
            max(2, extent.z * 0.55)
        )
        var minimum = worldMin - pad
        var maximum = worldMax + pad
        // Keep the establishing viewpoint inside the box, plus a little room to back up, and no farther.
        let retreat = eye + homeDirection * max(distance * 0.22, 1.5)
        minimum = simd_min(minimum, simd_min(eye, retreat) - SIMD3(repeating: 0.8))
        maximum = simd_max(maximum, simd_max(eye, retreat) + SIMD3(repeating: 0.8))
        minimum.y = max(minimum.y, groundY + PreviewLimits.clearance)
        if maximum.y < minimum.y + 1.2 { maximum.y = minimum.y + 1.2 }
        let limits = PreviewLimits(
            minimum: minimum,
            maximum: maximum,
            groundY: groundY,
            eyeClearance: PreviewLimits.clearance
        )
        let span = max(horizontal, 4)
        return PreviewFrame(
            rig: rig,
            limits: limits,
            slideMetersPerPoint: span / 480,
            dollyMetersPerLn: span * 0.65
        )
    }

    mutating func look(deltaYaw: Float, deltaPitch: Float) {
        yaw += deltaYaw
        pitch = min(Self.maxPitch, max(Self.minPitch, pitch + deltaPitch))
    }

    /// Move across the screen. `horizontalPoints` is right, `verticalPoints` is down, matching UIKit.
    /// The step stays on the view plane, so a drag cannot throw the camera out along its look direction.
    mutating func slide(horizontalPoints: Float, verticalPoints: Float, metersPerPoint: Float, limits: PreviewLimits) {
        eye -= right * horizontalPoints * metersPerPoint
        eye += screenUp * verticalPoints * metersPerPoint
        clamp(to: limits)
    }

    mutating func dolly(_ meters: Float, limits: PreviewLimits) {
        eye += forward * meters
        clamp(to: limits)
    }

    mutating func clamp(to limits: PreviewLimits) {
        eye = simd_clamp(eye, limits.minimum, limits.maximum)
        eye.y = max(eye.y, limits.groundY + limits.eyeClearance)
        pitch = min(Self.maxPitch, max(Self.minPitch, pitch))
    }
}

struct PreviewFrame: Equatable {
    var rig: PreviewRig
    var limits: PreviewLimits
    var slideMetersPerPoint: Float
    var dollyMetersPerLn: Float
}

final class BuildingSceneController: ObservableObject {
    struct SceneFrame: Equatable {
        var version: Int
        var preview: PreviewFrame
    }

    let scene = SCNScene()
    private let root = SCNNode()
    private let cameraNode = SCNNode()
    private var contentVersion = 0
    private var framedVersion = -1
    private var aspect: Float = 0
    private var boundsMin = SIMD3<Float>(repeating: 0)
    private var boundsMax = SIMD3<Float>(repeating: 0)
    private var hasBounds = false
    private var massSum = SIMD3<Float>(repeating: 0)
    private var massWeight: Float = 0
    /// Local Y of the satellite plane. The walk camera is kept above this so it cannot enter the photo.
    static let mapPlaneLocalY: Float = -0.08
    private var mapFloorLocalY: Float?
    private(set) var frame = SceneFrame(version: 0, preview: PreviewRig.framing(
        worldMin: SIMD3(-4, 0, -4),
        worldMax: SIMD3(4, 3, 4),
        comOffset: 0,
        aspect: 0.6,
        groundY: -0.2
    ))

    init() {
        scene.background.contents = UIColor(red: 0.05, green: 0.07, blue: 0.10, alpha: 1)
        scene.rootNode.addChildNode(root)
        let camera = SCNCamera()
        camera.fieldOfView = CGFloat(PreviewRig.verticalFovDegrees)
        // A fixed depth range. Auto range treats the big satellite plane as the scene and
        // pushes the near plane out until the building disappears.
        camera.zNear = 0.08
        camera.zFar = 2500
        camera.automaticallyAdjustsZRange = false
        camera.wantsHDR = false
        cameraNode.camera = camera
        scene.rootNode.addChildNode(cameraNode)
        place(frame.preview.rig)
    }

    func show(map: BuildingMap, highlight zoneID: String?, satellite: UIImage?) {
        root.simdPosition = .zero
        root.childNodes.forEach { $0.removeFromParentNode() }
        resetBounds()
        mapFloorLocalY = nil
        if let satellite, let bounds = map.bounds {
            root.addChildNode(satellitePlane(image: satellite, bounds: bounds, heading: map.building.mapHeadingDegrees))
            mapFloorLocalY = Self.mapPlaneLocalY
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
            let focused = zoneID == nil || zone.id == zoneID
            if focused {
                for surface in zone.surfaces where surface.kind != .opening {
                    include(surface, node.simdTransform)
                }
            }
        }
        noteContent()
    }

    func showPreview(surfaces: [BakeSurface], colors: SurfaceColorDocument?, atlas: UIImage?) {
        root.simdPosition = .zero
        root.childNodes.forEach { $0.removeFromParentNode() }
        resetBounds()
        mapFloorLocalY = nil
        let node = BuildingMesh.node(surfaces: surfaces, colors: colors, atlas: atlas)
        root.addChildNode(node)
        for surface in surfaces where surface.kind != .opening {
            include(surface, matrix_identity_float4x4)
        }
        noteContent()
    }

    func viewAspectChanged(_ aspect: Float) {
        guard aspect.isFinite, aspect > 0.25 else { return }
        self.aspect = aspect
        guard framedVersion != contentVersion else { return }
        applyFrame()
    }

    private func resetBounds() {
        hasBounds = false
        massSum = .zero
        massWeight = 0
    }

    private func include(_ surface: BakeSurface, _ placement: simd_float4x4) {
        let world = placement * surface.transform
        let half = simd_abs(surface.dimensions) / 2
        let halfZ = surface.kind == .wall ? max(half.z, 0.06) : max(half.z, 0.02)
        for x in [Float]([-half.x, half.x]) {
            for y in [Float]([-half.y, half.y]) {
                for z in [Float]([-halfZ, halfZ]) {
                    let p = world * SIMD4<Float>(x, y, z, 1)
                    let point = SIMD3(p.x, p.y, p.z)
                    if hasBounds {
                        boundsMin = simd_min(boundsMin, point)
                        boundsMax = simd_max(boundsMax, point)
                    } else {
                        boundsMin = point
                        boundsMax = point
                        hasBounds = true
                    }
                }
            }
        }
        let size = SIMD3(max(half.x * 2, 0.04), max(half.y * 2, 0.04), max(halfZ * 2, 0.04))
        let volume = size.x * size.y * size.z
        let worldCenter = placement * surface.transform * SIMD4<Float>(0, 0, 0, 1)
        massSum += SIMD3(worldCenter.x, worldCenter.y, worldCenter.z) * volume
        massWeight += volume
    }

    private func noteContent() {
        contentVersion += 1
        framedVersion = -1
        if aspect > 0.25 {
            applyFrame()
            objectWillChange.send()
        }
    }

    private func applyFrame() {
        framedVersion = contentVersion
        let center: SIMD3<Float>
        let worldMin: SIMD3<Float>
        let worldMax: SIMD3<Float>
        if hasBounds {
            let aabbCenter = (boundsMin + boundsMax) * 0.5
            center = massWeight > 0.0001 ? massSum / massWeight : aabbCenter
            worldMin = boundsMin - center
            worldMax = boundsMax - center
        } else {
            center = .zero
            worldMin = SIMD3(-4, 0, -4)
            worldMax = SIMD3(4, 3, 4)
        }
        // Shift the scan so gestures happen around the model, not the ARKit origin.
        root.simdPosition = -center
        let aabbCenter = hasBounds ? (boundsMin + boundsMax) * 0.5 : center
        let groundY: Float
        if let mapFloorLocalY {
            groundY = -center.y + mapFloorLocalY
        } else {
            groundY = worldMin.y - 0.05
        }
        let preview = PreviewRig.framing(
            worldMin: worldMin,
            worldMax: worldMax,
            comOffset: simd_length(aabbCenter - center),
            aspect: aspect,
            groundY: groundY
        )
        place(preview.rig)
        frame = SceneFrame(version: contentVersion, preview: preview)
    }

    private func place(_ rig: PreviewRig) {
        cameraNode.simdPosition = rig.eye
        cameraNode.simdOrientation = rig.lookRotation
    }

    private func satellitePlane(image: UIImage, bounds: FloorBounds, heading: Double) -> SCNNode {
        let width = CGFloat(max(bounds.width, 8) + 24)
        let depth = CGFloat(max(bounds.depth, 8) + 24)
        let plane = SCNPlane(width: width, height: depth)
        plane.firstMaterial?.diffuse.contents = image
        // Front face points up after the pitch below. One side, so the camera cannot get "inside" the photo.
        plane.firstMaterial?.isDoubleSided = false
        plane.firstMaterial?.lightingModel = .constant
        let node = SCNNode(geometry: plane)
        node.eulerAngles.x = -.pi / 2
        node.eulerAngles.y = Float(-heading * .pi / 180)
        node.position = SCNVector3(bounds.center.x, Self.mapPlaneLocalY, bounds.center.y)
        return node
    }
}

struct BuildingSceneView: View {
    @ObservedObject var controller: BuildingSceneController

    var body: some View {
        ZStack(alignment: .bottom) {
            BuildingSceneRepresentable(controller: controller)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Text("Drag to look  ·  two fingers to slide  ·  pinch to move")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.white.opacity(0.88))
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(.black.opacity(0.38), in: Capsule())
                .padding(.bottom, 8)
                .allowsHitTesting(false)
        }
    }
}

private struct BuildingSceneRepresentable: UIViewRepresentable {
    @ObservedObject var controller: BuildingSceneController

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> SCNView {
        let view = SCNView()
        view.scene = controller.scene
        view.pointOfView = controller.scene.rootNode.childNodes.first { $0.camera != nil }
        view.allowsCameraControl = false
        view.isMultipleTouchEnabled = true
        view.antialiasingMode = .multisampling4X
        view.backgroundColor = UIColor(red: 0.05, green: 0.07, blue: 0.10, alpha: 1)
        view.autoenablesDefaultLighting = false
        context.coordinator.attach(to: view)
        return view
    }

    func updateUIView(_ uiView: SCNView, context: Context) {
        uiView.scene = controller.scene
        if uiView.pointOfView?.camera == nil {
            uiView.pointOfView = controller.scene.rootNode.childNodes.first { $0.camera != nil }
        }
        context.coordinator.cameraNode = uiView.pointOfView
        let bounds = uiView.bounds
        guard bounds.width > 1, bounds.height > 1 else { return }
        controller.viewAspectChanged(Float(bounds.width / bounds.height))
        context.coordinator.sync(frame: controller.frame)
    }

    /// One finger looks around, two fingers slide across the view, pinch steps along the look direction.
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var rig = PreviewRig(eye: SIMD3(0, 2, 8), yaw: 0, pitch: -0.25)
        var limits = PreviewLimits(minimum: SIMD3(repeating: -30), maximum: SIMD3(repeating: 30), groundY: -1, eyeClearance: PreviewLimits.clearance)
        var slideMetersPerPoint: Float = 0.02
        var dollyMetersPerLn: Float = 4
        var framedVersion = -1
        weak var cameraNode: SCNNode?
        private var lookRecognizer: UIPanGestureRecognizer?
        private var attached = false

        func attach(to view: SCNView) {
            guard !attached else { return }
            attached = true
            let look = UIPanGestureRecognizer(target: self, action: #selector(look(_:)))
            look.minimumNumberOfTouches = 1
            look.maximumNumberOfTouches = 1
            look.delegate = self
            let slide = UIPanGestureRecognizer(target: self, action: #selector(slide(_:)))
            slide.minimumNumberOfTouches = 2
            slide.maximumNumberOfTouches = 2
            slide.delegate = self
            let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinch(_:)))
            pinch.delegate = self
            lookRecognizer = look
            view.addGestureRecognizer(look)
            view.addGestureRecognizer(slide)
            view.addGestureRecognizer(pinch)
        }

        func sync(frame: BuildingSceneController.SceneFrame) {
            guard frame.version != framedVersion else { return }
            framedVersion = frame.version
            rig = frame.preview.rig
            limits = frame.preview.limits
            slideMetersPerPoint = frame.preview.slideMetersPerPoint
            dollyMetersPerLn = frame.preview.dollyMetersPerLn
            apply()
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool {
            gestureRecognizer !== lookRecognizer && other !== lookRecognizer
        }

        @objc func look(_ gesture: UIPanGestureRecognizer) {
            let translation = gesture.translation(in: gesture.view)
            gesture.setTranslation(.zero, in: gesture.view)
            rig.look(deltaYaw: Float(translation.x) * 0.005, deltaPitch: Float(-translation.y) * 0.005)
            apply()
        }

        @objc func slide(_ gesture: UIPanGestureRecognizer) {
            let translation = gesture.translation(in: gesture.view)
            gesture.setTranslation(.zero, in: gesture.view)
            rig.slide(
                horizontalPoints: Float(translation.x),
                verticalPoints: Float(translation.y),
                metersPerPoint: slideMetersPerPoint,
                limits: limits
            )
            apply()
        }

        @objc func pinch(_ gesture: UIPinchGestureRecognizer) {
            guard gesture.scale > 0.01 else { return }
            rig.dolly(log(Float(gesture.scale)) * dollyMetersPerLn, limits: limits)
            gesture.scale = 1
            apply()
        }

        private func apply() {
            guard let cameraNode else { return }
            cameraNode.simdPosition = rig.eye
            cameraNode.simdOrientation = rig.lookRotation
        }
    }
}
