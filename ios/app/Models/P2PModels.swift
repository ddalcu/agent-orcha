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

struct P2PLLMInfo: Codable, Identifiable, Hashable {
    var id: String { name }
    let name: String
    let provider: String
    let model: String
}

struct PeerInfo: Codable, Identifiable {
    var id: String { peerId }
    let peerId: String
    var peerName: String
    let version: String
    var agents: [P2PAgentInfo]
    var llms: [P2PLLMInfo]
    let connectedAt: Double
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

    init(
        id: UUID = UUID(),
        role: MessageRole,
        content: String,
        timestamp: Date = Date(),
        isStreaming: Bool = false,
        thinkingContent: String? = nil,
        usage: TokenUsage? = nil
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.isStreaming = isStreaming
        self.thinkingContent = thinkingContent
        self.usage = usage
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
