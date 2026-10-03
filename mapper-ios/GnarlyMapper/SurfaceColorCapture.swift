import ARKit
import CoreImage
import Foundation
import ImageIO
import RoomPlan
import UniformTypeIdentifiers
import simd

// MARK: - Keyframes recorded while scanning

/// A camera photo saved during scanning, with the pose and lens data needed to project it onto RoomPlan surfaces.
struct ColorKeyframe: Sendable {
    let imageURL: URL
    let width: Int
    let height: Int
    /// Pinhole intrinsics scaled to the stored image (pixels).
    let focal: SIMD2<Float>
    let principal: SIMD2<Float>
    /// ARKit camera-to-world transform (sensor orientation, matching the stored image).
    let cameraTransform: simd_float4x4
    /// LiDAR depth in meters, row-major Float32, aligned with the image at lower resolution.
    let depthURL: URL?
    let depthWidth: Int
    let depthHeight: Int
}

/// Saves sharp, well-spaced camera frames while RoomPlan scans so walls, floors, doors, and furniture
/// can be colored from real photos after the final room is built.
final class SurfaceColorRecorder {
    static let maxKeyframes = 320
    private static let storedWidth: CGFloat = 1280

    private let queue = DispatchQueue(label: "com.gnarly.mapper.surface-color-keyframes", qos: .utility)
    private let context = CIContext()
    private let lock = NSLock()
    private var frames: [ColorKeyframe] = []
    private var generation = 0
    private var directory = SurfaceColorRecorder.makeDirectory()

    // Main-thread state.
    private var lastKeyframePose: simd_float4x4?
    private var lastKeyframeTime: TimeInterval = 0
    private var previousPose: simd_float4x4?
    private var pending = 0

    var keyframes: [ColorKeyframe] {
        lock.lock()
        defer { lock.unlock() }
        return frames
    }

    var count: Int { keyframes.count }

    /// Drops all photos. ARKit coordinates change between scans, so old photos would project to the wrong place.
    func reset() {
        let old = directory
        lock.lock()
        frames = []
        generation += 1
        lock.unlock()
        directory = Self.makeDirectory()
        lastKeyframePose = nil
        previousPose = nil
        lastKeyframeTime = 0
        queue.async { try? FileManager.default.removeItem(at: old) }
    }

    /// Call on the main thread with the session's current frame, a few times per second while scanning.
    func consider(_ frame: ARFrame) {
        let camera = frame.camera
        let pose = camera.transform
        defer { previousPose = pose }
        guard case .normal = camera.trackingState else { return }
        // Turning quickly blurs the photo; wait for the camera to settle.
        if let previousPose, Self.angle(previousPose, pose) > 0.12 { return }
        guard pending == 0 else { return }

        lock.lock()
        let index = frames.count
        let currentGeneration = generation
        lock.unlock()
        guard index < Self.maxKeyframes else { return }
        if let last = lastKeyframePose {
            let moved = simd_distance(last.columns.3, pose.columns.3)
            guard frame.timestamp - lastKeyframeTime >= 0.35,
                  moved >= 0.25 || Self.angle(last, pose) >= 0.2 else { return }
        }

        lastKeyframePose = pose
        lastKeyframeTime = frame.timestamp
        pending += 1
        let image = frame.capturedImage
        let depth = (frame.smoothedSceneDepth ?? frame.sceneDepth)?.depthMap
        let resolution = camera.imageResolution
        let intrinsics = camera.intrinsics
        let directory = self.directory
        queue.async { [weak self] in
            guard let self else { return }
            let keyframe = self.encode(
                image: image, depth: depth, resolution: resolution, intrinsics: intrinsics,
                pose: pose, directory: directory, index: index)
            self.lock.lock()
            if let keyframe, currentGeneration == self.generation { self.frames.append(keyframe) }
            self.lock.unlock()
            DispatchQueue.main.async { self.pending -= 1 }
        }
    }

