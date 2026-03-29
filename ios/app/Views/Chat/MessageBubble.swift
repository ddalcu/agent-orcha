import SwiftUI
import AVKit

struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 60) }

            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 6) {
                // Thinking section
                if let thinking = message.thinkingContent, !thinking.isEmpty {
                    thinkingSection(thinking)
                }

                // Tool calls section
                if !message.toolCalls.isEmpty {
                    toolCallsSection
                }

                // Media content (images, audio, video)
                if !message.mediaContent.isEmpty {
                    mediaSection
                }

                // Main content
                if message.content.isEmpty && message.isStreaming {
                    Text(" ")
                        .font(.body)
                        .foregroundStyle(AppTheme.textPrimary)
                } else if !message.content.isEmpty {
                    MarkdownText(message.content)
                        .textSelection(.enabled)
                }

                // Streaming indicator
                if message.isStreaming {
                    streamingIndicator
                }

                // Usage stats
                if let usage = message.usage {
                    usageBar(usage)
                }
            }
            .padding(12)
            .background(bubbleBackground)
            .clipShape(RoundedRectangle(cornerRadius: 16))

            if message.role == .assistant { Spacer(minLength: 60) }
        }
    }

    private var bubbleBackground: Color {
        message.role == .user ? AppTheme.userBubble : AppTheme.assistantBubble
    }

    // MARK: - Thinking

    private func thinkingSection(_ thinking: String) -> some View {
        ThinkingView(thinking: thinking, isStreaming: message.isStreaming)
    }

    // MARK: - Tool Calls

    private var toolCallsSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(message.toolCalls) { tool in
                ToolCallPill(toolCall: tool)
            }
        }
    }

    // MARK: - Media

    private var mediaSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(message.mediaContent) { media in
                if let dataURI = media.imageDataURI {
                    InlineImageView(dataURI: dataURI)
                }
                if let dataURI = media.audioDataURI {
                    InlineAudioPlayer(dataURI: dataURI)
                }
                if let dataURI = media.videoDataURI {
                    InlineVideoPlayer(dataURI: dataURI)
                }
            }
        }
    }

    // MARK: - Streaming Indicator

    private var streamingIndicator: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(AppTheme.accent)
                    .frame(width: 4, height: 4)
                    .opacity(0.6)
                    .animation(
                        .easeInOut(duration: 0.6)
                            .repeatForever()
                            .delay(Double(i) * 0.2),
                        value: message.isStreaming
                    )
            }
        }
    }

    // MARK: - Usage

    private func usageBar(_ usage: TokenUsage) -> some View {
        HStack(spacing: 8) {
            Label("\(usage.inputTokens)", systemImage: "arrow.down.circle")
            Label("\(usage.outputTokens)", systemImage: "arrow.up.circle")
        }
        .font(.caption2)
        .foregroundStyle(AppTheme.textSecondary.opacity(0.7))
    }
}

// MARK: - Tool Call Pill

// MARK: - Thinking View (auto-expands while streaming)

private struct ThinkingView: View {
    let thinking: String
    let isStreaming: Bool

    @State private var isExpanded = true

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "brain.head.profile")
                        .font(.caption2)
                    Text("Thinking")
                        .font(.caption)
                        .fontWeight(.medium)
                    if isStreaming {
                        ProgressView()
                            .scaleEffect(0.4)
                    }
                    Spacer()
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption2)
                }
                .foregroundStyle(AppTheme.textSecondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
            }
            .buttonStyle(.plain)

            if isExpanded {
                Text(thinking)
                    .font(.caption)
                    .foregroundStyle(AppTheme.textSecondary.opacity(0.8))
                    .padding(.horizontal, 8)
                    .padding(.bottom, 6)
            }
        }
        .background(AppTheme.accent.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .onChange(of: isStreaming) {
            // Collapse when streaming finishes
            if !isStreaming {
                withAnimation(.easeInOut(duration: 0.3)) {
                    isExpanded = false
                }
            }
        }
    }
}

// MARK: - Tool Call Pill

