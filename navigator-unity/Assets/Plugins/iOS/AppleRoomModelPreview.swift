import Foundation
import UIKit
import RealityKit
import Combine

@_silgen_name("UnitySendMessage")
private func UnitySendMessage(
    _ objectName: UnsafePointer<CChar>,
    _ methodName: UnsafePointer<CChar>,
    _ message: UnsafePointer<CChar>
)

private weak var activeRoomModelController: RoomModelViewController?

@_cdecl("GnarlyShowRoomModel")
public func GnarlyShowRoomModel(
    _ modelPath: UnsafePointer<CChar>?,
    _ buildingPath: UnsafePointer<CChar>?,
    _ scanPath: UnsafePointer<CChar>?,
    _ callbackObjectName: UnsafePointer<CChar>?,
    _ selectionJSON: UnsafePointer<CChar>?
) {
    guard let modelPath, let buildingPath, let scanPath, let callbackObjectName else {
        NSLog("[Gnarly] Cannot open the room model because a required native bridge argument is nil.")
        return
    }

    // Copy C strings before returning to Unity; their pointers are not valid inside the async block.
    let model = String(cString: modelPath)
    let building = String(cString: buildingPath)
    let scan = String(cString: scanPath)
    let callback = String(cString: callbackObjectName)
    let selection = selectionJSON
        .map { String(cString: $0) }
        .flatMap { try? JSONDecoder().decode(MapRouteRequest.self, from: Data($0.utf8)) }
    let missing = [model, building, scan].filter { !FileManager.default.fileExists(atPath: $0) }
    guard missing.isEmpty else {
        NSLog("[Gnarly] Cannot open interactive room model. Missing files: %@", missing.joined(separator: ", "))
        return
    }

    DispatchQueue.main.async {
        guard let presenter = UIApplication.shared.connectedScenes
            .compactMap({ ($0 as? UIWindowScene)?.keyWindow })
            .first?.rootViewController?.topPresenter else {
            NSLog("[Gnarly] Cannot open interactive room model because no presenting view controller exists.")
            return
        }
        let controller = RoomModelViewController(
            modelURL: URL(fileURLWithPath: model),
            buildingURL: URL(fileURLWithPath: building),
            scanURL: URL(fileURLWithPath: scan),
            callbackObjectName: callback,
            initialSelection: selection
        )
        controller.modalPresentationStyle = .fullScreen
        activeRoomModelController = controller
        presenter.present(controller, animated: true)
    }
}

@_cdecl("GnarlyUpdateRoomModelPosition")
public func GnarlyUpdateRoomModelPosition(_ x: Float, _ y: Float, _ z: Float) {
    DispatchQueue.main.async { activeRoomModelController?.setPosition(SIMD3<Float>(x, y, z)) }
}

@_cdecl("GnarlySetRoomModelRoute")
public func GnarlySetRoomModelRoute(_ routeJSON: UnsafePointer<CChar>?) {
    guard let routeJSON else {
        NSLog("[Gnarly] Cannot draw a room-model route because the route JSON is nil.")
        return
    }
    let json = String(cString: routeJSON)
    DispatchQueue.main.async { activeRoomModelController?.setRoute(json) }
}

@_cdecl("GnarlySetRoomModelStatus")
public func GnarlySetRoomModelStatus(_ message: UnsafePointer<CChar>?) {
    guard let message else { return }
    let text = String(cString: message)
    DispatchQueue.main.async { activeRoomModelController?.setStatus(text) }
}

private extension UIViewController {
    var topPresenter: UIViewController { presentedViewController?.topPresenter ?? self }
}

private struct BuildingDocument: Decodable { let nodes: [NavigationNode] }

private struct NavigationNode: Decodable {
    let id: String
    let type: String
    let position: [Float]
    let label: String?
}

private struct ScanDocument: Decodable {
    let doors: [ScanSurface]
    let openings: [ScanSurface]
    let objects: [ScanObject]
    let sections: [ScanSection]
}

private struct ScanSurface: Decodable {
    let identifier: String
    let category: String
    let position: [Float]
}

private struct ScanObject: Decodable {
    let identifier: String
    let category: String
    let position: [Float]
}

