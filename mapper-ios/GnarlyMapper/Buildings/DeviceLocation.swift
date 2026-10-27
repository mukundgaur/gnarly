import CoreLocation
import UIKit

/// A GPS fix the mapper can store on a building.
struct DeviceFix: Equatable {
    var latitude: Double
    var longitude: Double

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }
}

/// Asks for When-In-Use location and publishes a single current fix.
final class DeviceLocation: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published private(set) var fix: DeviceFix?
    @Published private(set) var authorization: CLAuthorizationStatus
    @Published private(set) var failed = false

    private let manager = CLLocationManager()

    override init() {
        authorization = .notDetermined
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        authorization = manager.authorizationStatus
    }

    var isDenied: Bool {
        authorization == .denied || authorization == .restricted
    }

    func request() {
        let status = manager.authorizationStatus
        publish { self.authorization = status; self.failed = false }
        switch status {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedAlways, .authorizedWhenInUse:
            manager.requestLocation()
        case .denied, .restricted:
            break
        @unknown default:
            break
        }
    }

    func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        publish {
            self.authorization = status
            if status == .authorizedAlways || status == .authorizedWhenInUse {
                manager.requestLocation()
            }
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        let fix = DeviceFix(latitude: location.coordinate.latitude, longitude: location.coordinate.longitude)
        publish {
            self.failed = false
            self.fix = fix
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        _ = error
        publish {
            if self.fix == nil { self.failed = true }
        }
    }

    private func publish(_ body: @escaping () -> Void) {
        if Thread.isMainThread {
            body()
        } else {
            DispatchQueue.main.async(execute: body)
        }
    }
}
