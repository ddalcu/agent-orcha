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

    func send(_ text: String, attachments: [Attachment]? = nil) {
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
            streamAgentResponse(agent: agent, input: trimmed, attachments: attachments)
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

    // MARK: - Agent Streaming (rich events)

    private func streamAgentResponse(agent: RemoteAgent, input: String, attachments: [Attachment]?) {
        let inputVar = agent.inputVariables.first ?? "query"
        let inputDict = [inputVar: input]

        streamTask = Task { [weak self] in
            guard let self else { return }
            let stream = service.invokeAgent(
                peerId: agent.peerId,
                agentName: agent.name,
                input: inputDict,
                sessionId: sessionId,
                attachments: attachments
            )

            do {
                for try await event in stream {
                    guard !Task.isCancelled else { break }
                    switch event {
                    case .content(let text):
                        self.appendToLastMessage(text)
                    case .thinking(let text):
                        self.appendThinking(text)
                    case .toolStart(let tool, let input, let runId):
                        self.addToolCall(tool: tool, input: input, runId: runId)
                    case .toolEnd(let tool, _, let runId, let media):
                        self.finishToolCall(tool: tool, runId: runId, media: media)
                    case .usage(let usage):
                        self.updateLastMessageUsage(usage)
                    }
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
                        self.updateLastMessageUsage(tokenUsage)
                    }
                }
            } catch {
                if !Task.isCancelled {
                    self.appendToLastMessage("\n\n**Error:** \(error.localizedDescription)")
                }
            }

            if !assistantContent.isEmpty {
                self.conversationHistory.append(["role": "assistant", "content": assistantContent])
            }

            self.finishStreaming()
        }
    }

    // MARK: - Message Helpers

    private func appendToLastMessage(_ text: String) {
        guard !messages.isEmpty else { return }
        let cleaned = Self.sanitizeContent(text)
        guard !cleaned.isEmpty else { return }
        messages[messages.count - 1].content += cleaned
    }

    /// Strip internal XML tags and metadata that should not be shown in the UI.
    /// Mirrors what the web app does via DOMPurify (strips unknown HTML tags).
    private static func sanitizeContent(_ text: String) -> String {
        var result = text
        // Remove <tool_call>...</tool_call> blocks (model's raw function calling output)
        result = result.replacingOccurrences(
            of: #"<tool_call>[\s\S]*?</\s*tool_call>"#,
            with: "",
            options: .regularExpression
        )
        // Remove <tool_history>...</tool_history> blocks (conversation store metadata)
        result = result.replacingOccurrences(
            of: #"<tool_history>[\s\S]*?</tool_history>"#,
            with: "",
            options: .regularExpression
        )
        // Remove standalone internal tags that might not have matching pairs
        result = result.replacingOccurrences(of: "<tool_call>", with: "")
        result = result.replacingOccurrences(of: "</tool_call>", with: "")
        result = result.replacingOccurrences(of: "<tool_history>", with: "")
        result = result.replacingOccurrences(of: "</tool_history>", with: "")
        // Remove raw JSON metadata events that may have been concatenated
        result = result.replacingOccurrences(
            of: #"\{"type":"react_iteration"[^}]*\}"#,
            with: "",
            options: .regularExpression
        )
        return result
    }

    private func appendThinking(_ text: String) {
        guard !messages.isEmpty else { return }
        let existing = messages[messages.count - 1].thinkingContent ?? ""
        messages[messages.count - 1].thinkingContent = existing + text
    }

    private func updateLastMessageThinking(_ thinking: String) {
        guard !messages.isEmpty else { return }
        messages[messages.count - 1].thinkingContent = thinking
    }

    private func updateLastMessageUsage(_ usage: TokenUsage) {
        guard !messages.isEmpty else { return }
        messages[messages.count - 1].usage = usage
    }

    private func addToolCall(tool: String, input: String, runId: String) {
        guard !messages.isEmpty else { return }
        let toolCall = ToolCallInfo(id: runId, tool: tool, input: input)
        messages[messages.count - 1].toolCalls.append(toolCall)
    }

    private func finishToolCall(tool: String, runId: String, media: MediaContent?) {
        guard !messages.isEmpty else { return }
        let msgIdx = messages.count - 1

        // Find the matching tool call by runId
        if let toolIdx = messages[msgIdx].toolCalls.firstIndex(where: { $0.id == runId }) {
            messages[msgIdx].toolCalls[toolIdx].isDone = true
            messages[msgIdx].toolCalls[toolIdx].media = media
        }

        // Add media content to the message if present
        if let media {
            messages[msgIdx].mediaContent.append(media)
        }
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
