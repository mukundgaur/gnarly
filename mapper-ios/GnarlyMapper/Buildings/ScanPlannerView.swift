import SwiftUI

struct ScanPlannerView: View {
    let building: OwnedBuilding
    let map: BuildingMap?
    var onPick: (ZoneScanTarget) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var creatingNew = false
    @State private var selectedZone: String?
    @State private var zoneName = ""
    @State private var selectedLevel: Int = 0
    @State private var newLevel = false
    @State private var newLevelNumber = 1
    @FocusState private var nameFocused: Bool

    private var zones: [BuildingZone] { map?.zones ?? [] }
    private var levels: [BuildingLevel] { map?.levels ?? [] }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if !zones.isEmpty {
                        Picker("This scan", selection: $creatingNew) {
                            Text("Update").tag(false)
                            Text("New zone").tag(true)
                        }
                        .pickerStyle(.segmented)
                    }

                    if creatingNew || zones.isEmpty {
                        Text("Zone name")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(MapperTheme.muted)
                        TextField("Kitchen", text: $zoneName)
                            .focused($nameFocused)
                            .font(.body)
                            .submitLabel(.done)
                            .padding(.horizontal, 12)
                            .frame(height: 40)
                            .background(MapperTheme.raised, in: RoundedRectangle(cornerRadius: 12))
                        if newLevel || levels.isEmpty {
                            Stepper("New floor  \(newLevelNumber)", value: $newLevelNumber, in: -4...20)
                                .font(.subheadline)
                        } else {
                            Picker("Floor", selection: $selectedLevel) {
                                ForEach(levels) { level in
                                    Text(level.name).tag(level.level)
                                }
                            }
                            .pickerStyle(.segmented)
                            Toggle("Scan a new floor", isOn: $newLevel)
                                .font(.subheadline)
                                .tint(MapperTheme.accent)
                        }
                    } else {
                        ForEach(zones) { zone in
                            Button {
                                selectedZone = zone.id
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(zone.name)
                                            .font(.subheadline.weight(.semibold))
                                        Text(map?.levelName(zone.level) ?? defaultLevelName(zone.level))
                                            .font(.caption2)
                                            .foregroundStyle(MapperTheme.muted)
                                    }
                                    Spacer()
                                    if selectedZone == zone.id {
                                        Image(systemName: "checkmark.circle.fill").foregroundStyle(MapperTheme.accent)
                                    }
                                }
                                .padding(.horizontal, 12)
                                .frame(minHeight: 44)
                                .background(MapperTheme.raised, in: RoundedRectangle(cornerRadius: 12))
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.white)
                        }
                    }
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(MapperTheme.background.ignoresSafeArea())
            .navigationTitle("What are you scanning?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("OK") { confirm() }
                        .disabled(!canConfirm)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { nameFocused = false }
                }
            }
            .onAppear {
                creatingNew = zones.isEmpty
                selectedLevel = levels.first?.level ?? 0
                selectedZone = zones.first?.id
                newLevelNumber = (levels.map(\.level).max() ?? -1) + 1
            }
        }
        .presentationDetents(nameFocused ? [.large] : [.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private var canConfirm: Bool {
        if creatingNew || zones.isEmpty {
            return !zoneName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return selectedZone != nil
    }

    private func confirm() {
        let version = building.activeVersion
        if creatingNew || zones.isEmpty {
            let level = (newLevel || levels.isEmpty) ? newLevelNumber : selectedLevel
            let name = zoneName.trimmingCharacters(in: .whitespacesAndNewlines)
            let id = ZoneIdentifier.make(from: name, existing: Set(zones.map(\.id)))
            let existingFloor = zones.first { $0.level == level }?.record.floorId
            onPick(ZoneScanTarget(
                kind: .newZone,
                buildingID: building.id,
                buildingName: building.name,
                versionID: version,
                zoneID: id,
                zoneName: name,
                floorID: floorIdentifier(level: level, existing: existingFloor),
                level: level,
                levelName: map?.levelName(level) ?? defaultLevelName(level),
                isNewLevel: newLevel || levels.isEmpty || !levels.contains { $0.level == level },
                previousPlacement: nil,
                previousWorldBounds: nil,
                levelBounds: map?.bounds(level: level)
            ))
        } else if let zone = zones.first(where: { $0.id == selectedZone }) {
            onPick(ZoneScanTarget(
                kind: .existingZone,
                buildingID: building.id,
                buildingName: building.name,
                versionID: version,
                zoneID: zone.id,
                zoneName: zone.name,
                floorID: zone.record.floorId,
                level: zone.level,
                levelName: map?.levelName(zone.level) ?? defaultLevelName(zone.level),
                isNewLevel: false,
                previousPlacement: zone.placement,
                previousWorldBounds: zone.worldBounds,
                levelBounds: map?.bounds(level: zone.level)
            ))
        }
    }
}
