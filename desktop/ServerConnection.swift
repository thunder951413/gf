import AppKit
import CryptoKit
import WebKit

/// Where the companion service runs and how to authenticate to it.
///
/// By default the desktop app talks to the service on this Mac. When the
/// service runs on another machine with LIFE_ACCESS_TOKEN set, the address and
/// token are saved in ~/Library/Application Support/Youjian/server.json (only
/// readable by this user). Native requests carry the token in a header; the
/// chat window gets the same session cookie the /login page would set.
struct ServerConfiguration: Codable, Equatable {
    var baseURL: String
    var token: String?
}

enum CompanionServer {
    static let defaultURL = "http://127.0.0.1:8765/"
    static let tokenHeader = "X-Youjian-Token"
    private(set) static var token: String?
    private(set) static var session: URLSession = .shared

    static var configurationFile: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Youjian", isDirectory: true).appendingPathComponent("server.json")
    }

    static func load() -> ServerConfiguration? {
        guard let data = try? Data(contentsOf: configurationFile) else { return nil }
        return try? JSONDecoder().decode(ServerConfiguration.self, from: data)
    }

    static func save(_ configuration: ServerConfiguration?) throws {
        let file = configurationFile
        guard let configuration else { try? FileManager.default.removeItem(at: file); return }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(configuration).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }

    /// Call once at launch, before any request is made.
    static func configure(token value: String?) {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        token = trimmed?.isEmpty == false ? trimmed : nil
        guard let token else { session = .shared; return }
        let configuration = URLSessionConfiguration.default
        configuration.httpAdditionalHeaders = [tokenHeader: token]
        session = URLSession(configuration: configuration)
    }

    /// The value the server stores in its session cookie: HMAC-SHA256(token, "youjian-session-v1").
    static func sessionCookieValue(_ token: String) -> String {
        let code = HMAC<SHA256>.authenticationCode(for: Data("youjian-session-v1".utf8), using: SymmetricKey(data: Data(token.utf8)))
        return code.map { String(format: "%02x", $0) }.joined()
    }

    static func installSessionCookie(baseURL: URL, completion: @escaping () -> Void = {}) {
        guard let token, let host = baseURL.host else { completion(); return }
        var properties: [HTTPCookiePropertyKey: Any] = [
            .name: "youjian_session", .value: sessionCookieValue(token), .domain: host, .path: "/",
            .expires: Date().addingTimeInterval(365 * 24 * 3600),
        ]
        if baseURL.scheme == "https" { properties[.secure] = "TRUE" }
        guard let cookie = HTTPCookie(properties: properties) else { completion(); return }
        WKWebsiteDataStore.default().httpCookieStore.setCookie(cookie) { completion() }
    }

    static var isRemote: Bool { load().map { $0.baseURL != defaultURL } ?? false }

    /// Settings dialog. Returns true when the configuration changed and the app should relaunch.
    static func presentSettings() -> Bool {
        let current = load()
        let alert = NSAlert()
        alert.messageText = "连接到有间服务"
        alert.informativeText = "地址留空表示使用这台 Mac 上的服务。服务放在其他机器上时，填写它的地址（例如 http://192.168.1.20:8765/）和服务器上设置的访问口令。保存后桌面程序会重新启动。"
        let address = NSTextField(string: current?.baseURL == defaultURL ? "" : current?.baseURL ?? "")
        address.placeholderString = "http://服务器地址:8765/"
        let secret = NSSecureTextField(string: current?.token ?? "")
        secret.placeholderString = "访问口令（本机服务可留空）"
        for field in [address, secret] { field.translatesAutoresizingMaskIntoConstraints = false; field.widthAnchor.constraint(equalToConstant: 340).isActive = true }
        let stack = NSStackView(views: [address, secret])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.frame = NSRect(x: 0, y: 0, width: 340, height: 56)
        alert.accessoryView = stack
        alert.addButton(withTitle: "保存并重新启动"); alert.addButton(withTitle: "取消")
        alert.window.initialFirstResponder = address
        guard alert.runModal() == .alertFirstButtonReturn else { return false }
        let raw = address.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = secret.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let next: ServerConfiguration?
        if raw.isEmpty {
            next = token.isEmpty ? nil : ServerConfiguration(baseURL: defaultURL, token: token)
        } else {
            let normalized = raw.hasSuffix("/") ? raw : raw + "/"
            guard companionBaseURL(normalized) != nil else {
                let error = NSAlert(); error.messageText = "地址无效"
                error.informativeText = "请填写 http:// 或 https:// 开头的地址，只包含主机和端口，例如 http://192.168.1.20:8765/。"
                error.runModal(); return false
            }
            next = ServerConfiguration(baseURL: normalized, token: token.isEmpty ? nil : token)
        }
        guard next != current else { return false }
        do { try save(next) } catch {
            let failure = NSAlert(); failure.messageText = "没有保存"; failure.informativeText = error.localizedDescription; failure.runModal(); return false
        }
        return true
    }

    static func relaunch() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        task.arguments = ["-c", "sleep 1; /usr/bin/open \"$0\"", Bundle.main.bundlePath]
        try? task.run()
        NSApp.terminate(nil)
    }
}
