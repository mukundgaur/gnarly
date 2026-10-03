import ARKit
import Foundation
import RoomPlan

@MainActor
final class MapperViewModel: ObservableObject {
    @Published private(set) var statusText = "Preparing AR session…"
    @Published private(set) var isScanning = false
    @Published private(set) var exportURL: URL?
    @Published private(set) var recordedNodes: [RecordedGraphNode] = []
    @Published var showsError = false
    @Published private(set) var errorMessage = ""

    let arSession = ARSession()
    private weak var captureView: RoomCaptureView?
    private var capturedRoom: CapturedRoom?
    private var testAnchor: TestAnchor?

    var canMarkAnchor: Bool {
        arSession.currentFrame != nil
    }

    var canAddNode: Bool {
        arSession.currentFrame != nil
    }

    var canExport: Bool {
        capturedRoom != nil && (testAnchor != nil || !recordedNodes.isEmpty)
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

        capturedRoom = nil
        testAnchor = nil
        recordedNodes = []
        exportURL = nil
        captureView?.captureSession.run(configuration: .init())
        isScanning = true
        statusText = "Scanning. Mark hallway, door, stair, and destination nodes as you walk."
    }

    func finishRoom() {
        guard isScanning else { return }
        statusText = "Processing RoomPlan scan…"
        isScanning = false
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
                statusText = "Room ready. Add any remaining graph nodes, mark the cube point, then export."
            } catch {
                showError("Unable to build the captured room: \(error.localizedDescription)")
            }
        }
    }

    func addNode(type: GraphNodeType, label: String) {
        guard let position = currentCameraPosition() else {
            showError("ARKit has no current camera frame. Look around until tracking resumes.")
            return
        }

        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        recordedNodes.append(
            RecordedGraphNode(
                type: type,
                label: trimmed.isEmpty ? nil : trimmed,
                position: position,
                capturedAt: ISO8601DateFormatter().string(from: Date())
            )
        )
        statusText = "Nodes: \(recordedNodes.count). Last: \(trimmed.isEmpty ? type.title : trimmed)."
    }

    func undoLastNode() {
        guard !recordedNodes.isEmpty else { return }
        recordedNodes.removeLast()
        statusText = recordedNodes.isEmpty ? "No recorded nodes." : "Nodes: \(recordedNodes.count)."
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

    private func currentCameraPosition() -> [Float]? {
        guard let frame = arSession.currentFrame else { return nil }
        let translation = frame.camera.transform.columns.3
        return [translation.x, translation.y, translation.z]
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
