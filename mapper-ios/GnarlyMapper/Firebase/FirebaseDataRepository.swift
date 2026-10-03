import FirebaseCore
import FirebaseAuth
import FirebaseFirestore
import FirebaseStorage
import Foundation

protocol FirebaseDataRepositoryProtocol {
    func createBuilding(_ building: Building) async throws
    func updateBuilding(_ building: Building) async throws
    func saveVersion(_ version: BuildingVersion, buildingId: String) async throws
    func saveFloor(_ floor: Floor, buildingId: String, versionId: String) async throws
    func saveZone(_ zone: Zone, buildingId: String, versionId: String) async throws
    func saveDestination(_ destination: Destination, buildingId: String, versionId: String) async throws
    func saveNode(_ node: NavigationNode, buildingId: String, versionId: String) async throws
    func saveEdge(_ edge: NavigationEdge, buildingId: String, versionId: String) async throws

    @discardableResult
    func uploadWorldMap(
        from localURL: URL,
        buildingId: String,
        versionId: String,
        zoneId: String
    ) async throws -> String

    @discardableResult
    func uploadBuildingJSON(
        from localURL: URL,
        buildingId: String,
        versionId: String
    ) async throws -> String

    @discardableResult
    func uploadScanJSON(
        from localURL: URL,
        buildingId: String,
        versionId: String
    ) async throws -> String

    @discardableResult
    func uploadScanFeatures(
        from localURL: URL,
        buildingId: String,
        versionId: String
    ) async throws -> String

    @discardableResult
    func uploadStructure(
        from localURL: URL,
        buildingId: String,
        versionId: String
    ) async throws -> String

    func fetchActiveVersion(buildingId: String) async throws -> ActiveBuildingVersion
    func downloadBuildingJSON(buildingId: String, versionId: String) async throws -> URL
    func downloadWorldMap(buildingId: String, versionId: String, zoneId: String) async throws -> URL
    func downloadActivePackage(buildingId: String, zoneId: String) async throws -> DownloadedNavigationPackage

    func writeDiagnosticRecord(token: String) async throws
    func readDiagnosticRecord(expectedToken: String) async throws
    func uploadDiagnosticText(token: String) async throws
    func downloadDiagnosticText(expectedToken: String) async throws -> URL
}

final class FirebaseDataRepository: FirebaseDataRepositoryProtocol {
    private let firestore: Firestore
    private let storage: Storage
    private let cache: NavigationFileCache

    convenience init(cache: NavigationFileCache? = nil) throws {
        guard FirebaseApp.app() != nil else { throw FirebaseDataError.notConfigured }
        let resolvedCache: NavigationFileCache
        do {
            if let cache {
                resolvedCache = cache
            } else {
                resolvedCache = try NavigationFileCache()
            }
        } catch {
            throw FirebaseDataError.cache(operation: "initialization", underlying: error)
        }
        self.init(firestore: .firestore(), storage: .storage(), cache: resolvedCache)
    }

    init(firestore: Firestore, storage: Storage, cache: NavigationFileCache) {
        self.firestore = firestore
        self.storage = storage
        self.cache = cache
    }

    func createBuilding(_ building: Building) async throws {
        let id = try requiredID(building.id, field: "buildingId")
        let reference = buildingReference(id)
        if try await documentExists(reference, operation: "check building existence") {
            throw FirebaseDataError.documentAlreadyExists(path: reference.path)
        }
        var data = try encode(building)
        data["createdAt"] = FieldValue.serverTimestamp()
        data["updatedAt"] = FieldValue.serverTimestamp()
        try await write(data, to: reference, merge: false, operation: "create building")
    }

    func updateBuilding(_ building: Building) async throws {
        let id = try requiredID(building.id, field: "buildingId")
        var data = try encode(building)
        data.removeValue(forKey: "createdAt")
        data["updatedAt"] = FieldValue.serverTimestamp()
        try await update(data, to: buildingReference(id), operation: "update building")
    }

