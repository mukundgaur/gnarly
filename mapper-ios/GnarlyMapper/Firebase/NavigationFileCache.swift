import Foundation

actor NavigationFileCache {
    private let fileManager: FileManager
    private let rootURL: URL

    init(fileManager: FileManager = .default, rootURL: URL? = nil) throws {
        self.fileManager = fileManager
        if let rootURL {
            self.rootURL = rootURL
        } else {
            let applicationSupport = try fileManager.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
            self.rootURL = applicationSupport.appendingPathComponent("GnarlyNavigationCache", isDirectory: true)
        }
        try fileManager.createDirectory(at: self.rootURL, withIntermediateDirectories: true)
    }

    func cachedFile(for storagePath: String) throws -> URL? {
        let url = try fileURL(for: storagePath)
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        let values = try url.resourceValues(forKeys: [.fileSizeKey])
        guard (values.fileSize ?? 0) > 0 else { return nil }
        return url
    }

    func temporaryDownloadURL(for storagePath: String) throws -> URL {
        let destination = try fileURL(for: storagePath)
        try fileManager.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        return destination.deletingLastPathComponent()
            .appendingPathComponent(".\(destination.lastPathComponent).\(UUID().uuidString).download")
    }

    func installDownloadedFile(_ temporaryURL: URL, for storagePath: String) throws -> URL {
        let destination = try fileURL(for: storagePath)
        try fileManager.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        if fileManager.fileExists(atPath: destination.path) {
            try fileManager.removeItem(at: destination)
        }
        try fileManager.moveItem(at: temporaryURL, to: destination)
        return destination
    }

    func cacheLocalFile(_ sourceURL: URL, for storagePath: String) throws -> URL {
        let temporaryURL = try temporaryDownloadURL(for: storagePath)
        if fileManager.fileExists(atPath: temporaryURL.path) {
            try fileManager.removeItem(at: temporaryURL)
        }
        try fileManager.copyItem(at: sourceURL, to: temporaryURL)
        return try installDownloadedFile(temporaryURL, for: storagePath)
    }

    func removeTemporaryFile(_ url: URL) {
        try? fileManager.removeItem(at: url)
    }

    private func fileURL(for storagePath: String) throws -> URL {
        let components = storagePath.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.isEmpty,
              components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw FirebaseDataError.invalidStoragePath(storagePath)
        }
        return components.reduce(rootURL) { partial, component in
            partial.appendingPathComponent(String(component), isDirectory: false)
        }
    }
}
