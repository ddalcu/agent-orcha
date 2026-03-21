import SwiftUI

struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 60) }

            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 6) {
                // Thinking section (for LLM thinking chunks)
                if let thinking = message.thinkingContent, !thinking.isEmpty {
                    thinkingSection(thinking)
                }

                // Main content
                if message.content.isEmpty && message.isStreaming {
                    Text(" ")
                        .font(.body)
                        .foregroundStyle(AppTheme.textPrimary)
                } else {
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

    private func thinkingSection(_ thinking: String) -> some View {
        DisclosureGroup {
            Text(thinking)
                .font(.caption)
                .foregroundStyle(AppTheme.textSecondary)
        } label: {
            Label("Thinking", systemImage: "brain.head.profile")
                .font(.caption)
                .foregroundStyle(AppTheme.textSecondary)
        }
        .tint(AppTheme.textSecondary)
    }

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

    private func usageBar(_ usage: TokenUsage) -> some View {
        HStack(spacing: 8) {
            Label("\(usage.inputTokens)", systemImage: "arrow.down.circle")
            Label("\(usage.outputTokens)", systemImage: "arrow.up.circle")
        }
        .font(.caption2)
        .foregroundStyle(AppTheme.textSecondary.opacity(0.7))
    }
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
