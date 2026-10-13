import SwiftUI

struct AuthView: View {
    @EnvironmentObject private var auth: FirebaseAuthSession
    @State private var creating = false
    @State private var email = ""
    @State private var password = ""
    @FocusState private var focused: Field?

    private enum Field: Hashable {
        case email, password, submit
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: focused == nil ? 18 : 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(creating ? "Create your account" : "Welcome back")
                            .font(.largeTitle.weight(.semibold))
                            .foregroundStyle(.white)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityAddTraits(.isHeader)
                        Text(creating
                             ? "This account owns the buildings you map. Sign-in stays on this phone."
                             : "Sign in to see only the buildings you own, then scan a zone.")
                            .font(.subheadline)
                            .foregroundStyle(MapperTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    field("Email", text: $email, secure: false, field: .email)
                    field("Password", text: $password, secure: true, field: .password)

                    if let error = auth.errorMessage {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityLabel("Error. \(error)")
                    }

                    MapperPrimaryButton(
                        title: creating ? "Create account" : "Sign in",
                        systemImage: creating ? "person.badge.plus" : "arrow.right",
                        busy: auth.isWorking,
                        enabled: canSubmit
                    ) {
                        submit()
                    }
                    .id(Field.submit)

                    Button(creating ? "I already have an account" : "Create an account") {
                        withAnimation { creating.toggle() }
                        auth.clearError()
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(MapperTheme.accent)
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
                .padding(.horizontal, 22)
                .padding(.top, 12)
                .padding(.bottom, 28)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: focused) { _, field in
                guard let field else { return }
                withAnimation {
                    proxy.scrollTo(field == .password ? Field.submit : field, anchor: .bottom)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MapperTheme.background.ignoresSafeArea())
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button(creating ? "Create account" : "Sign in") { submit() }
                    .disabled(!canSubmit)
                Button("Done") { focused = nil }
            }
        }
    }

    private var canSubmit: Bool {
        !email.isEmpty && !password.isEmpty && !auth.isWorking
    }

    private func submit() {
        guard canSubmit else { return }
        focused = nil
        Task {
            if creating {
                _ = await auth.createAccount(email: email, password: password)
            } else {
                _ = await auth.signIn(email: email, password: password)
            }
        }
    }

    private func field(_ title: String, text: Binding<String>, secure: Bool, field: Field) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(.caption.weight(.semibold))
                .foregroundStyle(MapperTheme.muted)
                .accessibilityHidden(true)
            Group {
                if secure {
                    SecureField(title, text: text)
                        .textContentType(creating ? .newPassword : .password)
                        .submitLabel(.go)
                        .onSubmit { submit() }
                } else {
                    TextField(title, text: text)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.next)
                        .onSubmit { focused = .password }
                }
            }
            .focused($focused, equals: field)
            .id(field)
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(MapperTheme.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .foregroundStyle(.white)
            .accessibilityLabel(title)
        }
    }
}
