import CoreHaptics
import Foundation

/// Continuous Taptic Engine rumble. Intensity is a 0...1 multiplier on a long haptic event,
/// so a closer, denser LiDAR obstacle can vibrate harder than a distant or sparse one.
final class GnarlyHapticPlayer {
    static let shared = GnarlyHapticPlayer()

    private let supportsHaptics: Bool
    private var engine: CHHapticEngine?
    private var player: CHHapticAdvancedPatternPlayer?
    private var playing = false
    private var engineStarted = false
    private var pendingIntensity: Float = 0
    private var applyQueued = false
    private var reportedError = false

    private init() {
        supportsHaptics = CHHapticEngine.capabilitiesForHardware().supportsHaptics
    }

    func setIntensity(_ intensity: Float) {
        guard supportsHaptics else { return }
        pendingIntensity = min(1, max(0, intensity))
        guard !applyQueued else { return }
        applyQueued = true
        DispatchQueue.main.async { [weak self] in
            guard let haptics = self else { return }
            haptics.applyQueued = false
            haptics.apply(haptics.pendingIntensity)
        }
    }

    func stop() {
        pendingIntensity = 0
        if Thread.isMainThread {
            apply(0)
        } else {
            DispatchQueue.main.sync { self.apply(0) }
        }
    }

    private func apply(_ intensity: Float) {
        if intensity < 0.02 {
            playing = false
            try? player?.stop(atTime: CHHapticTimeImmediate)
            return
        }

        do {
            try ensurePlaying()
            let intensityParameter = CHHapticDynamicParameter(
                parameterID: .hapticIntensityControl,
                value: intensity,
                relativeTime: 0
            )
            try player?.sendParameters([intensityParameter], atTime: CHHapticTimeImmediate)
        } catch {
            report(error)
            engineStarted = false
            playing = false
            player = nil
            // A stopped Core Haptics engine is not always restartable (for example after an audio
            // session interruption), so recreate it on the next keep-alive from Unity.
            engine = nil
        }
    }

    /// Starts the continuous event at zero strength. The caller then sends the real intensity,
    /// so the motor does not pop at full strength for a frame.
    private func ensurePlaying() throws {
        if engine == nil {
            let created = try CHHapticEngine()
            created.playsHapticsOnly = true
            created.isAutoShutdownEnabled = true
            created.stoppedHandler = { [weak self] _ in
                DispatchQueue.main.async {
                    guard let haptics = self else { return }
                    haptics.engineStarted = false
                    haptics.playing = false
                    haptics.player = nil
                }
            }
            created.resetHandler = { [weak self] in
                do {
                    try self?.engine?.start()
                    DispatchQueue.main.async {
                        self?.engineStarted = true
                        self?.playing = false
                        self?.player = nil
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

        if player == nil {
            player = try makePlayer()
        }

        if !playing {
            try player?.start(atTime: CHHapticTimeImmediate)
            let silent = CHHapticDynamicParameter(
                parameterID: .hapticIntensityControl,
                value: 0,
                relativeTime: 0
            )
            try player?.sendParameters([silent], atTime: CHHapticTimeImmediate)
            playing = true
        }
    }

    private func makePlayer() throws -> CHHapticAdvancedPatternPlayer? {
        let event = CHHapticEvent(
            eventType: .hapticContinuous,
            parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: 1),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.35)
            ],
            relativeTime: 0,
            duration: 30
        )
        let pattern = try CHHapticPattern(events: [event], parameters: [])
        let created = try engine?.makeAdvancedPlayer(with: pattern)
        created?.completionHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let haptics = self else { return }
                haptics.playing = false
                guard haptics.pendingIntensity >= 0.02 else { return }
                haptics.apply(haptics.pendingIntensity)
            }
        }
        return created
    }

    private func report(_ error: Error) {
        guard !reportedError else { return }
        reportedError = true
        NSLog("[Gnarly] Haptics unavailable: %@", error.localizedDescription)
    }
}

@_cdecl("GnarlyHapticsSetIntensity")
public func GnarlyHapticsSetIntensity(_ intensity: Float) {
    GnarlyHapticPlayer.shared.setIntensity(intensity)
}

@_cdecl("GnarlyHapticsStop")
public func GnarlyHapticsStop() {
    GnarlyHapticPlayer.shared.stop()
}
