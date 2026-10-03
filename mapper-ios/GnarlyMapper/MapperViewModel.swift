import ARKit
import Foundation
import RoomPlan
import simd

@MainActor
final class MapperViewModel: ObservableObject {
    @Published private(set) var statusText = "Preparing AR session…"
    @Published private(set) var isScanning = false
    @Published private(set) var exportURL: URL?
    @Published var showsError = false
    @Published private(set) var errorMessage = ""

    let arSession = ARSession()
    private weak var captureView: RoomCaptureView?
    private var capturedRoom: CapturedRoom?
    private var testAnchor: TestAnchor?

    var canMarkAnchor: Bool {
        capturedRoom != nil && arSession.currentFrame != nil
    }

    var canExport: Bool {
        capturedRoom != nil && testAnchor != nil
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
        exportURL = nil
        captureView?.captureSession.run(configuration: .init())
        isScanning = true
        statusText = "Scanning with the shared AR session"
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
                statusText = "Room ready. Stand at the cube test point and mark it."
            } catch {
                showError("Unable to build the captured room: \(error.localizedDescription)")
            }
        }
    }

    func markTestAnchor() {
        guard let frame = arSession.currentFrame else {
            showError("ARKit has no current camera frame. Look around until tracking resumes.")
            return
        }

        let translation = frame.camera.transform.columns.3
        testAnchor = TestAnchor(
            schemaVersion: 1,
            zoneID: "",
            position: [translation.x, translation.y, translation.z],
            coordinateSystem: "arkit-world-meters",
            capturedAt: ISO8601DateFormatter().string(from: Date()),
            notes: "Camera position captured by GnarlyMapper."
        )
        statusText = "Test anchor marked. Export the package when ready."
    }

    func exportPackage(zoneID rawZoneID: String) {
        guard let room = capturedRoom, let anchor = testAnchor else {
            showError("Finish a room scan and mark a test anchor before exporting.")
            return
        }

        let zoneID = rawZoneID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !zoneID.isEmpty else {
            showError("Enter a non-empty zone ID, such as zone-a.")
            return
        }

        statusText = "Saving ARWorldMap and RoomPlan output…"
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
                        anchor: anchor.withZoneID(zoneID)
                    )
                    self.statusText = "Package saved. Share it with the Unity engineer."
                } catch {
                    self.showError("Package export failed: \(error.localizedDescription)")
                }
            }
        }
    }

    private func showError(_ message: String) {
        errorMessage = message
        showsError = true
        statusText = "Needs attention"
    }
}
