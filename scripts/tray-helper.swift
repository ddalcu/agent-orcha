// Minimal macOS system tray helper for Agent Orcha
// Communicates with parent process via JSON over stdin/stdout
// Build: swiftc -O -o tray-helper scripts/tray-helper.swift

import Cocoa

class TrayDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var url: String = ""
    var menuItems: [(String, Bool, Int)] = [] // (title, enabled, id)

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Signal ready
        print("{\"type\":\"ready\"}")
        fflush(stdout)

        // Read config from stdin on background thread
        DispatchQueue.global().async { self.readInput() }
    }

    func readInput() {
        while let line = readLine() {
            guard let data = line.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                continue
            }

            if let type = json["type"] as? String, type == "exit" {
                DispatchQueue.main.async { NSApp.terminate(nil) }
                return
            }

            // Initial menu config
            if let items = json["items"] as? [[String: Any]] {
                let iconBase64 = json["icon"] as? String ?? ""
                let tooltip = json["tooltip"] as? String ?? "Agent Orcha"

                var parsed: [(String, Bool, Int)] = []
                for item in items {
                    let title = item["title"] as? String ?? ""
                    let enabled = item["enabled"] as? Bool ?? true
                    let id = item["__id"] as? Int ?? 0
                    parsed.append((title, enabled, id))
                }

                DispatchQueue.main.async {
                    self.setupTray(iconBase64: iconBase64, tooltip: tooltip, items: parsed)
                }
            }
        }
    }

    func setupTray(iconBase64: String, tooltip: String, items: [(String, Bool, Int)]) {
        self.menuItems = items
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

        if let button = statusItem.button {
            if !iconBase64.isEmpty, let data = Data(base64Encoded: iconBase64) {
                let image = NSImage(data: data)
                image?.size = NSSize(width: 18, height: 18)
                image?.isTemplate = true
                button.image = image
            } else {
                button.title = "🐋"
            }
            button.toolTip = tooltip
        }

        let menu = NSMenu()
        for (title, enabled, id) in items {
            if title == "<SEPARATOR>" {
                menu.addItem(NSMenuItem.separator())
            } else {
                let menuItem = NSMenuItem(title: title, action: enabled ? #selector(menuClicked(_:)) : nil, keyEquivalent: "")
                menuItem.target = self
                menuItem.tag = id
                menuItem.isEnabled = enabled
                menu.addItem(menuItem)
            }
        }
        statusItem.menu = menu
    }

    @objc func menuClicked(_ sender: NSMenuItem) {
        let json = "{\"type\":\"clicked\",\"__id\":\(sender.tag)}"
        print(json)
        fflush(stdout)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // No dock icon
let delegate = TrayDelegate()
app.delegate = delegate
app.run()
