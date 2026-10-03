import FirebaseCore
import Foundation
import OSLog

enum FirebaseBootstrap {
    private static let logger = Logger(subsystem: "com.gnarly.mapper", category: "Firebase")

    static func configureIfPossible(bundle: Bundle = .main) {
        guard FirebaseApp.app() == nil else { return }
        guard let path = bundle.path(forResource: "GoogleService-Info", ofType: "plist"),
              let options = FirebaseOptions(contentsOfFile: path) else {
            logger.warning("Firebase is disabled because GoogleService-Info.plist is not in the app bundle.")
            return
        }
        FirebaseApp.configure(options: options)
    }
}
