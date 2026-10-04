import CoreHaptics
import Foundation

/// Two navigation patterns on the Taptic Engine:
/// a faint continuous rumble while the user is on the route, and a violent
/// repeating pulse when LiDAR sees an obstacle. Pulse rate and hardness
/// follow closeness (0 = just detected, 1 = about to hit).
final class GnarlyHapticPlayer {
    static let shared = GnarlyHapticPlayer()

    private enum Mode {
        case stopped
        case route
        case obstacle
    }

    private enum Command {
        case idle
        case route
        case obstacle(Float)
    }

    private let supportsHaptics: Bool
    private var engine: CHHapticEngine?
    private var continuousPlayer: CHHapticAdvancedPatternPlayer?
    private var continuousPlaying = false
    private var engineStarted = false
    private var mode: Mode = .stopped
    private var pending: Command = .idle
    private var closeness: Float = 0
    private var pulseTimer: Timer?
    private var pulseInterval: TimeInterval = 0.36
    private var applyQueued = false
    private var reportedError = false

    private init() {
        supportsHaptics = CHHapticEngine.capabilitiesForHardware().supportsHaptics
    }

    func setRouteCue() {
        guard supportsHaptics else { return }
        pending = .route
        enqueueApply()
    }

    func setObstaclePulse(_ closeness: Float) {
        guard supportsHaptics else { return }
        pending = .obstacle(min(1, max(0, closeness)))
        enqueueApply()
    }

    func stop() {
        pending = .idle
        if Thread.isMainThread {
            applyStop()
        } else {
            DispatchQueue.main.sync { self.applyStop() }
        }
    }

    private func enqueueApply() {
        guard !applyQueued else { return }
        applyQueued = true
        DispatchQueue.main.async { [weak self] in
            guard let haptics = self else { return }
            haptics.applyQueued = false
            switch haptics.pending {
            case .idle:
                break
            case .route:
                haptics.applyRouteCue()
            case .obstacle(let closeness):
                haptics.applyObstaclePulse(closeness)
            }
        }
    }

    private func applyRouteCue() {
        stopPulseTimer()
        closeness = 0
        do {
            try ensureEngine()
            try ensureContinuousPlaying(intensity: 0.2, sharpness: 0.22)
            mode = .route
        } catch {
            recover(from: error)
        }
    }

    private func applyObstaclePulse(_ closeness: Float) {
        self.closeness = closeness
        let interval = TimeInterval(0.36 - Double(closeness) * 0.3)
        do {
            try ensureEngine()
            stopContinuous()
            let firstPulse = mode != .obstacle
            mode = .obstacle
            if firstPulse {
                pulseInterval = interval
                startPulseTimer()
            } else if abs(interval - pulseInterval) > 0.015 {
                pulseInterval = interval
                reschedulePulseTimer()
            }
        } catch {
            recover(from: error)
        }
    }

    private func applyStop() {
        mode = .stopped
        closeness = 0
        stopPulseTimer()
        stopContinuous()
    }

    private func startPulseTimer() {
        stopPulseTimer()
        fireObstaclePulse()
        reschedulePulseTimer()
    }

    private func reschedulePulseTimer() {
        pulseTimer?.invalidate()
        let timer = Timer.scheduledTimer(withTimeInterval: pulseInterval, repeats: true) { [weak self] _ in
            self?.fireObstaclePulse()
        }
        RunLoop.main.add(timer, forMode: .common)
        pulseTimer = timer
    }

    private func stopPulseTimer() {
        pulseTimer?.invalidate()
        pulseTimer = nil
    }

