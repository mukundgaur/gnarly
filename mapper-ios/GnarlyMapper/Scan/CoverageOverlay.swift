import ARKit
import simd
import SwiftUI
import UIKit

/// Camera-view overlay. Weak spots pulse; covered spots stay quiet. Touches pass through except on a marker.
struct CoverageOverlay: UIViewRepresentable {
    var samples: [CoverageSample]
    var session: ARSession
    var selectedID: String?
    var onSelect: (String?) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onSelect: onSelect)
    }

    func makeUIView(context: Context) -> CoverageCanvasView {
        let view = CoverageCanvasView()
        view.onSelect = context.coordinator.onSelect
        return view
    }

    func updateUIView(_ uiView: CoverageCanvasView, context: Context) {
        context.coordinator.onSelect = onSelect
        uiView.onSelect = context.coordinator.onSelect
        uiView.session = session
        uiView.samples = samples
        uiView.selectedID = selectedID
    }

    final class Coordinator {
        var onSelect: (String?) -> Void
        init(onSelect: @escaping (String?) -> Void) { self.onSelect = onSelect }
    }
}

struct CoverageMarker: Equatable {
    var id: String
    var point: CGPoint
    var grade: CoverageGrade
    var kind: String
    var count: Int
    /// Drawn on the screen edge, pointing at a weak spot that is currently off-camera.
    var pointsOffscreen: Bool
}

final class CoverageCanvasView: UIView {
    var samples: [CoverageSample] = [] { didSet { rebuild = true } }
    var selectedID: String?
    var session: ARSession?
    var onSelect: ((String?) -> Void)?
    private var markers: [CoverageMarker] = []
    private var rebuild = true
    private let ticker = DisplayTicker()
    private var link: CADisplayLink?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isOpaque = false
        isAccessibilityElement = false
        let link = CADisplayLink(target: ticker, selector: #selector(DisplayTicker.tick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
        link.add(to: .main, forMode: .common)
        ticker.view = self
        self.link = link
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
        addGestureRecognizer(tap)
    }

    required init?(coder: NSCoder) { nil }

    deinit { link?.invalidate() }

    fileprivate func tick() {
        if rebuild || session?.currentFrame != nil {
            markers = Self.layout(samples: samples, session: session, viewport: bounds.size, orientation: interfaceOrientation, selectedID: selectedID)
            rebuild = false
        }
        setNeedsDisplay()
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        marker(near: point) != nil
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        point(inside: point, with: event) ? self : nil
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        let time = CACurrentMediaTime()
        for marker in markers {
            draw(marker, time: time, selected: marker.id == selectedID, in: context)
        }
    }

    override var accessibilityElements: [Any]? {
        get {
            markers.map { marker in
                let element = UIAccessibilityElement(accessibilityContainer: self)
                element.accessibilityFrameInContainerSpace = CGRect(x: marker.point.x - 22, y: marker.point.y - 22, width: 44, height: 44)
                let whereText = marker.pointsOffscreen ? "off screen" : "on screen"
                element.accessibilityLabel = "\(Self.gradeName(marker.grade)) \(marker.kind), \(whereText)"
                element.accessibilityTraits = .button
                return element
            }
        }
        set {}
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        guard let marker = marker(near: gesture.location(in: self)) else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        onSelect?(selectedID == marker.id ? nil : marker.id)
    }

    private func marker(near point: CGPoint) -> CoverageMarker? {
        markers.min {
            hypot($0.point.x - point.x, $0.point.y - point.y) < hypot($1.point.x - point.x, $1.point.y - point.y)
        }.flatMap { hypot($0.point.x - point.x, $0.point.y - point.y) < 30 ? $0 : nil }
    }

    private var interfaceOrientation: UIInterfaceOrientation {
        window?.windowScene?.interfaceOrientation ?? .portrait
    }

