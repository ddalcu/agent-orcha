import SwiftUI

struct ContentView: View {
    let service: BareP2PService
    let llmService: LocalLLMService

    @State private var selectedTab = 0
    @State private var showPrivacyConsent = !PrivacyConsentManager.shared.hasConsented

    var body: some View {
        TabView(selection: $selectedTab) {
            ChatListView(viewModel: ChatListViewModel(service: service), service: service)
                .tabItem {
                    Label("Chat", systemImage: "bubble.left.and.bubble.right")
                }
                .tag(0)

            LocalLLMView(viewModel: LocalLLMViewModel(service: llmService))
                .tabItem {
                    Label("Local LLM", systemImage: "brain.head.profile")
                }
                .tag(1)

            PeersView(viewModel: PeersViewModel(service: service))
                .tabItem {
                    Label("Network", systemImage: "antenna.radiowaves.left.and.right")
                }
                .tag(2)

            SettingsView(viewModel: SettingsViewModel(service: service))
                .tabItem {
                    Label("Settings", systemImage: "gear")
                }
                .tag(3)
        }
        .tint(AppTheme.accent)
        .fullScreenCover(isPresented: $showPrivacyConsent) {
            PrivacyConsentView {
                PrivacyConsentManager.shared.grantConsent()
                showPrivacyConsent = false
                // Now that consent is granted, trigger P2P auto-connect
                let defaults = UserDefaults.standard
                let useCustom = defaults.bool(forKey: "p2p_use_custom_network")
                let networkKey = useCustom
                    ? (defaults.string(forKey: "p2p_custom_network_key") ?? "agent-orcha-default")
                    : "agent-orcha-default"
                let peerName = defaults.string(forKey: "p2p_peer_name") ?? UIDevice.current.name
                if !networkKey.isEmpty {
                    service.connect(networkKey: networkKey, peerName: peerName)
                }
            }
        }
    }
}