private struct ScanSection: Decodable {
    let label: String
    let center: [Float]
}

private struct NativeRoute: Decodable { let waypoints: [NativeWaypoint] }
private struct NativeWaypoint: Decodable { let position: [Float] }

/// Node IDs local to this zone. An empty startId means "start from my location".
private struct MapRouteRequest: Codable {
    let startId: String
    let destinationId: String
}

private final class RoomModelViewController: UIViewController, UIGestureRecognizerDelegate {
    private let modelURL: URL
    private let buildingURL: URL
    private let scanURL: URL
    private let callbackObjectName: String
    private let initialSelection: MapRouteRequest?
    private let arView = ARView(frame: .zero, cameraMode: .nonAR, automaticallyConfigureSession: false)
    private let modelAnchor = AnchorEntity(world: .zero)
    private let cameraAnchor = AnchorEntity(world: .zero)
    private let camera = PerspectiveCamera()
    private let routeRoot = Entity()
    private var userMarker: ModelEntity?
    private var modelCenter = SIMD3<Float>.zero
    private var pendingPosition = SIMD3<Float>.zero
    private var load: AnyCancellable?
    private var nodes = [NavigationNode]()
    private var markers = [String: ModelEntity]()
    private var selectedNode: NavigationNode?
    /// nil means the route starts from the user's current position.
    private var startNode: NavigationNode?
    private var destinationNode: NavigationNode?

    private var focus = SIMD3<Float>.zero
    private var yaw: Float = 0.2
    private var pitch: Float = 0.55
    private var distance: Float = 5
    private var minimumDistance: Float = 0.8
    private var maximumDistance: Float = 30

    private let statusLabel = UILabel()
    private let selectedLabel = UILabel()
    private let summaryLabel = UILabel()
    private let setStartButton = UIButton(type: .system)
    private let setDestinationButton = UIButton(type: .system)
    private let showRouteButton = UIButton(type: .system)
    private let myLocationButton = UIButton(type: .system)
    private let swapButton = UIButton(type: .system)
    private let clearButton = UIButton(type: .system)

    init(modelURL: URL, buildingURL: URL, scanURL: URL, callbackObjectName: String, initialSelection: MapRouteRequest?) {
        self.modelURL = modelURL
        self.buildingURL = buildingURL
        self.scanURL = scanURL
        self.callbackObjectName = callbackObjectName
        self.initialSelection = initialSelection
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        buildScene()
        buildControls()
        installGestures()
        loadDocumentsAndModel()
    }

