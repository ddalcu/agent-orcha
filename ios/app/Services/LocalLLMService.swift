import Foundation
import Hub
import Metal
import MLXLLM
import MLXLMCommon
import os.log

private let logger = Logger(subsystem: "com.agentorcha.ios", category: "LocalLLM")

enum LocalLLMState: Equatable {
    case notDownloaded
    case downloading(progress: Double, downloadedBytes: Int64, totalBytes: Int64)
    case downloaded
    case loading(progress: Double)
    case ready
    case error(String)
}

struct LocalModelInfo {
    let configuration: ModelConfiguration
    let displayName: String
    let sizeDescription: String

    static let small = LocalModelInfo(
        configuration: ModelConfiguration(id: "mlx-community/Qwen3-1.7B-4bit"),
        displayName: "Qwen 3 1.7B (4-bit)",
        sizeDescription: "~1 GB download"
    )

    static let standard = LocalModelInfo(
        configuration: ModelConfiguration(id: "mlx-community/Qwen3-4B-Instruct-2507-4bit"),
        displayName: "Qwen 3 4B Instruct (4-bit)",
        sizeDescription: "~2.2 GB download"
    )

    /// 8GB+ RAM gets the 4B model, under 8GB gets the 1.7B model
    static var forDevice: LocalModelInfo {
        let ramGB = ProcessInfo.processInfo.physicalMemory / (1024 * 1024 * 1024)
        return ramGB >= 8 ? .standard : .small
    }

    /// A14+ (apple7 GPU family) required for MLX Metal shaders
    static var deviceSupportsMLX: Bool {
        #if targetEnvironment(simulator)
        return false
        #else
        guard let device = MTLCreateSystemDefaultDevice() else { return false }
        return device.supportsFamily(.apple7)
        #endif
    }
}

@Observable
@MainActor
final class LocalLLMService {
    private(set) var state: LocalLLMState = .notDownloaded
    private var modelContainer: ModelContainer?
    private var chatSession: ChatSession?

    let activeModel: LocalModelInfo
    private var isQwen: Bool { activeModel.configuration.name.contains("Qwen") }

    /// True if the device can run MLX inference (real device with A14+)
    let canRunInference: Bool

    init() {
        self.activeModel = LocalModelInfo.forDevice

        #if targetEnvironment(simulator)
        self.canRunInference = false
        checkCachedModel()
        #else
        if !LocalModelInfo.deviceSupportsMLX {
            self.canRunInference = false
            state = .error("This device is not supported. MLX requires iPhone 12 or later (A14 chip or newer).")
        } else {
            self.canRunInference = true
            checkCachedModel()
        }
        #endif
    }

    // MARK: - Model Lifecycle

    /// Tracks download speed by sampling byte progress over time
    private var lastSpeedSample: (time: Date, bytes: Int64) = (.now, 0)
    private(set) var downloadSpeed: Double = 0 // bytes per second

    func downloadModel() async {
        guard state == .notDownloaded || isError else { return }
        state = .downloading(progress: 0, downloadedBytes: 0, totalBytes: 0)
        lastSpeedSample = (.now, 0)
        downloadSpeed = 0

        do {
            let hub = HubApi()
            let repo = Hub.Repo(id: activeModel.configuration.name)

            _ = try await hub.snapshot(from: repo, matching: ["*.safetensors", "*.json"]) { progress in
                Task { @MainActor in
                    let completed = progress.completedUnitCount
                    let total = progress.totalUnitCount
                    let fraction = progress.fractionCompleted

                    // Calculate speed from byte-level progress if available,
                    // otherwise estimate from fraction × known model size
                    let now = Date()
                    let elapsed = now.timeIntervalSince(self.lastSpeedSample.time)
                    if elapsed >= 0.5 {
                        let bytesDelta = completed - self.lastSpeedSample.bytes
                        if bytesDelta > 0 {
                            self.downloadSpeed = Double(bytesDelta) / elapsed
                        }
                        self.lastSpeedSample = (now, completed)
                    }

                    self.state = .downloading(
                        progress: fraction,
                        downloadedBytes: completed,
                        totalBytes: total
                    )
                }
            }

            state = .downloaded
            await loadModel()
        } catch {
            state = .error("Download failed: \(error.localizedDescription)")
        }
    }

    func loadModel() async {
        guard state == .downloaded else { return }

        guard canRunInference else {
            state = .error("Model downloaded. Inference requires a physical device with Metal GPU (iPhone 12+).")
            return
        }

        state = .loading(progress: 0)

        do {
            let container = try await LLMModelFactory.shared.loadContainer(
                configuration: activeModel.configuration
            ) { progress in
                Task { @MainActor in
                    self.state = .loading(progress: progress.fractionCompleted)
                }
            }
            self.modelContainer = container
            self.chatSession = ChatSession(
                container,
                instructions: isQwen ? "/no_think" : nil,
                generateParameters: makeGenerateParameters()
            )
            state = .ready
        } catch {
            state = .error("Failed to load model: \(error.localizedDescription)")
        }
    }

    func generate(messages: [[String: String]]) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let session = self.chatSession
            Task {
                guard let session else {
                    logger.error("Generate called but model not loaded")
                    continuation.finish(throwing: LocalLLMError.modelNotLoaded)
                    return
                }

                do {
                    let lastUserMessage = messages.last(where: { $0["role"] == "user" })?["content"] ?? ""
                    logger.info("─── LLM INPUT ───")
                    logger.info("\(lastUserMessage)")
                    logger.info("─────────────────")

                    var fullOutput = ""
                    for try await chunk in session.streamResponse(to: lastUserMessage) {
                        fullOutput += chunk
                        continuation.yield(chunk)
                    }

                    logger.info("─── LLM OUTPUT (\(fullOutput.count) chars) ───")
                    // Log in chunks since os_log truncates long strings
                    let maxChunk = 800
                    var offset = fullOutput.startIndex
                    while offset < fullOutput.endIndex {
                        let end = fullOutput.index(offset, offsetBy: maxChunk, limitedBy: fullOutput.endIndex) ?? fullOutput.endIndex
                        logger.info("\(fullOutput[offset..<end])")
                        offset = end
                    }
                    logger.info("─── END OUTPUT ───")

                    continuation.finish()
                } catch {
                    logger.error("LLM generate error: \(error.localizedDescription)")
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    func resetSession() {
        guard let container = modelContainer else { return }
        chatSession = ChatSession(
            container,
            instructions: isQwen ? "/no_think" : nil,
            generateParameters: makeGenerateParameters()
        )
    }

    // MARK: - Private

    private func makeGenerateParameters() -> GenerateParameters {
        GenerateParameters(
            maxTokens: 1024,
            maxKVSize: 2048,
            kvBits: 4,
            kvGroupSize: 64
        )
    }

    private func checkCachedModel() {
        let hub = HubApi()
        let repo = Hub.Repo(id: activeModel.configuration.name)
        let url = hub.localRepoLocation(repo)
        let configPath = url.appendingPathComponent("config.json")

        if FileManager.default.fileExists(atPath: configPath.path) {
            state = .downloaded
            Task { await loadModel() }
        } else {
            state = .notDownloaded
        }
    }

    private var isError: Bool {
        if case .error = state { return true }
        return false
    }
}

enum LocalLLMError: LocalizedError {
    case modelNotLoaded

    var errorDescription: String? {
        switch self {
        case .modelNotLoaded: return "Model is not loaded. Please download and load the model first."
        }
    }
}
