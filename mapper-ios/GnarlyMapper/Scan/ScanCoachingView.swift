import SwiftUI

/// Shows the floor-to-ceiling wall sweep people should follow for clean color.
struct ScanCoachingView: View {
    var photos: Int

    var body: some View {
        MapperCard {
            HStack(alignment: .top, spacing: 14) {
                SweepAnimation()
                    .frame(width: 72, height: 96)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Sweep each wall")
                        .font(.headline)
                    Text("Tilt the phone from the floor to the ceiling. Don’t walk backward — turn and face the wall.")
                        .font(.caption)
                        .foregroundStyle(MapperTheme.muted)
                    Text(photos == 0 ? "Waiting for a sharp photo…" : "\(photos) color photo\(photos == 1 ? "" : "s")")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(MapperTheme.accent)
                }
            }
        }
    }
}

struct SweepAnimation: View {
    var body: some View {
        TimelineView(.animation) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            let y = 0.82 - 0.64 * (sin(t * 1.6) + 1) / 2
            Canvas { context, size in
                let wall = CGRect(x: 8, y: 6, width: size.width - 16, height: size.height - 12)
                context.stroke(Path(roundedRect: wall, cornerRadius: 6), with: .color(.white.opacity(0.28)), lineWidth: 1.5)
                let lineY = wall.minY + wall.height * y
                var line = Path()
                line.move(to: CGPoint(x: wall.minX + 6, y: lineY))
                line.addLine(to: CGPoint(x: wall.maxX - 6, y: lineY))
                context.stroke(line, with: .color(MapperTheme.accent), lineWidth: 3)
                let phone = CGRect(x: size.width / 2 - 8, y: lineY - 16, width: 16, height: 32)
                context.fill(Path(roundedRect: phone, cornerRadius: 4), with: .color(.white))
            }
        }
    }
}
