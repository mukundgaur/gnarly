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
                .ignoresSafeArea(edges: .top)
            VStack(alignment: .leading, spacing: 12) {
                Text(target.isNewZone ? "New zone preview" : "Updated zone preview")
                    .font(.title3.weight(.semibold))
                Text(mapper.previewSummary.isEmpty ? mapper.statusText : mapper.previewSummary)
                    .font(.subheadline)
                    .foregroundStyle(MapperTheme.muted)
                if mapper.previewAtlas == nil {
                    Text("No color photos were kept. You can still upload the geometry, or scan again and sweep each wall.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                HStack(spacing: 10) {
                    Button("Scan again") {
                        mapper.beginPlannedScan(building: building, target: target)
                    }
                    .buttonStyle(.plain)
                    .font(.headline)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .background(MapperTheme.raised, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    MapperPrimaryButton(
                        title: mapper.isUploading ? "Uploading…" : "Upload",
                        systemImage: "icloud.and.arrow.up",
                        busy: mapper.isUploading,
                        enabled: mapper.canExport && !mapper.isUploading
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
            .padding(18)
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
