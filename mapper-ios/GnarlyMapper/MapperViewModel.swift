import ARKit
import FirebaseAuth
import Foundation
import OSLog
import RoomPlan
import UIKit

@MainActor
final class MapperViewModel: ObservableObject {
    private let uploadLogger = Logger(subsystem: "com.gnarly.mapper", category: "PackageUpload")
    @Published private(set) var statusText = "Preparing AR session…"
    @Published private(set) var isScanning = false
    @Published private(set) var exportURL: URL?
    @Published private(set) var recordedNodes: [RecordedGraphNode] = []
    @Published private(set) var isUploading = false
    @Published private(set) var detectedStairs: [DetectedStair] = []
    @Published private(set) var catalog = StairCatalogStore.load()
    @Published private(set) var isStairScan = false
    @Published private(set) var zoneConnectionsJSON = ""
    @Published private(set) var scanPlan = ScanPlan.empty
    @Published private(set) var diagnosticsText = "No RoomPlan scan has started yet."
    @Published private(set) var phase: ScanPhase = .idle
    @Published private(set) var previewSurfaces: [BakeSurface] = []
    @Published private(set) var previewColors: SurfaceColorDocument?
    @Published private(set) var previewAtlas: UIImage?
    @Published private(set) var previewSummary = ""
    @Published private(set) var colorFrameCount = 0
    @Published var activeTarget: ZoneScanTarget?
    @Published var activeBuilding: OwnedBuilding?

    enum ScanPhase {
        case idle, scanning, processing, preview, uploading
    }
    private var uploadAttemptID: UUID?

    private enum ScanTarget {
        case floor
        case stairs
    }

    private var scanTarget: ScanTarget = .floor
    @Published var showsError = false
    @Published private(set) var errorMessage = ""

    let arSession = ARSession()
    private let colorRecorder = SurfaceColorRecorder()
    private weak var captureView: RoomCaptureView?
    private var capturedRoom: CapturedRoom?
    private var testAnchor: TestAnchor?
    private var pathSamplingTimer: Timer?
    private var lastSampledPosition: [Float]?
    private var lastPlanUpdate = Date.distantPast
    private var lastStairCount = 0
    /// Latest live stair volumes. The processed room often omits stairs that were visible while scanning.
    private var seenStairVolumes: [String: StairVolume] = [:]
    private let automaticNodeSpacingMeters: Float = 0.75
    private var scanStartedAt: Date?
    private var roomUpdateCount = 0
    private var lastRoomStats = "No captured-room updates yet"
    private var lastInstruction = "none"
    private var lastCaptureFailure: String?

    var canMarkAnchor: Bool {
        arSession.currentFrame != nil
    }

    var canDropManualNode: Bool {
        arSession.currentFrame != nil
    }

    var canExport: Bool {
        capturedRoom != nil && (testAnchor != nil || !recordedNodes.isEmpty)
    }

    var recordedNodeCount: Int {
        recordedNodes.count
    }

    init() {
        let loaded = StairCatalogStore.load()
        catalog = loaded
        zoneConnectionsJSON = loaded.navigatorZoneConnectionsJSON()
    }

    func configure(captureView: RoomCaptureView) {
        self.captureView = captureView
        if activeTarget != nil, !isScanning, phase != .preview, phase != .processing {
            beginFloorScan()
        }
    }

    func beginPlannedScan(building: OwnedBuilding, target: ZoneScanTarget) {
        activeBuilding = building
        activeTarget = target
        if captureView != nil { beginFloorScan() }
    }

    func startScan() {
        guard RoomCaptureSession.isSupported else {
            showError("RoomPlan is not supported on this device. Use a LiDAR-capable iPhone.")
            return
        }

        stopPathSampling()
        capturedRoom = nil
        testAnchor = nil
        recordedNodes = []
        exportURL = nil
        if scanTarget == .floor {
            detectedStairs = []
            seenStairVolumes = [:]
        }
        scanPlan = .empty
        lastStairCount = 0
        scanStartedAt = Date()
        roomUpdateCount = 0
        lastRoomStats = "Waiting for RoomPlan geometry"
        lastInstruction = "none"
        lastCaptureFailure = nil
        colorRecorder.reset()
        captureView?.captureSession.run(configuration: .init())
        isScanning = true
        phase = .scanning
        statusText = "Sweep each wall from floor to ceiling. Path points save as you walk."
        updateDiagnostics()
        startPathSampling()
    }