private struct ToolCallPill: View {
    let toolCall: ToolCallInfo

    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "wrench")
                        .font(.caption2)
                    Text(toolCall.tool)
                        .font(.caption)
                        .fontWeight(.medium)
                    Spacer()
                    if toolCall.isDone {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.caption2)
                            .foregroundStyle(AppTheme.success)
                    } else {
                        ProgressView()
                            .scaleEffect(0.5)
                    }
                }
                .foregroundStyle(AppTheme.textSecondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: 4) {
                    if !toolCall.input.isEmpty {
                        Text("Input:")
                            .font(.caption2)
                            .foregroundStyle(AppTheme.textSecondary.opacity(0.7))
                        Text(toolCall.input.prefix(200) + (toolCall.input.count > 200 ? "..." : ""))
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(AppTheme.textSecondary)
                    }
                    if let output = toolCall.output, !output.isEmpty {
                        Text("Output:")
                            .font(.caption2)
                            .foregroundStyle(AppTheme.textSecondary.opacity(0.7))
                        Text(output.prefix(200) + (output.count > 200 ? "..." : ""))
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(AppTheme.textSecondary)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 6)
            }
        }
        .background(AppTheme.toolBackground)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

// MARK: - Inline Image View

private struct InlineImageView: View {
    let dataURI: String

    @State private var image: UIImage?
    @State private var showFullScreen = false
    @State private var saved = false

    var body: some View {
        Group {
            if let image {
                VStack(spacing: 0) {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(maxWidth: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .onTapGesture { showFullScreen = true }

                    SaveButton(label: "Save to Photos", icon: "square.and.arrow.down", saved: saved) {
                        UIImageWriteToSavedPhotosAlbum(image, nil, nil, nil)
                        withAnimation { saved = true }
                    }
                }
                .fullScreenCover(isPresented: $showFullScreen) {
                    ZStack {
                        Color.black.ignoresSafeArea()
                        Image(uiImage: image)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .ignoresSafeArea()
                    }
                    .onTapGesture { showFullScreen = false }
                }
            } else {
                RoundedRectangle(cornerRadius: 8)
                    .fill(AppTheme.surface)
                    .frame(height: 100)
                    .overlay {
                        ProgressView()
                            .tint(AppTheme.accent)
                    }
            }
        }
        .task {
            image = MediaCacheService.shared.imageFromDataURI(dataURI)
        }
    }
}

// MARK: - Inline Audio Player

private struct InlineAudioPlayer: View {
    let dataURI: String

    @State private var audioPlayer: AVAudioPlayer?
    @State private var audioFileURL: URL?
    @State private var isPlaying = false
    @State private var progress: Double = 0
    @State private var timerTask: Task<Void, Never>?
    @State private var showShareSheet = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button {
                    togglePlayback()
                } label: {
                    Image(systemName: isPlaying ? "pause.circle.fill" : "play.circle.fill")
                        .font(.system(size: 40))
                        .foregroundStyle(AppTheme.accent)
                }
                .buttonStyle(.plain)

                VStack(alignment: .leading, spacing: 6) {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule()
                                .fill(AppTheme.surface)
                                .frame(height: 5)
                            Capsule()
                                .fill(AppTheme.accent)
                                .frame(width: geo.size.width * progress, height: 5)
                        }
                        .frame(maxHeight: .infinity, alignment: .center)
                    }
                    .frame(height: 20)

                    HStack {
                        if let player = audioPlayer {
                            Text(formatDuration(player.currentTime))
                                .font(.caption2)
                                .foregroundStyle(AppTheme.textSecondary)
                                .monospacedDigit()
                            Spacer()
                            Text(formatDuration(player.duration))
                                .font(.caption2)
                                .foregroundStyle(AppTheme.textSecondary)
                                .monospacedDigit()
                        }
                    }
                }
            }
            .padding(12)

            if audioFileURL != nil {
                SaveButton(label: "Save Audio", icon: "square.and.arrow.down") {
                    showShareSheet = true
                }
                .sheet(isPresented: $showShareSheet) {
                    if let url = audioFileURL {
                        ShareSheet(items: [url])
                    }
                }
            }
        }
        .background(AppTheme.toolBackground)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .task {
            loadAudio()
        }
        .onDisappear {
            timerTask?.cancel()
            audioPlayer?.stop()
        }
    }

    private func loadAudio() {
        // Configure audio session for playback (required for iOS to output sound)
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            // Audio session config failed — playback may not work
        }

        guard let url = MediaCacheService.shared.fileURLFromDataURI(dataURI, fallbackExtension: "wav") else { return }
        audioFileURL = url
        audioPlayer = try? AVAudioPlayer(contentsOf: url)
        audioPlayer?.prepareToPlay()
    }

    private func togglePlayback() {
        guard let player = audioPlayer else { return }
        if isPlaying {
            player.pause()
            isPlaying = false
            timerTask?.cancel()
        } else {
            // Ensure audio session is active before playing
            try? AVAudioSession.sharedInstance().setActive(true)
            player.play()
            isPlaying = true
            startProgressTimer()
        }
    }

    private func startProgressTimer() {
        timerTask?.cancel()
        timerTask = Task {
            while !Task.isCancelled, let player = audioPlayer, player.isPlaying {
                progress = player.currentTime / max(player.duration, 0.01)
                try? await Task.sleep(for: .milliseconds(100))
            }
            if !Task.isCancelled {
                isPlaying = false
                progress = 0
            }
        }
    }

    private func formatDuration(_ seconds: TimeInterval) -> String {
        let mins = Int(seconds) / 60
        let secs = Int(seconds) % 60
        return String(format: "%d:%02d", mins, secs)
    }
}

