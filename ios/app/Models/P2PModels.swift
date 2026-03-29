import Foundation

// MARK: - Peer Catalog Types (mirrors lib/p2p/types.ts)

struct P2PAgentInfo: Codable, Identifiable, Hashable {
    var id: String { name }
    let name: String
    let description: String
    let inputVariables: [String]
    let sampleQuestions: [String]?

    enum CodingKeys: String, CodingKey {
        case name, description, inputVariables, sampleQuestions
    }
}

struct P2PModelInfo: Codable, Identifiable, Hashable {
    var id: String { name }
    let name: String
    let model: String
    let type: String  // "chat", "image", "tts"
    let modelId: String?
    let capabilities: [String]?

    enum CodingKeys: String, CodingKey {
        case name, model, type, modelId, capabilities
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? name
        type = try container.decodeIfPresent(String.self, forKey: .type) ?? "chat"
        modelId = try container.decodeIfPresent(String.self, forKey: .modelId)
        capabilities = try container.decodeIfPresent([String].self, forKey: .capabilities)
    }
}

/// Legacy type kept for backward compatibility with older peers
struct P2PLLMInfo: Codable, Identifiable, Hashable {
    var id: String { name }
    let name: String
    let provider: String
    let model: String
}

/// Inline token stats from catalog broadcasts
struct PeerStats: Codable {
    let si: Int  // served input tokens
    let so: Int  // served output tokens
    let ci: Int  // consumed input tokens
    let co: Int  // consumed output tokens
}

struct PeerInfo: Codable, Identifiable {
    var id: String { peerId }
    let peerId: String
    var peerName: String
    let version: String
    var agents: [P2PAgentInfo]
    var models: [P2PModelInfo]
    var load: Int
    var stats: PeerStats?
    let connectedAt: Double

    enum CodingKeys: String, CodingKey {
        case peerId, peerName, version, agents, models, load, stats, connectedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        peerId = try container.decode(String.self, forKey: .peerId)
        peerName = try container.decode(String.self, forKey: .peerName)
        version = try container.decodeIfPresent(String.self, forKey: .version) ?? "unknown"
        agents = try container.decodeIfPresent([P2PAgentInfo].self, forKey: .agents) ?? []
        models = try container.decodeIfPresent([P2PModelInfo].self, forKey: .models) ?? []
        load = try container.decodeIfPresent(Int.self, forKey: .load) ?? 0
        stats = try container.decodeIfPresent(PeerStats.self, forKey: .stats)
        connectedAt = try container.decode(Double.self, forKey: .connectedAt)
    }
}

// MARK: - Aggregated Remote Types

struct RemoteAgent: Identifiable, Hashable {
    var id: String { "\(peerId)/\(name)" }
    let name: String
    let description: String
    let peerId: String
    let peerName: String
    let inputVariables: [String]
    let sampleQuestions: [String]?

    static func == (lhs: RemoteAgent, rhs: RemoteAgent) -> Bool {
        lhs.id == rhs.id
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
}

struct RemoteLLM: Identifiable, Hashable {
    var id: String { "\(peerId)/\(name)" }
    let name: String
    let provider: String
    let model: String
    let peerId: String
    let peerName: String

    static func == (lhs: RemoteLLM, rhs: RemoteLLM) -> Bool {
        lhs.id == rhs.id
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
}

// MARK: - Chat Types

enum ChatTarget: Hashable {
    case agent(RemoteAgent)
    case llm(RemoteLLM)

    var displayName: String {
        switch self {
        case .agent(let agent): return agent.name
        case .llm(let llm): return llm.name
        }
    }

    var peerName: String {
        switch self {
        case .agent(let agent): return agent.peerName
        case .llm(let llm): return llm.peerName
        }
    }

    var peerId: String {
        switch self {
        case .agent(let agent): return agent.peerId
        case .llm(let llm): return llm.peerId
        }
    }

    var subtitle: String {
        switch self {
        case .agent(let agent): return agent.description
        case .llm(let llm): return "\(llm.provider) / \(llm.model)"
        }
    }
}

enum MessageRole: String, Codable {
    case user
    case assistant
    case system
}

struct ChatMessage: Identifiable {
    let id: UUID
    let role: MessageRole
    var content: String
    let timestamp: Date
    var isStreaming: Bool
    var thinkingContent: String?
    var usage: TokenUsage?
    var toolCalls: [ToolCallInfo]
    var mediaContent: [MediaContent]

    init(
        id: UUID = UUID(),
        role: MessageRole,
        content: String,
        timestamp: Date = Date(),
        isStreaming: Bool = false,
        thinkingContent: String? = nil,
        usage: TokenUsage? = nil,
        toolCalls: [ToolCallInfo] = [],
        mediaContent: [MediaContent] = []
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.isStreaming = isStreaming
        self.thinkingContent = thinkingContent
        self.usage = usage
        self.toolCalls = toolCalls
        self.mediaContent = mediaContent
    }
}

struct TokenUsage {
    let inputTokens: Int
    let outputTokens: Int
    let totalTokens: Int
}

// MARK: - LLM Stream Chunk Types

enum LLMChunkType {
    case content(String)
    case thinking(String)
    case usage(TokenUsage)
}

// MARK: - Rich Agent Stream Events

enum AgentStreamEvent {
    case content(String)
    case thinking(String)
    case toolStart(tool: String, input: String, runId: String)
    case toolEnd(tool: String, output: String, runId: String, media: MediaContent?)
    case usage(TokenUsage)
}

// MARK: - Media Content (from model tool outputs)

struct MediaContent: Identifiable {
    let id: UUID
    let task: String  // "text-to-image", "text-to-speech", "text-to-video"
    let imageDataURI: String?
    let audioDataURI: String?
    let videoDataURI: String?

    init(
        id: UUID = UUID(),
        task: String,
        imageDataURI: String? = nil,
        audioDataURI: String? = nil,
        videoDataURI: String? = nil
    ) {
        self.id = id
        self.task = task
        self.imageDataURI = imageDataURI
        self.audioDataURI = audioDataURI
        self.videoDataURI = videoDataURI
    }
}

// MARK: - Tool Call Tracking

struct ToolCallInfo: Identifiable {
    let id: String  // runId
    let tool: String
    let input: String
    var output: String?
    var isDone: Bool
    var media: MediaContent?

    init(id: String, tool: String, input: String, output: String? = nil, isDone: Bool = false, media: MediaContent? = nil) {
        self.id = id
        self.tool = tool
        self.input = input
        self.output = output
        self.isDone = isDone
        self.media = media
    }
}

// MARK: - File Attachments

struct Attachment: Identifiable {
    let id: UUID
    let data: Data
    let mediaType: String
    let name: String

    init(id: UUID = UUID(), data: Data, mediaType: String, name: String) {
        self.id = id
        self.data = data
        self.mediaType = mediaType
        self.name = name
    }

    var base64String: String { data.base64EncodedString() }

    var isImage: Bool { mediaType.hasPrefix("image/") }
    var isAudio: Bool { mediaType.hasPrefix("audio/") }
}

// MARK: - Leaderboard

struct P2PLeaderboardEntry: Codable, Identifiable {
    var id: String { peerId }
    let peerId: String
    let peerName: String
    let servedInputTokens: Int
    let servedOutputTokens: Int
    let servedTotalTokens: Int
    let servedRequests: Int
    let consumedInputTokens: Int
    let consumedOutputTokens: Int
    let consumedTotalTokens: Int
    let consumedRequests: Int
    let online: Bool
    let lastUpdated: Double
    let isSelf: Bool
}
