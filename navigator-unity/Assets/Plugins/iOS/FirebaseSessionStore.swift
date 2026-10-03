import Foundation
import Security
import Darwin

private enum FirebaseSessionKeychain {
    static let service = "com.gnarly.navigator.firebase"
    static let account = "refresh-token"

    static var query: [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account
        ]
    }
}

@_cdecl("GnarlyFirebaseLoadRefreshToken")
public func gnarlyFirebaseLoadRefreshToken() -> UnsafeMutablePointer<CChar>? {
    var query = FirebaseSessionKeychain.query
    query[kSecReturnData] = true
    query[kSecMatchLimit] = kSecMatchLimitOne

    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data,
          let token = String(data: data, encoding: .utf8) else { return nil }
    return strdup(token)
}

@_cdecl("GnarlyFirebaseFreeString")
public func gnarlyFirebaseFreeString(_ value: UnsafeMutablePointer<CChar>?) {
    free(value)
}

@_cdecl("GnarlyFirebaseSaveRefreshToken")
public func gnarlyFirebaseSaveRefreshToken(_ rawToken: UnsafePointer<CChar>?) {
    guard let rawToken else { return }
    let token = String(cString: rawToken)
    guard let data = token.data(using: .utf8) else { return }

    SecItemDelete(FirebaseSessionKeychain.query as CFDictionary)
    var item = FirebaseSessionKeychain.query
    item[kSecValueData] = data
    item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(item as CFDictionary, nil)
}

@_cdecl("GnarlyFirebaseClearRefreshToken")
public func gnarlyFirebaseClearRefreshToken() {
    SecItemDelete(FirebaseSessionKeychain.query as CFDictionary)
}
