import Foundation
import UIKit

/// Decodes data URIs (data:mime;base64,...) into usable media objects.
/// Caches decoded files in the temp directory for AVPlayer/UIImage consumption.
final class MediaCacheService {
    static let shared = MediaCacheService()

    private let cacheDir: URL
    private var cachedFiles: [String: URL] = [:]

    private init() {
        cacheDir = FileManager.default.temporaryDirectory.appendingPathComponent("orcha-media", isDirectory: true)
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
    }

    // MARK: - Image Decoding

    /// Decodes a data URI to a UIImage. Returns nil if the URI is invalid.
    func imageFromDataURI(_ uri: String) -> UIImage? {
        guard let data = dataFromURI(uri) else { return nil }
        return UIImage(data: data)
    }

    // MARK: - File Decoding (for audio/video)

    /// Decodes a data URI to a temporary file and returns its URL.
    /// Cached by a hash of the URI prefix to avoid re-writing the same file.
    func fileURLFromDataURI(_ uri: String, fallbackExtension: String = "bin") -> URL? {
        let cacheKey = String(uri.prefix(64)) + "-\(uri.count)"
        if let cached = cachedFiles[cacheKey], FileManager.default.fileExists(atPath: cached.path) {
            return cached
        }

        guard let data = dataFromURI(uri) else { return nil }
        let ext = extensionFromDataURI(uri) ?? fallbackExtension
        let filename = "\(UUID().uuidString).\(ext)"
        let fileURL = cacheDir.appendingPathComponent(filename)

        do {
            try data.write(to: fileURL)
            cachedFiles[cacheKey] = fileURL
            return fileURL
        } catch {
            return nil
        }
    }

    // MARK: - Helpers

    /// Extracts raw Data from a `data:mime;base64,XXXX` URI.
    private func dataFromURI(_ uri: String) -> Data? {
        guard uri.hasPrefix("data:"),
              let commaIndex = uri.firstIndex(of: ",") else { return nil }
        let base64String = String(uri[uri.index(after: commaIndex)...])
        return Data(base64Encoded: base64String, options: .ignoreUnknownCharacters)
    }

    /// Extracts the file extension from the MIME type in a data URI.
    private func extensionFromDataURI(_ uri: String) -> String? {
        // data:image/png;base64,... → "png"
        // data:audio/wav;base64,... → "wav"
        // data:video/mp4;base64,... → "mp4"
        guard uri.hasPrefix("data:"),
              let semicolonIndex = uri.firstIndex(of: ";"),
              let slashIndex = uri.firstIndex(of: "/") else { return nil }
        let ext = String(uri[uri.index(after: slashIndex)..<semicolonIndex])
        // Normalize common MIME types
        switch ext {
        case "jpeg": return "jpg"
        case "mpeg": return "mp3"
        case "x-wav": return "wav"
        default: return ext
        }
    }

    /// Clears all cached media files.
    func clearCache() {
        cachedFiles.removeAll()
        try? FileManager.default.removeItem(at: cacheDir)
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
    }
}
