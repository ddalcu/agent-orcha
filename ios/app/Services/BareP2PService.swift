import Foundation
import UIKit
import BareKit

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

    /// Peers that recently disconnected — kept for a grace period so chat sessions survive brief drops
    private var recentlyLostPeers: [String: PeerInfo] = [:]
    private var peerGraceTimers: [String: Task<Void, Never>] = [:]
    private let peerGracePeriod: TimeInterval = 30 // seconds before truly removing a peer

    /// Whether we had a successful connection at least once (for reconnect logic)
    private var hasConnectedBefore = false
    private var lastNetworkKey: String?
    private var lastPeerName: String?
    private var reconnectTask: Task<Void, Never>?

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
            peer.llms.map { llm in
                RemoteLLM(
                    name: llm.name,
                    provider: llm.provider,
                    model: llm.model,
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

    private func startIPCReader(_ ipc: IPC) {
        readerTask = Task { [weak self] in
            do {
                for try await data in ipc {
                    guard let self else { return }
                    let events = IPCEventParser.parse(data)
                    for event in events {
                        self.handleEvent(event)
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
                // Don't wipe peers — enter reconnecting state
                connectionState = .reconnecting
                scheduleReconnect()
            } else {
                connectionState = .idle
                peers.removeAll()
                clearAllGracePeers()
                streamManager.abortAllStreams(error: "Disconnected from P2P network")
            }

        case .peerJoined(let peer):
            // Cancel grace timer if this peer was recently lost
            if let timer = peerGraceTimers.removeValue(forKey: peer.peerId) {
                timer.cancel()
                recentlyLostPeers.removeValue(forKey: peer.peerId)
            }
            // Update or add
            if let index = peers.firstIndex(where: { $0.peerId == peer.peerId }) {
                peers[index] = peer
            } else {
                peers.append(peer)
            }

        case .peerLeft(let peerId):
            if let index = peers.firstIndex(where: { $0.peerId == peerId }) {
                let peer = peers.remove(at: index)
                // Move to grace period instead of immediate removal
                startPeerGracePeriod(peer)
            }

        case .catalogUpdate(let peerId, let agents, let llms):
            if let index = peers.firstIndex(where: { $0.peerId == peerId }) {
                peers[index].agents = agents
                peers[index].llms = llms
            }
            // Also update grace peer if present
            if var gracePeer = recentlyLostPeers[peerId] {
                gracePeer.agents = agents
                gracePeer.llms = llms
                recentlyLostPeers[peerId] = gracePeer
            }

        case .streamChunk(let requestId, let chunk):
            streamManager.yieldAgentChunk(requestId: requestId, chunk: chunk)

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

        case .error(let message):
            lastError = message
        }
    }

    // MARK: - Peer Grace Period

    /// Keep a recently-disconnected peer around for a grace period so
    /// active chat sessions don't lose their navigation target.
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
            // Exponential backoff: 2s, 4s, 8s, 16s, max 30s
            var delay: TimeInterval = 2
            let maxDelay: TimeInterval = 30

            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(delay))
                guard let self, !Task.isCancelled else { return }

                if self.connectionState == .reconnecting,
                   let key = self.lastNetworkKey, let name = self.lastPeerName {
                    self.sendCommand(.connect(networkKey: key, peerName: name))
                } else {
                    return // Connected or user disconnected
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

    func invokeAgent(peerId: String, agentName: String, input: [String: String], sessionId: String) -> AsyncThrowingStream<String, Error> {
        let requestId = generateRequestId()
        let stream = streamManager.createAgentStream(requestId: requestId)
        sendCommand(.invokeAgent(
            requestId: requestId,
            peerId: peerId,
            agentName: agentName,
            input: input,
            sessionId: sessionId
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
