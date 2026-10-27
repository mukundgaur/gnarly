import MapKit
import SwiftUI

struct CreateBuildingView: View {
    @ObservedObject var library: BuildingLibrary
    @EnvironmentObject private var auth: FirebaseAuthSession
    @Environment(\.dismiss) private var dismiss
    @StateObject private var location = DeviceLocation()
    @State private var name = ""
    @State private var coordinate: CLLocationCoordinate2D?
    @State private var pinMovedByHand = false
    @State private var didCenterOnDevice = false
    @State private var hasLocation = true
    @State private var heading = 0.0
    @State private var busy = false
    @State private var error: String?
    @FocusState private var nameFocused: Bool
    @State private var camera: MapCameraPosition = .userLocation(fallback: .automatic)

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Name")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(MapperTheme.muted)
                    TextField("North Hall", text: $name)
                        .focused($nameFocused)
                        .font(.body)
                        .submitLabel(.done)
                        .padding(.horizontal, 12)
                        .frame(height: 40)
                        .background(MapperTheme.raised, in: RoundedRectangle(cornerRadius: 12))
                        .foregroundStyle(.white)

                    Toggle("Place it on the map", isOn: $hasLocation)
                        .tint(MapperTheme.accent)

                    if hasLocation {
                        MapReader { proxy in
                            Map(position: $camera) {
                                UserAnnotation()
                                if let coordinate {
                                    Marker(name.isEmpty ? "Building" : name, coordinate: coordinate)
                                }
                            }
                            .mapStyle(.imagery(elevation: .realistic))
                            .frame(height: nameFocused ? 96 : 168)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .animation(.easeOut(duration: 0.2), value: nameFocused)
                            .gesture(SpatialTapGesture().onEnded { event in
                                if let tapped = proxy.convert(event.location, from: .local) {
                                    coordinate = tapped
                                    pinMovedByHand = true
                                }
                            })
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            Text(locationNote)
                                .font(.caption2)
                                .foregroundStyle(MapperTheme.muted)
                            HStack(spacing: 8) {
                                Button {
                                    useMyLocation()
                                } label: {
                                    Label("Use my location", systemImage: "location.fill")
                                        .font(.caption.weight(.semibold))
                                }
                                .buttonStyle(.plain)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(MapperTheme.raised, in: Capsule())
                                .foregroundStyle(.white)
                                if location.isDenied {
                                    Button("Allow in Settings") { location.openSettings() }
                                        .font(.caption.weight(.semibold))
                                        .buttonStyle(.plain)
                                        .foregroundStyle(MapperTheme.accent)
                                }
                            }
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Map heading  \(Int(heading))°")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(MapperTheme.muted)
                            Slider(value: $heading, in: 0...360)
                                .tint(MapperTheme.accent)
                            Text("Match the front of the building to north.")
                                .font(.caption2)
                                .foregroundStyle(MapperTheme.muted)
                        }
                    }

                    if let error {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }

                    MapperPrimaryButton(title: "Create building", systemImage: "checkmark", busy: busy, enabled: canCreate, compact: true) {
                        Task { await create() }
                    }
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(MapperTheme.background.ignoresSafeArea())
            .navigationTitle("New building")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { nameFocused = false }
                }
            }
        }
        .presentationDetents([.large])
        .task { if hasLocation { location.request() } }
        .onChange(of: hasLocation) { _, on in
            if on { location.request() }
        }
        .onChange(of: location.fix) { _, fix in
            guard let fix, !pinMovedByHand else { return }
            coordinate = fix.coordinate
            guard !didCenterOnDevice else { return }
            didCenterOnDevice = true
            camera = .region(MKCoordinateRegion(center: fix.coordinate, latitudinalMeters: 160, longitudinalMeters: 160))
        }
    }

    private var canCreate: Bool {
        let named = !name.trimmingCharacters(in: .whitespaces).isEmpty
        return named && (!hasLocation || coordinate != nil)
    }

    private var locationNote: String {
        if let coordinate {
            return String(format: "Pinned at %.5f, %.5f. Tap the map if this isn't the right spot.", coordinate.latitude, coordinate.longitude)
        }
        if location.isDenied {
            return "Location is off, so this building can't start where you are. Allow it in Settings, or tap the map."
        }
        if location.failed {
            return "Couldn't read a location fix. Tap the map to drop the pin."
        }
        if location.authorization == .authorizedAlways || location.authorization == .authorizedWhenInUse {
            return "Finding where you are…"
        }
        return "Allow location when iOS asks, so this building starts where you are."
    }

    private func useMyLocation() {
        pinMovedByHand = false
        didCenterOnDevice = false
        location.request()
        guard let fix = location.fix else { return }
        coordinate = fix.coordinate
        didCenterOnDevice = true
        camera = .region(MKCoordinateRegion(center: fix.coordinate, latitudinalMeters: 160, longitudinalMeters: 160))
    }

    private func create() async {
        guard let uid = auth.userUID else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await library.createBuilding(
                name: name,
                latitude: hasLocation ? coordinate?.latitude : nil,
                longitude: hasLocation ? coordinate?.longitude : nil,
                heading: heading,
                ownerUid: uid
            )
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