    private func encode(
        image: CVPixelBuffer,
        depth: CVPixelBuffer?,
        resolution: CGSize,
        intrinsics: simd_float3x3,
        pose: simd_float4x4,
        directory: URL,
        index: Int
    ) -> ColorKeyframe? {
        let scale = min(1, Self.storedWidth / resolution.width)
        let width = Int((resolution.width * scale).rounded(.down))
        let height = Int((resolution.height * scale).rounded(.down))
        let scaled = CIImage(cvPixelBuffer: image)
            .applyingFilter("CILanczosScaleTransform", parameters: [kCIInputScaleKey: scale, kCIInputAspectRatioKey: 1.0])
            .cropped(to: CGRect(x: 0, y: 0, width: width, height: height))
        let quality = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let jpeg = context.jpegRepresentation(of: scaled, colorSpace: colorSpace, options: [quality: 0.9]) else {
            return nil
        }
        let imageURL = directory.appendingPathComponent(String(format: "frame-%04d.jpg", index))
        do {
            try jpeg.write(to: imageURL)
        } catch {
            return nil
        }

        var depthURL: URL?
        var depthWidth = 0
        var depthHeight = 0
        if let depth, let data = Self.depthData(depth, width: &depthWidth, height: &depthHeight) {
            let url = directory.appendingPathComponent(String(format: "frame-%04d.depth", index))
            if (try? data.write(to: url)) != nil { depthURL = url }
        }

        let s = Float(scale)
        return ColorKeyframe(
            imageURL: imageURL,
            width: width,
            height: height,
            focal: SIMD2<Float>(intrinsics[0][0] * s, intrinsics[1][1] * s),
            principal: SIMD2<Float>(intrinsics[2][0] * s, intrinsics[2][1] * s),
            cameraTransform: pose,
            depthURL: depthURL,
            depthWidth: depthURL == nil ? 0 : depthWidth,
            depthHeight: depthURL == nil ? 0 : depthHeight
        )
    }

    private static func depthData(_ buffer: CVPixelBuffer, width: inout Int, height: inout Int) -> Data? {
        guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_DepthFloat32 else { return nil }
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
        width = CVPixelBufferGetWidth(buffer)
        height = CVPixelBufferGetHeight(buffer)
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        var data = Data(capacity: width * height * 4)
        for row in 0 ..< height {
            data.append(base.advanced(by: row * rowBytes).assumingMemoryBound(to: UInt8.self), count: width * 4)
        }
        return data
    }

    private static func makeDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("surface-color-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private static func angle(_ a: simd_float4x4, _ b: simd_float4x4) -> Float {
        let forwardA = simd_normalize(-SIMD3<Float>(a.columns.2.x, a.columns.2.y, a.columns.2.z))
        let forwardB = simd_normalize(-SIMD3<Float>(b.columns.2.x, b.columns.2.y, b.columns.2.z))
        return acos(max(-1, min(1, simd_dot(forwardA, forwardB))))
    }
}

// MARK: - Surfaces to color

/// A RoomPlan surface or object, copied out of `CapturedRoom` so baking can run off the main actor.
struct BakeSurface: Sendable {
    enum Kind: String, Sendable {
        case wall, door, window, opening, floor, object
    }

    let identifier: String
    let kind: Kind
    let transform: simd_float4x4
    let dimensions: SIMD3<Float>
    let parentIdentifier: String?
    /// Open doors and openings are holes you can see through.
    let isPassable: Bool

    static func all(in room: CapturedRoom) -> [BakeSurface] {
        func surface(_ item: CapturedRoom.Surface, _ kind: Kind) -> BakeSurface {
            var passable = kind == .opening
            if case .door(let isOpen) = item.category, isOpen { passable = true }
            return BakeSurface(
                identifier: item.identifier.uuidString,
                kind: kind,
                transform: item.transform,
                dimensions: item.dimensions,
                parentIdentifier: item.parentIdentifier?.uuidString,
                isPassable: passable
            )
        }
        var result = room.walls.map { surface($0, .wall) }
        result += room.doors.map { surface($0, .door) }
        result += room.windows.map { surface($0, .window) }
        result += room.openings.map { surface($0, .opening) }
        result += room.floors.map { surface($0, .floor) }
        result += room.objects.map { object in
            BakeSurface(
                identifier: object.identifier.uuidString,
                kind: .object,
                transform: object.transform,
                dimensions: object.dimensions,
                parentIdentifier: object.parentIdentifier?.uuidString,
                isPassable: false
            )
        }
        return result
    }
}

