import Combine
import FirebaseAuth
import FirebaseCore
import Foundation

@MainActor
final class FirebaseAuthSession: ObservableObject {
    @Published private(set) var userUID: String?
    @Published private(set) var isSigningIn = false
    @Published private(set) var errorMessage: String?

    var isAuthenticated: Bool { userUID != nil }

    init() {
        if FirebaseApp.app() != nil {
            userUID = Auth.auth().currentUser?.uid
        }
    }

    @discardableResult
    func signIn(email: String, password: String) async -> Bool {
        guard FirebaseApp.app() != nil else {
            errorMessage = FirebaseDataError.notConfigured.localizedDescription
            return false
        }

        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedEmail.isEmpty, !password.isEmpty else {
            errorMessage = "Enter the administrator email and password."
            return false
        }

        isSigningIn = true
        errorMessage = nil
        defer { isSigningIn = false }

        do {
            let result = try await Auth.auth().signIn(withEmail: trimmedEmail, password: password)
            userUID = result.user.uid
            return true
        } catch {
            userUID = nil
            errorMessage = "Firebase sign-in failed: \(error.localizedDescription)"
            return false
        }
    }

    func signOut() {
        do {
            try Auth.auth().signOut()
            userUID = nil
            errorMessage = nil
        } catch {
            errorMessage = "Firebase sign-out failed: \(error.localizedDescription)"
        }
    }
}
