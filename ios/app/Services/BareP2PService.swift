import Foundation
import UIKit

/// Connection lifecycle state
enum P2PConnectionState: Equatable {
    case idle
    case starting       // Bare runtime booting
    case connecting     // Swarm join in progress
    case connected      // Active on the network
    case reconnecting   // Was connected, temporarily lost, auto-retrying
}

/// Central service that owns the Bare runtime worklet and bridges
/// Hyperswarm P2P events to Swift via NDJSON over IPC.
@Observable
@MainActor
final class BareP2PService {
    // MARK: - Published State

    private(set) var connectionState: P2PConnectionState = .starting
    private(set) var peers: [PeerInfo] = []
    private(set) var lastError: String?
    private(set) var leaderboardEntries: [P2PLeaderboardEntry] = [] {
        didSet { LeaderboardCache.save(leaderboardEntries) }
    }

    /// Peers that recently disconnected — kept for a grace period so chat sessions survive brief drops
    private var recentlyLostPeers: [String: PeerInfo] = [:]
    private var peerGraceTimers: [String: Task<Void, Never>] = [:]
    private let peerGracePeriod: TimeInterval = 30

    /// Whether we had a successful connection at least once (for reconnect logic)
    private var hasConnectedBefore = false
    private var lastNetworkKey: String?
    private var lastPeerName: String?
    private var reconnectTask: Task<Void, Never>?

    /// Leaderboard request tracking
    private var leaderboardContinuation: CheckedContinuation<[P2PLeaderboardEntry], Never>?

    var isConnected: Bool { connectionState == .connected }
    var peerCount: Int { peers.count }

    /// Includes both live peers and recently-lost peers (grace period)
    var allAvailablePeers: [PeerInfo] {
        var result = peers
        for (peerId, peer) in recentlyLostPeers {
            if !result.contains(where: { $0.peerId == peerId }) {
                result.append(peer)
            }
        }
        return result
    }

    var remoteAgents: [RemoteAgent] {
        allAvailablePeers.flatMap { peer in
            peer.agents.map { agent in
                RemoteAgent(
                    name: agent.name,
                    description: agent.description,
                    peerId: peer.peerId,
                    peerName: peer.peerName,
                    inputVariables: agent.inputVariables,
                    sampleQuestions: agent.sampleQuestions
                )
            }
        }
    }

    var remoteLLMs: [RemoteLLM] {
        allAvailablePeers.flatMap { peer in
            peer.models
                .filter { $0.type == "chat" }
                .map { model in
                    RemoteLLM(
                        name: model.name,
                        provider: model.type,
                        model: model.model,
                        peerId: peer.peerId,
                        peerName: peer.peerName
                    )
                }
        }
    }

    // MARK: - Private

    let streamManager = StreamManager()
    private var worklet: Worklet?
    private var ipc: IPC?
    private var readerTask: Task<Void, Never>?
    private var requestCounter = 0

    // MARK: - Lifecycle

    init() {
        leaderboardEntries = LeaderboardCache.load()
        startWorklet()
    }

    private func startWorklet() {
        let worklet = Worklet()
        worklet.start(name: "p2p-client", ofType: "bundle")
        let ipc = IPC(worklet: worklet)
        self.worklet = worklet
        self.ipc = ipc
        startIPCReader(ipc)
    }

    // MARK: - IPC Reader

    /// Buffer for incomplete NDJSON lines across IPC data deliveries.
    /// Large events (e.g. tool_end with multi-MB base64 audio) may span multiple chunks.
    private var ipcBuffer = ""

    private func startIPCReader(_ ipc: IPC) {
        readerTask = Task { [weak self] in
            do {
                for try await data in ipc {
                    guard let self else { return }
                    guard let text = String(data: data, encoding: .utf8) else { continue }

                    // Accumulate into buffer and split on newlines (NDJSON)
                    self.ipcBuffer += text
                    let lines = self.ipcBuffer.split(separator: "\n", omittingEmptySubsequences: false)
                    // Last element is either empty (complete line) or a partial line to keep buffered
                    self.ipcBuffer = String(lines.last ?? "")

                    for line in lines.dropLast() {
                        let trimmed = line.trimmingCharacters(in: .whitespaces)
                        if trimmed.isEmpty { continue }
                        if let event = IPCEventParser.parseLine(trimmed) {
                            self.handleEvent(event)
                        }
                    }
                }
            } catch {
                guard let self else { return }
                self.lastError = "IPC read error: \(error.localizedDescription)"
            }
        }
    }

    // MARK: - Event Handling