// MARK: - Output format (surface-colors.json)

struct SurfaceColorDocument: Codable {
    struct Surface: Codable {
        let identifier: String
        let kind: String
        let faces: [Face]
    }

    /// Face names follow three.js BoxGeometry order in the feature's local frame: px, nx, py, pz, nz.
    /// Planar surfaces (walls, doors, windows, floors) only have pz and nz.
    /// Inside `rect`, u runs along the face's U axis and the top row is v = 1:
    ///   pz: U=+x V=+y   nz: U=-x V=+y   px: U=-z V=+y   nx: U=+z V=+y   py: U=+x V=-z
    struct Face: Codable {
        let face: String
        /// Average sRGB color, 0...1.
        let color: [Float]
        /// Fraction of texels seen in at least one photo.
        let coverage: Float
        /// Atlas pixel rect [x, y, width, height] from the top-left, or nil when coverage was too low for a texture.
        let rect: [Int]?
    }

    let schemaVersion: Int
    let zoneId: String
    let coordinateSystem: String
    let capturedAt: String
    let atlas: String
    let atlasWidth: Int
    let atlasHeight: Int
    let texelMeters: Float
    let keyframeCount: Int
    let usedLidarDepth: Bool
    let surfaces: [Surface]
    let notes: String
}

struct SurfaceColorBakeResult: Sendable {
    static let jsonFileName = "surface-colors.json"
    static let atlasFileName = "surface-colors.jpg"

    let json: Data
    let atlas: Data
    let summary: String
}

// MARK: - Baking

/// Projects the recorded photos onto every visible face of the final RoomPlan model, rejecting views that are
/// blocked (LiDAR depth, or the room geometry when depth is unavailable), and blends the best views per texel.
enum SurfaceColorBaker {
    static let maxTexels = 3_000_000
    static let minTexelMeters: Float = 0.015
    static let maxFaceTexels = 1024
    static let maxDistance: Float = 7
    static let atlasPadding = 4

