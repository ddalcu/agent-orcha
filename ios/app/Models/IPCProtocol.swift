import Foundation

// MARK: - Swift → JS Commands

enum IPCCommand: Encodable {
    case connect(networkKey: String, peerName: String)
    case disconnect
    case invokeAgent(requestId: String, peerId: String, agentName: String, input: [String: String], sessionId: String, attachments: [[String: String]]?)
    case invokeLLM(requestId: String, peerId: String, modelName: String, messages: [[String: String]], sessionId: String)
    case requestLeaderboard(requestId: String)
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

        case .invokeAgent(let requestId, let peerId, let agentName, let input, let sessionId, let attachments):
            try container.encode("invoke_agent", forKey: .key("cmd"))
            try container.encode(requestId, forKey: .key("requestId"))
            try container.encode(peerId, forKey: .key("peerId"))
            try container.encode(agentName, forKey: .key("agentName"))
            try container.encode(input, forKey: .key("input"))
            try container.encode(sessionId, forKey: .key("sessionId"))
            if let attachments {
                try container.encode(attachments, forKey: .key("attachments"))
            }

        case .invokeLLM(let requestId, let peerId, let modelName, let messages, let sessionId):
            try container.encode("invoke_llm", forKey: .key("cmd"))
            try container.encode(requestId, forKey: .key("requestId"))
            try container.encode(peerId, forKey: .key("peerId"))
            try container.encode(modelName, forKey: .key("modelName"))
            try container.encode(messages, forKey: .key("messages"))
            try container.encode(sessionId, forKey: .key("sessionId"))

        case .requestLeaderboard(let requestId):
            try container.encode("request_leaderboard", forKey: .key("cmd"))
            try container.encode(requestId, forKey: .key("requestId"))

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
    case catalogUpdate(peerId: String, agents: [P2PAgentInfo], models: [P2PModelInfo], load: Int, stats: PeerStats?)
    // Agent stream events (rich)
    case streamChunk(requestId: String, chunkType: String, content: String)
    case streamEvent(requestId: String, eventType: String, data: [String: Any])
    case streamEnd(requestId: String)
    case streamError(requestId: String, error: String)
    // LLM stream events
    case llmChunk(requestId: String, chunk: LLMChunkType)
    case llmEnd(requestId: String)
    case llmError(requestId: String, error: String)
    // Leaderboard
    case leaderboardResponse(requestId: String, entries: [P2PLeaderboardEntry])
    // Generic error
    case error(message: String)
}

enum IPCEventParser {
    /// Parse a raw Data blob that may contain multiple NDJSON lines.
    /// NOTE: This does NOT buffer partial lines — use `parseLine` with external buffering for large events.
    static func parse(_ data: Data) -> [IPCEvent] {
        guard let text = String(data: data, encoding: .utf8) else { return [] }

        var events: [IPCEvent] = []
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            if let event = parseLine(trimmed) {
                events.append(event)
            }
        }

        return events
    }

    /// Parse a single complete NDJSON line into an IPCEvent.
    static func parseLine(_ line: String) -> IPCEvent? {
        guard let lineData = line.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any],
              let eventType = json["event"] as? String else {
            return nil
        }
        return parseEvent(type: eventType, json: json)
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
            let models = decodeCodableArray(json["models"], as: P2PModelInfo.self)
            let load = json["load"] as? Int ?? 0
            let stats: PeerStats? = decodeCodable(json["stats"], as: PeerStats.self)
            return .catalogUpdate(peerId: peerId, agents: agents, models: models, load: load, stats: stats)

        case "stream_chunk":
            guard let requestId = json["requestId"] as? String else { return nil }
            let chunkType = json["chunkType"] as? String ?? "content"
            let content: String
            if let c = json["content"] as? String {
                content = c
            } else if let chunk = json["chunk"] {
                // Backward compat: old format where chunk is a string or object
                if let s = chunk as? String {
                    content = s
                } else if let d = chunk as? [String: Any], let c = d["content"] as? String {
                    content = c
                } else {
                    content = ""
                }
            } else {
                content = ""
            }
            return .streamChunk(requestId: requestId, chunkType: chunkType, content: content)

        case "stream_event":
            guard let requestId = json["requestId"] as? String,
                  let eventType = json["eventType"] as? String else { return nil }
            return .streamEvent(requestId: requestId, eventType: eventType, data: json)

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

        case "leaderboard_response":
            guard let requestId = json["requestId"] as? String else { return nil }
            let entries = decodeCodableArray(json["entries"], as: P2PLeaderboardEntry.self)
            return .leaderboardResponse(requestId: requestId, entries: entries)

        case "error":
            let message = json["message"] as? String ?? "Unknown error"
            return .error(message: message)

        default:
            return nil
        }
    }

    private static func decodeCodableArray<T: Decodable>(_ value: Any?, as type: T.Type) -> [T] {
        guard let array = value,
              JSONSerialization.isValidJSONObject(array),
              let data = try? JSONSerialization.data(withJSONObject: array),
              let decoded = try? JSONDecoder().decode([T].self, from: data) else {
            return []
        }
        return decoded
    }

    private static func decodeCodable<T: Decodable>(_ value: Any?, as type: T.Type) -> T? {
        guard let obj = value,
              JSONSerialization.isValidJSONObject(obj),
              let data = try? JSONSerialization.data(withJSONObject: obj),
              let decoded = try? JSONDecoder().decode(T.self, from: data) else {
            return nil
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
