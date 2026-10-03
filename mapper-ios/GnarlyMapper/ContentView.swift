import SwiftUI
import RoomPlan

struct ContentView: View {
    @EnvironmentObject private var authSession: FirebaseAuthSession
    @StateObject private var mapper = MapperViewModel()
    @State private var zoneID = "zone-a"
    @State private var floorID = "ground"
    @State private var buildingID = "main-building"
    @State private var showsFirebaseConnection = false

    var body: some View {
        ZStack(alignment: .top) {
            RoomCaptureContainer(mapper: mapper)
                .ignoresSafeArea()

            VStack(spacing: 8) {
                HStack(spacing: 10) {
                    Image(systemName: "point.3.connected.trianglepath.dotted")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.cyan)

                    VStack(alignment: .leading, spacing: 2) {
                        Text("GNARLY MAPPER")
                            .font(.caption2.weight(.heavy))
                            .tracking(1.2)
                            .foregroundStyle(.secondary)
                        Text(mapper.statusText)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(2)
                    }

                    Spacer(minLength: 8)

                    VStack(spacing: 1) {
                        Text("\(mapper.recordedNodeCount)")
                            .font(.headline.monospacedDigit())
                        Text("POINTS")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            .padding(.horizontal, 12)
            .padding(.top, 10)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    Label("PATH CAPTURE", systemImage: "dot.radiowaves.left.and.right")
                        .font(.caption.weight(.heavy))
                        .foregroundStyle(.cyan)
                    Spacer()
                    Text("\(mapper.recordedNodeCount) points")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }

                HStack(spacing: 8) {
                    TextField("Building", text: $buildingID)
                    TextField("Zone", text: $zoneID)
                    TextField("Floor", text: $floorID)
                }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)

                HStack(spacing: 8) {
                    Button("Finish") { mapper.finishRoom() }
                        .buttonStyle(.borderedProminent)
                        .tint(.cyan)
                        .disabled(!mapper.isScanning)

                    Button {
                        mapper.dropManualNode()
                    } label: {
                        Label("Drop", systemImage: "plus.circle")
                    }
                        .buttonStyle(.bordered)
                        .disabled(!mapper.canDropManualNode)

                    Button {
                        mapper.markTestAnchor()
                    } label: {
                        Label("Cube", systemImage: "cube")
                    }
                        .buttonStyle(.bordered)
                        .disabled(!mapper.canMarkAnchor)

                    Button("Export") { mapper.exportPackage(zoneID: zoneID, floorID: floorID) }
                        .buttonStyle(.borderedProminent)
                        .tint(.mint)
                        .disabled(!mapper.canExport)
                }
                .font(.subheadline)

                Button {
                    mapper.uploadPackage(buildingID: buildingID, zoneID: zoneID, floorID: floorID)
                } label: {
                    Label(mapper.isUploading ? "Uploading…" : "Upload to Firebase", systemImage: "icloud.and.arrow.up")
                }
                .buttonStyle(.borderedProminent)
                .tint(.indigo)
                .disabled(!mapper.canExport || !authSession.isAuthenticated || mapper.isUploading)

                Button {
                    showsFirebaseConnection = true
                } label: {
                    Label(
                        authSession.isAuthenticated ? "Firebase connected" : "Connect Firebase",
                        systemImage: authSession.isAuthenticated ? "checkmark.icloud" : "icloud.slash"
                    )
                }
                .buttonStyle(.bordered)

                if let exportURL = mapper.exportURL {
                    ShareLink(item: exportURL) {
                        Label("Share package", systemImage: "square.and.arrow.up")
                    }
                    .font(.subheadline)
                } else {
                    Text("Walked points save every 0.75 m. Use Drop for a deliberate extra point.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            .padding(.horizontal)
            .padding(.top, 10)
            .padding(.bottom, 8)
            .background(.ultraThinMaterial)
        }
        .alert("Mapper error", isPresented: $mapper.showsError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(mapper.errorMessage)
        }
        .sheet(isPresented: $showsFirebaseConnection) {
            FirebaseConnectionView(authSession: authSession)
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(FirebaseAuthSession())
}
