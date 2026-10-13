import SwiftUI
import UIKit

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
    @State private var satellite: UIImage?

    init(building: OwnedBuilding, library: BuildingLibrary) {
        self.library = library
        _building = State(initialValue: building)
    }

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                BuildingSceneView(controller: scene)
                if loading {
                    ProgressView("Loading this building…")
                        .tint(.white)
                        .foregroundStyle(.white)
                        .padding(12)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            VStack(alignment: .leading, spacing: 8) {
                Text(building.name)
                    .font(.headline)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(MapperTheme.muted)
                    .lineLimit(2)
                HStack(spacing: 8) {
                    Button {
                        aligning = map != nil
                    } label: {
                        Label("Align", systemImage: "map")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.white)
                    .background(MapperTheme.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    MapperPrimaryButton(title: "Scan", systemImage: "lidar", compact: true) {
                        planning = true
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 8)
            .background(.ultraThinMaterial)
        }
        .background(MapperTheme.background.ignoresSafeArea())
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
                if let map { scene.show(map: map, highlight: target.isNewZone ? nil : target.zoneID, satellite: satellite) }
            }
        }
        .sheet(item: $highlight, onDismiss: {
            if let map { scene.show(map: map, highlight: nil, satellite: satellite) }
        }) { target in
            ZoneConfirmView(target: target, map: map) {
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

    private var subtitle: String {
        if let map, !map.zones.isEmpty {
            let floors = map.levels.map(\.name).joined(separator: " · ")
            return floors.isEmpty ? locationLine : "\(floors) · \(locationLine)"
        }
        if !loading { return "No zones yet. Scan the first room to start the model." }
        return locationLine
    }

    private var locationLine: String {
        if building.hasLocation {
            return String(format: "%.5f, %.5f", building.latitude ?? 0, building.longitude ?? 0)
        }
        return "Not placed on the map yet"
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let loaded = try await library.loadMap(for: building)
            map = loaded
            satellite = await library.satelliteImage(for: building, bounds: loaded.bounds)
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
    var onConfirm: () -> Void
    @StateObject private var scene = BuildingSceneController()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                if let map {
                    BuildingSceneView(controller: scene)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .frame(height: 200)
                        .onAppear {
                            scene.show(map: map, highlight: target.isNewZone ? nil : target.zoneID, satellite: nil)
                        }
                }
                Text(target.isNewZone ? "New zone on \(target.levelName)" : "Updating \(target.zoneName)")
                    .font(.headline)
                Text(target.isNewZone
                     ? "Adds “\(target.zoneName)” on \(target.levelName)."
                     : "The new scan replaces this zone and keeps its place on the map.")
                    .font(.subheadline)
                    .foregroundStyle(MapperTheme.muted)
                MapperPrimaryButton(title: "Start scan", systemImage: "record.circle", compact: true) {
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
