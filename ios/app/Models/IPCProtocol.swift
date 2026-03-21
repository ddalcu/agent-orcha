import Foundation

// MARK: - Swift → JS Commands

enum IPCCommand: Encodable {
    case connect(networkKey: String, peerName: String)
    case disconnect
    case invokeAgent(requestId: String, peerId: String, agentName: String, input: [String: String], sessionId: String)
    case invokeLLM(requestId: String, peerId: String, modelName: String, messages: [[String: String]], sessionId: String)
    case abort(requestId: String)

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: DynamicCodingKey.self)

        switch self {
        case .connect(let networkKey, let peerName):
            try container.encode("connect", forKey: .key("cmd"))
            try container.encode(networkKey, forKey: .key("networkKey"))
            try container.encode(peerName, forKey: .key("peerName"))

        case .disconnect:
            try container.encode("disconnect", forKey: .key("cmd"))

        case .invokeAgent(let requestId, let peerId, let agentName, let input, let sessionId):
            try container.encode("invoke_agent", forKey: .key("cmd"))
            try container.encode(requestId, forKey: .key("requestId"))
            try container.encode(peerId, forKey: .key("peerId"))
            try container.encode(agentName, forKey: .key("agentName"))
            try container.encode(input, forKey: .key("input"))
            try container.encode(sessionId, forKey: .key("sessionId"))

        case .invokeLLM(let requestId, let peerId, let modelName, let messages, let sessionId):
            try container.encode("invoke_llm", forKey: .key("cmd"))
            try container.encode(requestId, forKey: .key("requestId"))
            try container.encode(peerId, forKey: .key("peerId"))
            try container.encode(modelName, forKey: .key("modelName"))
            try container.encode(messages, forKey: .key("messages"))
            try container.encode(sessionId, forKey: .key("sessionId"))

        case .abort(let requestId):
            try container.encode("abort", forKey: .key("cmd"))
            try container.encode(requestId, forKey: .key("requestId"))
        }
    }
}

// MARK: - JS → Swift Events

enum IPCEvent {
    case ready
    case connected(peerCount: Int)
    case disconnected
    case peerJoined(peer: PeerInfo)
    case peerLeft(peerId: String)
    case catalogUpdate(peerId: String, agents: [P2PAgentInfo], llms: [P2PLLMInfo])
    case streamChunk(requestId: String, chunk: String)
    case streamEnd(requestId: String)
    case streamError(requestId: String, error: String)
    case llmChunk(requestId: String, chunk: LLMChunkType)
    case llmEnd(requestId: String)
    case llmError(requestId: String, error: String)
    case error(message: String)
}

enum IPCEventParser {
    static func parse(_ data: Data) -> [IPCEvent] {
        guard let text = String(data: data, encoding: .utf8) else { return [] }

        var events: [IPCEvent] = []
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }

            guard let lineData = trimmed.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any],
                  let eventType = json["event"] as? String else {
                continue
            }

            let event = parseEvent(type: eventType, json: json)
            if let event { events.append(event) }
        }

        return events
    }

    private static func parseEvent(type: String, json: [String: Any]) -> IPCEvent? {
        switch type {
        case "ready":
            return .ready

        case "connected":
            let peerCount = json["peerCount"] as? Int ?? 0
            return .connected(peerCount: peerCount)

        case "disconnected":
            return .disconnected

        case "peer_joined":
            guard let peerDict = json["peer"] as? [String: Any],
                  let peerData = try? JSONSerialization.data(withJSONObject: peerDict),
                  let peer = try? JSONDecoder().decode(PeerInfo.self, from: peerData) else {
                return nil
            }
            return .peerJoined(peer: peer)

        case "peer_left":
            guard let peerId = json["peerId"] as? String else { return nil }
            return .peerLeft(peerId: peerId)

        case "catalog_update":
            guard let peerId = json["peerId"] as? String else { return nil }
            let agents = decodeCodableArray(json["agents"], as: P2PAgentInfo.self)
            let llms = decodeCodableArray(json["llms"], as: P2PLLMInfo.self)
            return .catalogUpdate(peerId: peerId, agents: agents, llms: llms)

        case "stream_chunk":
            guard let requestId = json["requestId"] as? String else { return nil }
            let chunk: String
            if let stringChunk = json["chunk"] as? String {
                chunk = stringChunk
            } else if let dictChunk = json["chunk"] as? [String: Any],
                      let content = dictChunk["content"] as? String {
                chunk = content
            } else {
                chunk = ""
            }
            return .streamChunk(requestId: requestId, chunk: chunk)

        case "stream_end":
            guard let requestId = json["requestId"] as? String else { return nil }
            return .streamEnd(requestId: requestId)

        case "stream_error":
            guard let requestId = json["requestId"] as? String else { return nil }
            let error = json["error"] as? String ?? "Unknown error"
            return .streamError(requestId: requestId, error: error)

        case "llm_chunk":
            guard let requestId = json["requestId"] as? String,
                  let chunkDict = json["chunk"] as? [String: Any],
                  let chunkType = chunkDict["type"] as? String else {
                return nil
            }
            let llmChunk: LLMChunkType
            switch chunkType {
            case "content":
                llmChunk = .content(chunkDict["content"] as? String ?? "")
            case "thinking":
                llmChunk = .thinking(chunkDict["content"] as? String ?? "")
            case "usage":
                llmChunk = .usage(TokenUsage(
                    inputTokens: chunkDict["input_tokens"] as? Int ?? 0,
                    outputTokens: chunkDict["output_tokens"] as? Int ?? 0,
                    totalTokens: chunkDict["total_tokens"] as? Int ?? 0
                ))
            default:
                return nil
            }
            return .llmChunk(requestId: requestId, chunk: llmChunk)

        case "llm_end":
            guard let requestId = json["requestId"] as? String else { return nil }
            return .llmEnd(requestId: requestId)

        case "llm_error":
            guard let requestId = json["requestId"] as? String else { return nil }
            let error = json["error"] as? String ?? "Unknown error"
            return .llmError(requestId: requestId, error: error)

        case "error":
            let message = json["message"] as? String ?? "Unknown error"
            return .error(message: message)

        default:
            return nil
        }
    }

    private static func decodeCodableArray<T: Decodable>(_ value: Any?, as type: T.Type) -> [T] {
        guard let array = value,
              let data = try? JSONSerialization.data(withJSONObject: array),
              let decoded = try? JSONDecoder().decode([T].self, from: data) else {
            return []
        }
        return decoded
    }
}

// MARK: - NDJSON Encoder

enum NDJSONEncoder {
    static func encode(_ command: IPCCommand) -> Data? {
        guard let jsonData = try? JSONEncoder().encode(command),
              var jsonString = String(data: jsonData, encoding: .utf8) else {
            return nil
        }
        jsonString += "\n"
        return jsonString.data(using: .utf8)
    }
}

// MARK: - Dynamic Coding Key

struct DynamicCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int?

    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { self.intValue = intValue; self.stringValue = "\(intValue)" }

    static func key(_ name: String) -> DynamicCodingKey {
        DynamicCodingKey(stringValue: name)!
    }
}
