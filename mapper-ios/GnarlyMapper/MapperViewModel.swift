import ARKit
import FirebaseAuth
import Foundation
import OSLog
import RoomPlan

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
    private var uploadAttemptID: UUID?

    private enum ScanTarget {
        case floor
        case stairs
    }

    private var scanTarget: ScanTarget = .floor
    @Published var showsError = false
    @Published private(set) var errorMessage = ""

    let arSession = ARSession()
    private weak var captureView: RoomCaptureView?
    private var capturedRoom: CapturedRoom?
    private var testAnchor: TestAnchor?
    private var pathSamplingTimer: Timer?
    private var lastSampledPosition: [Float]?
    private let automaticNodeSpacingMeters: Float = 0.75

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
        startScan()
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
        }
        captureView?.captureSession.run(configuration: .init())
        isScanning = true
        statusText = "Scanning. Walk the route; path nodes save automatically every 0.75 m."
        startPathSampling()
    }

    func finishRoom() {
        guard isScanning else { return }
        statusText = "Processing RoomPlan scan…"
        isScanning = false
        stopPathSampling()
        // Keep ARKit running so its coordinate system remains valid for map export.
        captureView?.captureSession.stop(pauseARSession: false)
    }

    func didFinishCapture(data: CapturedRoomData, error: Error?) {
        if let error {
            showError("RoomPlan stopped with an error: \(error.localizedDescription)")
            return
        }

        Task {
            do {
                let room = try await RoomBuilder(options: [.beautifyObjects]).capturedRoom(from: data)
                capturedRoom = room
                if scanTarget == .floor {
                    detectedStairs = RoomPlanScanExtractor.detectedStairs(in: room)
                    statusText = detectedStairs.isEmpty
                        ? "Room ready. Mark the cube point, then export the package."
                        : "RoomPlan found \(detectedStairs.count) stair object(s). Export this floor, then scan the stairwell."
                } else {
                    statusText = "Stairwell ready. Export this zone so its landings can connect to the floors."
                }
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
        statusText = asStairs
            ? "Saving the stair zone world map and RoomPlan stair links…"
            : "Saving ARWorldMap, RoomPlan scan, and building graph…"
        arSession.getCurrentWorldMap { [weak self] worldMap, error in
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
                        stairs: draft.stairs.isEmpty ? nil : draft
                    )
                    try StairCatalogStore.save(draft)
                    self.catalog = draft
                    self.zoneConnectionsJSON = draft.navigatorZoneConnectionsJSON()
                    let linkCount = draft.navigatorZoneConnections().connections.count
                    if linkCount == 0 {
                        self.statusText = "Package saved. No RoomPlan stair object was linked yet."
                    } else {
                        self.statusText = "Package saved. \(linkCount) RoomPlan stair link(s) written to zone-connections.json."
                    }
                } catch {
                    self.showError("Package export failed: \(error.localizedDescription)")
                }
            }
        }
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
                do {
                    try await repository.createBuilding(Building(id: buildingID, name: buildingID, activeVersion: nil, status: .draft, createdAt: nil, updatedAt: nil))
                } catch FirebaseDataError.documentAlreadyExists { }
                try Task.checkCancellation()
                statusText = "Saving version \(versionID)…"
                try await repository.saveVersion(BuildingVersion(id: versionID, versionNumber: Int(Date().timeIntervalSince1970), status: .draft, buildingJsonPath: nil, structurePath: nil, createdAt: nil, publishedAt: nil), buildingId: buildingID)
                try Task.checkCancellation()
                statusText = "Saving floor \(floorID)…"
                try await repository.saveFloor(Floor(id: floorID, name: floorID, story: 0, elevation: 0), buildingId: buildingID, versionId: versionID)
                try Task.checkCancellation()
                statusText = "Saving zone \(zoneID)…"
                try await repository.saveZone(Zone(id: zoneID, name: zoneID, floorId: floorID, worldMapPath: nil, buildingJsonPath: nil, relocalizationHint: "Look around the scanned area.", startNodeId: ""), buildingId: buildingID, versionId: versionID)
                try Task.checkCancellation()
                statusText = "Uploading zone graph…"
                try await repository.uploadZoneBuildingJSON(from: buildingJSON, buildingId: buildingID, versionId: versionID, zoneId: zoneID)
                try Task.checkCancellation()
                statusText = "Uploading RoomPlan scan…"
                try await repository.uploadZoneScanJSON(from: scanJSON, buildingId: buildingID, versionId: versionID, zoneId: zoneID) { [weak self] progress in
                    guard let progress, progress.totalUnitCount > 0 else { return }
                    let percent = Int(progress.fractionCompleted * 100)
                    Task { @MainActor [weak self] in
                        guard let self, self.uploadAttemptID == attemptID,
                              self.statusText.hasPrefix("Uploading RoomPlan scan") else { return }
                        self.statusText = "Uploading RoomPlan scan… \(percent)%"
                    }
                }
                try Task.checkCancellation()
                statusText = "Uploading scan features…"
                try await repository.uploadZoneScanFeatures(from: scanFeatures, buildingId: buildingID, versionId: versionID, zoneId: zoneID)
                try Task.checkCancellation()
                statusText = "Uploading 3D room model…"
                try await repository.uploadZoneStructure(from: structure, buildingId: buildingID, versionId: versionID, zoneId: zoneID)
                try Task.checkCancellation()
                statusText = "Uploading AR world map…"
                try await repository.uploadWorldMap(from: worldMap, buildingId: buildingID, versionId: versionID, zoneId: zoneID)
                try Task.checkCancellation()
                let connectionsURL = packageURL.appendingPathComponent("zone-connections.json")
                if FileManager.default.fileExists(atPath: connectionsURL.path) {
                    statusText = "Uploading RoomPlan stair links…"
                    _ = try await repository.uploadZoneConnections(from: connectionsURL, buildingId: buildingID, versionId: versionID)
                    try Task.checkCancellation()
                }
                statusText = "Publishing building version…"
                try await repository.saveVersion(BuildingVersion(id: versionID, versionNumber: Int(Date().timeIntervalSince1970), status: .published, buildingJsonPath: nil, structurePath: nil, createdAt: nil, publishedAt: Date()), buildingId: buildingID)
                try Task.checkCancellation()
                try await repository.updateBuilding(Building(id: buildingID, name: buildingID, activeVersion: versionID, status: .active, createdAt: nil, updatedAt: nil))
                try Task.checkCancellation()
                guard uploadAttemptID == attemptID else { return }
                statusText = "Uploaded zone \(zoneID) to \(buildingID)/\(versionID). Add more zones with this same version."
                if startNextZone {
                    let nextZone = String((Int(zoneID) ?? 0) + 1)
                    onNextZone(nextZone)
                    startScan()
                }
            } catch {
                if uploadAttemptID == attemptID, !(error is CancellationError) {
                    uploadLogger.error("Package upload failed: \(error.localizedDescription, privacy: .public)")
                    showError("Firebase upload failed: \(error.localizedDescription)")
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
            do {
                let file = FileManager.default.temporaryDirectory.appendingPathComponent("zone-connections-\(UUID().uuidString).json")
                try data.write(to: file, options: .atomic)
                defer { try? FileManager.default.removeItem(at: file) }
                let repository = try FirebaseDataRepository()
                _ = try await repository.uploadZoneConnections(from: file, buildingId: buildingID, versionId: versionID)
                statusText = "Zone connections uploaded for \(buildingID)/\(versionID)."
            } catch { showError("Zone connection upload failed: \(error.localizedDescription)") }
            isUploading = false
        }
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
