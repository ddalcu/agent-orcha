import SwiftUI

struct ContentView: View {
    let service: BareP2PService
    let llmService: LocalLLMService

    @State private var selectedTab = 0

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
                    Label("Peers", systemImage: "network")
                }
                .tag(2)

            SettingsView(viewModel: SettingsViewModel(service: service))
                .tabItem {
                    Label("Settings", systemImage: "gear")
                }
                .tag(3)
        }
        .tint(AppTheme.accent)
    }
}
