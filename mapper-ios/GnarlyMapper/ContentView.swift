import SwiftUI
import RoomPlan
import UIKit

struct ContentView: View {
    @EnvironmentObject private var authSession: FirebaseAuthSession
    @StateObject private var mapper = MapperViewModel()
    @State private var zoneID = "1"
    @State private var floorID = "ground"
    @State private var floorZoneID = "1"
    @State private var stairID = ""
    @State private var floorIsBelow = true
    @State private var buildingID = "main-building"
    @State private var versionID = "v1"
    @State private var zoneConnectionsJSON = "{\n  \"schemaVersion\": 1,\n  \"connections\": []\n}"
    @State private var showsFirebaseConnection = false
    @State private var showsSettings = false

    var body: some View {
        ZStack(alignment: .top) {
            RoomCaptureContainer(mapper: mapper)
                .ignoresSafeArea()

            HStack(spacing: 10) {
                Image(systemName: "point.3.connected.trianglepath.dotted")
                    .foregroundStyle(.cyan)
                Text(mapper.statusText)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 4)
                Text("\(mapper.recordedNodeCount)")
                    .font(.subheadline.monospacedDigit().weight(.bold))
                Text("pts")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 14)
            .frame(height: 48)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .frame(maxWidth: 500)
            .padding(.horizontal, 16)
            .padding(.top, 10)

            if !mapper.scanPlan.shapes.isEmpty {
                HStack {
                    Spacer(minLength: 0)
                    ScanMinimapCard(plan: mapper.scanPlan)
                }
                .frame(maxWidth: 500)
                .padding(.horizontal, 16)
                .padding(.top, 66)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    Label("Capture", systemImage: "dot.radiowaves.left.and.right")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.cyan)
                    Spacer()
                    Button {
                        showsSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                            .frame(width: 36, height: 36)
                    }
                    .buttonStyle(.plain)
                    .background(.thinMaterial, in: Circle())
                    .accessibilityLabel("Mapper settings")
                }

