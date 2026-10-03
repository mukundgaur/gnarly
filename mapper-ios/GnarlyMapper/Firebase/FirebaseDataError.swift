import Foundation

enum FirebaseDataError: LocalizedError {
    case notConfigured
    case notAuthenticated
    case invalidIdentifier(field: String)
    case invalidJSON
    case documentAlreadyExists(path: String)
    case missingDocument(path: String)
    case missingActiveVersion(buildingId: String)
    case missingStoragePath(field: String, documentPath: String)
    case unexpectedStoragePath(expected: String, actual: String)
    case invalidStoragePath(String)
    case emptyFile(URL)
    case firestore(operation: String, underlying: Error)
    case storage(operation: String, path: String, underlying: Error)
    case cache(operation: String, underlying: Error)
    case diagnosticVerification(step: String, reason: String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Firebase is not configured. Add GoogleService-Info.plist to the GnarlyMapper target."
        case .notAuthenticated:
            return "Sign in with the Firebase administrator account before using Firestore or Cloud Storage."
        case let .invalidIdentifier(field):
            return "\(field) must be non-empty and cannot contain '/'."
        case .invalidJSON:
            return "building.json is not valid JSON."
        case let .documentAlreadyExists(path):
            return "A Firestore document already exists at \(path)."
        case let .missingDocument(path):
            return "No Firestore document exists at \(path)."
        case let .missingActiveVersion(buildingId):
            return "Building '\(buildingId)' does not have an activeVersion."
        case let .missingStoragePath(field, documentPath):
            return "\(documentPath) is missing its \(field) Storage path."
        case let .unexpectedStoragePath(expected, actual):
            return "Unexpected Storage path '\(actual)'; expected '\(expected)'."
        case let .invalidStoragePath(path):
            return "The Storage path '\(path)' is not safe for the local cache."
        case let .emptyFile(url):
            return "The file at \(url.path) is empty."
        case let .firestore(operation, underlying):
            return "Firestore \(operation) failed: \(underlying.localizedDescription)"
        case let .storage(operation, path, underlying):
            return "Cloud Storage \(operation) failed for \(path): \(underlying.localizedDescription)"
        case let .cache(operation, underlying):
            return "Local cache \(operation) failed: \(underlying.localizedDescription)"
        case let .diagnosticVerification(step, reason):
            return "Firebase diagnostic \(step) verification failed: \(reason)"
        }
    }
}
