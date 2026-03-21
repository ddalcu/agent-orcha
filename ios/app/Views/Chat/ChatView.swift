import SwiftUI

struct ChatView: View {
    @Bindable var viewModel: ChatViewModel
    var onReset: (() -> Void)?

    @State private var inputText = ""
    @FocusState private var inputFocused: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            messageList
            if viewModel.isStreaming {
                streamingBar
            }
            inputBar
        }
        .background(AppTheme.background)
        .navigationTitle(viewModel.target.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(viewModel.target.displayName)
                        .font(.headline)
                        .foregroundStyle(AppTheme.textPrimary)
                    Text(viewModel.target.peerName)
                        .font(.caption2)
                        .foregroundStyle(AppTheme.textSecondary)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                if !viewModel.messages.isEmpty {
                    Button {
                        viewModel.reset()
                        onReset?()
                        dismiss()
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

    // MARK: - Message List

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

    // MARK: - Welcome Message

    private var welcomeMessage: some View {
        VStack(spacing: 12) {
            Image(systemName: targetIcon)
                .font(.system(size: 40))
                .foregroundStyle(AppTheme.accent.opacity(0.5))

            Text(viewModel.target.subtitle)
                .font(.subheadline)
                .foregroundStyle(AppTheme.textSecondary)
                .multilineTextAlignment(.center)

            Text("Responses are AI-generated and may be inaccurate.")
                .font(.caption)
                .foregroundStyle(AppTheme.textSecondary.opacity(0.7))

            if case .agent(let agent) = viewModel.target,
               let questions = agent.sampleQuestions, !questions.isEmpty {
                VStack(spacing: 8) {
                    ForEach(questions, id: \.self) { question in
                        Button {
                            inputText = question
                        } label: {
                            Text(question)
                                .font(.subheadline)
                                .foregroundStyle(AppTheme.accent)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(10)
                                .background(AppTheme.accent.opacity(0.1))
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
                .padding(.top, 8)
            }
        }
        .padding(.vertical, 40)
    }

    // MARK: - Streaming Bar

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

    // MARK: - Input Bar

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

    // MARK: - Helpers

    private var canSend: Bool {
        !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !viewModel.isStreaming
    }

    private var targetIcon: String {
        switch viewModel.target {
        case .agent: return "cpu"
        case .llm: return "brain"
        }
    }
}
