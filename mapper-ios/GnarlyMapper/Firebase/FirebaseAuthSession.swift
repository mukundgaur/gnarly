import Combine
import FirebaseAuth
import FirebaseCore
import Foundation

@MainActor
final class FirebaseAuthSession: ObservableObject {
    @Published private(set) var userUID: String?
    @Published private(set) var email: String?
    @Published private(set) var isWorking = false
    @Published private(set) var errorMessage: String?

    var isAuthenticated: Bool { userUID != nil }
    var isSigningIn: Bool { isWorking }

    init() {
        apply(FirebaseApp.app() == nil ? nil : Auth.auth().currentUser)
    }

    @discardableResult
    func signIn(email: String, password: String) async -> Bool {
        await authenticate(email: email, password: password, create: false)
    }

    @discardableResult
    func createAccount(email: String, password: String) async -> Bool {
        await authenticate(email: email, password: password, create: true)
    }

    func clearError() { errorMessage = nil }

    func signOut() {
        do {
            try Auth.auth().signOut()
            apply(nil)
            errorMessage = nil
        } catch {
            errorMessage = "Could not sign out: \(error.localizedDescription)"
        }
    }

    private func authenticate(email: String, password: String, create: Bool) async -> Bool {
        guard FirebaseApp.app() != nil else {
            errorMessage = FirebaseDataError.notConfigured.localizedDescription
            return false
        }

        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedEmail.isEmpty, !password.isEmpty else {
            errorMessage = "Enter your email and password."
            return false
        }
        if create, password.count < 6 {
            errorMessage = "Use at least 6 characters for the password."
            return false
        }

        isWorking = true
        errorMessage = nil
        defer { isWorking = false }

        do {
            let result = create
                ? try await Auth.auth().createUser(withEmail: trimmedEmail, password: password)
                : try await Auth.auth().signIn(withEmail: trimmedEmail, password: password)
            apply(result.user)
            return true
        } catch {
            apply(nil)
            errorMessage = (create ? "Could not create the account: " : "Could not sign in: ") + error.localizedDescription
            return false
        }
    }

    private func apply(_ user: User?) {
        userUID = user?.uid
        email = user?.email
    }
}