// MARK: - Inline Video Player

private struct InlineVideoPlayer: View {
    let dataURI: String

    @State private var playerItem: AVPlayerItem?
    @State private var player: AVPlayer?
    @State private var videoFileURL: URL?
    @State private var showShareSheet = false

    var body: some View {
        VStack(spacing: 0) {
            Group {
                if let player {
                    VideoPlayer(player: player)
                        .frame(maxWidth: .infinity)
                        .aspectRatio(16/9, contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                } else {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(AppTheme.surface)
                        .aspectRatio(16/9, contentMode: .fit)
                        .overlay {
                            ProgressView()
                                .tint(AppTheme.accent)
                        }
                }
            }

            if videoFileURL != nil {
                SaveButton(label: "Save Video", icon: "square.and.arrow.down") {
                    showShareSheet = true
                }
                .sheet(isPresented: $showShareSheet) {
                    if let url = videoFileURL {
                        ShareSheet(items: [url])
                    }
                }
            }
        }
        .task {
            guard let url = MediaCacheService.shared.fileURLFromDataURI(dataURI, fallbackExtension: "mp4") else { return }
            videoFileURL = url
            let item = AVPlayerItem(url: url)
            playerItem = item
            player = AVPlayer(playerItem: item)
        }
        .onDisappear {
            player?.pause()
        }
    }
}

// MARK: - Save Button

private struct SaveButton: View {
    let label: String
    let icon: String
    var saved: Bool = false
    let action: () -> Void

    var body: some View {
        Button {
            action()
        } label: {
            HStack(spacing: 5) {
                Image(systemName: saved ? "checkmark.circle.fill" : icon)
                    .font(.caption)
                Text(saved ? "Saved" : label)
                    .font(.caption)
            }
            .foregroundStyle(saved ? AppTheme.success : AppTheme.accent)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 7)
        }
        .buttonStyle(.plain)
        .disabled(saved)
    }
}

// MARK: - Share Sheet

private struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

// MARK: - Markdown Renderer

/// Renders markdown text with support for headings, bold, italic, code,
/// code blocks, lists, and links — styled for the dark theme.
struct MarkdownText: View {
    let source: String