    private func handleEvent(_ event: IPCEvent) {
        switch event {
        case .ready:
            lastError = nil
            connectionState = .connecting
            autoConnect()

        case .connected:
            connectionState = .connected
            hasConnectedBefore = true
            lastError = nil
            reconnectTask?.cancel()
            reconnectTask = nil

        case .disconnected:
            let wasConnected = isConnected || connectionState == .reconnecting
            if wasConnected && hasConnectedBefore {
                connectionState = .reconnecting
                scheduleReconnect()
            } else {
                connectionState = .idle
                peers.removeAll()
                clearAllGracePeers()
                streamManager.abortAllStreams(error: "Disconnected from P2P network")
            }

        case .peerJoined(let peer):
            if let timer = peerGraceTimers.removeValue(forKey: peer.peerId) {
                timer.cancel()
                recentlyLostPeers.removeValue(forKey: peer.peerId)
            }
            if let index = peers.firstIndex(where: { $0.peerId == peer.peerId }) {
                peers[index] = peer
            } else {
                peers.append(peer)
            }

        case .peerLeft(let peerId):
            if let index = peers.firstIndex(where: { $0.peerId == peerId }) {
                let peer = peers.remove(at: index)
                startPeerGracePeriod(peer)
            }

        case .catalogUpdate(let peerId, let agents, let models, let load, let stats):
            if let index = peers.firstIndex(where: { $0.peerId == peerId }) {
                peers[index].agents = agents
                peers[index].models = models
                peers[index].load = load
                peers[index].stats = stats
            }
            if var gracePeer = recentlyLostPeers[peerId] {
                gracePeer.agents = agents
                gracePeer.models = models
                gracePeer.load = load
                gracePeer.stats = stats
                recentlyLostPeers[peerId] = gracePeer
            }

        case .streamChunk(let requestId, let chunkType, let content):
            let event: AgentStreamEvent = chunkType == "thinking"
                ? .thinking(content)
                : .content(content)
            streamManager.yieldAgentEvent(requestId: requestId, event: event)

        case .streamEvent(let requestId, let eventType, let data):
            handleStreamEvent(requestId: requestId, eventType: eventType, data: data)

        case .streamEnd(let requestId):
            streamManager.finishAgentStream(requestId: requestId)

        case .streamError(let requestId, let error):
            streamManager.failAgentStream(requestId: requestId, error: error)

        case .llmChunk(let requestId, let chunk):
            streamManager.yieldLLMChunk(requestId: requestId, chunk: chunk)

        case .llmEnd(let requestId):
            streamManager.finishLLMStream(requestId: requestId)

        case .llmError(let requestId, let error):
            streamManager.failLLMStream(requestId: requestId, error: error)

        case .leaderboardResponse(_, let entries):
            leaderboardEntries = entries
            leaderboardContinuation?.resume(returning: entries)
            leaderboardContinuation = nil

        case .error(let message):
            lastError = message
        }
    }

    /// Parse rich agent stream events (tool_start, tool_end, usage)
    private func handleStreamEvent(requestId: String, eventType: String, data: [String: Any]) {
        switch eventType {
        case "tool_start":
            let tool = data["tool"] as? String ?? ""
            let input = data["input"] as? String ?? ""
            let runId = data["runId"] as? String ?? UUID().uuidString
            streamManager.yieldAgentEvent(requestId: requestId, event: .toolStart(tool: tool, input: input, runId: runId))

        case "tool_end":
            let tool = data["tool"] as? String ?? ""
            let outputRaw = data["output"] as? String ?? ""
            let runId = data["runId"] as? String ?? ""
            let media = extractMediaFromToolEnd(tool: tool, output: outputRaw)
            streamManager.yieldAgentEvent(requestId: requestId, event: .toolEnd(tool: tool, output: outputRaw, runId: runId, media: media))

        case "usage":
            let usage = TokenUsage(
                inputTokens: data["input_tokens"] as? Int ?? 0,
                outputTokens: data["output_tokens"] as? Int ?? 0,
                totalTokens: data["total_tokens"] as? Int ?? 0
            )
            streamManager.yieldAgentEvent(requestId: requestId, event: .usage(usage))

        default:
            break
        }
    }

    /// Extract media content from model tool outputs (generate_image, generate_tts, generate_video)
    private func extractMediaFromToolEnd(tool: String, output: String) -> MediaContent? {
        let modelTools = ["generate_image", "generate_tts", "generate_video"]
        guard modelTools.contains(tool) else { return nil }

        guard let data = output.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["__modelTask"] as? Bool == true else {
            return nil
        }

        let task = json["task"] as? String ?? tool
        let image = json["image"] as? String
        let audio = json["audio"] as? String
        let video = json["video"] as? String

        // Only create media if we have at least one data URI
        guard image?.hasPrefix("data:") == true ||
              audio?.hasPrefix("data:") == true ||
              video?.hasPrefix("data:") == true else {
            return nil
        }

        return MediaContent(
            task: task,
            imageDataURI: image?.hasPrefix("data:") == true ? image : nil,
            audioDataURI: audio?.hasPrefix("data:") == true ? audio : nil,
            videoDataURI: video?.hasPrefix("data:") == true ? video : nil
        )
    }

    // MARK: - Peer Grace Period

