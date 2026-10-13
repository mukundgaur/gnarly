import SwiftUI

struct AppRootView: View {
    @EnvironmentObject private var auth: FirebaseAuthSession
    @AppStorage("gnarly.mapper.didOnboard") private var didOnboard = false
    @StateObject private var library = BuildingLibrary()

    var body: some View {
        Group {
            if !didOnboard {
                OnboardingView { didOnboard = true }
            } else if !auth.isAuthenticated {
                AuthView()
            } else {
                NavigationStack {
                    BuildingHomeView(library: library)
                        .navigationDestination(for: OwnedBuilding.self) { building in
                            BuildingDetailView(building: building, library: library)
                        }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MapperTheme.background.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .tint(MapperTheme.accent)
    }
}