    init(_ source: String) {
        self.source = source
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                block
            }
        }
    }

    private var blocks: [AnyView] {
        let lines = source.split(separator: "\n", omittingEmptySubsequences: false)
        var result: [AnyView] = []
        var codeBlock: [String] = []
        var inCodeBlock = false
        var codeLanguage = ""

        for line in lines {
            let str = String(line)

            // Code block fences
            if str.hasPrefix("```") {
                if inCodeBlock {
                    result.append(AnyView(codeBlockView(codeBlock.joined(separator: "\n"), language: codeLanguage)))
                    codeBlock = []
                    inCodeBlock = false
                    codeLanguage = ""
                } else {
                    inCodeBlock = true
                    codeLanguage = String(str.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                }
                continue
            }

            if inCodeBlock {
                codeBlock.append(str)
                continue
            }

            // Headings
            if str.hasPrefix("### ") {
                result.append(AnyView(inlineMarkdown(String(str.dropFirst(4))).font(.subheadline).fontWeight(.semibold)))
            } else if str.hasPrefix("## ") {
                result.append(AnyView(inlineMarkdown(String(str.dropFirst(3))).font(.headline)))
            } else if str.hasPrefix("# ") {
                result.append(AnyView(inlineMarkdown(String(str.dropFirst(2))).font(.title3).fontWeight(.bold)))
            }
            // Unordered list
            else if str.hasPrefix("- ") || str.hasPrefix("* ") {
                let content = String(str.dropFirst(2))
                result.append(AnyView(
                    HStack(alignment: .top, spacing: 6) {
                        Text("•").foregroundStyle(AppTheme.textSecondary)
                        inlineMarkdown(content)
                    }
                ))
            }
            // Ordered list
            else if let match = str.range(of: #"^\d+\.\s"#, options: .regularExpression) {
                let prefix = String(str[match])
                let content = String(str[match.upperBound...])
                result.append(AnyView(
                    HStack(alignment: .top, spacing: 4) {
                        Text(prefix).foregroundStyle(AppTheme.textSecondary).font(.body.monospacedDigit())
                        inlineMarkdown(content)
                    }
                ))
            }
            // Horizontal rule
            else if str == "---" || str == "***" || str == "___" {
                result.append(AnyView(
                    Divider().overlay(AppTheme.border).padding(.vertical, 4)
                ))
            }
            // Empty line
            else if str.trimmingCharacters(in: .whitespaces).isEmpty {
                result.append(AnyView(Spacer().frame(height: 4)))
            }
            // Regular paragraph
            else {
                result.append(AnyView(inlineMarkdown(str)))
            }
        }

        // Unclosed code block
        if inCodeBlock && !codeBlock.isEmpty {
            result.append(AnyView(codeBlockView(codeBlock.joined(separator: "\n"), language: codeLanguage)))
        }

        return result
    }

    // MARK: - Code Block

    private func codeBlockView(_ code: String, language: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if !language.isEmpty {
                Text(language)
                    .font(.caption2)
                    .foregroundStyle(AppTheme.textSecondary)
                    .padding(.horizontal, 10)
                    .padding(.top, 6)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(AppTheme.textPrimary)
                    .padding(10)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.background)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - Inline Markdown

    /// Parses inline markdown (bold, italic, code, links) into a styled Text.
    private func inlineMarkdown(_ source: String) -> Text {
        var result = Text("")
        var remaining = source[...]

        while !remaining.isEmpty {
            // Inline code
            if remaining.hasPrefix("`"), let end = remaining.dropFirst().firstIndex(of: "`") {
                let code = remaining[remaining.index(after: remaining.startIndex)..<end]
                result = result + Text(String(code))
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(AppTheme.accent)
                remaining = remaining[remaining.index(after: end)...]
            }
            // Bold + italic
            else if remaining.hasPrefix("***"), let end = remaining.dropFirst(3).range(of: "***") {
                let content = remaining[remaining.index(remaining.startIndex, offsetBy: 3)..<end.lowerBound]
                result = result + Text(String(content)).bold().italic()
                remaining = remaining[end.upperBound...]
            }
            // Bold **
            else if remaining.hasPrefix("**"), let end = remaining.dropFirst(2).range(of: "**") {
                let content = remaining[remaining.index(remaining.startIndex, offsetBy: 2)..<end.lowerBound]
                result = result + Text(String(content)).bold()
                remaining = remaining[end.upperBound...]
            }
            // Italic *
            else if remaining.hasPrefix("*"), let end = remaining.dropFirst().firstIndex(of: "*") {
                let content = remaining[remaining.index(after: remaining.startIndex)..<end]
                result = result + Text(String(content)).italic()
                remaining = remaining[remaining.index(after: end)...]
            }
            // Link [text](url)
            else if remaining.hasPrefix("["),
                    let closeBracket = remaining.firstIndex(of: "]"),
                    remaining[remaining.index(after: closeBracket)...].hasPrefix("("),
                    let closeParen = remaining[remaining.index(after: closeBracket)...].firstIndex(of: ")") {
                let text = remaining[remaining.index(after: remaining.startIndex)..<closeBracket]
                let urlStr = remaining[remaining.index(closeBracket, offsetBy: 2)..<closeParen]
                if let url = URL(string: String(urlStr)) {
                    result = result + Text(AttributedString(String(text), attributes: .init([.link: url, .foregroundColor: UIColor(AppTheme.accent)])))
                } else {
                    result = result + Text(String(text)).foregroundStyle(AppTheme.accent)
                }
                remaining = remaining[remaining.index(after: closeParen)...]
            }
            // Plain character
            else {
                let next = remaining.removeFirst()
                result = result + Text(String(next))
            }
        }

        return result
            .font(.body)
            .foregroundStyle(AppTheme.textPrimary)
    }
}