    private func draw(_ marker: CoverageMarker, time: CFTimeInterval, selected: Bool, in context: CGContext) {
        let color = Self.color(marker.grade)
        let center = marker.point
        context.saveGState()
        if marker.pointsOffscreen {
            let nudge = CGFloat(sin(time * 5)) * 3
            let outward = Self.edgeDirection(center, in: bounds.insetBy(dx: 28, dy: 28))
            let drawn = CGPoint(x: center.x + outward.dx * nudge, y: center.y + outward.dy * nudge)
            context.setFillColor(color.withAlphaComponent(0.92).cgColor)
            Self.chevron(at: drawn, direction: outward, selected: selected).fill()
            context.restoreGState()
            return
        }

        context.setFillColor(UIColor.black.withAlphaComponent(selected ? 0.45 : 0.28).cgColor)
        context.fillEllipse(in: CGRect(x: center.x - 16, y: center.y - 16, width: 32, height: 32))

        switch marker.grade {
        case .unseen, .thin:
            let period = marker.grade == .unseen ? 1.15 : 1.7
            let phase = CGFloat(time.truncatingRemainder(dividingBy: period) / period)
            let radius = 8 + 20 * phase
            context.setStrokeColor(color.withAlphaComponent((1 - phase) * 0.9).cgColor)
            context.setLineWidth(selected ? 3 : 2)
            context.strokeEllipse(in: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
            let core: CGFloat = selected ? 8 : 6
            context.setFillColor(color.cgColor)
            context.fillEllipse(in: CGRect(x: center.x - core, y: center.y - core, width: core * 2, height: core * 2))
        case .good:
            let core: CGFloat = selected ? 7 : 4.5
            context.setFillColor(color.withAlphaComponent(selected ? 1 : 0.8).cgColor)
            context.fillEllipse(in: CGRect(x: center.x - core, y: center.y - core, width: core * 2, height: core * 2))
        }

        if selected {
            let bob = CGFloat(sin(time * 4)) * 3
            context.setFillColor(UIColor.white.cgColor)
            let chevron = UIBezierPath()
            let tip = CGPoint(x: center.x, y: center.y - 22 - bob)
            chevron.move(to: tip)
            chevron.addLine(to: CGPoint(x: center.x - 6, y: tip.y + 8))
            chevron.addLine(to: CGPoint(x: center.x + 6, y: tip.y + 8))
            chevron.close()
            chevron.fill()
        }

        if marker.count > 1 && marker.grade != .good {
            let text = "\(marker.count)" as NSString
            let font = UIFont.monospacedDigitSystemFont(ofSize: 10, weight: .bold)
            let size = text.size(withAttributes: [.font: font])
            let pill = CGRect(x: center.x + 6, y: center.y - 16, width: size.width + 8, height: size.height + 2)
            context.setFillColor(color.cgColor)
            UIBezierPath(roundedRect: pill, cornerRadius: pill.height / 2).fill()
            text.draw(at: CGPoint(x: pill.minX + 4, y: pill.minY + 1), withAttributes: [
                .font: font, .foregroundColor: UIColor.black,
            ])
        }
        context.restoreGState()
    }

    private static func layout(
        samples: [CoverageSample],
        session: ARSession?,
        viewport: CGSize,
        orientation: UIInterfaceOrientation,
        selectedID: String?
    ) -> [CoverageMarker] {
        guard let frame = session?.currentFrame, viewport.width > 1, viewport.height > 1 else { return [] }
        let safe = viewport.insetBy(dx: 18, dy: 0).inset(by: UIEdgeInsets(top: 168, left: 0, bottom: 128, right: 0))
        var placed: [(sample: CoverageSample, point: CGPoint, inside: Bool)] = []
        for sample in samples {
            guard let point = project(sample.world, frame: frame, viewport: viewport, orientation: orientation) else { continue }
            let inside = safe.contains(point)
            placed.append((sample, point, inside))
        }

        var markers = cluster(placed.filter { $0.inside }, radius: 54, limit: 26)
        if let selectedID, !markers.contains(where: { $0.id == selectedID }),
           let selected = placed.first(where: { $0.sample.id == selectedID && $0.inside }) {
            markers.append(CoverageMarker(id: selected.sample.id, point: selected.point, grade: selected.sample.grade, kind: selected.sample.kind, count: 1, pointsOffscreen: false))
        }

        let offscreen = placed.filter { !$0.inside && $0.sample.grade != .good }
            .sorted { lhs, rhs in
                if lhs.sample.grade != rhs.sample.grade { return lhs.sample.grade < rhs.sample.grade }
                return distanceToCenter(lhs.point, viewport) < distanceToCenter(rhs.point, viewport)
            }
        var usedEdges: [CGPoint] = []
        for item in offscreen.prefix(12) {
            let edge = clamp(item.point, to: safe.insetBy(dx: 16, dy: 16))
            guard !usedEdges.contains(where: { hypot($0.x - edge.x, $0.y - edge.y) < 46 }) else { continue }
            usedEdges.append(edge)
            markers.append(CoverageMarker(id: item.sample.id, point: edge, grade: item.sample.grade, kind: item.sample.kind, count: 1, pointsOffscreen: true))
            if usedEdges.count == 3 { break }
        }
        return markers
    }

    private static func cluster(_ placed: [(sample: CoverageSample, point: CGPoint, inside: Bool)], radius: CGFloat, limit: Int) -> [CoverageMarker] {
        var remaining = placed.sorted { lhs, rhs in
            if lhs.sample.grade != rhs.sample.grade { return lhs.sample.grade < rhs.sample.grade }
            return lhs.sample.id < rhs.sample.id
        }
        var markers: [CoverageMarker] = []
        var weak = 0
        var good = 0
        while let seed = remaining.first {
            remaining.removeFirst()
            var group = [seed]
            remaining.removeAll { other in
                guard hypot(other.point.x - seed.point.x, other.point.y - seed.point.y) < radius else { return false }
                group.append(other)
                return true
            }
            let worst = group.map { $0.sample.grade }.min() ?? seed.sample.grade
            if worst == .good {
                guard good < 8 else { continue }
                good += 1
            } else {
                guard weak < limit else { continue }
                weak += 1
            }
            let point = group.reduce(CGPoint.zero) { CGPoint(x: $0.x + $1.point.x, y: $0.y + $1.point.y) }
            markers.append(CoverageMarker(
                id: seed.sample.id,
                point: CGPoint(x: point.x / CGFloat(group.count), y: point.y / CGFloat(group.count)),
                grade: worst,
                kind: seed.sample.kind,
                count: group.count,
                pointsOffscreen: false
            ))
        }
        return markers
    }

    private static func project(_ world: SIMD3<Float>, frame: ARFrame, viewport: CGSize, orientation: UIInterfaceOrientation) -> CGPoint? {
        let local = frame.camera.transform.inverse * SIMD4<Float>(world.x, world.y, world.z, 1)
        guard -local.z > 0.2 else { return nil }
        let point = frame.camera.projectPoint(world, orientation: orientation, viewportSize: viewport)
        guard point.x.isFinite, point.y.isFinite else { return nil }
        return point
    }

    private static func clamp(_ point: CGPoint, to rect: CGRect) -> CGPoint {
        CGPoint(x: min(rect.maxX, max(rect.minX, point.x)), y: min(rect.maxY, max(rect.minY, point.y)))
    }

    private static func distanceToCenter(_ point: CGPoint, _ viewport: CGSize) -> CGFloat {
        hypot(point.x - viewport.width / 2, point.y - viewport.height / 2)
    }

    private static func edgeDirection(_ point: CGPoint, in rect: CGRect) -> CGVector {
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let dx = point.x - center.x
        let dy = point.y - center.y
        let length = max(1, hypot(dx, dy))
        return CGVector(dx: dx / length, dy: dy / length)
    }

    private static func chevron(at point: CGPoint, direction: CGVector, selected: Bool) -> UIBezierPath {
        let tip = point
        let back = CGPoint(x: tip.x - direction.dx * 16, y: tip.y - direction.dy * 16)
        let side = CGVector(dx: -direction.dy, dy: direction.dx)
        let span: CGFloat = selected ? 9 : 7
        let path = UIBezierPath()
        path.move(to: tip)
        path.addLine(to: CGPoint(x: back.x + side.dx * span, y: back.y + side.dy * span))
        path.addLine(to: CGPoint(x: back.x - side.dx * span, y: back.y - side.dy * span))
        path.close()
        return path
    }

    private static func color(_ grade: CoverageGrade) -> UIColor {
        switch grade {
        case .unseen: return UIColor(red: 1, green: 0.38, blue: 0.32, alpha: 1)
        case .thin: return UIColor(red: 1, green: 0.72, blue: 0.22, alpha: 1)
        case .good: return UIColor(red: 0.35, green: 0.86, blue: 0.58, alpha: 1)
        }
    }

    private static func gradeName(_ grade: CoverageGrade) -> String {
        switch grade {
        case .unseen: return "Needs a sweep"
        case .thin: return "Glancing coverage"
        case .good: return "Covered"
        }
    }
}

private final class DisplayTicker: NSObject {
    weak var view: CoverageCanvasView?
    @objc func tick() { view?.tick() }
}

private extension CGSize {
    func insetBy(dx: CGFloat, dy: CGFloat) -> CGRect {
        CGRect(x: dx, y: dy, width: max(0, width - dx * 2), height: max(0, height - dy * 2))
    }
}

struct CoverageStatusChip: View {
    var snapshot: CoverageSnapshot
    var visible: Bool
    var onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 8) {
                CoveragePulseDot(grade: snapshot.weakSurfaceCount == 0 && snapshot.surfaceCount > 0 ? .good : .unseen)
                Text(title)
                    .font(.caption.weight(.semibold))
                    .contentTransition(.numericText())
                Image(systemName: visible ? "eye" : "eye.slash")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.ultraThinMaterial, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityHint(visible ? "Hides the coverage overlay" : "Shows which surfaces still need a photo")
    }

