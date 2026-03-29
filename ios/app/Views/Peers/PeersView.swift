import SwiftUI

struct PeersView: View {
    @Bindable var viewModel: PeersViewModel

    var body: some View {
        NavigationStack {
            Group {
                switch viewModel.connectionState {
                case .idle:
                    disconnectedView
                case .starting, .connecting:
                    connectingView
                case .connected, .reconnecting:
                    connectedContent
                }
            }
            .background(AppTheme.background)
            .navigationTitle("Network")
        }
        .onAppear { viewModel.startAutoRefresh() }
        .onDisappear { viewModel.stopAutoRefresh() }
    }

    private var connectedContent: some View {
        VStack(spacing: 0) {
            // Segmented picker
            Picker("Tab", selection: $viewModel.selectedTab) {
                ForEach(PeersViewModel.NetworkTab.allCases, id: \.self) { tab in
                    Text(tab.rawValue).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 8)

            switch viewModel.selectedTab {
            case .peers:
                peersContent
            case .leaderboard:
                leaderboardContent
            }
        }
    }

    // MARK: - Peers Tab

    private var peersContent: some View {
        Group {
            if viewModel.peers.isEmpty {
                noPeersView
            } else {
                peerList
            }
        }
    }

    private var peerList: some View {
        List {
            ForEach(viewModel.peers) { peer in
                PeerRow(peer: peer, formattedTime: viewModel.formattedConnectedAt(peer.connectedAt))
                    .listRowBackground(AppTheme.surface)
            }
        }
        .scrollContentBackground(.hidden)
    }

    // MARK: - Leaderboard Tab

    private var leaderboardContent: some View {
        Group {
            if viewModel.leaderboardEntries.isEmpty {
                ContentUnavailableView {
                    Label("No Data", systemImage: "trophy")
                } description: {
                    Text("Leaderboard data will appear as peers share models and agents.")
                }
            } else {
                leaderboardList
            }
        }
    }

    private var leaderboardList: some View {
        List {
            ForEach(Array(viewModel.leaderboardEntries.enumerated()), id: \.element.peerId) { index, entry in
                LeaderboardRow(entry: entry, rank: index + 1)
                    .listRowBackground(entry.isSelf ? AppTheme.accent.opacity(0.08) : AppTheme.surface)
            }
        }
        .scrollContentBackground(.hidden)
        .refreshable {
            viewModel.refreshLeaderboard()
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

    private var disconnectedView: some View {
        ContentUnavailableView {
            Label("Not Connected", systemImage: "wifi.slash")
        } description: {
            Text("Connect to a P2P network in Settings.")
        }
    }

    private var noPeersView: some View {
        ContentUnavailableView {
            Label("No Peers", systemImage: "person.2.slash")
        } description: {
            Text("Connected to the network, waiting for peers to join...")
        }
    }
}

// MARK: - Peer Row

private struct PeerRow: View {
    let peer: PeerInfo
    let formattedTime: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "desktopcomputer")
                    .foregroundStyle(AppTheme.success)
                Text(peer.peerName)
                    .font(.headline)
                    .foregroundStyle(AppTheme.textPrimary)
                Spacer()
                LoadIndicator(load: peer.load)
                Text(formattedTime)
                    .font(.caption2)
                    .foregroundStyle(AppTheme.textSecondary)
            }

            HStack(spacing: 12) {
                Label("\(peer.agents.count) agent\(peer.agents.count == 1 ? "" : "s")", systemImage: "cpu")
                    .font(.caption)
                    .foregroundStyle(AppTheme.textSecondary)

                let chatModels = peer.models.filter { $0.type == "chat" }
                Label("\(chatModels.count) model\(chatModels.count == 1 ? "" : "s")", systemImage: "brain")
                    .font(.caption)
                    .foregroundStyle(AppTheme.textSecondary)

                let mediaModels = peer.models.filter { $0.type != "chat" }
                if !mediaModels.isEmpty {
                    Label("\(mediaModels.count) media", systemImage: "wand.and.stars")
                        .font(.caption)
                        .foregroundStyle(AppTheme.textSecondary)
                }
            }

            // Token stats
            if let stats = peer.stats, (stats.si + stats.so) > 0 {
                HStack(spacing: 8) {
                    Label("Served \(PeersViewModel.formatTokenCount(stats.si + stats.so))", systemImage: "arrow.up.circle")
                        .font(.caption2)
                        .foregroundStyle(AppTheme.success.opacity(0.8))
                    Label("Used \(PeersViewModel.formatTokenCount(stats.ci + stats.co))", systemImage: "arrow.down.circle")
                        .font(.caption2)
                        .foregroundStyle(AppTheme.accent.opacity(0.8))
                }
            }

            // Agent names
            if !peer.agents.isEmpty {
                FlowLayout(spacing: 4) {
                    ForEach(peer.agents) { agent in
                        Text(agent.name)
                            .font(.caption2)
                            .foregroundStyle(AppTheme.accent)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(AppTheme.accent.opacity(0.12))
                            .clipShape(Capsule())
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Load Indicator

private struct LoadIndicator: View {
    let load: Int

    var body: some View {
        Circle()
            .fill(loadColor)
            .frame(width: 8, height: 8)
    }

    private var loadColor: Color {
        if load == 0 { return AppTheme.success }
        if load <= 3 { return AppTheme.warning }
        return AppTheme.error
    }
}

// MARK: - Leaderboard Row

private struct LeaderboardRow: View {
    let entry: P2PLeaderboardEntry
    let rank: Int

    var body: some View {
        HStack(spacing: 12) {
            // Rank
            ZStack {
                if rank <= 3 {
                    Image(systemName: "crown.fill")
                        .font(.caption)
                        .foregroundStyle(rankColor)
                }
                Text("\(rank)")
                    .font(.headline)
                    .foregroundStyle(rank <= 3 ? rankColor : AppTheme.textSecondary)
                    .offset(y: rank <= 3 ? 12 : 0)
            }
            .frame(width: 30)

            // Peer info
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(entry.peerName)
                        .font(.headline)
                        .foregroundStyle(AppTheme.textPrimary)
                    if entry.isSelf {
                        Text("You")
                            .font(.caption2)
                            .foregroundStyle(AppTheme.accent)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(AppTheme.accent.opacity(0.15))
                            .clipShape(Capsule())
                    }
                    Spacer()
                    Circle()
                        .fill(entry.online ? AppTheme.success : AppTheme.textSecondary.opacity(0.3))
                        .frame(width: 8, height: 8)
                }

                HStack(spacing: 16) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Served")
                            .font(.caption2)
                            .foregroundStyle(AppTheme.textSecondary.opacity(0.7))
                        HStack(spacing: 4) {
                            Text(PeersViewModel.formatTokenCount(entry.servedTotalTokens))
                                .font(.subheadline)
                                .fontWeight(.medium)
                                .foregroundStyle(AppTheme.success)
                            Text("(\(entry.servedRequests) req)")
                                .font(.caption2)
                                .foregroundStyle(AppTheme.textSecondary)
                        }
                    }

                    VStack(alignment: .leading, spacing: 1) {
                        Text("Consumed")
                            .font(.caption2)
                            .foregroundStyle(AppTheme.textSecondary.opacity(0.7))
                        HStack(spacing: 4) {
                            Text(PeersViewModel.formatTokenCount(entry.consumedTotalTokens))
                                .font(.subheadline)
                                .fontWeight(.medium)
                                .foregroundStyle(AppTheme.accent)
                            Text("(\(entry.consumedRequests) req)")
                                .font(.caption2)
                                .foregroundStyle(AppTheme.textSecondary)
                        }
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var rankColor: Color {
        switch rank {
        case 1: return AppTheme.rankGold
        case 2: return AppTheme.rankSilver
        case 3: return AppTheme.rankBronze
        default: return AppTheme.textSecondary
        }
    }
}

// MARK: - Simple Flow Layout

private struct FlowLayout: Layout {
    var spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = arrangeSubviews(proposal: proposal, subviews: subviews)
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrangeSubviews(proposal: proposal, subviews: subviews)
        for (index, position) in result.positions.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + position.x, y: bounds.minY + position.y), proposal: .unspecified)
        }
    }

    private func arrangeSubviews(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, positions: [CGPoint]) {
        let maxWidth = proposal.width ?? .infinity
        var positions: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var totalHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > maxWidth, x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            positions.append(CGPoint(x: x, y: y))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
            totalHeight = y + rowHeight
        }

        return (CGSize(width: maxWidth, height: totalHeight), positions)
    }
}