    func saveVersion(_ version: BuildingVersion, buildingId: String) async throws {
        try FirebaseStoragePaths.validate(buildingId, field: "buildingId")
        let versionId = try requiredID(version.id, field: "versionId")
        let reference = versionReference(buildingId: buildingId, versionId: versionId)
        let exists = try await documentExists(reference, operation: "check building version existence")
        var data = try encode(version)
        if exists {
            if version.createdAt == nil { data.removeValue(forKey: "createdAt") }
        } else {
            if let createdAt = version.createdAt {
                data["createdAt"] = createdAt
            } else {
                data["createdAt"] = FieldValue.serverTimestamp()
            }
        }
        try await write(
            data,
            to: reference,
            merge: true,
            operation: "save building version"
        )
    }

    func saveFloor(_ floor: Floor, buildingId: String, versionId: String) async throws {
        try await saveChild(floor, id: floor.id, collection: "floors", buildingId: buildingId, versionId: versionId)
    }

    func saveZone(_ zone: Zone, buildingId: String, versionId: String) async throws {
        try await saveChild(zone, id: zone.id, collection: "zones", buildingId: buildingId, versionId: versionId)
    }

    func saveDestination(_ destination: Destination, buildingId: String, versionId: String) async throws {
        try await saveChild(destination, id: destination.id, collection: "destinations", buildingId: buildingId, versionId: versionId)
    }

    func saveNode(_ node: NavigationNode, buildingId: String, versionId: String) async throws {
        try await saveChild(node, id: node.id, collection: "nodes", buildingId: buildingId, versionId: versionId)
    }

    func saveEdge(_ edge: NavigationEdge, buildingId: String, versionId: String) async throws {
        try await saveChild(edge, id: edge.id, collection: "edges", buildingId: buildingId, versionId: versionId)
    }

    @discardableResult
    func uploadWorldMap(
        from localURL: URL,
        buildingId: String,
        versionId: String,
        zoneId: String
    ) async throws -> String {
        try validateNonemptyFile(localURL)
        let storagePath = try FirebaseStoragePaths.worldMap(
            buildingId: buildingId,
            versionId: versionId,
            zoneId: zoneId
        )
        try await uploadFile(localURL, storagePath: storagePath, contentType: "application/octet-stream")

        let zoneRef = childReference(
            collection: "zones",
            childId: zoneId,
            buildingId: buildingId,
            versionId: versionId
        )
        try await update(
            ["worldMapPath": storagePath],
            to: zoneRef,
            operation: "store zone worldMapPath"
        )
        try await cacheUploadedFile(localURL, storagePath: storagePath)
        return storagePath
    }

    @discardableResult
    func uploadBuildingJSON(
        from localURL: URL,
        buildingId: String,
        versionId: String
    ) async throws -> String {
        try validateNonemptyFile(localURL)
        let jsonData = try Data(contentsOf: localURL, options: [.mappedIfSafe])
        guard (try? JSONSerialization.jsonObject(with: jsonData)) != nil else {
            throw FirebaseDataError.invalidJSON
        }

        let storagePath = try FirebaseStoragePaths.buildingJSON(buildingId: buildingId, versionId: versionId)
        try await uploadFile(localURL, storagePath: storagePath, contentType: "application/json")
        try await update(
            ["buildingJsonPath": storagePath],
            to: versionReference(buildingId: buildingId, versionId: versionId),
            operation: "store buildingJsonPath"
        )
        try await cacheUploadedFile(localURL, storagePath: storagePath)
        return storagePath
    }

    @discardableResult
    func uploadScanJSON(
        from localURL: URL,
        buildingId: String,
        versionId: String
    ) async throws -> String {
        try validateNonemptyFile(localURL)
        let jsonData = try Data(contentsOf: localURL, options: [.mappedIfSafe])
        guard (try? JSONSerialization.jsonObject(with: jsonData)) != nil else {
            throw FirebaseDataError.invalidJSON
        }

        let storagePath = try FirebaseStoragePaths.scanJSON(buildingId: buildingId, versionId: versionId)
        try await uploadFile(localURL, storagePath: storagePath, contentType: "application/json")
        try await cacheUploadedFile(localURL, storagePath: storagePath)
        return storagePath
    }

