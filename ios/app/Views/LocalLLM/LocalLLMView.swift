import SwiftUI

struct LocalLLMView: View {
    @Bindable var viewModel: LocalLLMViewModel

    @State private var showingChat = false

    var body: some View {
        NavigationStack {
            setupContent
                .background(AppTheme.background)
                .navigationTitle("Local LLM")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .principal) {
                        VStack(spacing: 0) {
                            Text("Local LLM")
                                .font(.headline)
                                .foregroundStyle(AppTheme.textPrimary)
                            Text(viewModel.service.activeModel.displayName)
                                .font(.caption2)
                                .foregroundStyle(AppTheme.textSecondary)
                        }
                    }
                }
                .navigationDestination(isPresented: $showingChat) {
                    LocalLLMChatView(viewModel: viewModel)
                }
        }
    }

    // MARK: - Setup Content

    private var setupContent: some View {
        VStack(spacing: 20) {
            Spacer()

            Image(systemName: "brain.head.profile")
                .font(.system(size: 56))
                .foregroundStyle(AppTheme.accent.opacity(0.5))

            Text(viewModel.service.activeModel.displayName)
                .font(.title3)
                .fontWeight(.semibold)
                .foregroundStyle(AppTheme.textPrimary)

            Text(viewModel.service.activeModel.sizeDescription)
                .font(.subheadline)
                .foregroundStyle(AppTheme.textSecondary)

            Text("Run AI models directly on your device. No internet required after download.")
                .font(.subheadline)
                .foregroundStyle(AppTheme.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)

            Text("Responses are AI-generated and may be inaccurate.")
                .font(.caption)
                .foregroundStyle(AppTheme.textSecondary.opacity(0.7))

            stateView

            Spacer()
        }
        .padding()
    }

    @ViewBuilder
    private var stateView: some View {
        switch viewModel.service.state {
        case .notDownloaded:
            VStack(spacing: 10) {
                Button {
                    Task { await viewModel.service.downloadModel() }
                } label: {
                    Label("Download Model", systemImage: "arrow.down.circle.fill")
                        .font(.headline)
                        .foregroundStyle(.white)
                        .frame(maxWidth: 280)
                        .padding(.vertical, 14)
                        .background(AppTheme.accent)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                Label("Wi-Fi recommended", systemImage: "wifi")
                    .font(.caption)
                    .foregroundStyle(AppTheme.textSecondary.opacity(0.7))
            }

        case .downloading(let progress, let downloadedBytes, let totalBytes):
            DownloadProgressView(
                progress: progress,
                downloadedBytes: downloadedBytes,
                totalBytes: totalBytes,
                speed: viewModel.service.downloadSpeed
            )

        case .downloaded:
            VStack(spacing: 10) {
                ProgressView()
                    .tint(AppTheme.accent)
                Text("Preparing to load...")
                    .font(.caption)
                    .foregroundStyle(AppTheme.textSecondary)
            }

        case .loading(let progress):
            VStack(spacing: 12) {
                ZStack {
                    Circle()
                        .stroke(AppTheme.surface, lineWidth: 6)
                        .frame(width: 80, height: 80)
                    Circle()
                        .trim(from: 0, to: max(progress, 0.02))
                        .stroke(AppTheme.success, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                        .frame(width: 80, height: 80)
                        .rotationEffect(.degrees(-90))
                        .animation(.linear(duration: 0.3), value: progress)

                    if progress > 0.01 {
                        Text("\(Int(progress * 100))%")
                            .font(.title3)
                            .fontWeight(.bold)
                            .foregroundStyle(AppTheme.textPrimary)
                            .monospacedDigit()
                    } else {
                        ProgressView()
                            .tint(AppTheme.success)
                    }
                }

                Text("Loading model into memory...")
                    .font(.caption)
                    .foregroundStyle(AppTheme.textSecondary)

                ProgressView(value: progress)
                    .tint(AppTheme.success)
                    .frame(maxWidth: 280)
            }

        case .ready:
            Button {
                showingChat = true
            } label: {
                Label("Start Chat", systemImage: "bubble.left.fill")
                    .font(.headline)
                    .foregroundStyle(.white)
                    .frame(maxWidth: 280)
                    .padding(.vertical, 14)
                    .background(AppTheme.accent)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }

        case .error(let message):
            VStack(spacing: 12) {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(AppTheme.error)
                    Text("Error")
                        .fontWeight(.semibold)
                        .foregroundStyle(AppTheme.error)
                }
                .font(.subheadline)

                Text(message)
                    .font(.caption)
                    .foregroundStyle(AppTheme.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 40)

                if !message.contains("simulator") && !message.contains("physical device") && !message.contains("not supported") {
                    Button {
                        Task { await viewModel.service.downloadModel() }
                    } label: {
                        Text("Retry")
                            .font(.subheadline)
                            .foregroundStyle(AppTheme.accent)
                            .padding(.horizontal, 24)
                            .padding(.vertical, 8)
                            .background(AppTheme.accent.opacity(0.15))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                }
            }
        }
    }
}

// MARK: - Chat View

private struct LocalLLMChatView: View {
    @Bindable var viewModel: LocalLLMViewModel

    @State private var inputText = ""
    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            messageList
            if viewModel.isStreaming {
                streamingBar
            }
            inputBar
        }
        .background(AppTheme.background)
        .navigationTitle(viewModel.service.activeModel.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if !viewModel.messages.isEmpty {
                    Button {
                        viewModel.reset()
                    } label: {
                        Image(systemName: "arrow.counterclockwise")
                            .font(.subheadline)
                            .foregroundStyle(AppTheme.textSecondary)
                    }
                    .disabled(viewModel.isStreaming)
                }
            }
        }
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    if viewModel.messages.isEmpty {
                        welcomeMessage
                    }
                    ForEach(viewModel.messages) { message in
                        MessageBubble(message: message)
                            .id(message.id)
                    }
                }
                .padding()
            }
            .onChange(of: viewModel.messages.last?.content) {
                if let last = viewModel.messages.last {
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }

    private var welcomeMessage: some View {
        VStack(spacing: 12) {
            Image(systemName: "brain.head.profile")
                .font(.system(size: 40))
                .foregroundStyle(AppTheme.accent.opacity(0.5))

            Text("On-device AI — your conversations stay private.")
                .font(.subheadline)
                .foregroundStyle(AppTheme.textSecondary)
                .multilineTextAlignment(.center)

            Text("Responses are AI-generated and may be inaccurate.")
                .font(.caption)
                .foregroundStyle(AppTheme.textSecondary.opacity(0.7))
        }
        .padding(.vertical, 40)
    }

    private var streamingBar: some View {
        HStack(spacing: 8) {
            ProgressView()
                .tint(AppTheme.accent)
                .scaleEffect(0.8)

            Text(String(format: "%.1fs", viewModel.elapsedTime))
                .font(.caption)
                .foregroundStyle(AppTheme.textSecondary)
                .monospacedDigit()

            Spacer()

            Button("Stop") {
                viewModel.cancelStream()
            }
            .font(.caption)
            .foregroundStyle(AppTheme.error)
        }
        .padding(.horizontal)
        .padding(.vertical, 6)
        .background(AppTheme.surfaceElevated)
    }

    private var inputBar: some View {
        HStack(spacing: 10) {
            TextField("Message...", text: $inputText, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.plain)
                .padding(10)
                .background(AppTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .foregroundStyle(AppTheme.textPrimary)
                .focused($inputFocused)

            Button {
                let text = inputText
                inputText = ""
                viewModel.send(text)
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
                    .foregroundStyle(canSend ? AppTheme.accent : AppTheme.textSecondary.opacity(0.5))
            }
            .disabled(!canSend)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(AppTheme.surfaceElevated)
    }

    private var canSend: Bool {
        !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !viewModel.isStreaming
    }
}

// MARK: - Download Progress

private struct DownloadProgressView: View {
    let progress: Double
    let downloadedBytes: Int64
    let totalBytes: Int64
    let speed: Double

    var body: some View {
        VStack(spacing: 12) {
            // Circular progress with percentage
            ZStack {
                Circle()
                    .stroke(AppTheme.surface, lineWidth: 6)
                    .frame(width: 80, height: 80)
                Circle()
                    .trim(from: 0, to: progress)
                    .stroke(AppTheme.accent, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                    .frame(width: 80, height: 80)
                    .rotationEffect(.degrees(-90))
                    .animation(.linear(duration: 0.3), value: progress)

                Text("\(Int(progress * 100))%")
                    .font(.title3)
                    .fontWeight(.bold)
                    .foregroundStyle(AppTheme.textPrimary)
                    .monospacedDigit()
            }

            // Size info
            if totalBytes > 0 {
                Text("\(formatBytes(downloadedBytes)) / \(formatBytes(totalBytes))")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.textSecondary)
                    .monospacedDigit()
            } else {
                Text("Downloading...")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.textSecondary)
            }

            // Speed
            if speed > 0 {
                Text(formatSpeed(speed))
                    .font(.caption)
                    .foregroundStyle(AppTheme.textSecondary.opacity(0.8))
                    .monospacedDigit()
            }

            // Linear progress bar as secondary indicator
            ProgressView(value: progress)
                .tint(AppTheme.accent)
                .frame(maxWidth: 280)
        }
    }

    private func formatBytes(_ bytes: Int64) -> String {
        if bytes >= 1_073_741_824 {
            return String(format: "%.1f GB", Double(bytes) / 1_073_741_824)
        } else if bytes >= 1_048_576 {
            return String(format: "%.0f MB", Double(bytes) / 1_048_576)
        } else if bytes >= 1024 {
            return String(format: "%.0f KB", Double(bytes) / 1024)
        }
        return "\(bytes) B"
    }

    private func formatSpeed(_ bytesPerSec: Double) -> String {
        if bytesPerSec >= 1_048_576 {
            return String(format: "%.1f MB/s", bytesPerSec / 1_048_576)
        } else if bytesPerSec >= 1024 {
            return String(format: "%.0f KB/s", bytesPerSec / 1024)
        }
        return String(format: "%.0f B/s", bytesPerSec)
    }
}
