import Foundation

@Observable
@MainActor
final class LocalLLMViewModel {
    let service: LocalLLMService

    private(set) var messages: [ChatMessage] = []
    private(set) var isStreaming = false
    private(set) var streamStartTime: Date?
    private(set) var elapsedTime: TimeInterval = 0

    nonisolated(unsafe) private var streamTask: Task<Void, Never>?
    nonisolated(unsafe) private var timerTask: Task<Void, Never>?

    private var conversationHistory: [[String: String]] = []

    init(service: LocalLLMService) {
        self.service = service
    }

    deinit {
        streamTask?.cancel()
        timerTask?.cancel()
    }

    func send(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isStreaming else { return }

        messages.append(ChatMessage(role: .user, content: trimmed))
        messages.append(ChatMessage(role: .assistant, content: "", isStreaming: true))

        conversationHistory.append(["role": "user", "content": trimmed])

        isStreaming = true
        streamStartTime = Date()
        startElapsedTimer()

        streamTask = Task { [weak self] in
            guard let self else { return }

            let stream = service.generate(messages: conversationHistory)
            var assistantContent = ""
            var thinkingContent = ""
            var insideThink = false
            var buffer = ""

            do {
                for try await chunk in stream {
                    guard !Task.isCancelled else { break }
                    buffer += chunk

                    while !buffer.isEmpty {
                        if insideThink {
                            if let endRange = buffer.range(of: "</think>") {
                                let thought = String(buffer[buffer.startIndex..<endRange.lowerBound])
                                thinkingContent += thought
                                self.updateLastMessageThinking(thinkingContent)
                                buffer = String(buffer[endRange.upperBound...])
                                insideThink = false
                            } else {
                                // Could be partial "</think>" at the end — keep last 8 chars as buffer
                                let safeCount = max(0, buffer.count - 8)
                                if safeCount > 0 {
                                    let idx = buffer.index(buffer.startIndex, offsetBy: safeCount)
                                    thinkingContent += String(buffer[..<idx])
                                    self.updateLastMessageThinking(thinkingContent)
                                    buffer = String(buffer[idx...])
                                }
                                break
                            }
                        } else {
                            if let startRange = buffer.range(of: "<think>") {
                                let before = String(buffer[buffer.startIndex..<startRange.lowerBound])
                                if !before.isEmpty {
                                    assistantContent += before
                                    self.appendToLastMessage(before)
                                }
                                buffer = String(buffer[startRange.upperBound...])
                                insideThink = true
                            } else {
                                // Could be partial "<think>" at the end — keep last 7 chars as buffer
                                let safeCount = max(0, buffer.count - 7)
                                if safeCount > 0 {
                                    let idx = buffer.index(buffer.startIndex, offsetBy: safeCount)
                                    let text = String(buffer[..<idx])
                                    assistantContent += text
                                    self.appendToLastMessage(text)
                                    buffer = String(buffer[idx...])
                                }
                                break
                            }
                        }
                    }
                }

                // Flush remaining buffer
                if !buffer.isEmpty {
                    if insideThink {
                        thinkingContent += buffer
                        self.updateLastMessageThinking(thinkingContent)
                    } else {
                        assistantContent += buffer
                        self.appendToLastMessage(buffer)
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
        service.resetSession()
    }

    // MARK: - Private

    private func appendToLastMessage(_ text: String) {
        guard !messages.isEmpty else { return }
        messages[messages.count - 1].content += text
    }

    private func updateLastMessageThinking(_ thinking: String) {
        guard !messages.isEmpty else { return }
        let trimmed = thinking.trimmingCharacters(in: .whitespacesAndNewlines)
        messages[messages.count - 1].thinkingContent = trimmed.isEmpty ? nil : thinking
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
