import Foundation

@Observable
@MainActor
final class ChatViewModel {
    let target: ChatTarget
    private let service: BareP2PService
    private let sessionId: String

    private(set) var messages: [ChatMessage] = []
    private(set) var isStreaming = false
    private(set) var streamStartTime: Date?
    private(set) var elapsedTime: TimeInterval = 0

    nonisolated(unsafe) private var streamTask: Task<Void, Never>?
    nonisolated(unsafe) private var timerTask: Task<Void, Never>?

    /// Conversation history for LLM chat (role + content pairs)
    private var conversationHistory: [[String: String]] = []

    init(target: ChatTarget, service: BareP2PService) {
        self.target = target
        self.service = service
        self.sessionId = "ios-\(Int(Date().timeIntervalSince1970))-\(UUID().uuidString.prefix(6))"
    }

    deinit {
        streamTask?.cancel()
        timerTask?.cancel()
    }

    func send(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isStreaming else { return }

        // Add user message
        let userMessage = ChatMessage(role: .user, content: trimmed)
        messages.append(userMessage)

        // Add placeholder assistant message
        let assistantMessage = ChatMessage(role: .assistant, content: "", isStreaming: true)
        messages.append(assistantMessage)

        isStreaming = true
        streamStartTime = Date()
        startElapsedTimer()

        switch target {
        case .agent(let agent):
            streamAgentResponse(agent: agent, input: trimmed)
        case .llm(let llm):
            streamLLMResponse(llm: llm, message: trimmed)
        }
    }

    func cancelStream() {
        streamTask?.cancel()
        streamTask = nil
        finishStreaming()
    }

    func reset() {
        cancelStream()
        messages.removeAll()
        conversationHistory.removeAll()
        elapsedTime = 0
        streamStartTime = nil
    }

    // MARK: - Agent Streaming

    private func streamAgentResponse(agent: RemoteAgent, input: String) {
        let inputVar = agent.inputVariables.first ?? "query"
        let inputDict = [inputVar: input]

        streamTask = Task { [weak self] in
            guard let self else { return }
            let stream = service.invokeAgent(
                peerId: agent.peerId,
                agentName: agent.name,
                input: inputDict,
                sessionId: sessionId
            )

            do {
                for try await chunk in stream {
                    guard !Task.isCancelled else { break }
                    self.appendToLastMessage(chunk)
                }
            } catch {
                if !Task.isCancelled {
                    self.appendToLastMessage("\n\n**Error:** \(error.localizedDescription)")
                }
            }

            self.finishStreaming()
        }
    }

    // MARK: - LLM Streaming

    private func streamLLMResponse(llm: RemoteLLM, message: String) {
        // Build conversation history
        conversationHistory.append(["role": "user", "content": message])

        streamTask = Task { [weak self] in
            guard let self else { return }
            let stream = service.invokeLLM(
                peerId: llm.peerId,
                modelName: llm.name,
                messages: conversationHistory,
                sessionId: sessionId
            )

            var assistantContent = ""
            var thinkingContent = ""
            var usage: TokenUsage?

            do {
                for try await chunk in stream {
                    guard !Task.isCancelled else { break }
                    switch chunk {
                    case .content(let text):
                        assistantContent += text
                        self.appendToLastMessage(text)
                    case .thinking(let text):
                        thinkingContent += text
                        self.updateLastMessageThinking(thinkingContent)
                    case .usage(let tokenUsage):
                        usage = tokenUsage
                        self.updateLastMessageUsage(tokenUsage)
                    }
                }
            } catch {
                if !Task.isCancelled {
                    self.appendToLastMessage("\n\n**Error:** \(error.localizedDescription)")
                }
            }

            // Store assistant response in conversation history
            if !assistantContent.isEmpty {
                self.conversationHistory.append(["role": "assistant", "content": assistantContent])
            }

            self.finishStreaming()
        }
    }

    // MARK: - Message Helpers

    private func appendToLastMessage(_ text: String) {
        guard !messages.isEmpty else { return }
        messages[messages.count - 1].content += text
    }

    private func updateLastMessageThinking(_ thinking: String) {
        guard !messages.isEmpty else { return }
        messages[messages.count - 1].thinkingContent = thinking
    }

    private func updateLastMessageUsage(_ usage: TokenUsage) {
        guard !messages.isEmpty else { return }
        messages[messages.count - 1].usage = usage
    }

    private func finishStreaming() {
        if !messages.isEmpty {
            messages[messages.count - 1].isStreaming = false
        }
        isStreaming = false
        timerTask?.cancel()
        timerTask = nil
    }

    private func startElapsedTimer() {
        timerTask?.cancel()
        timerTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                guard let self, let start = self.streamStartTime else { return }
                self.elapsedTime = Date().timeIntervalSince(start)
            }
        }
    }
}