    func finishRoom() {
        guard isScanning else { return }
        statusText = "Processing RoomPlan scan…"
        isScanning = false
        phase = .processing
        stopPathSampling()
        updateDiagnostics()
        // Keep ARKit running so its coordinate system remains valid for map export.
        captureView?.captureSession.stop(pauseARSession: false)
    }

    func didFinishCapture(data: CapturedRoomData, error: Error?) {
        if let error {
            let diagnosis = captureFailureDescription(error)
            lastCaptureFailure = diagnosis
            isScanning = false
            stopPathSampling()
            updateDiagnostics()
            showError("RoomPlan stopped: \(diagnosis)")
            return
        }

        Task {
            do {
                let room = try await RoomBuilder(options: [.beautifyObjects]).capturedRoom(from: data)
                capturedRoom = room
                scanPlan = ScanPlan(room: room)
                if scanTarget == .floor {
                    let processed = RoomPlanScanExtractor.detectedStairs(in: room)
                    detectedStairs = processed.isEmpty
                        ? StairVolume.recovered(roomKeptStairs: false, seen: seenStairVolumes.values).map(\.detected)
                        : processed
                }
                await preparePreview()
            } catch {
                showError("Unable to build the captured room: \(error.localizedDescription)")
            }
        }
    }

    func dropManualNode() {
        guard let position = currentCameraPosition() else {
            showError("ARKit has no current camera frame. Look around until tracking resumes.")
            return
        }

        recordedNodes.append(
            RecordedGraphNode(
                type: .waypoint,
                label: "Manual point",
                position: position,
                capturedAt: ISO8601DateFormatter().string(from: Date())
            )
        )
        statusText = "Manual point added. Path nodes: \(recordedNodes.count)."
    }

    func markTestAnchor() {
        guard let position = currentCameraPosition() else {
            showError("ARKit has no current camera frame. Look around until tracking resumes.")
            return
        }

        testAnchor = TestAnchor(
            schemaVersion: 1,
            zoneID: "",
            position: position,
            coordinateSystem: "arkit-world-meters",
            capturedAt: ISO8601DateFormatter().string(from: Date()),
            notes: "Camera position captured by GnarlyMapper."
        )
        statusText = "Test anchor marked. Export the package when ready."
    }

    func noteRoomUpdate(_ room: CapturedRoom) {
        roomUpdateCount += 1
        let liveStairs = room.objects.filter { $0.category == .stairs }.map(RoomPlanScanExtractor.stairVolume)
        if !liveStairs.isEmpty {
            seenStairVolumes = Dictionary(uniqueKeysWithValues: liveStairs.map { ($0.identifier, $0) })
        }
        let stairs = liveStairs.count
        let now = Date()
        guard stairs != lastStairCount || now.timeIntervalSince(lastPlanUpdate) > 0.3 else { return }
        lastPlanUpdate = now
        lastStairCount = stairs
        lastRoomStats = roomStatistics(room)
        updateDiagnostics()
        scanPlan = ScanPlan(room: room)
    }

    func noteCaptureInstruction(_ instruction: RoomCaptureSession.Instruction) {
        lastInstruction = String(describing: instruction)
        updateDiagnostics()
    }

