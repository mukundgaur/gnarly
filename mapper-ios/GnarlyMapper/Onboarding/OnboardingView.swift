import SwiftUI

struct OnboardingView: View {
    var onFinished: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var page = 0

    private let slides: [(title: String, detail: String, systemImage: String)] = [
        ("Walk a room. Keep the map.", "LiDAR captures walls, doors, and the path you walk so indoor directions stay true to the building.", "lidar"),
        ("Sweep, don’t back up.", "For each wall, tilt the phone from the floor to the ceiling. That paints real color onto the model instead of smearing it.", "iphone.rear.camera"),
        ("See it where it stands.", "Each building you own sits on the map at its real location. Pick a zone, then scan.", "map"),
    ]

    var body: some View {
        VStack(spacing: 0) {
            TabView(selection: $page) {
                ForEach(slides.indices, id: \.self) { index in
                    slide(slides[index], index: index)
                        .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: page)

            controls
        }
        .background(MapperTheme.background.ignoresSafeArea())
    }

    private var controls: some View {
        VStack(spacing: 14) {
            HStack(spacing: 4) {
                ForEach(slides.indices, id: \.self) { index in
                    Button {
                        page = index
                    } label: {
                        Capsule()
                            .fill(index == page ? MapperTheme.accent : Color.white.opacity(0.28))
                            .frame(width: index == page ? 22 : 8, height: 8)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 18)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Page \(index + 1) of \(slides.count), \(slides[index].title)")
                    .accessibilityAddTraits(index == page ? .isSelected : [])
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: page = min(page + 1, slides.count - 1)
                case .decrement: page = max(page - 1, 0)
                @unknown default: break
                }
            }

            if page < slides.count - 1 {
                Button("Continue") { page += 1 }
                    .buttonStyle(.plain)
                    .font(.headline)
                    .foregroundStyle(MapperTheme.ink)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .padding(.vertical, 6)
                    .background(MapperTheme.accent, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .accessibilityHint("Shows the next introduction")
                Button("Skip") { onFinished() }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(MapperTheme.muted)
                    .frame(minHeight: 44)
                    .accessibilityLabel("Skip introduction")
            } else {
                MapperPrimaryButton(title: "Sign in or create an account", systemImage: "person.crop.circle") {
                    onFinished()
                }
                .accessibilityHint("Leaves the introduction and opens sign in")
            }
        }
        .padding(.horizontal, 22)
        .padding(.top, 4)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity)
        .background(MapperTheme.background)
    }

    private func slide(_ item: (title: String, detail: String, systemImage: String), index: Int) -> some View {
        GeometryReader { proxy in
            let artHeight = illustrationHeight(in: proxy.size)
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    OnboardingMotion(kind: index, animated: !reduceMotion)
                        .frame(maxWidth: .infinity)
                        .frame(height: artHeight)
                        .accessibilityHidden(true)
                    Text(item.title)
                        .font(.title.weight(.semibold))
                        .foregroundStyle(.white)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    Text(item.detail)
                        .font(.body)
                        .foregroundStyle(MapperTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, horizontalPadding(for: proxy.size.width))
                .padding(.top, 8)
                .padding(.bottom, 12)
                .frame(maxWidth: .infinity, minHeight: proxy.size.height, alignment: .top)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }

    /// Illustration grows with the phone and shrinks on short screens so the title stays on screen.
    private func illustrationHeight(in size: CGSize) -> CGFloat {
        let proposed = size.height * (size.height < 640 ? 0.32 : 0.4)
        return min(300, max(140, proposed))
    }

    private func horizontalPadding(for width: CGFloat) -> CGFloat {
        width < 360 ? 16 : 22
    }
}

/// Lightweight looping motion that previews the slide without needing recorded video.
private struct OnboardingMotion: View {
    let kind: Int
    var animated: Bool

    var body: some View {
        TimelineView(.animation(paused: !animated)) { timeline in
            let t = animated ? timeline.date.timeIntervalSinceReferenceDate : 0
            Canvas { context, size in
                let mid = CGPoint(x: size.width / 2, y: size.height / 2)
                let scale = min(size.width, size.height) / 260
                switch kind {
                case 0:
                    let pulse = 0.65 + 0.12 * sin(t * 1.6)
                    let room = CGRect(x: mid.x - 90 * pulse * scale, y: mid.y - 60 * pulse * scale, width: 180 * pulse * scale, height: 120 * pulse * scale)
                    context.stroke(Path(roundedRect: room, cornerRadius: 18 * scale), with: .color(MapperTheme.accent), lineWidth: 3)
                    let walker = CGPoint(x: mid.x + CGFloat(sin(t) * 50) * scale, y: mid.y + CGFloat(cos(t * 0.8) * 28) * scale)
                    context.fill(Path(ellipseIn: CGRect(x: walker.x - 7 * scale, y: walker.y - 7 * scale, width: 14 * scale, height: 14 * scale)), with: .color(.white))
                case 1:
                    let wall = CGRect(x: mid.x - 70 * scale, y: mid.y - 80 * scale, width: 140 * scale, height: 160 * scale)
                    context.stroke(Path(roundedRect: wall, cornerRadius: 8 * scale), with: .color(.white.opacity(0.35)), lineWidth: 2)
                    let y = mid.y + (70 - CGFloat((sin(t * 1.5) + 1) / 2) * 140) * scale
                    var sweep = Path()
                    sweep.move(to: CGPoint(x: mid.x - 55 * scale, y: y))
                    sweep.addLine(to: CGPoint(x: mid.x + 55 * scale, y: y))
                    context.stroke(sweep, with: .color(MapperTheme.accent), lineWidth: 4)
                    context.fill(Path(roundedRect: CGRect(x: mid.x - 12 * scale, y: y - 22 * scale, width: 24 * scale, height: 44 * scale), cornerRadius: 6 * scale), with: .color(.white))
                default:
                    let ring = CGRect(x: mid.x - 70 * scale, y: mid.y - 46 * scale, width: 140 * scale, height: 92 * scale)
                    context.stroke(Path(ellipseIn: ring), with: .color(.white.opacity(0.25)), lineWidth: 2)
                    let drop = 1 - abs(sin(t * 1.4))
                    context.fill(Path(ellipseIn: CGRect(x: mid.x - 8 * scale, y: mid.y + (-30 + 18 * drop) * scale, width: 16 * scale, height: 16 * scale)), with: .color(MapperTheme.accent))
                }
            }
        }
        .background(MapperTheme.raised, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
    }
}
