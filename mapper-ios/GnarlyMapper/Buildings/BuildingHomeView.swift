import SwiftUI

struct BuildingHomeView: View {
    @EnvironmentObject private var auth: FirebaseAuthSession
    @ObservedObject var library: BuildingLibrary
    @State private var creating = false

    var body: some View {
        List {
            if library.isLoading && library.buildings.isEmpty {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
                .listRowBackground(Color.clear)
            } else if library.buildings.isEmpty {
                empty
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            } else {
                ForEach(library.buildings) { building in
                    NavigationLink(value: building) {
                        row(building)
                    }
                    .listRowBackground(MapperTheme.raised)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(MapperTheme.background.ignoresSafeArea())
        .navigationTitle("Buildings")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Sign out") { auth.signOut() }
                    .foregroundStyle(MapperTheme.muted)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    creating = true
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("New building")
            }
        }
        .refreshable { await library.refresh() }
        .task { await library.refresh() }
        .sheet(isPresented: $creating) {
            CreateBuildingView(library: library)
        }
        .overlay(alignment: .bottom) {
            if let error = library.errorMessage {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.white)
                    .padding(12)
                    .background(.red.opacity(0.85), in: RoundedRectangle(cornerRadius: 12))
                    .padding()
            }
        }
    }

    private func row(_ building: OwnedBuilding) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(building.name)
                .font(.headline)
                .foregroundStyle(.white)
            HStack(spacing: 8) {
                Text(building.status.rawValue.capitalized)
                if building.hasLocation { Text("On the map") }
                else { Text("No map location yet") }
            }
            .font(.caption)
            .foregroundStyle(MapperTheme.muted)
        }
        .padding(.vertical, 6)
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("No buildings yet")
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white)
            Text("Already-scanned buildings show up here for every signed-in mapper. You can align their floors to the real map, or create a new one.")
                .foregroundStyle(MapperTheme.muted)
            MapperPrimaryButton(title: "Create a building", systemImage: "plus.square") {
                creating = true
            }
        }
        .padding(.vertical, 24)
    }
}