    static func bake(
        surfaces: [BakeSurface],
        keyframes: [ColorKeyframe],
        zoneID: String,
        capturedAt: String,
        progress: @escaping @Sendable (Double) -> Void
    ) -> SurfaceColorBakeResult? {
        guard !keyframes.isEmpty else { return nil }
        let (faces, texelMeters) = makeFaces(surfaces)
        guard let last = faces.last else { return nil }
        let texelCount = last.offset + last.columns * last.rows
        var accumulation = [SIMD4<Float>](repeating: .zero, count: texelCount)
        let occluders = makeOccluders(surfaces)
        let toLinear = (0 ..< 256).map { srgbToLinear(Float($0) / 255) }
        var usedDepth = false

        for (index, keyframe) in keyframes.enumerated() {
            autoreleasepool {
                guard let frame = FrameData(keyframe) else { return }
                if frame.depth != nil { usedDepth = true }
                accumulation.withUnsafeMutableBufferPointer { buffer in
                    let target = buffer
                    DispatchQueue.concurrentPerform(iterations: faces.count) { faceIndex in
                        project(face: faces[faceIndex], frame: frame, occluders: occluders, toLinear: toLinear, into: target)
                    }
                }
            }
            progress(Double(index + 1) / Double(keyframes.count) * 0.9)
        }

        let finished = finish(faces: faces, accumulation: accumulation)
        progress(0.95)
        guard let atlas = packAtlas(finished) else { return nil }
        progress(1)

        var bySurface = [Int: [SurfaceColorDocument.Face]]()
        var coloredFaces = 0
        var seenTexels = 0
        for item in finished {
            guard let color = item.averageColor else { continue }
            coloredFaces += 1
            seenTexels += item.seenTexels
            bySurface[item.face.surfaceIndex, default: []].append(SurfaceColorDocument.Face(
                face: item.face.name,
                color: [color.x, color.y, color.z].map { linearToSRGB($0) },
                coverage: item.coverage,
                rect: atlas.rects[item.face.offset]
            ))
        }
        let documentSurfaces = bySurface.keys.sorted().map { index in
            SurfaceColorDocument.Surface(
                identifier: surfaces[index].identifier,
                kind: surfaces[index].kind.rawValue,
                faces: bySurface[index] ?? []
            )
        }

        let document = SurfaceColorDocument(
            schemaVersion: 1,
            zoneId: zoneID,
            coordinateSystem: "arkit-world-meters",
            capturedAt: capturedAt,
            atlas: SurfaceColorBakeResult.atlasFileName,
            atlasWidth: atlas.width,
            atlasHeight: atlas.height,
            texelMeters: texelMeters,
            keyframeCount: keyframes.count,
            usedLidarDepth: usedDepth,
            surfaces: documentSurfaces,
            notes: "Real colors projected from scan photos onto RoomPlan surfaces. Identifiers match scan-features.json."
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let json = try? encoder.encode(document) else { return nil }
        let percent = texelCount > 0 ? Int((Float(seenTexels) / Float(texelCount) * 100).rounded()) : 0
        let summary = "Colored \(coloredFaces) of \(faces.count) faces from \(keyframes.count) photos (\(percent)% seen\(usedDepth ? ", LiDAR-checked" : ""))."
        return SurfaceColorBakeResult(json: json, atlas: atlas.jpeg, summary: summary)
    }

    // MARK: Faces

    fileprivate struct Face {
        let surfaceIndex: Int
        let name: String
        let center: SIMD3<Float>
        let uAxis: SIMD3<Float>
        let vAxis: SIMD3<Float>
        let normal: SIMD3<Float>
        let width: Float
        let height: Float
        var columns = 0
        var rows = 0
        var offset = 0

        var radius: Float { 0.5 * (width * width + height * height).squareRoot() }

        func point(column: Int, row: Int) -> SIMD3<Float> {
            let u = (Float(column) + 0.5) / Float(columns) - 0.5
            let v = 0.5 - (Float(row) + 0.5) / Float(rows)
            return center + uAxis * (u * width) + vAxis * (v * height)
        }
    }

    private static func makeFaces(_ surfaces: [BakeSurface]) -> ([Face], Float) {
        var faces = [Face]()
        for (index, surface) in surfaces.enumerated() where surface.kind != .opening {
            let t = surface.transform
            let x = simd_normalize(SIMD3<Float>(t.columns.0.x, t.columns.0.y, t.columns.0.z))
            let y = simd_normalize(SIMD3<Float>(t.columns.1.x, t.columns.1.y, t.columns.1.z))
            let z = simd_normalize(SIMD3<Float>(t.columns.2.x, t.columns.2.y, t.columns.2.z))
            let c = SIMD3<Float>(t.columns.3.x, t.columns.3.y, t.columns.3.z)
            let d = simd_abs(surface.dimensions)
            func add(_ name: String, _ offset: SIMD3<Float>, _ u: SIMD3<Float>, _ v: SIMD3<Float>, _ n: SIMD3<Float>, _ w: Float, _ h: Float) {
                guard w > 0.02, h > 0.02 else { return }
                faces.append(Face(surfaceIndex: index, name: name, center: c + offset, uAxis: u, vAxis: v, normal: n, width: w, height: h))
            }
            if surface.kind == .object {
                add("px", x * (d.x / 2), -z, y, x, d.z, d.y)
                add("nx", -x * (d.x / 2), z, y, -x, d.z, d.y)
                add("py", y * (d.y / 2), x, -z, y, d.x, d.z)
                add("pz", z * (d.z / 2), x, y, z, d.x, d.y)
                add("nz", -z * (d.z / 2), -x, y, -z, d.x, d.y)
            } else {
                add("pz", .zero, x, y, z, d.x, d.y)
                add("nz", .zero, -x, y, -z, d.x, d.y)
            }
        }

        let area = faces.reduce(Float(0)) { $0 + $1.width * $1.height }
        let texel = max(minTexelMeters, (area / Float(maxTexels)).squareRoot())
        var offset = 0
        for index in faces.indices {
            faces[index].columns = min(maxFaceTexels, max(2, Int((faces[index].width / texel).rounded(.up))))
            faces[index].rows = min(maxFaceTexels, max(2, Int((faces[index].height / texel).rounded(.up))))
            faces[index].offset = offset
            offset += faces[index].columns * faces[index].rows
        }
        return (faces, texel)
    }

    // MARK: Occlusion without LiDAR depth

    fileprivate struct Occluder {
        let surfaceIndex: Int
        let center: SIMD3<Float>
        let x: SIMD3<Float>
        let y: SIMD3<Float>
        let z: SIMD3<Float>
        let half: SIMD3<Float>
        let radius: Float
        let planar: Bool
        /// Child openings, open doors, and windows in wall-local coordinates: minX, minY, maxX, maxY.
        let holes: [SIMD4<Float>]

        func hits(origin: SIMD3<Float>, direction: SIMD3<Float>, maxT: Float) -> Bool {
            let offset = origin - center
            let o = SIMD3<Float>(simd_dot(offset, x), simd_dot(offset, y), simd_dot(offset, z))
            let d = SIMD3<Float>(simd_dot(direction, x), simd_dot(direction, y), simd_dot(direction, z))
            if planar {
                guard abs(d.z) > 1e-5 else { return false }
                let t = -o.z / d.z
                guard t > 0, t < maxT else { return false }
                let hx = o.x + d.x * t
                let hy = o.y + d.y * t
                guard abs(hx) <= half.x, abs(hy) <= half.y else { return false }
                return !holes.contains { hx > $0.x && hx < $0.z && hy > $0.y && hy < $0.w }
            }
            var near: Float = 0
            var far = maxT
            for axis in 0 ..< 3 {
                if abs(d[axis]) < 1e-6 {
                    if abs(o[axis]) > half[axis] { return false }
                    continue
                }
                var t1 = (-half[axis] - o[axis]) / d[axis]
                var t2 = (half[axis] - o[axis]) / d[axis]
                if t1 > t2 { swap(&t1, &t2) }
                near = max(near, t1)
                far = min(far, t2)
                if near > far { return false }
            }
            return near < maxT
        }
    }

    private static func makeOccluders(_ surfaces: [BakeSurface]) -> [Occluder] {
        var holes = [String: [SIMD4<Float>]]()
        let wallsByID = Dictionary(
            surfaces.filter { $0.kind == .wall }.map { ($0.identifier, $0) },
            uniquingKeysWith: { first, _ in first })
        for surface in surfaces where surface.isPassable || surface.kind == .window {
            guard let parentID = surface.parentIdentifier, let wall = wallsByID[parentID] else { continue }
            let toWall = wall.transform.inverse * surface.transform
            let center = SIMD2<Float>(toWall.columns.3.x, toWall.columns.3.y)
            let half = simd_abs(surface.dimensions) / 2
            holes[parentID, default: []].append(SIMD4<Float>(center.x - half.x, center.y - half.y, center.x + half.x, center.y + half.y))
        }

        return surfaces.enumerated().compactMap { index, surface in
            guard !surface.isPassable, surface.kind != .window else { return nil }
            let t = surface.transform
            let half = simd_abs(surface.dimensions) / 2
            return Occluder(
                surfaceIndex: index,
                center: SIMD3<Float>(t.columns.3.x, t.columns.3.y, t.columns.3.z),
                x: simd_normalize(SIMD3<Float>(t.columns.0.x, t.columns.0.y, t.columns.0.z)),
                y: simd_normalize(SIMD3<Float>(t.columns.1.x, t.columns.1.y, t.columns.1.z)),
                z: simd_normalize(SIMD3<Float>(t.columns.2.x, t.columns.2.y, t.columns.2.z)),
                half: half,
                radius: simd_length(half),
                planar: surface.kind != .object,
                holes: holes[surface.identifier] ?? []
            )
        }
    }

    // MARK: Projection

    fileprivate struct FrameData {
        let pixels: [UInt8]
        let width: Int
        let height: Int
        let depth: [Float]?
        let depthWidth: Int
        let depthHeight: Int
        let cameraPosition: SIMD3<Float>
        let worldToCamera: simd_float4x4
        let focal: SIMD2<Float>
        let principal: SIMD2<Float>

        init?(_ keyframe: ColorKeyframe) {
            guard let source = CGImageSourceCreateWithURL(keyframe.imageURL as CFURL, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
                  let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
            let width = image.width
            let height = image.height
            var pixels = [UInt8](repeating: 0, count: width * height * 4)
            let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
                guard let context = CGContext(
                    data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                    bytesPerRow: width * 4, space: colorSpace,
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
                context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
                return true
            }
            guard drawn else { return nil }
            self.pixels = pixels
            self.width = width
            self.height = height

            var depth: [Float]?
            if let url = keyframe.depthURL, let data = try? Data(contentsOf: url),
               data.count == keyframe.depthWidth * keyframe.depthHeight * 4, keyframe.depthWidth > 0 {
                depth = data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
            }
            self.depth = depth
            depthWidth = keyframe.depthWidth
            depthHeight = keyframe.depthHeight

            let t = keyframe.cameraTransform
            cameraPosition = SIMD3<Float>(t.columns.3.x, t.columns.3.y, t.columns.3.z)
            worldToCamera = t.inverse
            // Intrinsics are for the stored image size, which may differ by rounding from the recorded size.
            let sx = Float(width) / Float(max(1, keyframe.width))
            let sy = Float(height) / Float(max(1, keyframe.height))
            focal = SIMD2<Float>(keyframe.focal.x * sx, keyframe.focal.y * sy)
            principal = SIMD2<Float>(keyframe.principal.x * sx, keyframe.principal.y * sy)
        }
    }

    private static func project(
        face: Face,
        frame: FrameData,
        occluders: [Occluder],
        toLinear: [Float],
        into accumulation: UnsafeMutableBufferPointer<SIMD4<Float>>
    ) {
        let camera = frame.cameraPosition
        let toCamera = camera - face.center
        guard simd_dot(toCamera, face.normal) > 0.03 else { return }
        guard simd_length(toCamera) - face.radius < maxDistance else { return }
        guard projectedBoundsOverlap(face: face, frame: frame) else { return }

        let blockers = frame.depth == nil
            ? occluders.filter { occluder in
                occluder.surfaceIndex != face.surfaceIndex &&
                    distanceToSegment(occluder.center, camera, face.center) < occluder.radius + face.radius
            }
            : []
        let width = Float(frame.width)
        let height = Float(frame.height)
        let edgeScale = 0.12 * min(width, height)

        for row in 0 ..< face.rows {
            for column in 0 ..< face.columns {
                let point = face.point(column: column, row: row)
                let ray = point - camera
                let distance = simd_length(ray)
                guard distance > 0.15, distance < maxDistance else { continue }
                let cosine = -simd_dot(ray, face.normal) / distance
                guard cosine > 0.17 else { continue }

                let local = frame.worldToCamera * SIMD4<Float>(point, 1)
                let z = -local.z
                guard z > 0.1 else { continue }
                let px = frame.focal.x * local.x / z + frame.principal.x
                let py = frame.focal.y * -local.y / z + frame.principal.y
                guard px >= 1, py >= 1, px < width - 2, py < height - 2 else { continue }

                if let depth = frame.depth {
                    let dx = min(frame.depthWidth - 1, Int(px * Float(frame.depthWidth) / width))
                    let dy = min(frame.depthHeight - 1, Int(py * Float(frame.depthHeight) / height))
                    let measured = depth[dy * frame.depthWidth + dx]
                    if measured.isFinite, measured > 0 {
                        if measured < z - max(0.05, 0.03 * z) { continue }   // something stands in front
                        if measured > z + max(0.25, 0.1 * z) { continue }    // the surface isn't really there
                    }
                } else if blockers.contains(where: { $0.hits(origin: camera, direction: ray / distance, maxT: distance - 0.12) }) {
                    continue
                }

                let color = sample(frame, x: px, y: py, toLinear: toLinear)
                let edge = min(1, min(min(px, width - px), min(py, height - py)) / edgeScale)
                let base = cosine * cosine / max(distance * distance, 0.25) * (0.25 + 0.75 * edge)
                // Squaring favors the sharpest, most head-on views while still averaging out noise.
                let weight = base * base
                accumulation[face.offset + row * face.columns + column] += SIMD4<Float>(color * weight, weight)
            }
        }
    }

    private static func projectedBoundsOverlap(face: Face, frame: FrameData) -> Bool {
        var minX = Float.greatestFiniteMagnitude
        var minY = Float.greatestFiniteMagnitude
        var maxX = -Float.greatestFiniteMagnitude
        var maxY = -Float.greatestFiniteMagnitude
        var behind = 0
        let unitCorners: [SIMD2<Float>] = [SIMD2(-0.5, -0.5), SIMD2(0.5, -0.5), SIMD2(-0.5, 0.5), SIMD2(0.5, 0.5)]
        let corners = unitCorners.map { corner in
            face.center + face.uAxis * (corner.x * face.width) + face.vAxis * (corner.y * face.height)
        }
        for corner in corners {
            let local = frame.worldToCamera * SIMD4<Float>(corner, 1)
            let z = -local.z
            if z < 0.1 {
                behind += 1
                continue
            }
            let px = frame.focal.x * local.x / z + frame.principal.x
            let py = frame.focal.y * -local.y / z + frame.principal.y
            minX = min(minX, px)
            maxX = max(maxX, px)
            minY = min(minY, py)
            maxY = max(maxY, py)
        }
        if behind == corners.count { return false }
        // A face crossing the camera plane can't be bounded reliably; let per-texel tests decide.
        if behind > 0 { return true }
        return maxX >= 0 && minX <= Float(frame.width) && maxY >= 0 && minY <= Float(frame.height)
    }

    private static func sample(_ frame: FrameData, x: Float, y: Float, toLinear: [Float]) -> SIMD3<Float> {
        let fx = x - 0.5
        let fy = y - 0.5
        let x0 = max(0, Int(fx))
        let y0 = max(0, Int(fy))
        let x1 = min(frame.width - 1, x0 + 1)
        let y1 = min(frame.height - 1, y0 + 1)
        let tx = fx - Float(x0)
        let ty = fy - Float(y0)
        func pixel(_ px: Int, _ py: Int) -> SIMD3<Float> {
            let i = (py * frame.width + px) * 4
            return SIMD3<Float>(toLinear[Int(frame.pixels[i])], toLinear[Int(frame.pixels[i + 1])], toLinear[Int(frame.pixels[i + 2])])
        }
        let top = pixel(x0, y0) * (1 - tx) + pixel(x1, y0) * tx
        let bottom = pixel(x0, y1) * (1 - tx) + pixel(x1, y1) * tx
        return top * (1 - ty) + bottom * ty
    }

    private static func distanceToSegment(_ point: SIMD3<Float>, _ a: SIMD3<Float>, _ b: SIMD3<Float>) -> Float {
        let ab = b - a
        let lengthSquared = simd_length_squared(ab)
        guard lengthSquared > 1e-8 else { return simd_distance(point, a) }
        let t = max(0, min(1, simd_dot(point - a, ab) / lengthSquared))
        return simd_distance(point, a + ab * t)
    }

    // MARK: Finishing and atlas

    fileprivate struct FinishedFace {
        let face: Face
        /// Linear RGB per texel, holes filled.
        let texels: [SIMD3<Float>]
        let averageColor: SIMD3<Float>?
        let coverage: Float
        let seenTexels: Int
    }

    private static func finish(faces: [Face], accumulation: [SIMD4<Float>]) -> [FinishedFace] {
        faces.map { face in
            let count = face.columns * face.rows
            var texels = [SIMD3<Float>](repeating: .zero, count: count)
            var filled = [Bool](repeating: false, count: count)
            var sum = SIMD3<Float>.zero
            var seen = 0
            for index in 0 ..< count {
                let value = accumulation[face.offset + index]
                guard value.w > 0 else { continue }
                let color = SIMD3<Float>(value.x, value.y, value.z) / value.w
                texels[index] = color
                filled[index] = true
                sum += color
                seen += 1
            }
            guard seen > 0 else {
                return FinishedFace(face: face, texels: texels, averageColor: nil, coverage: 0, seenTexels: 0)
            }
            let average = sum / Float(seen)

            // Grow seen texels into unseen gaps, then fall back to the face's average color.
            for _ in 0 ..< 24 {
                var grew = false
                var next = filled
                for row in 0 ..< face.rows {
                    for column in 0 ..< face.columns {
                        let index = row * face.columns + column
                        guard !filled[index] else { continue }
                        var neighborSum = SIMD3<Float>.zero
                        var neighbors = 0
                        for (dc, dr) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
                            let c = column + dc
                            let r = row + dr
                            guard c >= 0, r >= 0, c < face.columns, r < face.rows else { continue }
                            let n = r * face.columns + c
                            if filled[n] {
                                neighborSum += texels[n]
                                neighbors += 1
                            }
                        }
                        if neighbors > 0 {
                            texels[index] = neighborSum / Float(neighbors)
                            next[index] = true
                            grew = true
                        }
                    }
                }
                filled = next
                if !grew { break }
            }
            for index in 0 ..< count where !filled[index] { texels[index] = average }
            return FinishedFace(face: face, texels: texels, averageColor: average, coverage: Float(seen) / Float(count), seenTexels: seen)
        }
    }

    private struct Atlas {
        let jpeg: Data
        let width: Int
        let height: Int
        /// Rect per face, keyed by the face's accumulator offset.
        let rects: [Int: [Int]]
    }

    private static func packAtlas(_ faces: [FinishedFace]) -> Atlas? {
        let textured = faces.filter { $0.averageColor != nil && $0.coverage >= 0.03 }
            .sorted { $0.face.rows > $1.face.rows }
        let padding = atlasPadding
        let area = textured.reduce(0) { $0 + ($1.face.columns + 2 * padding) * ($1.face.rows + 2 * padding) }
        let width = area > 2048 * 1400 ? 4096 : 2048

        var rects = [Int: [Int]]()
        var x = 0
        var y = 0
        var shelfHeight = 0
        for item in textured {
            let w = item.face.columns + 2 * padding
            let h = item.face.rows + 2 * padding
            if x + w > width {
                x = 0
                y += shelfHeight
                shelfHeight = 0
            }
            rects[item.face.offset] = [x + padding, y + padding, item.face.columns, item.face.rows]
            x += w
            shelfHeight = max(shelfHeight, h)
        }
        let height = max(4, y + shelfHeight)

        var pixels = [UInt8](repeating: 128, count: width * height * 4)
        for item in textured {
            guard let rect = rects[item.face.offset] else { continue }
            let columns = item.face.columns
            let rows = item.face.rows
            // Padding repeats the edge texels so filtering and JPEG blocks don't bleed neighboring faces.
            for py in -padding ..< rows + padding {
                for px in -padding ..< columns + padding {
                    let source = item.texels[min(rows - 1, max(0, py)) * columns + min(columns - 1, max(0, px))]
                    let index = ((rect[1] + py) * width + rect[0] + px) * 4
                    pixels[index] = UInt8(max(0, min(255, (linearToSRGB(source.x) * 255).rounded())))
                    pixels[index + 1] = UInt8(max(0, min(255, (linearToSRGB(source.y) * 255).rounded())))
                    pixels[index + 2] = UInt8(max(0, min(255, (linearToSRGB(source.z) * 255).rounded())))
                    pixels[index + 3] = 255
                }
            }
        }

        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let provider = CGDataProvider(data: Data(pixels) as CFData),
              let image = CGImage(
                width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
                space: colorSpace, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) else { return nil }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.92] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return Atlas(jpeg: output as Data, width: width, height: height, rects: rects)
    }

    private static func srgbToLinear(_ c: Float) -> Float {
        c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
    }

    private static func linearToSRGB(_ l: Float) -> Float {
        let c = max(0, min(1, l))
        return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1 / 2.4) - 0.055
    }
}
