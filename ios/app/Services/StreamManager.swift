import Foundation

/// Correlates P2P requestIds to AsyncThrowingStream continuations.
/// Used by BareP2PService to route stream chunks to the correct consumer.
@Observable
final class StreamManager {
    /// Active agent stream continuations keyed by requestId
    private var agentContinuations: [String: AsyncThrowingStream<String, Error>.Continuation] = [:]
    /// Active LLM stream continuations keyed by requestId
    private var llmContinuations: [String: AsyncThrowingStream<LLMChunkType, Error>.Continuation] = [:]

    // MARK: - Agent Streams

    func createAgentStream(requestId: String) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            self.agentContinuations[requestId] = continuation
            continuation.onTermination = { @Sendable _ in
                Task { @MainActor in
                    self.agentContinuations.removeValue(forKey: requestId)
                }
            }
        }
    }

    func yieldAgentChunk(requestId: String, chunk: String) {
        agentContinuations[requestId]?.yield(chunk)
    }

    func finishAgentStream(requestId: String) {
        agentContinuations[requestId]?.finish()
        agentContinuations.removeValue(forKey: requestId)
    }

    func failAgentStream(requestId: String, error: String) {
        agentContinuations[requestId]?.finish(throwing: P2PError.streamError(error))
        agentContinuations.removeValue(forKey: requestId)
    }

    // MARK: - LLM Streams

    func createLLMStream(requestId: String) -> AsyncThrowingStream<LLMChunkType, Error> {
        AsyncThrowingStream { continuation in
            self.llmContinuations[requestId] = continuation
            continuation.onTermination = { @Sendable _ in
                Task { @MainActor in
                    self.llmContinuations.removeValue(forKey: requestId)
                }
            }
        }
    }

    func yieldLLMChunk(requestId: String, chunk: LLMChunkType) {
        llmContinuations[requestId]?.yield(chunk)
    }

    func finishLLMStream(requestId: String) {
        llmContinuations[requestId]?.finish()
        llmContinuations.removeValue(forKey: requestId)
    }

    func failLLMStream(requestId: String, error: String) {
        llmContinuations[requestId]?.finish(throwing: P2PError.streamError(error))
        llmContinuations.removeValue(forKey: requestId)
    }

    // MARK: - Bulk Cleanup

    func abortAllStreams(error: String) {
        let err = P2PError.streamError(error)
        for (_, continuation) in agentContinuations {
            continuation.finish(throwing: err)
        }
        agentContinuations.removeAll()

        for (_, continuation) in llmContinuations {
            continuation.finish(throwing: err)
        }
        llmContinuations.removeAll()
    }
}

// MARK: - Error Type

enum P2PError: LocalizedError {
    case notConnected
    case peerNotFound(String)
    case streamError(String)
    case runtimeError(String)

    var errorDescription: String? {
        switch self {
        case .notConnected: return "Not connected to P2P network"
        case .peerNotFound(let id): return "Peer not found: \(id)"
        case .streamError(let msg): return msg
        case .runtimeError(let msg): return "Runtime error: \(msg)"
        }
    }
}
