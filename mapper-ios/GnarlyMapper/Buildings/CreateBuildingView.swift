import MapKit
import SwiftUI

struct CreateBuildingView: View {
    @ObservedObject var library: BuildingLibrary
    @EnvironmentObject private var auth: FirebaseAuthSession
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var coordinate = CLLocationCoordinate2D(latitude: 42.4534, longitude: -76.4738)
    @State private var hasLocation = true
    @State private var heading = 0.0
    @State private var busy = false
    @State private var error: String?
    @FocusState private var nameFocused: Bool
    @State private var camera: MapCameraPosition = .region(MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 42.4534, longitude: -76.4738),
        span: MKCoordinateSpan(latitudeDelta: 0.01, longitudeDelta: 0.01)
    ))

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
                                Marker(name.isEmpty ? "Building" : name, coordinate: coordinate)
                            }
                            .mapStyle(.imagery(elevation: .realistic))
                            .frame(height: nameFocused ? 96 : 168)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .animation(.easeOut(duration: 0.2), value: nameFocused)
                            .gesture(SpatialTapGesture().onEnded { event in
                                if let tapped = proxy.convert(event.location, from: .local) {
                                    coordinate = tapped
                                }
                            })
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

                    MapperPrimaryButton(title: "Create building", systemImage: "checkmark", busy: busy, enabled: !name.trimmingCharacters(in: .whitespaces).isEmpty, compact: true) {
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
    }

    private func create() async {
        guard let uid = auth.userUID else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await library.createBuilding(
                name: name,
                latitude: hasLocation ? coordinate.latitude : nil,
                longitude: hasLocation ? coordinate.longitude : nil,
                heading: heading,
                ownerUid: uid
            )
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
