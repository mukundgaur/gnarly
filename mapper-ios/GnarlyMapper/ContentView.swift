import SwiftUI

/// Kept as the historical entry name; the app now routes through `AppRootView`.
struct ContentView: View {
    var body: some View {
        AppRootView()
    }
}

#Preview {
    ContentView()
        .environmentObject(FirebaseAuthSession())
}
