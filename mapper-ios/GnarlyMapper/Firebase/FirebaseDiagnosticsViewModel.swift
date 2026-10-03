import Combine
import Foundation

enum FirebaseDiagnosticStep: String, CaseIterable, Hashable, Identifiable {
    case firestoreWrite = "Firestore write"
    case firestoreRead = "Firestore read"
    case storageUpload = "Storage upload"
    case storageDownload = "Storage download"

    var id: String { rawValue }
}

enum FirebaseDiagnosticStatus {
    case idle
    case running
    case success(String)
    case failure(String)
}

@MainActor
final class FirebaseDiagnosticsViewModel: ObservableObject {
    @Published private(set) var statuses: [FirebaseDiagnosticStep: FirebaseDiagnosticStatus] =
        Dictionary(uniqueKeysWithValues: FirebaseDiagnosticStep.allCases.map { ($0, .idle) })
    @Published private(set) var isRunning = false

    func run() async {
        guard !isRunning else { return }
        isRunning = true
        defer { isRunning = false }

        statuses = Dictionary(uniqueKeysWithValues: FirebaseDiagnosticStep.allCases.map { ($0, .idle) })
        let token = UUID().uuidString

        let repository: FirebaseDataRepository
        do {
            repository = try FirebaseDataRepository()
        } catch {
            for step in FirebaseDiagnosticStep.allCases {
                statuses[step] = .failure(error.localizedDescription)
            }
            return
        }

        await perform(.firestoreWrite, success: "buildings/firebase-test") {
            try await repository.writeDiagnosticRecord(token: token)
        }
        await perform(.firestoreRead, success: "Current test token verified") {
            try await repository.readDiagnosticRecord(expectedToken: token)
        }
        await perform(.storageUpload, success: FirebaseStoragePaths.diagnosticText) {
            try await repository.uploadDiagnosticText(token: token)
        }
        await perform(.storageDownload, success: "Downloaded text verified") {
            _ = try await repository.downloadDiagnosticText(expectedToken: token)
        }
    }

    func reset() {
        statuses = Dictionary(uniqueKeysWithValues: FirebaseDiagnosticStep.allCases.map { ($0, .idle) })
    }

    private func perform(
        _ step: FirebaseDiagnosticStep,
        success: String,
        operation: () async throws -> Void
    ) async {
        statuses[step] = .running
        do {
            try await operation()
            statuses[step] = .success(success)
        } catch {
            statuses[step] = .failure(error.localizedDescription)
        }
    }
}
