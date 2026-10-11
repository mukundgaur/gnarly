import SwiftUI

struct AuthView: View {
    @EnvironmentObject private var auth: FirebaseAuthSession
    @State private var creating = false
    @State private var email = ""
    @State private var password = ""

    var body: some View {
        MapperScreen(
            title: creating ? "Create your account" : "Welcome back",
            subtitle: creating
                ? "This account owns the buildings you map. Sign-in stays on this phone."
                : "Sign in to see only the buildings you own, then scan a zone."
        ) {
            VStack(spacing: 14) {
                field("Email", text: $email, secure: false)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                field("Password", text: $password, secure: true)
                    .textContentType(creating ? .newPassword : .password)

                if let error = auth.errorMessage {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                MapperPrimaryButton(
                    title: creating ? "Create account" : "Sign in",
                    systemImage: creating ? "person.badge.plus" : "arrow.right",
                    busy: auth.isWorking,
                    enabled: !email.isEmpty && !password.isEmpty
                ) {
                    Task {
                        if creating {
                            _ = await auth.createAccount(email: email, password: password)
                        } else {
                            _ = await auth.signIn(email: email, password: password)
                        }
                    }
                }

                Button(creating ? "I already have an account" : "Create an account") {
                    withAnimation { creating.toggle() }
                    auth.clearError()
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(MapperTheme.accent)
                .frame(maxWidth: .infinity)
            }
        }
    }

    private func field(_ title: String, text: Binding<String>, secure: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(.caption.weight(.semibold))
                .foregroundStyle(MapperTheme.muted)
            Group {
                if secure {
                    SecureField("", text: text)
                } else {
                    TextField("", text: text)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            }
            .padding(.horizontal, 14)
            .frame(height: 48)
            .background(MapperTheme.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .foregroundStyle(.white)
        }
    }
}
