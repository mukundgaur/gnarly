import SwiftUI

struct BuildingDetailView: View {
    @ObservedObject var library: BuildingLibrary
    @State private var building: OwnedBuilding
    @StateObject private var scene = BuildingSceneController()
    @State private var map: BuildingMap?
    @State private var loading = true
    @State private var error: String?
    @State private var planning = false
    @State private var aligning = false
    @State private var highlight: ZoneScanTarget?
    @State private var scanning: ZoneScanTarget?

    init(building: OwnedBuilding, library: BuildingLibrary) {
        self.library = library
        _building = State(initialValue: building)
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            MapperTheme.background.ignoresSafeArea()
            BuildingSceneView(controller: scene)
                .ignoresSafeArea()

            if loading {
                ProgressView("Loading this building…")
                    .tint(.white)
                    .foregroundStyle(.white)
                    .padding(16)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
            }

            VStack(alignment: .leading, spacing: 12) {
                MapperCard {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(building.name)
                            .font(.title3.weight(.semibold))
                        Text(locationLine)
                            .font(.caption)
                            .foregroundStyle(MapperTheme.muted)
                        if let map, !map.zones.isEmpty {
                            Text(map.levels.map(\.name).joined(separator: " · "))
                                .font(.caption)
                                .foregroundStyle(MapperTheme.muted)
                        } else if !loading {
                            Text("No zones yet. Scan the first room to start the model.")
                                .font(.caption)
                                .foregroundStyle(MapperTheme.muted)
                        }
                    }
                }
                HStack(spacing: 10) {
                    Button {
                        aligning = map != nil
                    } label: {
                        Label("Align", systemImage: "map")
                            .font(.headline)
                            .frame(maxWidth: .infinity, minHeight: 52)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.white)
                    .background(MapperTheme.raised, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    MapperPrimaryButton(title: "Scan", systemImage: "lidar") {
                        planning = true
                    }
                }
            }
            .padding(16)
        }
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .fullScreenCover(isPresented: $aligning) {
            if let map {
                AlignBuildingView(library: library, map: map) { updated in
                    building = updated
                    Task { await load() }
                }
            }
        }
        .sheet(isPresented: $planning) {
            ScanPlannerView(building: building, map: map) { target in
                planning = false
                highlight = target
                if let map { scene.show(map: map, highlight: target.isNewZone ? nil : target.zoneID, satellite: nil) }
            }
        }
        .sheet(item: $highlight) { target in
            ZoneConfirmView(target: target, map: map, scene: scene) {
                highlight = nil
                scanning = target
            }
        }
        .fullScreenCover(item: $scanning, onDismiss: { Task { await load() } }) { target in
            ScanSessionView(building: building, target: target, library: library)
        }
        .overlay(alignment: .top) {
            if let error {
                Text(error)
                    .font(.footnote)
                    .padding(10)
                    .background(.red.opacity(0.85), in: Capsule())
                    .padding(.top, 8)
            }
        }
    }

    private var locationLine: String {
        if building.hasLocation {
            return String(format: "%.5f, %.5f · heading %.0f°", building.latitude ?? 0, building.longitude ?? 0, building.mapHeadingDegrees)
        }
        return "Not placed on the map yet"
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let loaded = try await library.loadMap(for: building)
            map = loaded
            let satellite = await library.satelliteImage(for: building, bounds: loaded.bounds)
            scene.show(map: loaded, highlight: nil, satellite: satellite)
        } catch {
            self.error = error.localizedDescription
            scene.show(map: BuildingMap(building: building, versionId: building.activeVersion, layout: BuildingLayoutDocument(), zones: []), highlight: nil, satellite: nil)
        }
    }
}

private struct ZoneConfirmView: View {
    let target: ZoneScanTarget
    let map: BuildingMap?
    @ObservedObject var scene: BuildingSceneController
    var onConfirm: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                if let map {
                    BuildingSceneView(controller: scene)
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .frame(minHeight: 280)
                        .onAppear {
                            scene.show(map: map, highlight: target.isNewZone ? nil : target.zoneID, satellite: nil)
                        }
                }
                Text(target.isNewZone ? "New zone on \(target.levelName)" : "Updating \(target.zoneName)")
                    .font(.title3.weight(.semibold))
                Text(target.isNewZone
                     ? "The scan will be added as “\(target.zoneName)” on \(target.levelName)."
                     : "This zone is highlighted. The new scan replaces its geometry and colors, and stays where it is on the map.")
                    .foregroundStyle(MapperTheme.muted)
                MapperPrimaryButton(title: "Start scan", systemImage: "record.circle") {
                    onConfirm()
                    dismiss()
                }
            }
            .padding(20)
            .background(MapperTheme.background.ignoresSafeArea())
            .navigationTitle("Confirm zone")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Back") { dismiss() } }
            }
        }
        .presentationDetents([.large])
    }
}
