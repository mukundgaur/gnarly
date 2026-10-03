import SwiftUI
import RoomPlan

struct ContentView: View {
    @StateObject private var mapper = MapperViewModel()
    @State private var zoneID = "zone-a"
    @State private var floorID = "ground"
    @State private var nodeType: GraphNodeType = .hallway
    @State private var nodeLabel = ""

    var body: some View {
        ZStack(alignment: .bottom) {
            RoomCaptureContainer(mapper: mapper)
                .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 10) {
                Text(mapper.statusText)
                    .font(.headline)

                HStack {
                    TextField("Zone ID", text: $zoneID)
                    TextField("Floor ID", text: $floorID)
                }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)

                Picker("Node type", selection: $nodeType) {
                    ForEach([GraphNodeType.entrance, .hallway, .stairs, .destination]) { type in
                        Text(type.title).tag(type)
                    }
                }
                .pickerStyle(.segmented)

                TextField("Optional label (Room 204)", text: $nodeLabel)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)

                HStack {
                    Button("Finish room") { mapper.finishRoom() }
                        .buttonStyle(.borderedProminent)
                        .disabled(!mapper.isScanning)

                    Button("Add node") { mapper.addNode(type: nodeType, label: nodeLabel) }
                        .buttonStyle(.bordered)
                        .disabled(!mapper.canAddNode)

                    Button("Undo") { mapper.undoLastNode() }
                        .buttonStyle(.bordered)
                        .disabled(mapper.recordedNodes.isEmpty)
                }

                HStack {
                    Button("Mark test anchor") { mapper.markTestAnchor() }
                        .buttonStyle(.bordered)
                        .disabled(!mapper.canMarkAnchor)

                    Button("Export package") { mapper.exportPackage(zoneID: zoneID, floorID: floorID) }
                        .buttonStyle(.borderedProminent)
                        .disabled(!mapper.canExport)
                }

                if let exportURL = mapper.exportURL {
                    ShareLink(item: exportURL) {
                        Label("Share exported package", systemImage: "square.and.arrow.up")
                    }
                }

                Text("Scan with a LiDAR iPhone. Tap Add node at the entrance, turns, stairs, and destinations. Finish the RoomPlan scan, optionally mark the Unity cube point, then export scan.json and building.json.")
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
