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
    static let userBubble = Color(hex: 0x6C5CE7)
    static let assistantBubble = Color(hex: 0x1C1C1E)
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
