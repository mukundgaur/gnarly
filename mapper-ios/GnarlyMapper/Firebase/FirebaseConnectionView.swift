import SwiftUI

struct FirebaseConnectionView: View {
    @ObservedObject var authSession: FirebaseAuthSession
    @StateObject private var diagnostics = FirebaseDiagnosticsViewModel()
    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var password = ""

    var body: some View {
        NavigationStack {
            Form {
                if let uid = authSession.userUID {
                    signedInSection(uid: uid)
                    diagnosticsSection
                } else {
                    signInSection
                }
            }
            .navigationTitle("Firebase Connection")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var signInSection: some View {
        Section("Administrator sign in") {
            TextField("Email", text: $email)
                .textInputAutocapitalization(.never)
                .textContentType(.username)
                .keyboardType(.emailAddress)
                .autocorrectionDisabled()

            SecureField("Password", text: $password)
                .textContentType(.password)

            Button {
                Task {
                    if await authSession.signIn(email: email, password: password) {
                        password = ""
                    }
                }
            } label: {
                if authSession.isSigningIn {
                    ProgressView()
                } else {
                    Text("Sign In")
                }
            }
            .disabled(authSession.isSigningIn || email.isEmpty || password.isEmpty)

            if let error = authSession.errorMessage {
                Label(error, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.red)
            }
        }
    }

    private func signedInSection(uid: String) -> some View {
        Section("Authenticated administrator") {
            LabeledContent("UID") {
                Text(uid)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            }

            Button("Sign Out", role: .destructive) {
                authSession.signOut()
                diagnostics.reset()
            }
        }
    }

    private var diagnosticsSection: some View {
        Section("Temporary diagnostics") {
            ForEach(FirebaseDiagnosticStep.allCases) { step in
                diagnosticRow(step)
            }

            Button {
                Task { await diagnostics.run() }
            } label: {
                if diagnostics.isRunning {
                    HStack {
                        ProgressView()
                        Text("Running Firebase Test…")
                    }
                } else {
                    Text("Run Firebase Test")
                }
            }
            .disabled(diagnostics.isRunning || !authSession.isAuthenticated)

            Text("This writes buildings/firebase-test and transfers buildings/firebase-test/test.txt. Re-running overwrites the same diagnostic records.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func diagnosticRow(_ step: FirebaseDiagnosticStep) -> some View {
        let status = diagnostics.statuses[step] ?? .idle
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(step.rawValue)
                Spacer()
                statusIcon(status)
            }
            if let detail = statusDetail(status) {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(statusIsFailure(status) ? Color.red : Color.secondary)
            }
        }
    }

    @ViewBuilder
    private func statusIcon(_ status: FirebaseDiagnosticStatus) -> some View {
        switch status {
        case .idle:
            Image(systemName: "circle")
                .foregroundStyle(.secondary)
        case .running:
            ProgressView()
        case .success:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .failure:
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(.red)
        }
    }

    private func statusDetail(_ status: FirebaseDiagnosticStatus) -> String? {
        switch status {
        case .idle:
            return nil
        case .running:
            return "In progress"
        case let .success(detail), let .failure(detail):
            return detail
        }
    }

    private func statusIsFailure(_ status: FirebaseDiagnosticStatus) -> Bool {
        if case .failure = status { return true }
        return false
    }
}