    private func updateDiagnostics() {
        let elapsed = scanStartedAt.map { Date().timeIntervalSince($0) } ?? 0
        let mode = isStairScan ? "stair zone" : "floor zone"
        let failure = lastCaptureFailure.map { "\nLast stop: \($0)" } ?? ""
        diagnosticsText = """
        Mode: \(mode) · scanning: \(isScanning ? "yes" : "no") · elapsed: \(Int(elapsed)) s
        AR tracking: \(trackingStateDescription()) · thermal: \(thermalStateDescription())
        RoomPlan updates: \(roomUpdateCount) · last instruction: \(lastInstruction)
        Geometry: \(lastRoomStats)
        Recorded path nodes: \(recordedNodes.count)
        \(failure)
        """.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func roomStatistics(_ room: CapturedRoom) -> String {
        let surfaces = room.walls + room.doors + room.openings + room.windows + room.floors
        let centers = surfaces.map { SIMD2<Float>($0.transform.columns.3.x, $0.transform.columns.3.z) }
        let span: String
        if let first = centers.first {
            let minX = centers.map(\.x).min() ?? first.x
            let maxX = centers.map(\.x).max() ?? first.x
            let minZ = centers.map(\.y).min() ?? first.y
            let maxZ = centers.map(\.y).max() ?? first.y
            span = String(format: "feature span %.1f m × %.1f m", maxX - minX, maxZ - minZ)
        } else {
            span = "no surface centers yet"
        }
        return "\(room.walls.count) walls · \(room.floors.count) floors · \(room.doors.count) doors · \(room.openings.count) openings · \(room.windows.count) windows · \(room.objects.count) objects · \(span)"
    }

    private func captureFailureDescription(_ error: Error) -> String {
        guard let captureError = error as? RoomCaptureSession.CaptureError else {
            return "\(String(describing: error)) (\(error.localizedDescription))"
        }
        switch captureError {
        case .exceedSceneSizeLimit:
            return "RoomPlan scene-size limit exceeded. Split this floor into smaller zones."
        case .deviceTooHot:
            return "Device is too hot for RoomPlan. Let it cool, remove the case if practical, then retry."
        case .worldTrackingFailure:
            return "ARKit world tracking failed. Return to a well-lit, feature-rich area and start a new zone."
        case .invalidARConfiguration:
            return "RoomPlan rejected the AR configuration. Restart the app and try again."
        case .deviceNotSupported:
            return "This device does not support RoomPlan/LiDAR capture."
        case .internalError:
            return "RoomPlan reported an internal error. Save the diagnostics and retry a smaller zone."
        @unknown default:
            return "RoomPlan stopped with an unknown capture error: \(String(describing: captureError))."
        }
    }

    private func trackingStateDescription() -> String {
        guard let state = arSession.currentFrame?.camera.trackingState else { return "no AR frame" }
        switch state {
        case .normal: return "normal"
        case .notAvailable: return "not available"
        case .limited(let reason): return "limited (\(String(describing: reason)))"
        }
    }

    private func thermalStateDescription() -> String {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
    }

    func beginFloorScan() {
        scanTarget = .floor
        isStairScan = false
        resetTracking()
        startScan()
        statusText = "Scanning this floor. RoomPlan stair objects become links into a separate stair zone."
    }

    func beginStairScan(stairID rawStairID: String) {
        let stairID = StairZoneID.sanitize(rawStairID)
        guard !stairID.isEmpty else {
            showError("RoomPlan has not detected a stair yet. Finish a floor scan that includes the staircase.")
            return
        }
        let keptStairs = detectedStairs
        scanTarget = .stairs
        isStairScan = true
        resetTracking()
        startScan()
        detectedStairs = keptStairs
        statusText = "Scanning stair zone \(stairID). Walk from the lower landing to the upper landing, then export."
    }

    func exportPackage(
        zoneID rawZoneID: String,
        floorID rawFloorID: String,
        asStairs: Bool = false,
        stairID rawStairID: String = "",
        linkedFloorZoneID: String = "",
        floorIsBelow: Bool = true
    ) {
        guard let room = capturedRoom else {
            showError("Finish a room scan before exporting.")
            return
        }

        let floorID = rawFloorID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !floorID.isEmpty else {
            showError("Enter a floor ID, such as ground.")
            return
        }
        let packageZoneID = StairZoneID.sanitize(rawZoneID)
        guard !packageZoneID.isEmpty else {
            showError("Enter a non-empty zone ID.")
            return
        }

        var draft = catalog
        let map: ExportedMap
        if asStairs {
            let floorZoneID = StairZoneID.sanitize(linkedFloorZoneID.isEmpty ? rawZoneID : linkedFloorZoneID)
            let pointer = FloorPointer(floorID: floorID, zoneID: floorZoneID, story: room.story, nodeID: packageZoneID)
            let sample = RoomPlanScanExtractor.detectedStairs(in: room).first
            let center = sample?.position ?? recordedNodes.first?.position ?? [0, 0, 0]
            let landings = StairLandings.positions(
                center: center,
                dimensions: sample?.dimensions ?? [1.2, 3, 2.5],
                up: sample?.up ?? [0, 1, 0],
                forward: sample?.forward ?? [0, 0, 1]
            )
            let existing = draft.stair(id: packageZoneID)
            let below = floorIsBelow ? pointer : existing?.prev
            let above = floorIsBelow ? existing?.next : pointer
            draft.markScanned(
                id: packageZoneID,
                prev: below,
                next: above,
                landingBelow: landings.below,
                landingAbove: landings.above
            )
            map = .stairZone(id: packageZoneID)
        } else {
            let end: StairEnd = floorIsBelow ? .below : .above
            let selected = StairZoneID.sanitize(rawStairID)
            let attaching = !selected.isEmpty && draft.stair(id: selected) != nil && !detectedStairs.contains(where: { $0.id == selected })
            if attaching {
                let pointer = FloorPointer(floorID: floorID, zoneID: packageZoneID, story: room.story, nodeID: selected)
                draft.link(stairID: selected, floor: pointer, as: end)
            } else {
                for stair in detectedStairs {
                    let pointer = FloorPointer(
                        floorID: floorID,
                        zoneID: packageZoneID,
                        story: stair.story,
                        nodeID: stair.id
                    )
                    draft.upsert(detection: stair, on: pointer)
                    draft.link(stairID: stair.id, floor: pointer, as: end)
                }
            }
            map = .floor
        }

        let anchor = (testAnchor ?? fallbackAnchor()).withZoneID(packageZoneID)
        let recorded = recordedNodes
        let savingStatus = asStairs
            ? "Saving the stair zone world map and RoomPlan stair links…"
            : "Saving ARWorldMap, RoomPlan scan, and building graph…"
        let recoveredStairs = StairVolume.recovered(
            roomKeptStairs: room.objects.contains { $0.category == .stairs },
            seen: seenStairVolumes.values
        )
        let surfaces = BakeSurface.all(in: room, recoveredStairs: recoveredStairs)
        let keyframes = colorRecorder.keyframes
        let capturedAt = ISO8601DateFormatter().string(from: Date())
        statusText = keyframes.isEmpty ? savingStatus : "Coloring the model from \(keyframes.count) scan photos…"

        Task { @MainActor [weak self] in
            // Baking is CPU-heavy (every photo is projected onto every visible face), so keep it off the main actor.
            let colors = await Task.detached(priority: .userInitiated) {
                SurfaceColorBaker.bake(surfaces: surfaces, keyframes: keyframes, zoneID: packageZoneID, capturedAt: capturedAt) { fraction in
                    Task { @MainActor [weak self] in
                        guard let self, self.statusText.hasPrefix("Coloring the model") else { return }
                        self.statusText = "Coloring the model from scan photos… \(Int(fraction * 100))%"
                    }
                }
            }.value
            guard let self else { return }
            if !keyframes.isEmpty, colors == nil {
                self.uploadLogger.error("Surface color bake produced no output from \(keyframes.count) keyframes.")
            }
            self.statusText = savingStatus
            self.arSession.getCurrentWorldMap { [weak self] worldMap, error in
                Task { @MainActor in
                    guard let self else { return }
                    guard let worldMap else {
                        self.showError("Unable to retrieve the ARWorldMap: \(error?.localizedDescription ?? "unknown error")")
                        return
                    }

                    do {
                        self.exportURL = try POCPackageExporter.export(
                            room: room,
                            worldMap: worldMap,
                            anchor: anchor,
                            recordedNodes: recorded,
                            floorID: floorID,
                            map: map,
                            stairs: draft.stairs.isEmpty ? nil : draft,
                            recoveredStairs: recoveredStairs,
                            surfaceColors: colors
                        )
                        try StairCatalogStore.save(draft)
                        self.catalog = draft
                        self.zoneConnectionsJSON = draft.navigatorZoneConnectionsJSON()
                        let linkCount = draft.navigatorZoneConnections().connections.count
                        let stairStatus = linkCount == 0
                            ? "No RoomPlan stair object was linked yet."
                            : "\(linkCount) RoomPlan stair link(s) written to zone-connections.json."
                        let colorStatus = colors?.summary ?? "No real colors: no usable scan photos were recorded."
                        self.previewSurfaces = surfaces
                        if let colors, let image = UIImage(data: colors.atlas) {
                            self.previewAtlas = image
                            self.previewColors = try? JSONDecoder().decode(SurfaceColorDocument.self, from: colors.json)
                        } else {
                            self.previewAtlas = nil
                            self.previewColors = nil
                        }
                        self.previewSummary = colorStatus
                        self.phase = .preview
                        self.statusText = "Package saved. \(colorStatus) \(stairStatus)"
                    } catch {
                        self.showError("Package export failed: \(error.localizedDescription)")
                    }
                }
            }
        }
    }

    private func preparePreview() async {
        let target = activeTarget
        exportPackage(
            zoneID: target?.zoneID ?? "1",
            floorID: target?.floorID ?? "ground"
        )
    }

    private func resetTracking() {
        let configuration = ARWorldTrackingConfiguration()
        configuration.planeDetection = [.horizontal, .vertical]
        configuration.environmentTexturing = .automatic
        arSession.run(configuration, options: [.resetTracking, .removeExistingAnchors])
    }

    func uploadPackage(buildingID rawBuildingID: String, versionID rawVersionID: String, zoneID rawZoneID: String, floorID rawFloorID: String, startNextZone: Bool = false, onNextZone: @escaping (String) -> Void = { _ in }) {
        guard let packageURL = exportURL else { showError("Export the scan before uploading it."); return }
        guard Auth.auth().currentUser != nil else { showError("Connect Firebase and sign in before uploading."); return }
        let buildingID = rawBuildingID.trimmingCharacters(in: .whitespacesAndNewlines)
        let versionID = rawVersionID.trimmingCharacters(in: .whitespacesAndNewlines)
        let zoneID = rawZoneID.trimmingCharacters(in: .whitespacesAndNewlines)
        let floorID = rawFloorID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !buildingID.isEmpty, !versionID.isEmpty, !zoneID.isEmpty, !floorID.isEmpty else { showError("Building, version, zone, and floor IDs are required."); return }

        isUploading = true
        phase = .uploading
        let attemptID = UUID()
        uploadAttemptID = attemptID
        let uploadTask = Task { @MainActor [self] in
            do {
                let repository = try FirebaseDataRepository()
                let buildingJSON = packageURL.appendingPathComponent("building.json")
                let scanJSON = packageURL.appendingPathComponent("scan.json")
                let scanFeatures = packageURL.appendingPathComponent("scan-features.json")
                let structure = packageURL.appendingPathComponent("structure.usdz")
                let worldMap = packageURL.appendingPathComponent("worldmap-\(zoneID).bin")
                guard FileManager.default.fileExists(atPath: buildingJSON.path),
                      FileManager.default.fileExists(atPath: scanJSON.path),
                      FileManager.default.fileExists(atPath: scanFeatures.path),
                      FileManager.default.fileExists(atPath: structure.path),
                      FileManager.default.fileExists(atPath: worldMap.path) else {
                    throw CocoaError(.fileNoSuchFile)
                }
                statusText = "Checking Firebase building…"
                let owner = Auth.auth().currentUser?.uid
                let existing = activeBuilding
                do {
                    try await repository.createBuilding(Building(
                        id: buildingID,
                        name: existing?.name ?? buildingID,
                        activeVersion: nil,
                        status: .draft,
                        createdAt: nil,
                        updatedAt: nil,
                        ownerUid: owner,
                        latitude: existing?.latitude,
                        longitude: existing?.longitude,
                        mapHeadingDegrees: existing?.mapHeadingDegrees
                    ))
                } catch FirebaseDataError.documentAlreadyExists { }
                try Task.checkCancellation()
                let api = try PackagePublishClient.live()
                var files = [
                    PackageUpload(name: "building.json", zoneId: zoneID, contentType: "application/json", fileURL: buildingJSON),
                    PackageUpload(name: "scan.json", zoneId: zoneID, contentType: "application/json", fileURL: scanJSON),
                    PackageUpload(name: "scan-features.json", zoneId: zoneID, contentType: "application/json", fileURL: scanFeatures),
                    PackageUpload(name: "structure.usdz", zoneId: zoneID, contentType: "model/vnd.usdz+zip", fileURL: structure),
                    PackageUpload(name: "worldmap.bin", zoneId: zoneID, contentType: "application/octet-stream", fileURL: worldMap),
                ]
                let colorsJSON = packageURL.appendingPathComponent(SurfaceColorBakeResult.jsonFileName)
                let colorsAtlas = packageURL.appendingPathComponent(SurfaceColorBakeResult.atlasFileName)
                if FileManager.default.fileExists(atPath: colorsJSON.path), FileManager.default.fileExists(atPath: colorsAtlas.path) {
                    files.append(PackageUpload(name: SurfaceColorBakeResult.jsonFileName, zoneId: zoneID, contentType: "application/json", fileURL: colorsJSON))
                    files.append(PackageUpload(name: SurfaceColorBakeResult.atlasFileName, zoneId: zoneID, contentType: "image/jpeg", fileURL: colorsAtlas))
                }
                let connectionsURL = packageURL.appendingPathComponent("zone-connections.json")
                if FileManager.default.fileExists(atPath: connectionsURL.path) {
                    files.append(PackageUpload(name: "zone-connections.json", zoneId: "", contentType: "application/json", fileURL: connectionsURL))
                }
                let layoutFile = try await layoutUpload(api: api, buildingID: buildingID, zoneID: zoneID, previousVersion: existing?.activeVersion)
                defer { if let layoutFile { try? FileManager.default.removeItem(at: layoutFile.fileURL) } }
                if let layoutFile { files.append(layoutFile) }
                try Task.checkCancellation()
                statusText = "Requesting upload URLs…"
                let session = try await api.startZonePublish(
                    buildingId: buildingID,
                    versionId: versionID,
                    zone: [
                        "zoneId": zoneID,
                        "floorId": floorID,
                        "name": activeTarget?.zoneName ?? zoneID,
                        "story": activeTarget?.level ?? 0,
                        "elevation": 0,
                        "relocalizationHint": "Look around the scanned area.",
                        "startNodeId": "",
                    ],
                    files: files
                )
                try Task.checkCancellation()
                for upload in session.uploads {
                    statusText = "Uploading \(upload.name)…"
                    try await api.upload([upload], files: files)
                    try Task.checkCancellation()
                }
                statusText = "Checking the package…"
                let committed = try await api.commit(buildingId: buildingID, publishId: session.publishId)
                try Task.checkCancellation()
                guard uploadAttemptID == attemptID else { return }
                statusText = "Uploaded \(activeTarget?.zoneName ?? zoneID) as \(committed.versionId)."
                phase = .preview
                if startNextZone {
                    let nextZone = String((Int(zoneID) ?? 0) + 1)
                    onNextZone(nextZone)
                    startScan()
                }
            } catch {
                if uploadAttemptID == attemptID, !(error is CancellationError) {
                    uploadLogger.error("Package upload failed: \(error.localizedDescription, privacy: .public)")
                    showError("Publish failed: \(error.localizedDescription)")
                }
            }
            if uploadAttemptID == attemptID {
                uploadAttemptID = nil
                isUploading = false
            }
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 180_000_000_000)
            guard uploadAttemptID == attemptID else { return }
            uploadTask.cancel()
            uploadLogger.error("Package upload timed out at step: \(self.statusText, privacy: .public)")
            uploadAttemptID = nil
            isUploading = false
            showError("Firebase did not finish within 3 minutes (last step: \(self.statusText)). Check the iPhone’s connection, then retry. A Firebase write already in progress may finish in the background.")
        }
    }