    private func startPeerGracePeriod(_ peer: PeerInfo) {
        recentlyLostPeers[peer.peerId] = peer

        let peerId = peer.peerId
        peerGraceTimers[peerId]?.cancel()
        peerGraceTimers[peerId] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(self?.peerGracePeriod ?? 30))
            guard let self, !Task.isCancelled else { return }
            self.recentlyLostPeers.removeValue(forKey: peerId)
            self.peerGraceTimers.removeValue(forKey: peerId)
        }
    }

    private func clearAllGracePeers() {
        for (_, timer) in peerGraceTimers { timer.cancel() }
        peerGraceTimers.removeAll()
        recentlyLostPeers.removeAll()
    }

    // MARK: - Reconnection

    private func scheduleReconnect() {
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            var delay: TimeInterval = 2
            let maxDelay: TimeInterval = 30

            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(delay))
                guard let self, !Task.isCancelled else { return }

                if self.connectionState == .reconnecting,
                   let key = self.lastNetworkKey, let name = self.lastPeerName {
                    self.sendCommand(.connect(networkKey: key, peerName: name))
                } else {
                    return
                }

                delay = min(delay * 2, maxDelay)
            }
        }
    }

    // MARK: - Commands

    func connect(networkKey: String, peerName: String) {
        lastNetworkKey = networkKey
        lastPeerName = peerName
        if connectionState != .connected {
            connectionState = .connecting
        }
        sendCommand(.connect(networkKey: networkKey, peerName: peerName))
    }

    func disconnect() {
        hasConnectedBefore = false
        reconnectTask?.cancel()
        reconnectTask = nil
        connectionState = .idle
        peers.removeAll()
        clearAllGracePeers()
        streamManager.abortAllStreams(error: "Disconnected")
        sendCommand(.disconnect)
    }

    func invokeAgent(peerId: String, agentName: String, input: [String: String], sessionId: String, attachments: [Attachment]? = nil) -> AsyncThrowingStream<AgentStreamEvent, Error> {
        let requestId = generateRequestId()
        let stream = streamManager.createAgentStream(requestId: requestId)

        // Encode attachments as base64 dictionaries
        let encodedAttachments: [[String: String]]? = attachments?.map { attachment in
            ["data": attachment.base64String, "mediaType": attachment.mediaType, "name": attachment.name]
        }

        sendCommand(.invokeAgent(
            requestId: requestId,
            peerId: peerId,
            agentName: agentName,
            input: input,
            sessionId: sessionId,
            attachments: encodedAttachments
        ))
        return stream
    }

    func invokeLLM(peerId: String, modelName: String, messages: [[String: String]], sessionId: String) -> AsyncThrowingStream<LLMChunkType, Error> {
        let requestId = generateRequestId()
        let stream = streamManager.createLLMStream(requestId: requestId)
        sendCommand(.invokeLLM(
            requestId: requestId,
            peerId: peerId,
            modelName: modelName,
            messages: messages,
            sessionId: sessionId
        ))
        return stream
    }

    func requestLeaderboard() {
        let requestId = generateRequestId()
        sendCommand(.requestLeaderboard(requestId: requestId))
    }

    // MARK: - Helpers

    private func sendCommand(_ command: IPCCommand) {
        guard let ipc, let data = NDJSONEncoder.encode(command) else {
            lastError = "Failed to encode IPC command"
            return
        }
        Task {
            do {
                try await ipc.write(data: data)
            } catch {
                lastError = "IPC write error: \(error.localizedDescription)"
            }
        }
    }

    private func autoConnect() {
        // Do not auto-connect unless user has granted privacy consent (App Store 5.1.1/5.1.2)
        guard PrivacyConsentManager.shared.hasConsented else {
            connectionState = .idle
            return
        }

        let defaults = UserDefaults.standard
        let useCustom = defaults.bool(forKey: "p2p_use_custom_network")
        let networkKey = useCustom
            ? (defaults.string(forKey: "p2p_custom_network_key") ?? "agent-orcha-default")
            : "agent-orcha-default"
        let peerName = defaults.string(forKey: "p2p_peer_name") ?? UIDevice.current.name
        guard !networkKey.isEmpty else { return }
        connect(networkKey: networkKey, peerName: peerName)
    }

    private func generateRequestId() -> String {
        requestCounter += 1
        let random = UUID().uuidString.prefix(8)
        return "ios-\(requestCounter)-\(random)"
    }

    // MARK: - App Lifecycle

    func suspend() {
        worklet?.suspend()
    }

    func resume() {
        worklet?.resume()
    }
}

// MARK: - Leaderboard Disk Cache

private enum LeaderboardCache {
    private static let cacheURL: URL = {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        return dir.appendingPathComponent("leaderboard.json")
    }()

    static func save(_ entries: [P2PLeaderboardEntry]) {
        guard !entries.isEmpty else { return }
        Task.detached(priority: .utility) {
            do {
                let data = try JSONEncoder().encode(entries)
                try data.write(to: cacheURL, options: .atomic)
            } catch {
                // Cache write failed — not critical
            }
        }
    }

    static func load() -> [P2PLeaderboardEntry] {
        guard let data = try? Data(contentsOf: cacheURL),
              let entries = try? JSONDecoder().decode([P2PLeaderboardEntry].self, from: data) else {
            return []
        }
        return entries
    }
}
