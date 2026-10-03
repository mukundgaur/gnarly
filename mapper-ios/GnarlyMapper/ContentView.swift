import SwiftUI
import RoomPlan

struct ContentView: View {
    @EnvironmentObject private var authSession: FirebaseAuthSession
    @StateObject private var mapper = MapperViewModel()
    @State private var zoneID = "zone-a"
    @State private var floorID = "ground"
    @State private var showsFirebaseConnection = false

    var body: some View {
        ZStack(alignment: .top) {
            RoomCaptureContainer(mapper: mapper)
                .ignoresSafeArea()

            Text(mapper.statusText)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(.ultraThinMaterial, in: Capsule())
                .padding(.top, 12)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    TextField("Zone", text: $zoneID)
                    TextField("Floor", text: $floorID)
                }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)

                HStack(spacing: 8) {
                    Button("Finish") { mapper.finishRoom() }
                        .buttonStyle(.borderedProminent)
                        .disabled(!mapper.isScanning)

                    Button("Drop node") { mapper.dropManualNode() }
                        .buttonStyle(.bordered)
                        .disabled(!mapper.canDropManualNode)

                    Button("Set cube") { mapper.markTestAnchor() }
                        .buttonStyle(.bordered)
                        .disabled(!mapper.canMarkAnchor)

                    Button("Export") { mapper.exportPackage(zoneID: zoneID, floorID: floorID) }
                        .buttonStyle(.borderedProminent)
                        .disabled(!mapper.canExport)
                }
                .font(.subheadline)

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
                    Text("Walked points save automatically; use Drop node only for a deliberate extra point.")
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
