import SwiftUI

@main
struct GnarlyMapperApp: App {
    @StateObject private var authSession: FirebaseAuthSession

    init() {
        FirebaseBootstrap.configureIfPossible()
        _authSession = StateObject(wrappedValue: FirebaseAuthSession())
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(authSession)
        }
    }
}
