import MapKit
import SwiftUI

/// Lets any signed-in mapper place an existing scan on the real map and nudge its floors.
struct AlignBuildingView: View {
    @ObservedObject var library: BuildingLibrary
    let source: BuildingMap
    var onSaved: (OwnedBuilding) -> Void

    @Environment(\.dismiss) private var dismiss
    @StateObject private var scene = BuildingSceneController()
    @State private var building: OwnedBuilding
    @State private var layout: BuildingLayoutDocument
    @State private var selectedLevel: Int
    @State private var step = 1.0
    @State private var turn = 5.0
    @State private var satellite: UIImage?
    @State private var saving = false
    @State private var error: String?
    @State private var camera: MapCameraPosition

    init(library: BuildingLibrary, map: BuildingMap, onSaved: @escaping (OwnedBuilding) -> Void) {
        self.library = library
        source = map
        self.onSaved = onSaved
        let building = map.building
        _building = State(initialValue: building)
        _layout = State(initialValue: map.layout)
        let level = map.levels.first?.level ?? 0
        _selectedLevel = State(initialValue: level)
        let center = CLLocationCoordinate2D(latitude: building.latitude ?? 42.4534, longitude: building.longitude ?? -76.4738)
        _camera = State(initialValue: .region(MKCoordinateRegion(center: center, latitudinalMeters: 180, longitudinalMeters: 180)))
    }

    var body: some View {
        NavigationStack {
            GeometryReader { proxy in
                let height = proxy.size.height
                let mapHeight = min(128, max(92, height * 0.2))
                let controlsHeight = min(220, max(156, height * 0.32))
                VStack(spacing: 0) {
                    BuildingSceneView(controller: scene)
                        .frame(height: max(150, height - mapHeight - controlsHeight))
                    mapPicker
                        .frame(height: mapHeight)
                    controls
                        .frame(height: controlsHeight)
                }
            }
            .background(MapperTheme.background.ignoresSafeArea())
            .navigationTitle("Align on the map")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") { Task { await save() } }
                        .disabled(saving)
                }
            }
            .task { await refreshPreview(reloadSatellite: true) }
        }
    }

    private var mapPicker: some View {
        MapReader { proxy in
            Map(position: $camera) {
                if let latitude = building.latitude, let longitude = building.longitude {
                    Marker(building.name, coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: longitude))
                }
            }
            .mapStyle(.imagery(elevation: .realistic))
            .gesture(SpatialTapGesture().onEnded { event in
                if let tapped = proxy.convert(event.location, from: .local) {
                    building.latitude = tapped.latitude
                    building.longitude = tapped.longitude
                    Task { await refreshPreview(reloadSatellite: true) }
                }
            })
        }
        .overlay(alignment: .topLeading) {
            Text("Tap to place the building")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(.ultraThinMaterial, in: Capsule())
                .padding(8)
        }
    }

    private var controls: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if let error { Text(error).font(.caption).foregroundStyle(.red) }

                VStack(alignment: .leading, spacing: 4) {
                    Text("Heading  \(Int(building.mapHeadingDegrees.rounded()))°")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(MapperTheme.muted)
                    Slider(value: $building.mapHeadingDegrees, in: 0...360, step: 1) { editing in
                        if !editing { Task { await refreshPreview(reloadSatellite: true) } }
                    }
                    .tint(MapperTheme.accent)
                }

                if !source.levels.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Floor")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(MapperTheme.muted)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack {
                                ForEach(source.levels) { level in
                                    Button(level.name) {
                                        selectedLevel = level.level
                                        previewFloors()
                                    }
                                    .buttonStyle(.plain)
                                    .font(.caption.weight(.semibold))
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(selectedLevel == level.level ? MapperTheme.accent : MapperTheme.raised, in: Capsule())
                                    .foregroundStyle(selectedLevel == level.level ? MapperTheme.ink : .white)
                                }
                            }
                        }
                    }

                    HStack {
                        stepChip("0.25 m", 0.25)
                        stepChip("1 m", 1)
                        stepChip("5 m", 5)
                        Spacer()
                        turnChip("1°", 1)
                        turnChip("5°", 5)
                        turnChip("15°", 15)
                    }

                    HStack(spacing: 8) {
                        nudge("N", systemImage: "arrow.up") { moveFloor(north: step, east: 0) }
                        nudge("S", systemImage: "arrow.down") { moveFloor(north: -step, east: 0) }
                        nudge("W", systemImage: "arrow.left") { moveFloor(north: 0, east: -step) }
                        nudge("E", systemImage: "arrow.right") { moveFloor(north: 0, east: step) }
                        nudge("↺", systemImage: "rotate.left") { rotateSelected(-turn) }
                        nudge("↻", systemImage: "rotate.right") { rotateSelected(turn) }
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
    }

    private func stepChip(_ title: String, _ value: Double) -> some View {
        Button(title) { step = value }
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 5)
            .background(step == value ? MapperTheme.accent.opacity(0.25) : MapperTheme.raised, in: Capsule())
    }

    private func turnChip(_ title: String, _ value: Double) -> some View {
        Button(title) { turn = value }
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 5)
            .background(turn == value ? MapperTheme.accent.opacity(0.25) : MapperTheme.raised, in: Capsule())
    }

    private func nudge(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Image(systemName: systemImage)
                Text(title).font(.caption2.weight(.semibold))
            }
            .frame(maxWidth: .infinity, minHeight: 36)
            .background(MapperTheme.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.white)
    }

    /// Convert true-north / east meters into layout X/Z using the current map heading.
    private func moveFloor(north: Double, east: Double) {
        let radians = building.mapHeadingDegrees * .pi / 180
        let x = east * cos(radians) - north * sin(radians)
        let z = -north * cos(radians) - east * sin(radians)
        layout.shiftFloor(selectedLevel, x: x, z: z)
        previewFloors()
    }

    private func rotateSelected(_ degrees: Double) {
        layout.rotateFloor(selectedLevel, by: degrees)
        previewFloors()
    }

    private func previewFloors() {
        let preview = source.applying(building: building, layout: layout)
        scene.show(map: preview, highlight: preview.zones.first { $0.level == selectedLevel }?.id, satellite: satellite)
    }

    private func refreshPreview(reloadSatellite: Bool) async {
        var next = building
        if next.latitude == nil { next.latitude = 42.4534 }
        if next.longitude == nil { next.longitude = -76.4738 }
        building = next
        if reloadSatellite {
            satellite = await library.satelliteImage(for: building, bounds: source.applying(building: building, layout: layout).bounds)
        }
        previewFloors()
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            try await library.saveAlignment(building: building, layout: layout)
            onSaved(building)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
