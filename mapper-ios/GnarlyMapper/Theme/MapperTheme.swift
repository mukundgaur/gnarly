import SwiftUI

enum MapperTheme {
    static let accent = Color(red: 0.37, green: 0.78, blue: 1.0)
    static let ink = Color(red: 0.02, green: 0.07, blue: 0.11)
    static let background = Color(red: 0.04, green: 0.06, blue: 0.09)
    static let raised = Color.white.opacity(0.06)
    static let line = Color.white.opacity(0.10)
    static let muted = Color.white.opacity(0.58)
}

struct MapperScreen<Content: View>: View {
    var title: String
    var subtitle: String? = nil
    @ViewBuilder var content: () -> Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(title)
                        .font(.largeTitle.weight(.semibold))
                        .foregroundStyle(.white)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    if let subtitle {
                        Text(subtitle)
                            .font(.subheadline)
                            .foregroundStyle(MapperTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                content()
            }
            .padding(.horizontal, 22)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MapperTheme.background.ignoresSafeArea())
    }
}

struct MapperPrimaryButton: View {
    let title: String
    var systemImage: String? = nil
    var busy = false
    var enabled = true
    var compact = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if busy { ProgressView().tint(MapperTheme.ink) }
                else if let systemImage { Image(systemName: systemImage).accessibilityHidden(true) }
                Text(title)
                    .font(compact ? .subheadline.weight(.semibold) : .headline)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, compact ? 10 : 14)
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.plain)
        .foregroundStyle(MapperTheme.ink)
        .background(MapperTheme.accent, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .opacity(enabled && !busy ? 1 : 0.45)
        .disabled(!enabled || busy)
    }
}

struct MapperCard<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(MapperTheme.line, lineWidth: 1)
            )
    }
}
