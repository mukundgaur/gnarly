import SwiftUI

struct OnboardingView: View {
    var onFinished: () -> Void
    @State private var page = 0

    private let slides: [(title: String, detail: String, systemImage: String)] = [
        ("Walk a room. Keep the map.", "LiDAR captures walls, doors, and the path you walk so indoor directions stay true to the building.", "lidar"),
        ("Sweep, don’t back up.", "For each wall, tilt the phone from the floor to the ceiling. That paints real color onto the model instead of smearing it.", "iphone.rear.camera"),
        ("See it where it stands.", "Each building you own sits on the map at its real location. Pick a zone, then scan.", "map"),
    ]

    var body: some View {
        ZStack {
            MapperTheme.background.ignoresSafeArea()
            TabView(selection: $page) {
                ForEach(slides.indices, id: \.self) { index in
                    slide(slides[index], index: index)
                        .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .always))
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 12) {
                if page < slides.count - 1 {
                    Button("Continue") { withAnimation { page += 1 } }
                        .buttonStyle(.plain)
                        .font(.headline)
                        .foregroundStyle(MapperTheme.ink)
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .background(MapperTheme.accent, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                } else {
                    MapperPrimaryButton(title: "Sign in or create an account", systemImage: "person.crop.circle") {
                        onFinished()
                    }
                }
                if page < slides.count - 1 {
                    Button("Skip") { onFinished() }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(MapperTheme.muted)
                }
            }
            .padding(.horizontal, 22)
            .padding(.bottom, 18)
        }
    }

    private func slide(_ item: (title: String, detail: String, systemImage: String), index: Int) -> some View {
        VStack(spacing: 28) {
            Spacer()
            OnboardingMotion(kind: index)
                .frame(height: 260)
            VStack(alignment: .leading, spacing: 10) {
                Label(item.title, systemImage: item.systemImage)
                    .font(.title.weight(.semibold))
                    .foregroundStyle(.white)
                    .labelStyle(.titleOnly)
                Text(item.detail)
                    .font(.body)
                    .foregroundStyle(MapperTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 8)
            Spacer()
            Spacer()
        }
        .padding(24)
    }
}

/// Lightweight looping motion that previews the slide without needing recorded video.
private struct OnboardingMotion: View {
    let kind: Int
    var body: some View {
        TimelineView(.animation) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            Canvas { context, size in
                let mid = CGPoint(x: size.width / 2, y: size.height / 2)
                switch kind {
                case 0:
                    let pulse = 0.65 + 0.12 * sin(t * 1.6)
                    var room = Path(roundedRect: CGRect(x: mid.x - 90 * pulse, y: mid.y - 60 * pulse, width: 180 * pulse, height: 120 * pulse), cornerRadius: 18)
                    context.stroke(room, with: .color(MapperTheme.accent), lineWidth: 3)
                    let walker = CGPoint(x: mid.x + CGFloat(sin(t) * 50), y: mid.y + CGFloat(cos(t * 0.8) * 28))
                    context.fill(Path(ellipseIn: CGRect(x: walker.x - 7, y: walker.y - 7, width: 14, height: 14)), with: .color(.white))
                case 1:
                    let wall = CGRect(x: mid.x - 70, y: mid.y - 80, width: 140, height: 160)
                    context.stroke(Path(roundedRect: wall, cornerRadius: 8), with: .color(.white.opacity(0.35)), lineWidth: 2)
                    let y = mid.y + 70 - CGFloat((sin(t * 1.5) + 1) / 2) * 140
                    var sweep = Path()
                    sweep.move(to: CGPoint(x: mid.x - 55, y: y))
                    sweep.addLine(to: CGPoint(x: mid.x + 55, y: y))
                    context.stroke(sweep, with: .color(MapperTheme.accent), lineWidth: 4)
                    context.fill(Path(roundedRect: CGRect(x: mid.x - 12, y: y - 22, width: 24, height: 44), cornerRadius: 6), with: .color(.white))
                default:
                    let ring = CGRect(x: mid.x - 70, y: mid.y - 46, width: 140, height: 92)
                    context.stroke(Path(ellipseIn: ring), with: .color(.white.opacity(0.25)), lineWidth: 2)
                    let drop = 1 - abs(sin(t * 1.4))
                    context.fill(Path(ellipseIn: CGRect(x: mid.x - 8, y: mid.y - 30 + 18 * drop, width: 16, height: 16)), with: .color(MapperTheme.accent))
                }
            }
        }
        .background(MapperTheme.raised, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
    }
}
