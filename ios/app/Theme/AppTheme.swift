import SwiftUI

enum AppTheme {
    static let background = Color(hex: 0x0D0D0D)
    static let surface = Color(hex: 0x1A1A1A)
    static let surfaceElevated = Color(hex: 0x242424)
    static let accent = Color(hex: 0x6C5CE7)
    static let textPrimary = Color.white
    static let textSecondary = Color(hex: 0x8E8E93)
    static let border = Color(hex: 0x2A2A2A)
    static let success = Color(hex: 0x34C759)
    static let error = Color(hex: 0xFF3B30)
    static let warning = Color(hex: 0xFF9500)
    static let userBubble = Color(hex: 0x6C5CE7)
    static let assistantBubble = Color(hex: 0x1C1C1E)
    static let toolBackground = Color(hex: 0x1E1E2E)
    static let rankGold = Color(hex: 0xFFD700)
    static let rankSilver = Color(hex: 0xC0C0C0)
    static let rankBronze = Color(hex: 0xCD7F32)
}

extension Color {
    init(hex: UInt, opacity: Double = 1.0) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}
