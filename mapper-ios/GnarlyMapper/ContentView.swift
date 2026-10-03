import SwiftUI
import RoomPlan

struct ContentView: View {
    @StateObject private var mapper = MapperViewModel()
    @State private var zoneID = "zone-a"

    var body: some View {
        ZStack(alignment: .bottom) {
            RoomCaptureContainer(mapper: mapper)
                .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 12) {
                Text(mapper.statusText)
                    .font(.headline)

                TextField("Zone ID", text: $zoneID)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)

                HStack {
                    Button("Finish room") { mapper.finishRoom() }
                        .buttonStyle(.borderedProminent)
                        .disabled(!mapper.isScanning)

                    Button("Mark test anchor") { mapper.markTestAnchor() }
                        .buttonStyle(.bordered)
                        .disabled(!mapper.canMarkAnchor)
                }

                Button("Export POC package") { mapper.exportPackage(zoneID: zoneID) }
                    .buttonStyle(.borderedProminent)
                    .disabled(!mapper.canExport)

                if let exportURL = mapper.exportURL {
                    ShareLink(item: exportURL) {
                        Label("Share exported package", systemImage: "square.and.arrow.up")
                    }
                }

                Text("Scan a distinctive room. Finish the RoomPlan scan, stand at the cube test point, mark its position, then export.")
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding()
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18))
            .padding()
        }
        .alert("Mapper error", isPresented: $mapper.showsError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(mapper.errorMessage)
        }
    }
}

#Preview {
    ContentView()
}