    @discardableResult
    func uploadScanFeatures(
        from localURL: URL,
        buildingId: String,
        versionId: String
    ) async throws -> String {
        try validateNonemptyFile(localURL)
        let jsonData = try Data(contentsOf: localURL, options: [.mappedIfSafe])
        guard (try? JSONSerialization.jsonObject(with: jsonData)) != nil else {
            throw FirebaseDataError.invalidJSON
        }

        let storagePath = try FirebaseStoragePaths.scanFeatures(buildingId: buildingId, versionId: versionId)
        try await uploadFile(localURL, storagePath: storagePath, contentType: "application/json")
        try await cacheUploadedFile(localURL, storagePath: storagePath)
        return storagePath
    }

    @discardableResult
    func uploadStructure(
        from localURL: URL,
        buildingId: String,
        versionId: String
    ) async throws -> String {
        try validateNonemptyFile(localURL)
        let storagePath = try FirebaseStoragePaths.structure(buildingId: buildingId, versionId: versionId)
        try await uploadFile(localURL, storagePath: storagePath, contentType: "model/vnd.usdz+zip")
        try await update(
            ["structurePath": storagePath],
            to: versionReference(buildingId: buildingId, versionId: versionId),
            operation: "store structurePath"
        )
        try await cacheUploadedFile(localURL, storagePath: storagePath)
        return storagePath
    }

    func fetchActiveVersion(buildingId: String) async throws -> ActiveBuildingVersion {
        try FirebaseStoragePaths.validate(buildingId, field: "buildingId")
        let building: Building = try await fetch(
            Building.self,
            from: buildingReference(buildingId),
            operation: "fetch building"
        )
        guard let versionId = building.activeVersion, !versionId.isEmpty else {
            throw FirebaseDataError.missingActiveVersion(buildingId: buildingId)
        }
        try FirebaseStoragePaths.validate(versionId, field: "activeVersion")
        let version: BuildingVersion = try await fetch(
            BuildingVersion.self,
            from: versionReference(buildingId: buildingId, versionId: versionId),
            operation: "fetch active building version"
        )
        return ActiveBuildingVersion(building: building, version: version)
    }

    func downloadBuildingJSON(buildingId: String, versionId: String) async throws -> URL {
        let deterministicPath = try FirebaseStoragePaths.buildingJSON(buildingId: buildingId, versionId: versionId)
        if let cached = try await cachedFile(storagePath: deterministicPath) { return cached }

        let version: BuildingVersion = try await fetch(
            BuildingVersion.self,
            from: versionReference(buildingId: buildingId, versionId: versionId),
            operation: "fetch building version"
        )
        guard let path = version.buildingJsonPath, !path.isEmpty else {
            throw FirebaseDataError.missingStoragePath(
                field: "buildingJsonPath",
                documentPath: "buildings/\(buildingId)/versions/\(versionId)"
            )
        }
        guard path == deterministicPath else {
            throw FirebaseDataError.unexpectedStoragePath(expected: deterministicPath, actual: path)
        }
        return try await cachedOrDownload(storagePath: deterministicPath)
    }

    func downloadWorldMap(buildingId: String, versionId: String, zoneId: String) async throws -> URL {
        let deterministicPath = try FirebaseStoragePaths.worldMap(
            buildingId: buildingId,
            versionId: versionId,
            zoneId: zoneId
        )
        if let cached = try await cachedFile(storagePath: deterministicPath) { return cached }

        let zoneRef = childReference(
            collection: "zones",
            childId: zoneId,
            buildingId: buildingId,
            versionId: versionId
        )
        let zone: Zone = try await fetch(Zone.self, from: zoneRef, operation: "fetch zone")
        guard let path = zone.worldMapPath, !path.isEmpty else {
            throw FirebaseDataError.missingStoragePath(field: "worldMapPath", documentPath: zoneRef.path)
        }
        guard path == deterministicPath else {
            throw FirebaseDataError.unexpectedStoragePath(expected: deterministicPath, actual: path)
        }
        return try await cachedOrDownload(storagePath: deterministicPath)
    }

