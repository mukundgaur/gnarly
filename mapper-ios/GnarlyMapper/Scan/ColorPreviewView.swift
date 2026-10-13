import SwiftUI

struct ColorPreviewView: View {
    @ObservedObject var mapper: MapperViewModel
    let building: OwnedBuilding
    let target: ZoneScanTarget
    var onDone: () -> Void
    @StateObject private var scene = BuildingSceneController()

    var body: some View {
        VStack(spacing: 0) {
            BuildingSceneView(controller: scene)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            VStack(alignment: .leading, spacing: 8) {
                Text(target.isNewZone ? "New zone preview" : "Updated zone preview")
                    .font(.headline)
                Text(mapper.previewSummary.isEmpty ? mapper.statusText : mapper.previewSummary)
                    .font(.caption)
                    .foregroundStyle(MapperTheme.muted)
                    .lineLimit(2)
                if mapper.previewAtlas == nil {
                    Text("No color photos yet. You can still upload the geometry.")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
                HStack(spacing: 8) {
                    Button("Scan again") {
                        mapper.beginPlannedScan(building: building, target: target)
                    }
                    .buttonStyle(.plain)
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background(MapperTheme.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    MapperPrimaryButton(
                        title: mapper.isUploading ? "Uploading…" : "Upload",
                        systemImage: "icloud.and.arrow.up",
                        busy: mapper.isUploading,
                        enabled: mapper.canExport && !mapper.isUploading,
                        compact: true
                    ) {
                        mapper.uploadPackage(
                            buildingID: target.buildingID,
                            versionID: target.versionID ?? "v1",
                            zoneID: target.zoneID,
                            floorID: target.floorID
                        )
                    }
                }
                Button("Done") { onDone() }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(MapperTheme.muted)
                    .frame(maxWidth: .infinity)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 8)
            .background(.ultraThinMaterial)
        }
        .background(MapperTheme.background.ignoresSafeArea())
        .onAppear { refresh() }
        .onChange(of: mapper.previewSummary) { _, _ in refresh() }
        .onChange(of: mapper.statusText) { _, text in
            if text.hasPrefix("Uploaded") { onDone() }
        }
    }

    private func refresh() {
        scene.showPreview(surfaces: mapper.previewSurfaces, colors: mapper.previewColors, atlas: mapper.previewAtlas)
    }
}
