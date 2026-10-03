import ARKit
import FirebaseAuth
import Foundation
import RoomPlan

@MainActor
final class MapperViewModel: ObservableObject {
    @Published private(set) var statusText = "Preparing AR session…"
    @Published private(set) var isScanning = false
    @Published private(set) var exportURL: URL?
    @Published private(set) var recordedNodes: [RecordedGraphNode] = []
    @Published private(set) var isUploading = false
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
                statusText = "Room ready. Mark the cube point, then export the package."
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

    func exportPackage(zoneID rawZoneID: String, floorID rawFloorID: String) {
        guard let room = capturedRoom else {
            showError("Finish a room scan before exporting.")
            return
        }

        let zoneID = rawZoneID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !zoneID.isEmpty else {
            showError("Enter a non-empty zone ID, such as zone-a.")
            return
        }

        let floorID = rawFloorID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !floorID.isEmpty else {
            showError("Enter a floor ID, such as ground.")
            return
        }

        let anchor = (testAnchor ?? fallbackAnchor()).withZoneID(zoneID)

        statusText = "Saving ARWorldMap, RoomPlan scan, and building graph…"
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
                        recordedNodes: self.recordedNodes,
                        floorID: floorID
                    )
                    self.statusText = "Package saved. Share it for Unity relocalization and graph work."
                } catch {
                    self.showError("Package export failed: \(error.localizedDescription)")
                }
            }
        }
    }

    func uploadPackage(buildingID rawBuildingID: String, zoneID rawZoneID: String, floorID rawFloorID: String) {
        guard let packageURL = exportURL else { showError("Export the scan before uploading it."); return }
        guard Auth.auth().currentUser != nil else { showError("Connect Firebase and sign in before uploading."); return }
        let buildingID = rawBuildingID.trimmingCharacters(in: .whitespacesAndNewlines)
        let zoneID = rawZoneID.trimmingCharacters(in: .whitespacesAndNewlines)
        let floorID = rawFloorID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !buildingID.isEmpty, !zoneID.isEmpty, !floorID.isEmpty else { showError("Building, zone, and floor IDs are required."); return }

        isUploading = true
        Task {
            do {
                let repository = try FirebaseDataRepository()
                let versionID = "v-\(Int(Date().timeIntervalSince1970))"
                let buildingJSON = packageURL.appendingPathComponent("building.json")
                let worldMap = packageURL.appendingPathComponent("worldmap-\(zoneID).bin")
                guard FileManager.default.fileExists(atPath: buildingJSON.path), FileManager.default.fileExists(atPath: worldMap.path) else {
                    throw CocoaError(.fileNoSuchFile)
                }
                do {
                    try await repository.createBuilding(Building(id: buildingID, name: buildingID, activeVersion: nil, status: .draft, createdAt: nil, updatedAt: nil))
                } catch FirebaseDataError.documentAlreadyExists { }
                try await repository.saveVersion(BuildingVersion(id: versionID, versionNumber: Int(Date().timeIntervalSince1970), status: .draft, buildingJsonPath: nil, structurePath: nil, createdAt: nil, publishedAt: nil), buildingId: buildingID)
                try await repository.saveFloor(Floor(id: floorID, name: floorID, story: 0, elevation: 0), buildingId: buildingID, versionId: versionID)
                try await repository.saveZone(Zone(id: zoneID, name: zoneID, floorId: floorID, worldMapPath: nil, relocalizationHint: "Look around the scanned area.", startNodeId: ""), buildingId: buildingID, versionId: versionID)
                try await repository.uploadBuildingJSON(from: buildingJSON, buildingId: buildingID, versionId: versionID)
                try await repository.uploadWorldMap(from: worldMap, buildingId: buildingID, versionId: versionID, zoneId: zoneID)
                try await repository.saveVersion(BuildingVersion(id: versionID, versionNumber: Int(Date().timeIntervalSince1970), status: .published, buildingJsonPath: nil, structurePath: nil, createdAt: nil, publishedAt: Date()), buildingId: buildingID)
                try await repository.updateBuilding(Building(id: buildingID, name: buildingID, activeVersion: versionID, status: .active, createdAt: nil, updatedAt: nil))
                statusText = "Uploaded \(buildingID)/\(versionID). Navigator can download it now."
            } catch { showError("Firebase upload failed: \(error.localizedDescription)") }
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
