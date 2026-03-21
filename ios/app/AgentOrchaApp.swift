import SwiftUI

@main
struct AgentOrchaApp: App {
    @State private var service = BareP2PService()
    @State private var llmService = LocalLLMService()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView(service: service, llmService: llmService)
                .preferredColorScheme(.dark)
        }
        .onChange(of: scenePhase) { _, newPhase in
            switch newPhase {
            case .background:
                service.suspend()
            case .active:
                service.resume()
            default:
                break
            }
        }
    }
}
