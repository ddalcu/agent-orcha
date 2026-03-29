import Foundation

/// Manages user consent for P2P data sharing.
/// Required by App Store guidelines 5.1.1(i) and 5.1.2(i).
@Observable
final class PrivacyConsentManager {
    static let shared = PrivacyConsentManager()

    private static let consentKey = "privacy_p2p_consent_granted"
    private static let consentDateKey = "privacy_p2p_consent_date"

    /// Whether the user has accepted the P2P data sharing consent.
    private(set) var hasConsented: Bool

    /// When consent was granted (nil if never).
    var consentDate: Date? {
        guard let timestamp = UserDefaults.standard.object(forKey: Self.consentDateKey) as? Double else { return nil }
        return Date(timeIntervalSince1970: timestamp)
    }

    private init() {
        hasConsented = UserDefaults.standard.bool(forKey: Self.consentKey)
    }

    /// Record that the user has granted consent.
    func grantConsent() {
        hasConsented = true
        UserDefaults.standard.set(true, forKey: Self.consentKey)
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: Self.consentDateKey)
    }

    /// Revoke consent. This should also trigger P2P disconnect.
    func revokeConsent() {
        hasConsented = false
        UserDefaults.standard.set(false, forKey: Self.consentKey)
        UserDefaults.standard.removeObject(forKey: Self.consentDateKey)
    }
}
