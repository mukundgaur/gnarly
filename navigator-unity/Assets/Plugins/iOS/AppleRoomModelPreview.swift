import Foundation
import UIKit
import RealityKit
import Combine

private weak var activeRoomModelController: RoomModelViewController?

@_cdecl("GnarlyShowRoomModel")
public func GnarlyShowRoomModel(_ path: UnsafePointer<CChar>?) {
    guard let path, FileManager.default.fileExists(atPath: String(cString: path)) else { return }
    DispatchQueue.main.async {
        guard let presenter = UIApplication.shared.connectedScenes
            .compactMap({ ($0 as? UIWindowScene)?.keyWindow })
            .first?.rootViewController?.topPresenter else { return }
        let controller = RoomModelViewController(url: URL(fileURLWithPath: String(cString: path)))
        controller.modalPresentationStyle = .fullScreen
        activeRoomModelController = controller
        presenter.present(controller, animated: true)
    }
}

@_cdecl("GnarlyUpdateRoomModelPosition")
public func GnarlyUpdateRoomModelPosition(_ x: Float, _ y: Float, _ z: Float) {
    DispatchQueue.main.async { activeRoomModelController?.setPosition(SIMD3<Float>(x, y, z)) }
}

private extension UIViewController {
    var topPresenter: UIViewController { presentedViewController?.topPresenter ?? self }
}

private final class RoomModelViewController: UIViewController {
    private let url: URL
    private let arView = ARView(frame: .zero, cameraMode: .nonAR, automaticallyConfigureSession: false)
    private let modelAnchor = AnchorEntity(world: .zero)
    private let cameraAnchor = AnchorEntity(world: .zero)
    private let camera = PerspectiveCamera()
    private var marker: ModelEntity?
    private var modelCenter = SIMD3<Float>.zero
    private var pendingPosition = SIMD3<Float>.zero
    private var load: AnyCancellable?
    private let statusLabel = UILabel()

    init(url: URL) { self.url = url; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        arView.frame = view.bounds; arView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(arView); arView.scene.addAnchor(modelAnchor); arView.scene.addAnchor(cameraAnchor)
        cameraAnchor.addChild(camera)
        statusLabel.text = "Loading indoor model…"
        statusLabel.textColor = .white
        statusLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0
        statusLabel.frame = CGRect(x: 24, y: 110, width: view.bounds.width - 48, height: 80)
        statusLabel.autoresizingMask = [.flexibleWidth]
        view.addSubview(statusLabel)
        let close = UIButton(type: .system); close.setTitle("×", for: .normal); close.titleLabel?.font = .systemFont(ofSize: 34, weight: .bold)
        close.tintColor = .white; close.backgroundColor = UIColor.black.withAlphaComponent(0.6); close.layer.cornerRadius = 22
        close.frame = CGRect(x: 22, y: 56, width: 44, height: 44); close.addTarget(self, action: #selector(dismissModel), for: .touchUpInside); view.addSubview(close)
        load = Entity.loadAsync(contentsOf: url).sink(receiveCompletion: { [weak self] completion in
            if case let .failure(error) = completion {
                self?.statusLabel.text = "Could not load the RoomPlan model.\n\(error.localizedDescription)"
            }
        }, receiveValue: { [weak self] entity in
            guard let self else { return }
            let bounds = entity.visualBounds(relativeTo: nil)
            let largestDimension = max(bounds.extents.x, max(bounds.extents.y, bounds.extents.z))
            guard largestDimension.isFinite, largestDimension > 0.05 else {
                self.statusLabel.text = "The RoomPlan model has invalid bounds."
                return
            }

            self.modelCenter = bounds.center
            entity.position = -self.modelCenter
            self.modelAnchor.addChild(entity)
            let markerRadius = min(0.09, max(0.035, largestDimension * 0.009))
            let marker = ModelEntity(
                mesh: .generateSphere(radius: markerRadius),
                materials: [UnlitMaterial(color: .systemMint)]
            )
            self.marker = marker
            self.modelAnchor.addChild(marker)
            self.updateMarkerPosition()

            let distance = max(2.5, largestDimension * 1.45)
            self.camera.look(
                at: .zero,
                from: SIMD3<Float>(largestDimension * 0.15, largestDimension * 0.65, distance),
                relativeTo: nil
            )
            self.statusLabel.isHidden = true
        })
    }
    func setPosition(_ position: SIMD3<Float>) {
        pendingPosition = position
        updateMarkerPosition()
    }
    private func updateMarkerPosition() {
        marker?.position = pendingPosition - modelCenter + SIMD3<Float>(0, 0.12, 0)
    }
    @objc private func dismissModel() { dismiss(animated: true) }
}
