import Foundation
import FirebaseAuth

enum GnarlyApiConfig {
    static func url(from raw: String?) throws -> URL {
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard let url = URL(string: trimmed), let host = url.host?.lowercased(), let scheme = url.scheme?.lowercased() else {
            throw PackagePublishError("Set GnarlyApiBaseURL in Info.plist to the publish API origin.")
        }
        let local = host == "localhost" || host == "127.0.0.1"
        guard scheme == "https" || (scheme == "http" && local) else {
            throw PackagePublishError("The publish API must use https, or http on localhost.")
        }
        return url
    }

    static func liveBaseURL(bundle: Bundle = .main) throws -> URL {
        try url(from: bundle.object(forInfoDictionaryKey: "GnarlyApiBaseURL") as? String)
    }
}

struct PackagePublishError: LocalizedError {
    var message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

struct PackageUpload: Encodable {
    var name: String
    var zoneId: String
    var contentType: String
    var fileURL: URL

    func descriptor() throws -> [String: Any] {
        let size = try FileManager.default.attributesOfItem(atPath: fileURL.path)[.size] as? NSNumber
        guard let size, size.intValue > 0 else { throw PackagePublishError("\(name) is missing.") }
        return ["name": name, "size": size.intValue, "contentType": contentType]
    }
}

struct PublishSession: Decodable {
    var publishId: String
    var versionId: String
    var uploads: [SignedUpload]
}

struct SignedUpload: Decodable {
    var name: String
    var zoneId: String
    var path: String
    var url: URL
    var headers: [String: String]
}

struct PublishCommit: Decodable {
    var versionId: String
    var activeVersion: String?
}

/// Talks to the publish API. Bytes go to short-lived signed URLs; activeVersion moves only after commit.
struct PackagePublishClient {
    var baseURL: URL
    var token: () async throws -> String
    var session: URLSession = .shared

    static func live() throws -> PackagePublishClient {
        let baseURL = try GnarlyApiConfig.liveBaseURL()
        return PackagePublishClient(baseURL: baseURL, token: {
            guard let user = Auth.auth().currentUser else { throw PackagePublishError("Sign in before publishing.") }
            return try await user.getIDToken()
        })
    }

    func startZonePublish(buildingId: String, versionId: String, zone: [String: Any], files: [PackageUpload]) async throws -> PublishSession {
        let descriptors = try files.filter { $0.zoneId.isEmpty }.map { try $0.descriptor() }
        let zoneFiles = try files.filter { !$0.zoneId.isEmpty }.map { try $0.descriptor() }
        var zoneBody = zone
        zoneBody["files"] = zoneFiles
        return try await post(
            "/v1/buildings/\(buildingId)/publishes",
            body: ["versionId": versionId, "zones": [zoneBody], "files": descriptors]
        )
    }

    func startFilePublish(buildingId: String, versionId: String, files: [PackageUpload]) async throws -> PublishSession {
        let descriptors = try files.map { try $0.descriptor() }
        return try await post(
            "/v1/buildings/\(buildingId)/publishes",
            body: ["versionId": versionId, "files": descriptors]
        )
    }

    func upload(_ uploads: [SignedUpload], files: [PackageUpload]) async throws {
        for upload in uploads {
            guard let file = files.first(where: { $0.name == upload.name && ($0.zoneId.isEmpty ? upload.zoneId.isEmpty : $0.zoneId == upload.zoneId) }) else {
                throw PackagePublishError("The API requested \(upload.name), which is not in this package.")
            }
            var request = URLRequest(url: upload.url)
            request.httpMethod = "PUT"
            request.timeoutInterval = 170
            for (field, value) in upload.headers { request.setValue(value, forHTTPHeaderField: field) }
            let (_, response) = try await session.upload(for: request, fromFile: file.fileURL)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                throw PackagePublishError("Upload of \(upload.name) failed (HTTP \(status)). The active map was not changed.")
            }
        }
    }

    func commit(buildingId: String, publishId: String) async throws -> PublishCommit {
        try await send("POST", path: "/v1/buildings/\(buildingId)/publishes/\(publishId)/commit", body: [:])
    }

    /// Previous display layout, if the active package has one. A missing layout is not an error.
    func downloadActiveLayout(buildingId: String) async throws -> Data? {
        let package: ActivePackage
        do { package = try await send("GET", path: "/v1/buildings/\(buildingId)/package", body: nil) }
        catch let error as PackagePublishError {
            if error.message.contains("no active") || error.message.contains("not published") || error.message.contains("missing") { return nil }
            throw error
        }
        guard let file = package.files.first(where: { $0.name == "building-layout.json" }) else { return nil }
        let (data, response) = try await session.data(from: file.url)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
        return data
    }

    private func post<Response: Decodable>(_ path: String, body: [String: Any]) async throws -> Response {
        try await send("POST", path: path, body: body)
    }

    private func send<Response: Decodable>(_ method: String, path: String, body: [String: Any]?) async throws -> Response {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw PackagePublishError("The publish API URL is invalid.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 170
        request.setValue("Bearer \(try await token())", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if !(200..<300).contains(status) {
            let message = (try? JSONDecoder().decode(ApiEnvelope.self, from: data))?.error.message
            throw PackagePublishError(message ?? "Publish API failed (HTTP \(status)).")
        }
        do { return try JSONDecoder().decode(Response.self, from: data) }
        catch { throw PackagePublishError("The publish API returned an unexpected response.") }
    }
}

struct LayoutWire: Encodable {
    var schemaVersion: Int
    var zones: [BuildingLayoutDocument.ZoneEntry]
    var floors: [BuildingLayoutDocument.FloorName]?
    var notes: String?

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(zones, forKey: .zones)
        try container.encodeIfPresent(floors, forKey: .floors)
        try container.encodeIfPresent(notes, forKey: .notes)
    }

    private enum CodingKeys: String, CodingKey { case schemaVersion, zones, floors, notes }
}

private struct ApiEnvelope: Decodable {
    struct Body: Decodable { var message: String }
    var error: Body
}

private struct RemotePackageFile: Decodable {
    var name: String
    var url: URL
}

private struct ActivePackage: Decodable {
    var files: [RemotePackageFile]
}
