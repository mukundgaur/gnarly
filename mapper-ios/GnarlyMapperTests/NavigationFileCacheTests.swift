import Foundation
import XCTest
@testable import GnarlyMapper

final class NavigationFileCacheTests: XCTestCase {
    func testCachesAndReturnsAFile() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let source = root.appendingPathComponent("source.json")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("{\"schemaVersion\":1}".utf8).write(to: source)

        let cache = try NavigationFileCache(rootURL: root.appendingPathComponent("cache"))
        let storagePath = "buildings/demo/v1/building.json"
        let storedURL = try await cache.cacheLocalFile(source, for: storagePath)
        let cachedURL = try await cache.cachedFile(for: storagePath)

        XCTAssertEqual(cachedURL, storedURL)
        XCTAssertEqual(try Data(contentsOf: storedURL), try Data(contentsOf: source))
    }

    func testRejectsTraversalPath() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = try NavigationFileCache(rootURL: root)

        do {
            _ = try await cache.cachedFile(for: "buildings/../secret")
            XCTFail("Expected traversal path to be rejected")
        } catch is FirebaseDataError {
            // Expected.
        }
    }
}