    func downloadActivePackage(buildingId: String, zoneId: String) async throws -> DownloadedNavigationPackage {
        let active = try await fetchActiveVersion(buildingId: buildingId)
        let buildingJSONURL = try await downloadBuildingJSON(
            buildingId: buildingId,
            versionId: active.versionId
        )
        let worldMapURL = try await downloadWorldMap(
            buildingId: buildingId,
            versionId: active.versionId,
            zoneId: zoneId
        )
        return DownloadedNavigationPackage(
            buildingId: buildingId,
            versionId: active.versionId,
            zoneId: zoneId,
            buildingJSONURL: buildingJSONURL,
            worldMapURL: worldMapURL
        )
    }

    func writeDiagnosticRecord(token: String) async throws {
        let reference = buildingReference("firebase-test")
        try await write(
            [
                "name": "Firebase Diagnostic",
                "activeVersion": NSNull(),
                "status": RecordStatus.draft.rawValue,
                "diagnosticToken": token,
                "createdAt": FieldValue.serverTimestamp(),
                "updatedAt": FieldValue.serverTimestamp()
            ],
            to: reference,
            merge: true,
            operation: "write diagnostic document"
        )
    }

    func readDiagnosticRecord(expectedToken: String) async throws {
        try requireAuthenticated()
        let reference = buildingReference("firebase-test")
        do {
            let snapshot = try await reference.getDocument(source: .server)
            guard snapshot.exists else {
                throw FirebaseDataError.missingDocument(path: reference.path)
            }
            guard snapshot.data()?["diagnosticToken"] as? String == expectedToken else {
                throw FirebaseDataError.diagnosticVerification(
                    step: "Firestore read",
                    reason: "the returned token did not match the current test run"
                )
            }
        } catch let error as FirebaseDataError {
            throw error
        } catch {
            throw FirebaseDataError.firestore(operation: "read diagnostic document", underlying: error)
        }
    }

    func uploadDiagnosticText(token: String) async throws {
        let data = Data("Gnarly Firebase diagnostic: \(token)\n".utf8)
        try await uploadData(
            data,
            storagePath: FirebaseStoragePaths.diagnosticText,
            contentType: "text/plain"
        )
    }

    func downloadDiagnosticText(expectedToken: String) async throws -> URL {
        let url = try await downloadFile(
            storagePath: FirebaseStoragePaths.diagnosticText,
            useCache: false
        )
        let contents: String
        do {
            contents = try String(contentsOf: url, encoding: .utf8)
        } catch {
            throw FirebaseDataError.cache(operation: "read diagnostic download", underlying: error)
        }
        guard contents == "Gnarly Firebase diagnostic: \(expectedToken)\n" else {
            throw FirebaseDataError.diagnosticVerification(
                step: "Storage download",
                reason: "the downloaded text did not match the current test run"
            )
        }
        return url
    }

    private func buildingReference(_ buildingId: String) -> DocumentReference {
        firestore.collection("buildings").document(buildingId)
    }

    private func versionReference(buildingId: String, versionId: String) -> DocumentReference {
        buildingReference(buildingId).collection("versions").document(versionId)
    }

    private func childReference(
        collection: String,
        childId: String,
        buildingId: String,
        versionId: String
    ) -> DocumentReference {
        versionReference(buildingId: buildingId, versionId: versionId)
            .collection(collection)
            .document(childId)
    }

    private func saveChild<T: Encodable>(
        _ value: T,
        id: String?,
        collection: String,
        buildingId: String,
        versionId: String
    ) async throws {
        try FirebaseStoragePaths.validate(buildingId, field: "buildingId")
        try FirebaseStoragePaths.validate(versionId, field: "versionId")
        let childId = try requiredID(id, field: "\(collection) document ID")
        try await write(
            try encode(value),
            to: childReference(
                collection: collection,
                childId: childId,
                buildingId: buildingId,
                versionId: versionId
            ),
            merge: true,
            operation: "save \(collection) document"
        )
    }

    private func requiredID(_ id: String?, field: String) throws -> String {
        guard let id else { throw FirebaseDataError.invalidIdentifier(field: field) }
        try FirebaseStoragePaths.validate(id, field: field)
        return id
    }

    private func encode<T: Encodable>(_ value: T) throws -> [String: Any] {
        do {
            return try Firestore.Encoder().encode(value)
        } catch {
            throw FirebaseDataError.firestore(operation: "encode document", underlying: error)
        }
    }

