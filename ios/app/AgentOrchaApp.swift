import SwiftUI
import os.log

private let logger = Logger(subsystem: "com.agentorcha.ios", category: "App")

@main
struct AgentOrchaApp: App {
    @State private var service = BareP2PService()
    @State private var llmService = LocalLLMService()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        logger.info("🚀 AgentOrcha starting up")
        logger.info("Device RAM: \(ProcessInfo.processInfo.physicalMemory / (1024*1024*1024)) GB")
        logger.info("Active model: \(LocalModelInfo.forDevice.displayName)")
    }

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
