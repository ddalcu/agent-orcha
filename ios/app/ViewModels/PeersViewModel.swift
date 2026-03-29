import Foundation

@Observable
@MainActor
final class PeersViewModel {
    private let service: BareP2PService

    var peers: [PeerInfo] { service.allAvailablePeers }
    var connectionState: P2PConnectionState { service.connectionState }
    var isConnected: Bool { service.isConnected }
    var leaderboardEntries: [P2PLeaderboardEntry] { service.leaderboardEntries }

    var selectedTab: NetworkTab = .peers

    enum NetworkTab: String, CaseIterable {
        case peers = "Peers"
        case leaderboard = "Leaderboard"
    }

    private var refreshTask: Task<Void, Never>?

    init(service: BareP2PService) {
        self.service = service
    }

    func refreshLeaderboard() {
        service.requestLeaderboard()
    }

    /// Start auto-refreshing leaderboard every 10 seconds while visible
    func startAutoRefresh() {
        stopAutoRefresh()
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if self.selectedTab == .leaderboard && self.isConnected {
                    self.service.requestLeaderboard()
                }
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    func stopAutoRefresh() {
        refreshTask?.cancel()
        refreshTask = nil
    }

    func formattedConnectedAt(_ timestamp: Double) -> String {
        let date = Date(timeIntervalSince1970: timestamp / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    /// Format token count for display: 1234 → "1.2K", 1234567 → "1.2M"
    static func formatTokenCount(_ count: Int) -> String {
        if count >= 1_000_000 {
            return String(format: "%.1fM", Double(count) / 1_000_000)
        } else if count >= 1_000 {
            return String(format: "%.1fK", Double(count) / 1_000)
        }
        return "\(count)"
    }
}