                HStack(spacing: 8) {
                    Button {
                        mapper.finishRoom()
                    } label: {
                        CaptureActionLabel(title: "Finish", systemImage: "checkmark", highlighted: mapper.isScanning)
                    }
                        .disabled(!mapper.isScanning)

                    Button {
                        mapper.dropManualNode()
                    } label: {
                        CaptureActionLabel(title: "Point", systemImage: "plus", highlighted: false)
                    }
                        .disabled(!mapper.canDropManualNode)

                    Button {
                        mapper.markTestAnchor()
                    } label: {
                        CaptureActionLabel(title: "Anchor", systemImage: "cube", highlighted: false)
                    }
                        .disabled(!mapper.canMarkAnchor)

                    Button {
                        mapper.exportPackage(
                            zoneID: zoneID,
                            floorID: floorID,
                            asStairs: mapper.isStairScan,
                            stairID: stairID,
                            linkedFloorZoneID: floorZoneID,
                            floorIsBelow: floorIsBelow
                        )
                    } label: {
                        CaptureActionLabel(title: "Export", systemImage: "square.and.arrow.down", highlighted: false)
                    }
                        .disabled(!mapper.canExport)
                }
            }
            .frame(maxWidth: 500)
            .padding(10)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
        .onAppear { zoneConnectionsJSON = mapper.zoneConnectionsJSON }
        .onChange(of: mapper.zoneConnectionsJSON) { _, newValue in
            zoneConnectionsJSON = newValue
        }
        .onChange(of: mapper.detectedStairs.map(\.id)) { _, ids in
            guard stairID.isEmpty, let first = ids.first else { return }
            stairID = first
        }
        .alert("Mapper error", isPresented: $mapper.showsError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(mapper.errorMessage)
        }
        .sheet(isPresented: $showsFirebaseConnection) {
            FirebaseConnectionView(authSession: authSession)
        }
        .sheet(isPresented: $showsSettings) {
            NavigationStack {
                Form {
                    Section("Package details") {
                        TextField("Building", text: $buildingID)
                        TextField("Version", text: $versionID)
                        TextField("Zone", text: $zoneID)
                        TextField("Floor", text: $floorID)
                    }

                    Section("Scan diagnostics") {
                        Text(mapper.diagnosticsText)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                        Button("Copy diagnostics") {
                            UIPasteboard.general.string = mapper.diagnosticsText
                        }
                    }

                    Section("Firebase") {
                        Button {
                            showsFirebaseConnection = true
                        } label: {
                            Label(
                                authSession.isAuthenticated ? "Firebase connected" : "Connect Firebase",
                                systemImage: authSession.isAuthenticated ? "checkmark.icloud" : "icloud.slash"
                            )
                        }

                        Button {
                            mapper.uploadPackage(buildingID: buildingID, versionID: versionID, zoneID: zoneID, floorID: floorID)
                        } label: {
                            Label(mapper.isUploading ? "Uploading…" : "Upload package", systemImage: "icloud.and.arrow.up")
                        }
                        .disabled(!mapper.canExport || !authSession.isAuthenticated || mapper.isUploading)

                        if mapper.isUploading {
                            HStack(spacing: 10) {
                                ProgressView()
                                Text(mapper.statusText)
                                    .font(.subheadline)
                            }
                            .accessibilityElement(children: .combine)
                        } else if mapper.showsError {
                            Label(mapper.errorMessage, systemImage: "exclamationmark.triangle")
                                .font(.subheadline)
                                .foregroundStyle(.red)
                        } else if mapper.exportURL != nil {
                            Text(mapper.statusText)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        Button("Upload & start next zone") {
                            mapper.uploadPackage(buildingID: buildingID, versionID: versionID, zoneID: zoneID, floorID: floorID, startNextZone: true) {
                                zoneID = $0
                                showsSettings = false
                            }
                        }
                        .disabled(!mapper.canExport || !authSession.isAuthenticated || mapper.isUploading)
                    }

                    Section("Stair and zone links") {
                        Text("RoomPlan stair objects fill these links. A floor node connects to landing-below or landing-above in the stair zone. Publish the JSON so the navigator can cross floors.")
                            .font(.caption)
                        Picker("This floor is", selection: $floorIsBelow) {
                            Text("Below the stairs").tag(true)
                            Text("Above the stairs").tag(false)
                        }
                        if !mapper.detectedStairs.isEmpty || !mapper.catalog.stairs.isEmpty {
                            Picker("Stair zone", selection: $stairID) {
                                Text("Detected stair").tag("")
                                ForEach(Array(Set(mapper.detectedStairs.map(\.id) + mapper.catalog.stairs.map(\.id))).sorted(), id: \.self) { id in
                                    Text(id).tag(id)
                                }
                            }
                        }
                        TextEditor(text: $zoneConnectionsJSON)
                            .font(.system(.caption, design: .monospaced))
                            .frame(minHeight: 150)
                        Button("Publish zone connections") {
                            mapper.uploadZoneConnections(buildingID: buildingID, versionID: versionID, json: zoneConnectionsJSON)
                        }
                        .disabled(!authSession.isAuthenticated || mapper.isUploading)
                    }

                    if let exportURL = mapper.exportURL {
                        Section("Export") {
                            ShareLink(item: exportURL) {
                                Label("Share package", systemImage: "square.and.arrow.up")
                            }
                        }
                    }
                }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .navigationTitle("Mapper settings")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { showsSettings = false }
                    }
                }
            }
            .presentationDetents([.medium, .large])
        }
    }
}

private struct CaptureActionLabel: View {
    let title: String
    let systemImage: String
    let highlighted: Bool

    var body: some View {
        VStack(spacing: 5) {
            Image(systemName: systemImage)
                .font(.headline.weight(.semibold))
            Text(title)
                .font(.caption2.weight(.semibold))
        }
        .foregroundStyle(highlighted ? Color.black : Color.primary)
        .frame(maxWidth: .infinity, minHeight: 58)
        .background(highlighted ? Color.cyan : Color.primary.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

#Preview {
    ContentView()
        .environmentObject(FirebaseAuthSession())
}
