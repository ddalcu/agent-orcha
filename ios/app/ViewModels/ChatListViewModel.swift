import Foundation

@Observable
@MainActor
final class ChatListViewModel {
    private let service: BareP2PService

    var remoteAgents: [RemoteAgent] { service.remoteAgents }
    var remoteLLMs: [RemoteLLM] { service.remoteLLMs }
    var connectionState: P2PConnectionState { service.connectionState }
    var isConnected: Bool { service.isConnected }
    var peerCount: Int { service.peerCount }

    var searchText: String = ""

    var filteredAgents: [RemoteAgent] {
        if searchText.isEmpty { return remoteAgents }
        let query = searchText.lowercased()
        return remoteAgents.filter {
            $0.name.lowercased().contains(query) ||
            $0.description.lowercased().contains(query) ||
            $0.peerName.lowercased().contains(query)
        }
    }

    var filteredLLMs: [RemoteLLM] {
        if searchText.isEmpty { return remoteLLMs }
        let query = searchText.lowercased()
        return remoteLLMs.filter {
            $0.name.lowercased().contains(query) ||
            $0.model.lowercased().contains(query) ||
            $0.provider.lowercased().contains(query) ||
            $0.peerName.lowercased().contains(query)
        }
    }

    var isEmpty: Bool {
        filteredAgents.isEmpty && filteredLLMs.isEmpty
    }

    init(service: BareP2PService) {
        self.service = service
    }
}
