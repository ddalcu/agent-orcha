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
                    if viewModel.peers.isEmpty {
                        noPeersView
                    } else {
                        peerList
                    }
                }
            }
            .background(AppTheme.background)
            .navigationTitle("Peers")
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
                Text(formattedTime)
                    .font(.caption2)
                    .foregroundStyle(AppTheme.textSecondary)
            }

            HStack(spacing: 12) {
                Label("\(peer.agents.count) agent\(peer.agents.count == 1 ? "" : "s")", systemImage: "cpu")
                    .font(.caption)
                    .foregroundStyle(AppTheme.textSecondary)

                Label("\(peer.llms.count) LLM\(peer.llms.count == 1 ? "" : "s")", systemImage: "brain")
                    .font(.caption)
                    .foregroundStyle(AppTheme.textSecondary)
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