    func uploadZoneConnections(buildingID rawBuildingID: String, versionID rawVersionID: String, json: String) {
        guard Auth.auth().currentUser != nil else { showError("Connect Firebase and sign in before uploading."); return }
        let buildingID = rawBuildingID.trimmingCharacters(in: .whitespacesAndNewlines)
        let versionID = rawVersionID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !buildingID.isEmpty, !versionID.isEmpty else { showError("Building and version IDs are required."); return }
        guard let data = json.data(using: .utf8), (try? JSONSerialization.jsonObject(with: data)) != nil else { showError("Zone connections must be valid JSON."); return }
        isUploading = true
        Task {
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("zone-connections-\(UUID().uuidString).json")
            defer { try? FileManager.default.removeItem(at: file) }
            do {
                try data.write(to: file, options: .atomic)
                let api = try PackagePublishClient.live()
                let upload = PackageUpload(name: "zone-connections.json", zoneId: "", contentType: "application/json", fileURL: file)
                let session = try await api.startFilePublish(buildingId: buildingID, versionId: versionID, files: [upload])
                try await api.upload(session.uploads, files: [upload])
                let committed = try await api.commit(buildingId: buildingID, publishId: session.publishId)
                statusText = "Zone connections published as \(committed.versionId)."
            } catch { showError("Zone connection upload failed: \(error.localizedDescription)") }
            isUploading = false
        }
    }

