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
    private let marker = ModelEntity(mesh: .generateSphere(radius: 0.16), materials: [SimpleMaterial(color: .systemMint, isMetallic: true)])
    private var load: AnyCancellable?

    init(url: URL) { self.url = url; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        arView.frame = view.bounds; arView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(arView); arView.scene.addAnchor(modelAnchor); arView.scene.addAnchor(cameraAnchor)
        cameraAnchor.addChild(camera)
        marker.position = [0, 0.2, 0]; modelAnchor.addChild(marker)
        let close = UIButton(type: .system); close.setTitle("×", for: .normal); close.titleLabel?.font = .systemFont(ofSize: 34, weight: .bold)
        close.tintColor = .white; close.backgroundColor = UIColor.black.withAlphaComponent(0.6); close.layer.cornerRadius = 22
        close.frame = CGRect(x: 22, y: 56, width: 44, height: 44); close.addTarget(self, action: #selector(dismissModel), for: .touchUpInside); view.addSubview(close)
        load = Entity.loadAsync(contentsOf: url).sink(receiveCompletion: { _ in }, receiveValue: { [weak self] entity in
            guard let self else { return }
            let bounds = entity.visualBounds(relativeTo: nil)
            entity.position = -bounds.center
            self.modelAnchor.addChild(entity)
            let largestDimension = max(bounds.extents.x, max(bounds.extents.y, bounds.extents.z))
            let distance = max(2.5, largestDimension * 1.7)
            self.camera.look(at: .zero, from: SIMD3<Float>(0, largestDimension * 0.35, distance), relativeTo: nil)
        })
    }
    func setPosition(_ position: SIMD3<Float>) { marker.position = position + SIMD3<Float>(0, 0.2, 0) }
    @objc private func dismissModel() { dismiss(animated: true) }
}
