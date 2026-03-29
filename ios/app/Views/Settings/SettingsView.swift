import SwiftUI

struct SettingsView: View {
    @Bindable var viewModel: SettingsViewModel
    @State private var showPrivacyReview = false

    var body: some View {
        NavigationStack {
            List {
                // Connection Status
                Section {
                    connectionStatus
                } header: {
                    Text("Status")
                }

                // Peer Configuration
                Section {
                    peerNameField
                    networkKeyPicker
                    if viewModel.useCustomNetwork {
                        customNetworkKeyField
                    }
                } header: {
                    Text("Configuration")
                } footer: {
                    Text("Peers on the same network key can discover each other.")
                        .foregroundStyle(AppTheme.textSecondary)
                }

                // Connect/Disconnect
                Section {
                    connectButton
                }

                // Error
                if let error = viewModel.lastError {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(AppTheme.error)
                            .font(.caption)
                    }
                }

                // Privacy
                Section {
                    privacySection
                } header: {
                    Text("Privacy")
                } footer: {
                    Text("P2P data sharing requires your consent per App Store guidelines.")
                        .foregroundStyle(AppTheme.textSecondary)
                }

                // About
                Section {
                    aboutSection
                } header: {
                    Text("About")
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .navigationTitle("Settings")
        }
    }

    // MARK: - Privacy

    private var privacySection: some View {
        Group {
            HStack {
                Label("P2P Data Sharing", systemImage: "hand.raised")
                    .foregroundStyle(AppTheme.textPrimary)
                Spacer()
                if PrivacyConsentManager.shared.hasConsented {
                    Text("Consented")
                        .font(.subheadline)
                        .foregroundStyle(AppTheme.success)
                } else {
                    Text("Not Consented")
                        .font(.subheadline)
                        .foregroundStyle(AppTheme.textSecondary)
                }
            }
            .listRowBackground(AppTheme.surface)

            if let date = PrivacyConsentManager.shared.consentDate {
                HStack {
                    Text("Consent Given")
                        .foregroundStyle(AppTheme.textPrimary)
                    Spacer()
                    Text(date, style: .date)
                        .font(.subheadline)
                        .foregroundStyle(AppTheme.textSecondary)
                }
                .listRowBackground(AppTheme.surface)
            }

            Button {
                showPrivacyReview = true
            } label: {
                Label("Review Privacy Details", systemImage: "doc.text")
                    .foregroundStyle(AppTheme.accent)
            }
            .listRowBackground(AppTheme.surface)
            .sheet(isPresented: $showPrivacyReview) {
                PrivacyConsentView {
                    if !PrivacyConsentManager.shared.hasConsented {
                        PrivacyConsentManager.shared.grantConsent()
                        viewModel.connect()
                    }
                    showPrivacyReview = false
                }
            }

            if PrivacyConsentManager.shared.hasConsented {
                Button(role: .destructive) {
                    PrivacyConsentManager.shared.revokeConsent()
                    viewModel.disconnect()
                } label: {
                    Label("Revoke Consent & Disconnect", systemImage: "xmark.shield")
                        .foregroundStyle(AppTheme.error)
                }
                .listRowBackground(AppTheme.surface)
            }
        }
    }

    // MARK: - Connection Status

    private var connectionStatus: some View {
        HStack {
            switch viewModel.connectionState {
            case .idle:
                Circle().fill(AppTheme.error).frame(width: 10, height: 10)
                Text("Disconnected").foregroundStyle(AppTheme.textPrimary)
            case .starting:
                ProgressView().controlSize(.small).tint(AppTheme.textSecondary)
                Text("Starting runtime...").foregroundStyle(AppTheme.textSecondary)
            case .connecting:
                ProgressView().controlSize(.small).tint(AppTheme.accent)
                Text("Connecting...").foregroundStyle(AppTheme.textPrimary)
            case .connected:
                Circle().fill(AppTheme.success).frame(width: 10, height: 10)
                Text("Connected").foregroundStyle(AppTheme.textPrimary)
            case .reconnecting:
                ProgressView().controlSize(.small).tint(AppTheme.accent.opacity(0.6))
                Text("Reconnecting...").foregroundStyle(AppTheme.textSecondary)
            }

            Spacer()

            if viewModel.peerCount > 0 {
                Text("\(viewModel.peerCount) peer\(viewModel.peerCount == 1 ? "" : "s")")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.textSecondary)
            }
        }
        .listRowBackground(AppTheme.surface)
    }