    /// Merges this zone into the previous layout and returns a file for the new immutable version.
    private func layoutUpload(api: PackagePublishClient, buildingID: String, zoneID: String, previousVersion: String?) async throws -> PackageUpload? {
        guard let target = activeTarget else { return nil }
        var layout = BuildingLayoutDocument()
        if previousVersion?.isEmpty == false,
           let data = try? await api.downloadActiveLayout(buildingId: buildingID),
           let decoded = try? JSONDecoder().decode(BuildingLayoutDocument.self, from: data) {
            layout = decoded
        }
        let placement = target.previousPlacement
            ?? .beside(levelBounds: target.levelBounds, zoneId: zoneID, level: target.level)
        layout.upsert(placement)
        layout.setFloorName(target.levelName, for: target.level)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(LayoutWire(schemaVersion: layout.schemaVersion, zones: layout.zones, floors: layout.floors, notes: layout.notes))
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("building-layout-\(UUID().uuidString).json")
        try data.write(to: url, options: .atomic)
        return PackageUpload(name: "building-layout.json", zoneId: "", contentType: "application/json", fileURL: url)
    }

    private func currentCameraPosition() -> [Float]? {
        guard let frame = arSession.currentFrame else { return nil }
        let translation = frame.camera.transform.columns.3
        return [translation.x, translation.y, translation.z]
    }

