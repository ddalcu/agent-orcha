import SwiftUI
import PhotosUI

struct ChatView: View {
    @Bindable var viewModel: ChatViewModel
    var onReset: (() -> Void)?

    @State private var inputText = ""
    @State private var pendingAttachments: [Attachment] = []
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var showingFilePicker = false
    @FocusState private var inputFocused: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            messageList
            if viewModel.isStreaming {
                streamingBar
            }
            if !pendingAttachments.isEmpty {
                attachmentPreview
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
        .fileImporter(
            isPresented: $showingFilePicker,
            allowedContentTypes: [.pdf, .plainText, .json, .audio, .image],
            allowsMultipleSelection: true
        ) { result in
            handleFileImport(result)
        }
        .onChange(of: selectedPhotos) {
            handlePhotoSelection()
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

    // MARK: - Attachment Preview

    private var attachmentPreview: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(pendingAttachments) { attachment in
                    AttachmentThumbnail(attachment: attachment) {
                        pendingAttachments.removeAll { $0.id == attachment.id }
                    }
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 6)
        }
        .background(AppTheme.surfaceElevated)
    }

    // MARK: - Input Bar

    private var inputBar: some View {
        HStack(spacing: 8) {
            // Attachment menu (only for agents)
            if case .agent = viewModel.target {
                Menu {
                    PhotosPicker(selection: $selectedPhotos, maxSelectionCount: 5, matching: .images) {
                        Label("Photo Library", systemImage: "photo.on.rectangle")
                    }
                    Button {
                        showingFilePicker = true
                    } label: {
                        Label("Browse Files", systemImage: "doc")
                    }
                } label: {
                    Image(systemName: "paperclip")
                        .font(.title3)
                        .foregroundStyle(AppTheme.textSecondary)
                }
                .disabled(viewModel.isStreaming)
            }

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
                let attachments = pendingAttachments.isEmpty ? nil : pendingAttachments
                inputText = ""
                pendingAttachments = []
                selectedPhotos = []
                viewModel.send(text, attachments: attachments)
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

    private func handlePhotoSelection() {
        Task {
            for item in selectedPhotos {
                guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
                let mediaType = "image/jpeg"
                let name = "photo_\(Int(Date().timeIntervalSince1970)).jpg"
                pendingAttachments.append(Attachment(data: data, mediaType: mediaType, name: name))
            }
        }
    }

    private func handleFileImport(_ result: Result<[URL], Error>) {
        guard case .success(let urls) = result else { return }
        for url in urls {
            guard url.startAccessingSecurityScopedResource() else { continue }
            defer { url.stopAccessingSecurityScopedResource() }
            guard let data = try? Data(contentsOf: url) else { continue }
            let mediaType = mimeType(for: url.pathExtension)
            pendingAttachments.append(Attachment(data: data, mediaType: mediaType, name: url.lastPathComponent))
        }
    }

    private func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "gif": return "image/gif"
        case "pdf": return "application/pdf"
        case "txt": return "text/plain"
        case "json": return "application/json"
        case "wav": return "audio/wav"
        case "mp3": return "audio/mpeg"
        case "m4a": return "audio/mp4"
        default: return "application/octet-stream"
        }
    }
}

// MARK: - Attachment Thumbnail

private struct AttachmentThumbnail: View {
    let attachment: Attachment
    let onRemove: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            if attachment.isImage, let image = UIImage(data: attachment.data) {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 56, height: 56)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            } else {
                VStack(spacing: 2) {
                    Image(systemName: iconForType(attachment.mediaType))
                        .font(.title3)
                        .foregroundStyle(AppTheme.accent)
                    Text(attachment.name)
                        .font(.system(size: 8))
                        .foregroundStyle(AppTheme.textSecondary)
                        .lineLimit(1)
                }
                .frame(width: 56, height: 56)
                .background(AppTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }

            Button {
                onRemove()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(AppTheme.textSecondary)
                    .background(Circle().fill(AppTheme.background))
            }
            .offset(x: 4, y: -4)
        }
    }

    private func iconForType(_ type: String) -> String {
        if type.hasPrefix("audio/") { return "waveform" }
        if type.hasPrefix("image/") { return "photo" }
        if type.contains("pdf") { return "doc.richtext" }
        return "doc"
    }
}