    private func buildScene() {
        arView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(arView)
        NSLayoutConstraint.activate([
            arView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            arView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            arView.topAnchor.constraint(equalTo: view.topAnchor),
            arView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        arView.scene.addAnchor(modelAnchor)
        arView.scene.addAnchor(cameraAnchor)
        cameraAnchor.addChild(camera)
        modelAnchor.addChild(routeRoot)
    }

    private func buildControls() {
        let close = makeButton("‹  Back", action: #selector(dismissModel))
        let reset = makeButton("Reset View", action: #selector(resetView))
        let topBar = UIStackView(arrangedSubviews: [close, UIView(), reset])
        topBar.axis = .horizontal
        topBar.alignment = .center
        topBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(topBar)

        statusLabel.text = "Loading scanned building…"
        statusLabel.textColor = .white
        statusLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(statusLabel)

        let panel = UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterial))
        panel.layer.cornerRadius = 20
        panel.clipsToBounds = true
        panel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(panel)

        selectedLabel.text = "Tap a dot to pick a room, door, or destination"
        selectedLabel.textColor = .label
        selectedLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        selectedLabel.numberOfLines = 2

        configureActionButton(setStartButton, title: "Set as Start", color: .systemGreen, action: #selector(setSelectedAsStart))
        configureActionButton(setDestinationButton, title: "Set as Destination", color: .systemPink, action: #selector(setSelectedAsDestination))
        configureActionButton(showRouteButton, title: "Navigate in AR", color: .systemBlue, action: #selector(showRoute))
        configureActionButton(myLocationButton, title: "My Location", color: .systemGray, action: #selector(useMyLocation))
        configureActionButton(swapButton, title: "Swap", color: .systemGray, action: #selector(swapSelection))
        configureActionButton(clearButton, title: "Clear", color: .systemGray, action: #selector(clearSelection))
        setStartButton.isEnabled = false
        setDestinationButton.isEnabled = false
        showRouteButton.isEnabled = false

        summaryLabel.textColor = .label
        summaryLabel.font = .systemFont(ofSize: 16, weight: .medium)
        summaryLabel.numberOfLines = 2
        updateSummary()

        let selectionActions = UIStackView(arrangedSubviews: [setStartButton, setDestinationButton])
        selectionActions.axis = .horizontal
        selectionActions.spacing = 10
        selectionActions.distribution = .fillEqually

        let editActions = UIStackView(arrangedSubviews: [myLocationButton, swapButton, clearButton])
        editActions.axis = .horizontal
        editActions.spacing = 10
        editActions.distribution = .fillEqually

        let controls = UIStackView(arrangedSubviews: [selectedLabel, selectionActions, summaryLabel, editActions, showRouteButton])
        controls.axis = .vertical
        controls.spacing = 10
        controls.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView.addSubview(controls)

        NSLayoutConstraint.activate([
            topBar.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            topBar.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            topBar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 10),
            statusLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 70),
            statusLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -70),
            statusLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 64),
            panel.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 14),
            panel.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -14),
            panel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
            controls.leadingAnchor.constraint(equalTo: panel.contentView.leadingAnchor, constant: 16),
            controls.trailingAnchor.constraint(equalTo: panel.contentView.trailingAnchor, constant: -16),
            controls.topAnchor.constraint(equalTo: panel.contentView.topAnchor, constant: 14),
            controls.bottomAnchor.constraint(equalTo: panel.contentView.bottomAnchor, constant: -14),
            setStartButton.heightAnchor.constraint(equalToConstant: 44),
            setDestinationButton.heightAnchor.constraint(equalToConstant: 44),
            myLocationButton.heightAnchor.constraint(equalToConstant: 38),
            showRouteButton.heightAnchor.constraint(equalToConstant: 50)
        ])
    }

    private func makeButton(_ title: String, action: Selector) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(title, for: .normal)
        button.setTitleColor(.white, for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 17, weight: .bold)
        button.backgroundColor = UIColor.black.withAlphaComponent(0.58)
        button.layer.cornerRadius = 12
        button.heightAnchor.constraint(equalToConstant: 44).isActive = true
        button.addTarget(self, action: action, for: .touchUpInside)
        return button
    }

    private func configureActionButton(_ button: UIButton, title: String, color: UIColor, action: Selector) {
        button.setTitle(title, for: .normal)
        button.setTitleColor(.white, for: .normal)
        button.setTitleColor(.tertiaryLabel, for: .disabled)
        button.titleLabel?.font = .systemFont(ofSize: 15, weight: .bold)
        button.backgroundColor = color.withAlphaComponent(0.82)
        button.layer.cornerRadius = 11
        button.addTarget(self, action: action, for: .touchUpInside)
    }

    private func installGestures() {
        let tap = UITapGestureRecognizer(target: self, action: #selector(tappedModel(_:)))
        let orbit = UIPanGestureRecognizer(target: self, action: #selector(orbitModel(_:)))
        orbit.minimumNumberOfTouches = 1
        orbit.maximumNumberOfTouches = 1
        let pan = UIPanGestureRecognizer(target: self, action: #selector(panModel(_:)))
        pan.minimumNumberOfTouches = 2
        pan.maximumNumberOfTouches = 2
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(zoomModel(_:)))
        for gesture in [tap, orbit, pan, pinch] {
            gesture.delegate = self
            arView.addGestureRecognizer(gesture)
        }
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        (gestureRecognizer is UIPinchGestureRecognizer && otherGestureRecognizer is UIPanGestureRecognizer) ||
        (gestureRecognizer is UIPanGestureRecognizer && otherGestureRecognizer is UIPinchGestureRecognizer)
    }

    private func loadDocumentsAndModel() {
        do {
            let decoder = JSONDecoder()
            let building = try decoder.decode(BuildingDocument.self, from: Data(contentsOf: buildingURL))
            let scan = try decoder.decode(ScanDocument.self, from: Data(contentsOf: scanURL))
            nodes = mergedNodes(building: building, scan: scan)
            if let initialSelection {
                startNode = nodes.first { $0.id == initialSelection.startId }
                destinationNode = nodes.first { $0.id == initialSelection.destinationId }
            }
            updateSummary()
        } catch {
            showError("Could not read building map data.\n\(error.localizedDescription)")
            return
        }

        load = Entity.loadAsync(contentsOf: modelURL).sink(receiveCompletion: { [weak self] completion in
            if case let .failure(error) = completion {
                self?.showError("Could not load the RoomPlan model.\n\(error.localizedDescription)")
            }
        }, receiveValue: { [weak self] entity in
            guard let self else { return }
            let bounds = entity.visualBounds(relativeTo: nil)
            let largestDimension = max(bounds.extents.x, max(bounds.extents.y, bounds.extents.z))
            guard largestDimension.isFinite, largestDimension > 0.05 else {
                self.showError("The RoomPlan model has invalid bounds.")
                return
            }

            self.modelCenter = bounds.center
            entity.position = -self.modelCenter
            self.modelAnchor.addChild(entity)
            self.buildNodeMarkers(radius: min(0.14, max(0.055, largestDimension * 0.012)))
            self.updateMarkerColors()
            self.buildUserMarker(radius: min(0.11, max(0.045, largestDimension * 0.01)))
            self.minimumDistance = max(0.7, largestDimension * 0.35)
            self.maximumDistance = max(8, largestDimension * 6)
            self.distance = max(2.5, largestDimension * 1.5)
            self.resetCamera()
            self.statusLabel.isHidden = true
        })
    }

    private func mergedNodes(building: BuildingDocument, scan: ScanDocument) -> [NavigationNode] {
        var result = building.nodes
        var ids = Set(result.map(\.id))
        func append(_ node: NavigationNode) {
            guard node.position.count == 3, !ids.contains(node.id) else { return }
            ids.insert(node.id)
            result.append(node)
        }
        for section in scan.sections where section.label != "unidentified" {
            append(NavigationNode(id: "section-\(section.label)", type: "room", position: section.center, label: section.label))
        }
        for surface in scan.doors {
            append(NavigationNode(id: "door-\(shortId(surface.identifier))", type: "door", position: surface.position, label: surface.category))
        }
        for surface in scan.openings {
            append(NavigationNode(id: "opening-\(shortId(surface.identifier))", type: "opening", position: surface.position, label: surface.category))
        }
        for object in scan.objects where object.category == "stairs" {
            append(NavigationNode(id: "stairs-\(shortId(object.identifier))", type: "stairs", position: object.position, label: "stairs"))
        }
        return result
    }

    private func shortId(_ id: String) -> String { String(id.prefix(8)).lowercased() }

    private func buildNodeMarkers(radius: Float) {
        for node in nodes where node.position.count == 3 {
            let marker = ModelEntity(
                mesh: .generateSphere(radius: node.type == "destination" ? radius * 1.25 : radius),
                materials: [UnlitMaterial(color: baseColor(node))]
            )
            marker.name = "gnarly-node:\(node.id)"
            marker.position = vector(node.position) - modelCenter + SIMD3<Float>(0, radius, 0)
            marker.generateCollisionShapes(recursive: false)
            modelAnchor.addChild(marker)
            markers[node.id] = marker
        }
    }

    private func buildUserMarker(radius: Float) {
        let marker = ModelEntity(
            mesh: .generateSphere(radius: radius),
            materials: [UnlitMaterial(color: .systemMint)]
        )
        userMarker = marker
        modelAnchor.addChild(marker)
        updateMarkerPosition()
    }

    func setPosition(_ position: SIMD3<Float>) {
        pendingPosition = position
        updateMarkerPosition()
    }

    private func updateMarkerPosition() {
        userMarker?.position = pendingPosition - modelCenter + SIMD3<Float>(0, 0.12, 0)
    }

    func setRoute(_ json: String) {
        do {
            let route = try JSONDecoder().decode(NativeRoute.self, from: Data(json.utf8))
            drawRoute(route)
            dismiss(animated: true)
        } catch {
            showError("Could not draw the selected route.\n\(error.localizedDescription)")
        }
    }

    func setStatus(_ message: String) {
        statusLabel.text = message
        statusLabel.isHidden = false
    }

    private func drawRoute(_ route: NativeRoute) {
        routeRoot.children.removeAll()
        let points = route.waypoints.filter { $0.position.count == 3 }.map {
            vector($0.position) - modelCenter + SIMD3<Float>(0, 0.09, 0)
        }
        guard !points.isEmpty else { return }
        let material = UnlitMaterial(color: .systemCyan)
        for point in points {
            let dot = ModelEntity(mesh: .generateSphere(radius: 0.065), materials: [material])
            dot.position = point
            routeRoot.addChild(dot)
        }
        guard points.count > 1 else { return }
        for index in 0..<(points.count - 1) {
            let start = points[index]
            let end = points[index + 1]
            let length = simd_distance(start, end)
            guard length > 0.001 else { continue }
            let segment = ModelEntity(
                mesh: .generateBox(size: SIMD3<Float>(0.075, 0.045, length)),
                materials: [material]
            )
            let midpoint = (start + end) * 0.5
            segment.position = midpoint
            segment.look(at: end, from: midpoint, relativeTo: modelAnchor)
            routeRoot.addChild(segment)
        }
    }

    @objc private func tappedModel(_ recognizer: UITapGestureRecognizer) {
        guard recognizer.state == .ended, let entity = arView.entity(at: recognizer.location(in: arView)) else { return }
        var candidate: Entity? = entity
        while let current = candidate {
            if current.name.hasPrefix("gnarly-node:") {
                let id = String(current.name.dropFirst("gnarly-node:".count))
                selectNode(id)
                return
            }
            candidate = current.parent
        }
    }

    private func selectNode(_ id: String) {
        guard let node = nodes.first(where: { $0.id == id }) else { return }
        selectedNode = node
        selectedLabel.text = "Selected: \(displayName(node))"
        setStartButton.isEnabled = true
        setDestinationButton.isEnabled = true
        updateMarkerColors()
    }

    @objc private func setSelectedAsStart() {
        guard let selectedNode else { return }
        startNode = selectedNode
        if destinationNode?.id == selectedNode.id { destinationNode = nil }
        updateSummary()
        updateMarkerColors()
    }

    @objc private func setSelectedAsDestination() {
        guard let selectedNode else { return }
        destinationNode = selectedNode
        if startNode?.id == selectedNode.id { startNode = nil }
        updateSummary()
        updateMarkerColors()
    }

    @objc private func useMyLocation() {
        startNode = nil
        updateSummary()
        updateMarkerColors()
    }

    /// Only possible when both ends are map points; "my location" can't become a destination.
    @objc private func swapSelection() {
        guard let start = startNode, let destination = destinationNode else { return }
        startNode = destination
        destinationNode = start
        updateSummary()
        updateMarkerColors()
    }

    @objc private func clearSelection() {
        startNode = nil
        destinationNode = nil
        selectedNode = nil
        selectedLabel.text = "Tap a dot to pick a room, door, or destination"
        setStartButton.isEnabled = false
        setDestinationButton.isEnabled = false
        routeRoot.children.removeAll()
        updateSummary()
        updateMarkerColors()
    }

    @objc private func showRoute() {
        guard let destinationNode else { return }
        do {
            let request = MapRouteRequest(startId: startNode?.id ?? "", destinationId: destinationNode.id)
            let data = try JSONEncoder().encode(request)
            guard let json = String(data: data, encoding: .utf8) else {
                throw CocoaError(.fileWriteInapplicableStringEncoding)
            }
            callbackObjectName.withCString { objectName in
                "OnIndoorMapRouteRequested".withCString { methodName in
                    json.withCString { message in UnitySendMessage(objectName, methodName, message) }
                }
            }
            statusLabel.text = "Calculating route…"
            statusLabel.isHidden = false
        } catch {
            showError("Could not request the selected route.\n\(error.localizedDescription)")
        }
    }

    private func updateSummary() {
        let start = startNode.map(displayName) ?? "My location"
        let destination = destinationNode.map(displayName) ?? "Choose a destination"
        summaryLabel.text = "From:  \(start)\nTo:  \(destination)"
        showRouteButton.isEnabled = destinationNode != nil && startNode?.id != destinationNode?.id
        myLocationButton.isEnabled = startNode != nil
        swapButton.isEnabled = startNode != nil && destinationNode != nil
        clearButton.isEnabled = startNode != nil || destinationNode != nil
    }

    private func updateMarkerColors() {
        for node in nodes {
            guard let marker = markers[node.id] else { continue }
            let color: UIColor
            if node.id == startNode?.id { color = .systemGreen }
            else if node.id == destinationNode?.id { color = .systemPink }
            else if node.id == selectedNode?.id { color = .systemYellow }
            else { color = baseColor(node) }
            marker.model?.materials = [UnlitMaterial(color: color)]
        }
    }

    private func baseColor(_ node: NavigationNode) -> UIColor {
        switch node.type {
        case "destination": return .systemOrange
        case "entrance": return .systemGreen
        case "room": return .systemPurple
        case "stairs": return .systemIndigo
        default: return .systemTeal
        }
    }

    private func displayName(_ node: NavigationNode) -> String {
        switch node.type {
        case "door": return "Door"
        case "opening": return "Opening"
        case "stairs" where node.label == nil || node.label == "stairs": return "Stairs"
        default: break
        }
        guard let label = node.label, !label.isEmpty else { return humanize(node.id) }
        return node.type == "room" ? humanize(label) : label
    }

    /// "livingRoom" → "Living room", matching the Unity planner's names.
    private func humanize(_ raw: String) -> String {
        var result = ""
        var previous: Character?
        for character in raw {
            if character == "-" || character == "_" {
                result.append(" ")
            } else {
                if character.isUppercase, let previous, previous.isLowercase { result.append(" ") }
                result += result.isEmpty ? character.uppercased() : character.lowercased()
            }
            previous = character
        }
        return result.trimmingCharacters(in: .whitespaces)
    }

    private func vector(_ values: [Float]) -> SIMD3<Float> {
        SIMD3<Float>(values[0], values[1], values[2])
    }

    @objc private func orbitModel(_ recognizer: UIPanGestureRecognizer) {
        let translation = recognizer.translation(in: arView)
        yaw -= Float(translation.x) * 0.006
        pitch = min(1.35, max(0.08, pitch + Float(translation.y) * 0.005))
        recognizer.setTranslation(.zero, in: arView)
        updateCamera()
    }

    @objc private func panModel(_ recognizer: UIPanGestureRecognizer) {
        let translation = recognizer.translation(in: arView)
        let forward = simd_normalize(focus - camera.position(relativeTo: nil))
        let right = simd_normalize(simd_cross(forward, SIMD3<Float>(0, 1, 0)))
        let up = simd_normalize(simd_cross(right, forward))
        let scale = distance / Float(max(arView.bounds.height, 1)) * 1.4
        focus += right * Float(-translation.x) * scale + up * Float(translation.y) * scale
        recognizer.setTranslation(.zero, in: arView)
        updateCamera()
    }

    @objc private func zoomModel(_ recognizer: UIPinchGestureRecognizer) {
        guard recognizer.scale > 0 else { return }
        distance = min(maximumDistance, max(minimumDistance, distance / Float(recognizer.scale)))
        recognizer.scale = 1
        updateCamera()
    }

    @objc private func resetView() { resetCamera() }

    private func resetCamera() {
        focus = .zero
        yaw = 0.2
        pitch = 0.55
        distance = min(maximumDistance, max(minimumDistance, distance))
        updateCamera()
    }

    private func updateCamera() {
        let horizontal = distance * cos(pitch)
        let position = focus + SIMD3<Float>(
            horizontal * sin(yaw),
            distance * sin(pitch),
            horizontal * cos(yaw)
        )
        camera.look(at: focus, from: position, relativeTo: nil)
    }

    private func showError(_ message: String) {
        NSLog("[Gnarly] %@", message)
        statusLabel.text = message
        statusLabel.isHidden = false
    }

    @objc private func dismissModel() { dismiss(animated: true) }
}
