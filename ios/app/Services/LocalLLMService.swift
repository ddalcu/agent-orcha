import Foundation
import Hub
import Metal
import MLXLLM
import MLXLMCommon

enum LocalLLMState: Equatable {
    case notDownloaded
    case downloading(progress: Double)
    case downloaded
    case loading
    case ready
    case error(String)
}

struct LocalModelInfo {
    let configuration: ModelConfiguration
    let displayName: String
    let sizeDescription: String

    static let small = LocalModelInfo(
        configuration: ModelConfiguration(id: "mlx-community/Llama-3.2-1B-Instruct-4bit"),
        displayName: "Llama 3.2 1B (4-bit)",
        sizeDescription: "~700 MB download"
    )

    static let standard = LocalModelInfo(
        configuration: ModelConfiguration(id: "mlx-community/Qwen3-1.7B-4bit"),
        displayName: "Qwen 3 1.7B (4-bit)",
        sizeDescription: "~1 GB download"
    )

    /// 6GB+ RAM gets the 1.7B model, under 6GB gets the 1B model
    static var forDevice: LocalModelInfo {
        let ramGB = ProcessInfo.processInfo.physicalMemory / (1024 * 1024 * 1024)
        return ramGB >= 6 ? .standard : .small
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

    init() {
        self.activeModel = LocalModelInfo.forDevice

        #if targetEnvironment(simulator)
        state = .error("MLX requires a physical device with Metal GPU support. Please run on a real device.")
        #else
        if !LocalModelInfo.deviceSupportsMLX {
            state = .error("This device is not supported. MLX requires iPhone 12 or later (A14 chip or newer).")
        } else {
            checkCachedModel()
        }
        #endif
    }

    // MARK: - Model Lifecycle

    func downloadModel() async {
        guard state == .notDownloaded || isError else { return }
        state = .downloading(progress: 0)

        do {
            let hub = HubApi()
            let repo = Hub.Repo(id: activeModel.configuration.name)

            _ = try await hub.snapshot(from: repo, matching: ["*.safetensors", "*.json"]) { progress in
                Task { @MainActor in
                    self.state = .downloading(progress: progress.fractionCompleted)
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
        state = .loading

        do {
            let container = try await LLMModelFactory.shared.loadContainer(
                configuration: activeModel.configuration
            ) { progress in
                Task { @MainActor in
                    self.state = .loading
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
                    continuation.finish(throwing: LocalLLMError.modelNotLoaded)
                    return
                }

                do {
                    let lastUserMessage = messages.last(where: { $0["role"] == "user" })?["content"] ?? ""

                    for try await chunk in session.streamResponse(to: lastUserMessage) {
                        continuation.yield(chunk)
                    }
                    continuation.finish()
                } catch {
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
