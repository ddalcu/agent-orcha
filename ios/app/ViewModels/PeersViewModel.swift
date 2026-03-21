import Foundation

@Observable
@MainActor
final class PeersViewModel {
    private let service: BareP2PService

    var peers: [PeerInfo] { service.allAvailablePeers }
    var connectionState: P2PConnectionState { service.connectionState }
    var isConnected: Bool { service.isConnected }

    init(service: BareP2PService) {
        self.service = service
    }

    func formattedConnectedAt(_ timestamp: Double) -> String {
        let date = Date(timeIntervalSince1970: timestamp / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