    private func write(
        _ data: [String: Any],
        to reference: DocumentReference,
        merge: Bool,
        operation: String
    ) async throws {
        try requireAuthenticated()
        do {
            try await reference.setData(data, merge: merge)
        } catch {
            throw FirebaseDataError.firestore(operation: operation, underlying: error)
        }
    }

    private func update(
        _ data: [AnyHashable: Any],
        to reference: DocumentReference,
        operation: String
    ) async throws {
        try requireAuthenticated()
        do {
            try await reference.updateData(data)
        } catch {
            throw FirebaseDataError.firestore(operation: operation, underlying: error)
        }
    }

    private func fetch<T: Decodable>(
        _ type: T.Type,
        from reference: DocumentReference,
        operation: String
    ) async throws -> T {
        try requireAuthenticated()
        do {
            let snapshot = try await reference.getDocument(source: .default)
            guard snapshot.exists else { throw FirebaseDataError.missingDocument(path: reference.path) }
            return try snapshot.data(as: type)
        } catch let error as FirebaseDataError {
            throw error
        } catch {
            throw FirebaseDataError.firestore(operation: operation, underlying: error)
        }
    }

    private func documentExists(_ reference: DocumentReference, operation: String) async throws -> Bool {
        try requireAuthenticated()
        do {
            return try await reference.getDocument(source: .default).exists
        } catch {
            throw FirebaseDataError.firestore(operation: operation, underlying: error)
        }
    }

    private func uploadFile(_ localURL: URL, storagePath: String, contentType: String) async throws {
        try requireAuthenticated()
        let metadata = StorageMetadata()
        metadata.contentType = contentType
        do {
            _ = try await storage.reference(withPath: storagePath)
                .putFileAsync(from: localURL, metadata: metadata)
        } catch {
            throw FirebaseDataError.storage(operation: "upload", path: storagePath, underlying: error)
        }
    }

    private func uploadData(_ data: Data, storagePath: String, contentType: String) async throws {
        try requireAuthenticated()
        let metadata = StorageMetadata()
        metadata.contentType = contentType
        do {
            _ = try await storage.reference(withPath: storagePath)
                .putDataAsync(data, metadata: metadata)
        } catch {
            throw FirebaseDataError.storage(operation: "upload", path: storagePath, underlying: error)
        }
    }

    private func cachedOrDownload(storagePath: String) async throws -> URL {
        try await downloadFile(storagePath: storagePath, useCache: true)
    }

    private func downloadFile(storagePath: String, useCache: Bool) async throws -> URL {
        if useCache, let cached = try await cachedFile(storagePath: storagePath) { return cached }
        try requireAuthenticated()

        let temporaryURL: URL
        do {
            temporaryURL = try await cache.temporaryDownloadURL(for: storagePath)
        } catch {
            throw FirebaseDataError.cache(operation: "prepare download", underlying: error)
        }

        do {
            _ = try await storage.reference(withPath: storagePath).writeAsync(toFile: temporaryURL)
            return try await cache.installDownloadedFile(temporaryURL, for: storagePath)
        } catch {
            await cache.removeTemporaryFile(temporaryURL)
            if error is FirebaseDataError { throw error }
            throw FirebaseDataError.storage(operation: "download", path: storagePath, underlying: error)
        }
    }

    private func cachedFile(storagePath: String) async throws -> URL? {
        do {
            return try await cache.cachedFile(for: storagePath)
        } catch {
            throw FirebaseDataError.cache(operation: "lookup", underlying: error)
        }
    }

    private func cacheUploadedFile(_ localURL: URL, storagePath: String) async throws {
        do {
            _ = try await cache.cacheLocalFile(localURL, for: storagePath)
        } catch {
            throw FirebaseDataError.cache(operation: "store uploaded file", underlying: error)
        }
    }

    private func validateNonemptyFile(_ url: URL) throws {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true, (values.fileSize ?? 0) > 0 else {
            throw FirebaseDataError.emptyFile(url)
        }
    }

    private func requireAuthenticated() throws {
        guard Auth.auth().currentUser != nil else {
            throw FirebaseDataError.notAuthenticated
        }
    }
}