    /// One hit that grows into a rapid, overlapping burst as the obstacle gets closer.
    private func fireObstaclePulse() {
        guard mode == .obstacle else { return }
        let intensity = 0.78 + 0.22 * closeness
        let sharpness = 0.7 + 0.3 * closeness
        let extraHits = Int((closeness * 3).rounded(.down))
        var events: [CHHapticEvent] = []
        for i in 0...extraHits {
            events.append(CHHapticEvent(
                eventType: .hapticTransient,
                parameters: [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: intensity),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness)
                ],
                relativeTime: TimeInterval(i) * 0.035
            ))
        }
        events.append(CHHapticEvent(
            eventType: .hapticContinuous,
            parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: intensity),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness)
            ],
            relativeTime: 0,
            duration: 0.07 + TimeInterval(closeness) * 0.1
        ))

        do {
            try ensureEngine()
            let pattern = try CHHapticPattern(events: events, parameters: [])
            let player = try engine?.makePlayer(with: pattern)
            try player?.start(atTime: CHHapticTimeImmediate)
        } catch {
            recover(from: error)
        }
    }

    private func ensureEngine() throws {
        if engine == nil {
            let created = try CHHapticEngine()
            created.playsHapticsOnly = true
            created.isAutoShutdownEnabled = false
            created.stoppedHandler = { [weak self] _ in
                DispatchQueue.main.async {
                    guard let haptics = self else { return }
                    haptics.engineStarted = false
                    haptics.continuousPlaying = false
                    haptics.continuousPlayer = nil
                }
            }
            created.resetHandler = { [weak self] in
                do {
                    try self?.engine?.start()
                    DispatchQueue.main.async {
                        self?.engineStarted = true
                        self?.continuousPlaying = false
                        self?.continuousPlayer = nil
                    }
                } catch {
                    self?.report(error)
                }
            }
            engine = created
        }

        if !engineStarted {
            try engine?.start()
            engineStarted = true
        }
    }

    private func ensureContinuousPlaying(intensity: Float, sharpness: Float) throws {
        if continuousPlayer == nil {
            continuousPlayer = try makeContinuousPlayer(sharpness: sharpness)
        }
        if !continuousPlaying {
            try continuousPlayer?.start(atTime: CHHapticTimeImmediate)
            continuousPlaying = true
        }
        let intensityParameter = CHHapticDynamicParameter(
            parameterID: .hapticIntensityControl,
            value: intensity,
            relativeTime: 0
        )
        try continuousPlayer?.sendParameters([intensityParameter], atTime: CHHapticTimeImmediate)
    }

    private func makeContinuousPlayer(sharpness: Float) throws -> CHHapticAdvancedPatternPlayer? {
        let event = CHHapticEvent(
            eventType: .hapticContinuous,
            parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: 1),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness)
            ],
            relativeTime: 0,
            duration: 100
        )
        let pattern = try CHHapticPattern(events: [event], parameters: [])
        let created = try engine?.makeAdvancedPlayer(with: pattern)
        created?.completionHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let haptics = self else { return }
                haptics.continuousPlaying = false
                haptics.continuousPlayer = nil
                guard haptics.mode == .route else { return }
                haptics.applyRouteCue()
            }
        }
        return created
    }

    private func stopContinuous() {
        continuousPlaying = false
        try? continuousPlayer?.stop(atTime: CHHapticTimeImmediate)
        continuousPlayer = nil
    }

    private func recover(from error: Error) {
        report(error)
        engineStarted = false
        continuousPlaying = false
        continuousPlayer = nil
        stopPulseTimer()
        engine = nil
        if mode != .stopped {
            mode = .stopped
        }
    }

    private func report(_ error: Error) {
        guard !reportedError else { return }
        reportedError = true
        NSLog("[Gnarly] Haptics unavailable: %@", error.localizedDescription)
    }
}

@_cdecl("GnarlyHapticsSetRouteCue")
public func GnarlyHapticsSetRouteCue() {
    GnarlyHapticPlayer.shared.setRouteCue()
}

@_cdecl("GnarlyHapticsSetObstaclePulse")
public func GnarlyHapticsSetObstaclePulse(_ closeness: Float) {
    GnarlyHapticPlayer.shared.setObstaclePulse(closeness)
}

@_cdecl("GnarlyHapticsStop")
public func GnarlyHapticsStop() {
    GnarlyHapticPlayer.shared.stop()
}
