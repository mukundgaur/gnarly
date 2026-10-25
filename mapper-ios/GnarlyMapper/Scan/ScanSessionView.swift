import SwiftUI

struct ScanSessionView: View {
    let building: OwnedBuilding
    let target: ZoneScanTarget
    @ObservedObject var library: BuildingLibrary
    @Environment(\.dismiss) private var dismiss
    @StateObject private var mapper = MapperViewModel()
    @State private var started = false
    @State private var showCoach = true
    @State private var showCoverage = true
    @State private var selectedCoverage: String?

    var body: some View {
        ZStack {
            if mapper.phase == .preview || mapper.phase == .uploading && mapper.exportURL != nil {
                ColorPreviewView(mapper: mapper, building: building, target: target) {
                    dismiss()
                }
            } else {
                capture
            }
        }
        .alert("Mapper error", isPresented: $mapper.showsError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(mapper.errorMessage)
        }
    }

    private var capture: some View {
        ZStack(alignment: .top) {
            RoomCaptureContainer(mapper: mapper)
                .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.headline)
                            .frame(width: 36, height: 36)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .accessibilityLabel("Close")
                    Spacer()
                    Text(target.zoneName)
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(.ultraThinMaterial, in: Capsule())
                }

                HStack {
                    Text(mapper.statusText)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                    Spacer()
                    Text("\(mapper.recordedNodeCount) pts")
                        .font(.caption.monospacedDigit().weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                .padding(12)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                if mapper.phase == .scanning {
                    CoverageStatusChip(snapshot: mapper.coverage, visible: showCoverage) {
                        withAnimation(.spring(duration: 0.35)) {
                            showCoverage.toggle()
                            if !showCoverage { selectedCoverage = nil }
                        }
                    }
                    if showCoverage {
                        CoverageLegend()
                            .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                    if showCoverage, let sample = mapper.coverage.samples.first(where: { $0.id == selectedCoverage }) {
                        CoverageHintCard(sample: sample) {
                            withAnimation(.spring(duration: 0.35)) { selectedCoverage = nil }
                        }
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                }

                if showCoach && mapper.phase == .scanning {
                    ScanCoachingView(photos: mapper.colorFrameCount)
                        .onTapGesture { withAnimation { showCoach = false } }
                }

                if !mapper.scanPlan.shapes.isEmpty {
                    HStack {
                        Spacer()
                        ScanMinimapCard(plan: mapper.scanPlan)
                    }
                }
                Spacer()
                    .allowsHitTesting(false)
            }
            .padding(16)

            if showCoverage && mapper.phase == .scanning {
                CoverageOverlay(samples: mapper.coverage.samples, session: mapper.arSession, selectedID: selectedCoverage) { id in
                    withAnimation(.spring(duration: 0.35)) { selectedCoverage = id }
                }
                .ignoresSafeArea()
                .transition(.opacity)
            }
        }
        .safeAreaInset(edge: .bottom) {
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
            }
            .padding(10)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
        .onAppear {
            guard !started else { return }
            started = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                mapper.beginPlannedScan(building: building, target: target)
            }
        }
    }
}

struct CaptureActionLabel: View {
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
