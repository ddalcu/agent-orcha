import Foundation
import SwiftUI

@Observable
@MainActor
final class SettingsViewModel {
    var peerName: String = UIDevice.current.name {
        didSet {
            saveSettings()
            reconnectIfNeeded()
        }
    }
    var networkKey: String = "agent-orcha-default"
    var useCustomNetwork: Bool = false {
        didSet {
            saveSettings()
            reconnectIfNeeded()
        }
    }
    var customNetworkKey: String = "" {
        didSet {
            saveSettings()
            reconnectIfNeeded()
        }
    }

    private let service: BareP2PService
    private var isLoadingSettings = false
    nonisolated(unsafe) private var reconnectTask: Task<Void, Never>?

    var connectionState: P2PConnectionState { service.connectionState }
    var isConnected: Bool { service.isConnected }
    var peerCount: Int { service.peerCount }
    var lastError: String? { service.lastError }

    var activeNetworkKey: String {
        useCustomNetwork ? customNetworkKey : "agent-orcha-default"
    }

    init(service: BareP2PService) {
        self.service = service
        loadSettings()
    }

    func connect() {
        let key = activeNetworkKey
        guard !key.isEmpty else { return }
        service.connect(networkKey: key, peerName: peerName)
        saveSettings()
    }

    func disconnect() {
        service.disconnect()
    }

    func toggleConnection() {
        if isConnected {
            disconnect()
        } else {
            connect()
        }
    }

    // MARK: - Private

    private func reconnectIfNeeded() {
        guard !isLoadingSettings, isConnected || connectionState == .reconnecting else { return }
        reconnectTask?.cancel()
        reconnectTask = Task {
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            let key = activeNetworkKey
            guard !key.isEmpty else { return }
            service.disconnect()
            service.connect(networkKey: key, peerName: peerName)
        }
    }

    // MARK: - Persistence

    private func loadSettings() {
        isLoadingSettings = true
        let defaults = UserDefaults.standard
        if let savedName = defaults.string(forKey: "p2p_peer_name") {
            peerName = savedName
        }
        if let savedKey = defaults.string(forKey: "p2p_custom_network_key") {
            customNetworkKey = savedKey
        }
        useCustomNetwork = defaults.bool(forKey: "p2p_use_custom_network")
        isLoadingSettings = false
    }

    private func saveSettings() {
        guard !isLoadingSettings else { return }
        let defaults = UserDefaults.standard
        defaults.set(peerName, forKey: "p2p_peer_name")
        defaults.set(customNetworkKey, forKey: "p2p_custom_network_key")
        defaults.set(useCustomNetwork, forKey: "p2p_use_custom_network")
    }
}