    private var title: String {
        guard snapshot.surfaceCount > 0 else { return "Waiting for the room…" }
        if snapshot.weakSurfaceCount == 0 { return "Color coverage looks solid" }
        let count = snapshot.weakSurfaceCount
        return "\(count) surface\(count == 1 ? "" : "s") need a closer sweep"
    }
}

struct CoverageLegend: View {
    var body: some View {
        HStack(spacing: 12) {
            legend(.unseen, "Sweep")
            legend(.thin, "Glancing")
            legend(.good, "Covered")
        }
        .font(.caption2.weight(.semibold))
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(.ultraThinMaterial, in: Capsule())
        .accessibilityElement(children: .combine)
    }

    private func legend(_ grade: CoverageGrade, _ title: String) -> some View {
        HStack(spacing: 5) {
            CoveragePulseDot(grade: grade)
            Text(title)
        }
    }
}

struct CoverageHintCard: View {
    var sample: CoverageSample
    var dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            CoveragePulseDot(grade: sample.grade)
                .padding(.top, 3)
            VStack(alignment: .leading, spacing: 4) {
                Text(sample.grade == .good ? "Covered" : sample.grade == .thin ? "Needs a better angle" : "Needs a sweep")
                    .font(.subheadline.weight(.semibold))
                Text(ColorCoverage.hint(kind: sample.kind, grade: sample.grade))
                    .font(.caption)
                    .foregroundStyle(MapperTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
                    .frame(width: 28, height: 28)
            }
            .accessibilityLabel("Dismiss coverage hint")
        }
        .padding(12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

private struct CoveragePulseDot: View {
    var grade: CoverageGrade

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: grade == .good)) { timeline in
            let phase = timeline.date.timeIntervalSinceReferenceDate
            let pulse = grade == .good ? 1 : 0.55 + 0.45 * (sin(phase * (grade == .unseen ? 5 : 3)) + 1) / 2
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
                .scaleEffect(grade == .good ? 1 : 0.85 + 0.25 * pulse)
                .opacity(grade == .good ? 1 : 0.65 + 0.35 * pulse)
        }
        .frame(width: 12, height: 12)
    }

    private var color: Color {
        switch grade {
        case .unseen: return Color(red: 1, green: 0.38, blue: 0.32)
        case .thin: return Color(red: 1, green: 0.72, blue: 0.22)
        case .good: return Color(red: 0.35, green: 0.86, blue: 0.58)
        }
    }
}
