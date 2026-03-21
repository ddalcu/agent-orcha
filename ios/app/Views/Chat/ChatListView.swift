import SwiftUI

struct ChatListView: View {
    @Bindable var viewModel: ChatListViewModel
    let service: BareP2PService
    @State private var chatSessions: [ChatTarget: ChatViewModel] = [:]

    var body: some View {
        NavigationStack {
            Group {
                switch viewModel.connectionState {
                case .idle:
                    disconnectedView
                case .starting, .connecting:
                    connectingView
                case .reconnecting:
                    if viewModel.isEmpty {
                        reconnectingView
                    } else {
                        listContent
                    }
                case .connected:
                    if viewModel.isEmpty {
                        emptyView
                    } else {
                        listContent
                    }
                }
            }
            .background(AppTheme.background)
            .navigationTitle("Chat")
            .searchable(text: $viewModel.searchText, prompt: "Search agents & LLMs")
        }
    }

    // MARK: - List Content

    private var listContent: some View {
        List {
            if !viewModel.filteredAgents.isEmpty {
                Section {
                    ForEach(viewModel.filteredAgents) { agent in
                        NavigationLink(value: ChatTarget.agent(agent)) {
                            AgentRow(agent: agent)
                        }
                        .listRowBackground(AppTheme.surface)
                    }
                } header: {
                    SectionHeader(title: "Agents", count: viewModel.filteredAgents.count)
                }
            }

            if !viewModel.filteredLLMs.isEmpty {
                Section {
                    ForEach(viewModel.filteredLLMs) { llm in
                        NavigationLink(value: ChatTarget.llm(llm)) {
                            LLMRow(llm: llm)
                        }
                        .listRowBackground(AppTheme.surface)
                    }
                } header: {
                    SectionHeader(title: "LLMs", count: viewModel.filteredLLMs.count)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .navigationDestination(for: ChatTarget.self) { target in
            ChatView(viewModel: chatViewModel(for: target), onReset: {
                chatSessions.removeValue(forKey: target)
            })
        }
    }

    // MARK: - Empty States

    private var connectingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .controlSize(.large)
                .tint(AppTheme.accent)
            Text("Connecting to P2P network...")
                .font(.subheadline)
                .foregroundStyle(AppTheme.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func chatViewModel(for target: ChatTarget) -> ChatViewModel {
        if let existing = chatSessions[target] { return existing }
        let vm = ChatViewModel(target: target, service: service)
        chatSessions[target] = vm
        return vm
    }

    private var reconnectingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .controlSize(.large)
                .tint(AppTheme.accent.opacity(0.6))
            Text("Reconnecting...")
                .font(.subheadline)
                .foregroundStyle(AppTheme.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var disconnectedView: some View {
        ContentUnavailableView {
            Label("Not Connected", systemImage: "wifi.slash")
        } description: {
            Text("Connect to a P2P network in Settings to discover agents and LLMs.")
        }
    }

    private var emptyView: some View {
        ContentUnavailableView {
            Label("No Agents or LLMs", systemImage: "magnifyingglass")
        } description: {
            Text("Connected to \(viewModel.peerCount) peer(s), but none are sharing agents or LLMs.")
        }
    }
}

// MARK: - Row Views

private struct AgentRow: View {
    let agent: RemoteAgent

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: "cpu")
                    .foregroundStyle(AppTheme.accent)
                    .font(.caption)
                Text(agent.name)
                    .font(.headline)
                    .foregroundStyle(AppTheme.textPrimary)
                Spacer()
                PeerBadge(name: agent.peerName)
            }
            Text(agent.description)
                .font(.subheadline)
                .foregroundStyle(AppTheme.textSecondary)
                .lineLimit(2)
        }
        .padding(.vertical, 4)
    }
}

private struct LLMRow: View {
    let llm: RemoteLLM

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: "brain")
                    .foregroundStyle(AppTheme.accent)
                    .font(.caption)
                Text(llm.name)
                    .font(.headline)
                    .foregroundStyle(AppTheme.textPrimary)
                Spacer()
                PeerBadge(name: llm.peerName)
            }
            Text("\(llm.provider) / \(llm.model)")
                .font(.subheadline)
                .foregroundStyle(AppTheme.textSecondary)
        }
        .padding(.vertical, 4)
    }
}

private struct PeerBadge: View {
    let name: String

    var body: some View {
        Text(name)
            .font(.caption2)
            .foregroundStyle(AppTheme.accent)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(AppTheme.accent.opacity(0.15))
            .clipShape(Capsule())
    }
}

private struct SectionHeader: View {
    let title: String
    let count: Int

    var body: some View {
        HStack {
            Text(title)
            Spacer()
            Text("\(count)")
                .foregroundStyle(AppTheme.textSecondary)
        }
    }
}
