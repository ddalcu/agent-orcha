import SwiftUI

/// Full-screen privacy consent that must be accepted before the app
/// connects to the P2P network or sends any data to remote AI services.
/// Required by App Store guidelines 5.1.1(i) and 5.1.2(i).
struct PrivacyConsentView: View {
    let onAccept: () -> Void

    @State private var hasScrolledToBottom = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header
                    dataCollectionSection
                    dataUsageSection
                    thirdPartySection
                    userControlSection
                    importantNotice
                }
                .padding(24)
                .onAppear {
                    // Allow accept immediately — the full disclosure is visible
                    hasScrolledToBottom = true
                }
            }

            Divider().overlay(AppTheme.border)

            acceptSection
        }
        .background(AppTheme.background)
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: "hand.raised.fill")
                .font(.system(size: 44))
                .foregroundStyle(AppTheme.accent)

            Text("Data & Privacy")
                .font(.largeTitle)
                .fontWeight(.bold)
                .foregroundStyle(AppTheme.textPrimary)

            Text("Agent Orcha uses a peer-to-peer network to connect you with AI agents and language models hosted by other users. Before you can use this feature, please review how your data is handled.")
                .font(.body)
                .foregroundStyle(AppTheme.textSecondary)
        }
    }

    // MARK: - Data Collection

    private var dataCollectionSection: some View {
        disclosureSection(
            icon: "doc.text.magnifyingglass",
            title: "What Data Is Shared",
            items: [
                "Messages you type in chat are sent to the peer hosting the AI agent or model you are chatting with.",
                "File attachments (images, documents, audio) you send in chat are transmitted to the remote peer for processing.",
                "Your chosen peer name (display name) is visible to all peers on the same network.",
                "Basic connection metadata (network key, connection timestamps) is used to establish peer-to-peer connections."
            ]
        )
    }

    // MARK: - Data Usage

    private var dataUsageSection: some View {
        disclosureSection(
            icon: "gearshape.2",
            title: "How Your Data Is Used",
            items: [
                "Your messages and attachments are processed by AI models running on the remote peer's device to generate responses.",
                "Token usage statistics (counts of input/output tokens) are tracked anonymously for the network leaderboard — no message content is stored for this purpose.",
                "Your peer name is broadcast on the network so other users can identify your device.",
                "On-device local LLM processing stays entirely on your device and is never sent to any third party."
            ]
        )
    }

    // MARK: - Third Party

    private var thirdPartySection: some View {
        disclosureSection(
            icon: "person.2.circle",
            title: "Who Receives Your Data",
            items: [
                "Your data is sent directly to other users (peers) on the same P2P network — there is no central server.",
                "Each peer runs their own AI models. The peer's device processes your messages locally using their configured AI provider (which may include third-party AI services such as OpenAI, Anthropic, Google, or locally hosted models).",
                "You choose which peers to interact with. Data is only sent when you actively start a chat and send a message.",
                "Agent Orcha (the app developer) does not collect, store, or have access to your messages or attachments."
            ]
        )
    }

    // MARK: - User Control

    private var userControlSection: some View {
        disclosureSection(
            icon: "slider.horizontal.3",
            title: "Your Controls",
            items: [
                "You can disconnect from the P2P network at any time in Settings to stop all data sharing.",
                "You can use a private network key so only trusted peers can connect.",
                "You can use the Local LLM feature for fully on-device, private AI chat with no network activity.",
                "You can revoke this consent at any time in Settings > Privacy, which will disconnect you from the network."
            ]
        )
    }

    // MARK: - Important Notice

    private var importantNotice: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Important", systemImage: "exclamationmark.triangle.fill")
                .font(.subheadline)
                .fontWeight(.semibold)
                .foregroundStyle(AppTheme.warning)

            Text("Because this is a decentralized peer-to-peer network, Agent Orcha cannot guarantee how remote peers handle your data after receiving it. Only connect to networks and peers you trust. Do not send sensitive personal information, passwords, or confidential data through the chat.")
                .font(.caption)
                .foregroundStyle(AppTheme.textSecondary)
        }
        .padding(12)
        .background(AppTheme.warning.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Accept Section

    private var acceptSection: some View {
        VStack(spacing: 12) {
            Button {
                onAccept()
            } label: {
                Text("I Understand & Agree")
                    .font(.headline)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(AppTheme.accent)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }

            Text("You can change your mind at any time in Settings > Privacy.")
                .font(.caption2)
                .foregroundStyle(AppTheme.textSecondary)
                .multilineTextAlignment(.center)
        }
        .padding(20)
        .background(AppTheme.surfaceElevated)
    }

    // MARK: - Helpers

    private func disclosureSection(icon: String, title: String, items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: icon)
                .font(.headline)
                .foregroundStyle(AppTheme.textPrimary)

            VStack(alignment: .leading, spacing: 8) {
                ForEach(items, id: \.self) { item in
                    HStack(alignment: .top, spacing: 8) {
                        Circle()
                            .fill(AppTheme.accent)
                            .frame(width: 5, height: 5)
                            .padding(.top, 6)
                        Text(item)
                            .font(.subheadline)
                            .foregroundStyle(AppTheme.textSecondary)
                    }
                }
            }
        }
        .padding(14)
        .background(AppTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