    private func startPathSampling() {
        sampleWalkedPathIfNeeded()
        pathSamplingTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self, self.isScanning else { return }
            self.sampleWalkedPathIfNeeded()
            if let frame = self.arSession.currentFrame {
                self.colorRecorder.consider(frame)
                self.colorFrameCount = self.colorRecorder.count
            }
        }
    }

    private func stopPathSampling() {
        pathSamplingTimer?.invalidate()
        pathSamplingTimer = nil
        lastSampledPosition = nil
    }

    private func sampleWalkedPathIfNeeded() {
        guard let position = currentCameraPosition() else { return }
        guard let previous = lastSampledPosition else {
            appendWalkedNode(at: position)
            return
        }

        let horizontalDistance = hypot(position[0] - previous[0], position[2] - previous[2])
        guard horizontalDistance >= automaticNodeSpacingMeters else { return }
        appendWalkedNode(at: position)
    }

    private func appendWalkedNode(at position: [Float]) {
        recordedNodes.append(
            RecordedGraphNode(
                type: .waypoint,
                label: nil,
                position: position,
                capturedAt: ISO8601DateFormatter().string(from: Date())
            )
        )
        lastSampledPosition = position
        statusText = "Scanning. Walked path: \(recordedNodes.count) nodes."
    }

    private func fallbackAnchor() -> TestAnchor {
        let position = recordedNodes.first?.position ?? [0, 0, 0]
        return TestAnchor(
            schemaVersion: 1,
            zoneID: "",
            position: position,
            coordinateSystem: "arkit-world-meters",
            capturedAt: ISO8601DateFormatter().string(from: Date()),
            notes: "Filled from the first recorded graph node because no test cube point was marked."
        )
    }

    private func showError(_ message: String) {
        errorMessage = message
        showsError = true
        statusText = "Needs attention"
    }
}