    // MARK: - Config Fields

    private var peerNameField: some View {
        HStack {
            Label("Peer Name", systemImage: "person.circle")
                .foregroundStyle(AppTheme.textPrimary)
            Spacer()
            TextField("Device name", text: $viewModel.peerName)
                .multilineTextAlignment(.trailing)
                .foregroundStyle(AppTheme.textPrimary)
        }
        .listRowBackground(AppTheme.surface)
    }

    private var networkKeyPicker: some View {
        HStack {
            Label("Network", systemImage: "key")
                .foregroundStyle(AppTheme.textPrimary)
            Spacer()
            Picker("", selection: $viewModel.useCustomNetwork) {
                Text("Default").tag(false)
                Text("Custom").tag(true)
            }
            .pickerStyle(.segmented)
            .frame(width: 160)
        }
        .listRowBackground(AppTheme.surface)
    }

    private var customNetworkKeyField: some View {
        HStack {
            Label("Key", systemImage: "lock")
                .foregroundStyle(AppTheme.textPrimary)
            Spacer()
            TextField("Network key", text: $viewModel.customNetworkKey)
                .multilineTextAlignment(.trailing)
                .foregroundStyle(AppTheme.textPrimary)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
        .listRowBackground(AppTheme.surface)
    }

    // MARK: - Connect Button

    private var connectButton: some View {
        let isBusy = viewModel.connectionState == .connecting || viewModel.connectionState == .starting
        let showDisconnect = viewModel.isConnected || viewModel.connectionState == .reconnecting
        let needsConsent = !PrivacyConsentManager.shared.hasConsented && !showDisconnect

        return Button {
            if needsConsent {
                showPrivacyReview = true
            } else {
                viewModel.toggleConnection()
            }
        } label: {
            HStack {
                Spacer()
                if isBusy {
                    ProgressView().controlSize(.small).tint(AppTheme.accent)
                }
                Text(showDisconnect ? "Disconnect" : (needsConsent ? "Review Privacy & Connect" : "Connect"))
                    .fontWeight(.semibold)
                Spacer()
            }
        }
        .disabled(isBusy)
        .foregroundStyle(showDisconnect ? AppTheme.error : AppTheme.accent)
        .listRowBackground(
            (showDisconnect ? AppTheme.error : AppTheme.accent).opacity(0.15)
        )
    }

    // MARK: - About

    private var aboutSection: some View {
        Group {
            HStack {
                Text("Version")
                    .foregroundStyle(AppTheme.textPrimary)
                Spacer()
                Text("1.0.0")
                    .foregroundStyle(AppTheme.textSecondary)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Build custom AI agents and share your own LLMs with this app. Set up Agent Orcha on your Mac, PC, or Linux machine.")
                    .font(.caption)
                    .foregroundStyle(AppTheme.textSecondary)
                Link(destination: URL(string: "https://agentorcha.com")!) {
                    Label("agentorcha.com", systemImage: "arrow.up.right.square")
                        .font(.caption)
                        .foregroundStyle(AppTheme.accent)
                }
            }
            Text("AI-generated responses may be inaccurate or incomplete. Do not rely on them for critical decisions.")
                .font(.caption)
                .foregroundStyle(AppTheme.textSecondary.opacity(0.7))
        }
        .listRowBackground(AppTheme.surface)
    }
}
