import AppKit
import SceneKit
import WebKit

final class PetPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class PetView: SCNView {
    var clicked: (() -> Void)?
    var attention: (() -> Void)?
    var showMenu: ((NSEvent) -> Void)?
    var moved: (() -> Void)?
    private var startMouse = NSPoint.zero
    private var startOrigin = NSPoint.zero
    private var dragged = false
    private lazy var gestures = DesktopAttentionGestureRouter(
        onSingle: { [weak self] in self?.clicked?() },
        onAttention: { [weak self] in self?.attention?() }
    )
    override var isOpaque: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        gestures.mouseDown(clickCount: event.clickCount)
        startMouse = NSEvent.mouseLocation; startOrigin = window?.frame.origin ?? .zero; dragged = false
    }
    override func mouseDragged(with event: NSEvent) {
        let p = NSEvent.mouseLocation
        if hypot(p.x - startMouse.x, p.y - startMouse.y) > 3 { dragged = true }
        if dragged { window?.setFrameOrigin(NSPoint(x: startOrigin.x + p.x - startMouse.x, y: startOrigin.y + p.y - startMouse.y)) }
    }
    override func mouseUp(with event: NSEvent) { if dragged { gestures.cancel(); moved?() } else { gestures.mouseUp(clickCount:event.clickCount,dragged:false) } }
    override func accessibilityPerformPress() -> Bool { clicked?(); return true }
    override func rightMouseDown(with event: NSEvent) { gestures.cancel(); showMenu?(event) }
}

final class BubbleView: NSView {
    let heading = NSTextField(labelWithString: "林雨薇")
    let body = NSTextField(wrappingLabelWithString: "")
    var clicked: (() -> Void)?
    var shouldSuppress: (() -> Bool)?
    var isMessage = false
    var tailAnchor: CGFloat = 135
    override init(frame: NSRect) {
        super.init(frame: frame)
        heading.font = .systemFont(ofSize: 11, weight: .semibold)
        heading.textColor = NSColor(calibratedRed: 0.52, green: 0.37, blue: 0.40, alpha: 1)
        body.font = .systemFont(ofSize: 13)
        body.textColor = NSColor(calibratedRed: 0.25, green: 0.23, blue: 0.27, alpha: 1)
        body.maximumNumberOfLines = 4; body.lineBreakMode = .byTruncatingTail
        for label in [heading, body] { label.isSelectable = false; addSubview(label) }
        setAccessibilityElement(true); setAccessibilityRole(.button)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func layout() {
        super.layout()
        heading.frame = NSRect(x: 18, y: bounds.height - 31, width: bounds.width - 36, height: 17)
        body.frame = NSRect(x: 18, y: 24, width: bounds.width - 36, height: bounds.height - 60)
    }
    override func draw(_ dirtyRect: NSRect) {
        let box = NSBezierPath(roundedRect: NSRect(x: 3, y: 13, width: bounds.width - 6, height: bounds.height - 17), xRadius: 19, yRadius: 19)
        NSColor(calibratedRed: 1, green: 0.98, blue: 0.95, alpha: 0.97).setFill(); box.fill()
        NSColor(calibratedRed: 0.83, green: 0.73, blue: 0.72, alpha: 0.85).setStroke(); box.lineWidth = 1; box.stroke()
        let tail = NSBezierPath(); tail.move(to: NSPoint(x: tailAnchor - 9, y: 14)); tail.line(to: NSPoint(x: tailAnchor + 1, y: 2)); tail.line(to: NSPoint(x: tailAnchor + 12, y: 14)); tail.close()
        NSColor(calibratedRed: 1, green: 0.98, blue: 0.95, alpha: 0.97).setFill(); tail.fill()
    }
    override func hitTest(_ point: NSPoint) -> NSView? { bounds.contains(convert(point, from: superview)) ? self : nil }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { clicked?() }
    override func accessibilityPerformPress() -> Bool { clicked?(); return true }
    func show(_ text: String, title: String, message: Bool) {
        heading.stringValue = title; body.stringValue = text; isMessage = message
        setAccessibilityLabel("\(title)，\(text)，点击打开聊天")
        // A chat window is the full conversation surface. Keep its desktop
        // counterpart quiet even when the chat is not the focused window.
        isHidden = shouldSuppress?() ?? false; needsDisplay = true
    }
}

private struct WardrobeServiceError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

private struct WardrobeErrorPayload: Decodable { let error: String? }
private struct DesktopAttentionError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
private enum DesktopAttentionCancelled: Error { case modelCancelled }

final class DesktopApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    var chatCheckFinished = false
    let baseURL: URL
    let demo: Bool
    let testProfile: Bool
    let defaults: UserDefaults
    let character = CharacterScene()
    let pet = PetView(frame: NSRect(x: 0, y: 0, width: 300, height: 350))
    let photoLibrary = PhotoPetLibrary(resourceURL: Bundle.main.resourceURL)
    let sceneCanvas = NativeSceneCanvas(frame: NSRect(x: 0, y: 0, width: 300, height: 350))
    var photoPet: PhotoPetView { sceneCanvas.figureView }
    let bubble = BubbleView(frame: NSRect(x: 15, y: 340, width: 270, height: 130))
    var panel: PetPanel!
    var status: NSStatusItem!
    var chatWindow: NSWindow?
    var web: WKWebView?
    var tracker: MessageTracker
    var lastMessage: DesktopMessage?
    var manualPose: CompanionPose?
    var world: LifeSnapshot?
    var wardrobe: WardrobeSnapshot?
    var wardrobeOnline = false
    var wardrobeBusy = false
    var wardrobePreviewOutfitID: String?
    var wardrobeReviewPose = "both"
    var wardrobeWindow: NSWindow?
    var appearance: AppearanceSnapshot?
    var appearanceOnline = false
    var visualStudio: VisualStudioController!
    var sceneImageStudio: SceneImageStudioController!
    var connected = false
    var polling = false
    var lastLifeCheck = Date.distantPast
    var pollTimer: Timer?
    var mouseTimer: Timer?
    var lastFailure = Date.distantPast
    var previewUntil = Date.distantPast
    var attentionCoordinator = DesktopAttentionCoordinator()
    var privatePreview: Bool { defaults.bool(forKey: "privatePreview") }
    var scale: CGFloat { let value = defaults.double(forKey: "scale"); return value >= 0.7 && value <= 1.4 ? value : 1 }
    var poseStatus: String { manualPose.map { "姿态预览 · \($0.title)" } ?? (world?.world.activity ?? "等待生活状态") }
    var prefersPhotoRenderer: Bool { defaults.string(forKey: "pet.renderer") != "old3d" }
    var usingPhotoRenderer: Bool { !sceneCanvas.isHidden && (sceneCanvas.uploadedSceneEnabled || photoPet.asset != nil) }
    var requestedPose: CompanionPose { manualPose ?? CompanionPose(rawValue: world?.poseID ?? "idle") ?? .idle }
    var displayedPhotoPoseID: String { photoPoseID(for: requestedPose.rawValue) }
    var confirmedWardrobeKey: String { "wardrobe.confirmed.\(baseURL.absoluteString)" }
    var confirmedAppearanceKey: String { "appearance.confirmed.\(baseURL.absoluteString)" }
    var snapshotsDirectory: String?

    init(baseURL: URL, demo: Bool, snapshotsDirectory: String?) {
        self.baseURL = baseURL; self.demo = demo; self.snapshotsDirectory = snapshotsDirectory
        testProfile = CommandLine.arguments.contains("--test-profile")
        defaults = demo || testProfile
            ? (UserDefaults(suiteName: "local.youjian.desktop.demo") ?? .standard)
            : .standard
        tracker = MessageTracker(cursor: defaults.string(forKey: "cursor.\(baseURL.absoluteString)"), pendingID: defaults.string(forKey: "pending.\(baseURL.absoluteString)"))
        super.init()
        visualStudio = VisualStudioController(library: photoLibrary, defaults: defaults) { [weak self] selection, settings in
            self?.postAppearance(selection: selection, settings: settings)
        }
        sceneImageStudio = SceneImageStudioController(baseURL:baseURL,defaults:defaults) { [weak self] in
            guard let self,self.panel != nil else{return}
            if self.sceneImageStudio.snapshot?.enabled == true {self.defaults.set("photo",forKey:"pet.renderer")}
            self.refreshPetAppearance();self.updateMenu()
        }
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        installMainMenu()
        panel = PetPanel(contentRect: NSRect(x: 0, y: 0, width: 300, height: 478), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "林雨薇 · 桌面陪伴"
        panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = false
        panel.level = .floating; panel.hidesOnDeactivate = false; panel.isFloatingPanel = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.isReleasedWhenClosed = false
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 478))
        panel.contentView = content
        pet.scene = character.scene; pet.pointOfView = character.camera
        pet.backgroundColor = .clear; pet.antialiasingMode = .multisampling4X
        pet.preferredFramesPerSecond = 24; pet.isPlaying = true; pet.rendersContinuously = false
        pet.setAccessibilityElement(true); pet.setAccessibilityRole(.button)
        pet.setAccessibilityLabel("林雨薇 3D 备用角色，单击聊天，双击关心她，再次双击表达亲昵，拖动调整位置，右键打开菜单")
        pet.clicked = { [weak self] in self?.openChat() }
        pet.attention = { [weak self] in self?.requestDesktopAttention() }
        pet.moved = { [weak self] in self?.clampPosition(); self?.savePosition() }
        pet.showMenu = { [weak self] event in guard let self else { return }; NSMenu.popUpContextMenu(self.makeMenu(), with: event, for: self.pet) }
        photoPet.setAccessibilityElement(true); photoPet.setAccessibilityRole(.button)
        photoPet.setAccessibilityLabel("林雨薇照片角色，单击聊天，双击关心她，再次双击表达亲昵，拖动调整位置，右键打开菜单")
        photoPet.clicked = { [weak self] in self?.openChat() }
        photoPet.attention = { [weak self] in self?.requestDesktopAttention() }
        photoPet.moved = { [weak self] in self?.clampPosition(); self?.savePosition() }
        photoPet.showMenu = { [weak self] event in guard let self else { return }; NSMenu.popUpContextMenu(self.makeMenu(), with: event, for: self.photoPet) }
        sceneCanvas.uploadedView.clicked = { [weak self] in self?.openChat() }
        sceneCanvas.uploadedView.attention = { [weak self] in self?.requestDesktopAttention() }
        sceneCanvas.uploadedView.moved = { [weak self] in self?.clampPosition();self?.savePosition() }
        sceneCanvas.uploadedView.showMenu = { [weak self] event in guard let self else{return};NSMenu.popUpContextMenu(self.makeMenu(),with:event,for:self.sceneCanvas.uploadedView) }
        sceneCanvas.uploadedView.setAccessibilityElement(true);sceneCanvas.uploadedView.setAccessibilityRole(.button)
        sceneCanvas.uploadedView.setAccessibilityLabel("林雨薇场景图片，单击聊天，双击关心她，再次双击表达亲昵，拖动调整位置，右键切换场景图片")
        bubble.clicked = { [weak self] in self?.openChat() }
        content.addSubview(pet); content.addSubview(sceneCanvas); content.addSubview(bubble)
        bubble.shouldSuppress = { [weak self] in self?.isChatWindowVisible ?? false }
        bubble.show("点击我就能聊天。拖动换个位置，右键可以试试不同姿态。", title: "林雨薇 · 桌面陪伴", message: false)
        previewUntil = Date().addingTimeInterval(12)
        resize(scale)
        if defaults.object(forKey: "x") != nil {
            panel.setFrameOrigin(NSPoint(x: defaults.double(forKey: "x"), y: defaults.double(forKey: "y")))
        } else if let screen = NSScreen.main {
            panel.setFrameOrigin(NSPoint(x: screen.visibleFrame.maxX - panel.frame.width - 24, y: screen.visibleFrame.minY + 12))
        }
        clampPosition(); panel.orderFrontRegardless()
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status.button?.image = NSImage(systemSymbolName: "heart.bubble", accessibilityDescription: "有间桌面")
        updateMenu()
        mouseTimer = Timer.scheduledTimer(withTimeInterval: 0.10, repeats: true) { [weak self] _ in self?.updateMousePassThrough() }
        NotificationCenter.default.addObserver(self, selector: #selector(screenChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(woke), name: NSWorkspace.didWakeNotification, object: nil)
        if demo {
            connected = true
            wardrobe = .demo
            wardrobeOnline = true
            if let manifest = photoLibrary.manifest, let current = firstCompatibleVisualSelection(in: manifest) {
                appearance = AppearanceSnapshot(manifest: manifest, current: current,
                    settings: .init(automatic: true, locked: false,
                                    sceneCardEnabled: defaults.bool(forKey: "appearance.sceneCardEnabled"),
                                    reduceMotion: defaults.bool(forKey: "appearance.reduceMotion")),
                    revision: 0, resolution: nil)
                appearanceOnline = true
            }
            if let value = argument("--pose"), let pose = CompanionPose(rawValue: value) { manualPose = pose; character.setPose(pose, animated: false) }
            refreshPetAppearance(animated: false)
            bubble.show("刚读到一段很喜欢的话，想和你聊聊。", title: "预览消息 · 不会写入聊天", message: true)
            previewUntil = .distantFuture
            updateMenu()
        } else {
            loadConfirmedWardrobe()
            loadConfirmedAppearance()
            refreshPetAppearance(animated: false)
            poll(); pollTimer = Timer.scheduledTimer(withTimeInterval: 8, repeats: true) { [weak self] _ in self?.poll() }
        }
        if snapshotsDirectory != nil { exportSnapshots() }
        if CommandLine.arguments.contains("--show-studio") {
            DispatchQueue.main.asyncAfter(deadline:.now()+2) { [weak self] in self?.openVisualStudio() }
        }
        if CommandLine.arguments.contains("--test-profile"), argument("--check-chat") != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.openChat() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
                guard let self, !self.chatCheckFinished else { return }
                self.finishChatCheck(["ok": false, "error": "WebKit rendering timed out"])
            }
        }
    }
    func endpoint(_ path: String) -> URL { baseURL.appendingPathComponent(path) }
    func installMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); let appMenu = NSMenu()
        let quit = NSMenuItem(title: "退出有间桌面", action: #selector(quit), keyEquivalent: "q"); quit.target = self
        appMenu.addItem(quit); appItem.submenu = appMenu; main.addItem(appItem)
        let fileItem = NSMenuItem(title: "文件", action: nil, keyEquivalent: "")
        let file = NSMenu(title: "文件")
        // Leave the target unset so AppKit sends Command-W to the active window.
        file.addItem(NSMenuItem(title: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        fileItem.submenu = file; main.addItem(fileItem)
        let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: ""); let edit = NSMenu(title: "编辑")
        for (title, action, key) in [("撤销","undo:","z"),("剪切","cut:","x"),("复制","copy:","c"),("粘贴","paste:","v"),("全选","selectAll:","a")] {
            edit.addItem(NSMenuItem(title: title, action: Selector(action), keyEquivalent: key))
        }
        editItem.submenu = edit; main.addItem(editItem); NSApp.mainMenu = main
    }
    func read<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        var request = URLRequest(url: endpoint(path)); request.timeoutInterval = 6; request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200, data.count < 20_000_000 else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(type, from: data)
    }
    func readIfAvailable<T: Decodable>(_ path: String, as type: T.Type) async -> T? {
        try? await read(path, as: type)
    }
    func poll() {
        guard !polling else { return }; polling = true
        sceneImageStudio.refresh()
        Task { @MainActor in
            defer { polling = false }
            do {
                async let conversation = read("api/conversations/miyue", as: ConversationSnapshot.self)
                async let inbox = read("api/inbox", as: InboxSnapshot.self)
                async let canonicalWardrobe: WardrobeSnapshot? = readIfAvailable("api/wardrobe", as: WardrobeSnapshot.self)
                async let canonicalAppearance: AppearanceSnapshot? = readIfAvailable("api/appearance", as: AppearanceSnapshot.self)
                let (snapshot, unread, wardrobeSnapshot, appearanceSnapshot) = try await (conversation, inbox, canonicalWardrobe, canonicalAppearance)
                let wasOffline = !connected; connected = true
                let wardrobeWasOnline = wardrobeOnline
                wardrobeOnline = wardrobeSnapshot != nil
                if let wardrobeSnapshot { acceptWardrobe(wardrobeSnapshot) }
                appearanceOnline = appearanceSnapshot != nil
                if let appearanceSnapshot { acceptAppearance(appearanceSnapshot) }
                if wardrobeWasOnline != wardrobeOnline { refreshWardrobeWindow() }
                if let message = tracker.ingest(snapshot.messages, unreadIDs: Set(unread.items.filter { $0.role == "miyue" }.map(\.messageId))) {
                    lastMessage = message
                    showMessage(message)
                    // The photo renderer is intentionally static. The legacy renderer may still greet.
                    if !usingPhotoRenderer && character.pose != .sleeping { character.greet() }
                } else if wasOffline && !bubble.isMessage && Date() > previewUntil { bubble.isHidden = true }
                persistCursor()
                if Date().timeIntervalSince(lastLifeCheck) >= 60 {
                    if let life = try? await read("api/life", as: LifeSnapshot.self) {
                        world = life; lastLifeCheck = Date()
                        if let wardrobeSnapshot = life.wardrobe {
                            let wardrobeWasOnline = wardrobeOnline
                            wardrobeOnline = true; acceptWardrobe(wardrobeSnapshot)
                            if wardrobeWasOnline != wardrobeOnline { refreshWardrobeWindow() }
                        }
                        if manualPose == nil, let pose = CompanionPose(rawValue: life.poseID) { character.setPose(pose) }
                        refreshPetAppearance()
                        pet.setAccessibilityValue("\(life.world.location)，\(life.world.activity)")
                        photoPet.setAccessibilityValue("\(life.world.location)，\(life.world.activity)")
                    }
                }
                if wasOffline, let web, web.url == nil || web.url?.scheme == "about" { web.load(URLRequest(url: baseURL)) }
                updateMenu()
            } catch {
                connected = false
                wardrobeOnline = false
                appearanceOnline = false
                refreshWardrobeWindow()
                if !bubble.isMessage && Date() > previewUntil {
                    bubble.show("暂时连不上有间服务，正在自动重连。", title: "连接暂停", message: false)
                }
                updateMenu()
            }
        }
    }
    func showMessage(_ message: DesktopMessage) {
        let count = tracker.pendingCount > 1 ? " · \(tracker.pendingCount) 条新消息" : " · 有新消息"
        bubble.show(bubbleExcerpt(message.text, privatePreview: privatePreview), title: "林雨薇\(count)", message: true)
    }
    func requestDesktopAttention() {
        let now = Date()
        guard !demo else {
            bubble.show("演示里也收到了你的关心。", title: "桌面演示 · 不会写入聊天", message: false)
            return
        }
        switch attentionCoordinator.receiveDouble(at: now) {
        case .queuedAffection:
            bubble.show("她会接着回应你的亲近。", title: "正在传达", message: false)
        case let .start(level):
            startDesktopAttention(level: level.rawValue)
        }
    }
    private func startDesktopAttention(level: String, showPending: Bool = true) {
        previewUntil = Date().addingTimeInterval(130)
        if showPending { bubble.show("她正在想怎么回应你…", title: "正在传达", message: false) }
        let requestID = UUID().uuidString
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if let followup = self.attentionCoordinator.complete() {
                    // Keep the completed care reply visible while the retained
                    // affectionate follow-up is being generated.
                    self.startDesktopAttention(level: followup.rawValue, showPending: false)
                }
            }
            do {
                let response = try await self.postDesktopAttention(requestID: requestID, level: level)
                let responseMessage = response.messages.last(where: { $0.speaker == "assistant" })
                if let message = self.tracker.recordDelivered(response.messages) {
                    self.lastMessage = message
                    self.showMessage(message)
                    self.persistCursor()
                    self.updateMenu()
                } else if let responseMessage, self.lastMessage == nil || self.lastMessage?.id == responseMessage.id {
                    self.lastMessage = responseMessage
                    self.showMessage(responseMessage)
                }
                self.poll()
            } catch DesktopAttentionCancelled.modelCancelled {
                self.attentionCoordinator.cancel()
                self.previewUntil = Date().addingTimeInterval(10)
                self.bubble.show("已接着你的聊天回复。", title: "林雨薇", message: false)
                self.poll()
            } catch {
                self.previewUntil = Date().addingTimeInterval(10)
                self.bubble.show("这次没能传达出去，请稍后再试。", title: "连接暂时有问题", message: false)
            }
        }
    }
    private func postDesktopAttention(requestID: String, level: String) async throws -> DesktopAttentionResponse {
        let payload = try JSONSerialization.data(withJSONObject: ["requestId": requestID, "level": level])
        let deadline = Date().addingTimeInterval(125)
        var transportRetries = 0
        while Date() < deadline {
            var request = URLRequest(url: endpoint("api/desktop/attention"))
            request.httpMethod = "POST"; request.httpBody = payload
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.timeoutInterval = min(65, max(1, deadline.timeIntervalSinceNow))
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse else { throw DesktopAttentionError(message: "服务响应无效") }
                if http.statusCode == 200 { return try JSONDecoder().decode(DesktopAttentionResponse.self, from: data) }
                let errorCode = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["code"] as? String
                if http.statusCode == 409, errorCode == "MODEL_CANCELLED" { throw DesktopAttentionCancelled.modelCancelled }
                if http.statusCode == 409, errorCode == "ROLE_BUSY", Date().addingTimeInterval(2) < deadline {
                    try await Task.sleep(nanoseconds: 2_000_000_000)
                    continue
                }
                if http.statusCode == 409 { throw DesktopAttentionError(message: errorCode ?? "请求冲突") }
                throw DesktopAttentionError(message: "服务返回 \(http.statusCode)")
            } catch is CancellationError { throw CancellationError() }
            catch {
                guard let urlError = error as? URLError,
                      [URLError.timedOut, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed].contains(urlError.code),
                      transportRetries == 0,
                      Date().addingTimeInterval(1) < deadline else {
                    throw error
                }
                transportRetries += 1
                try await Task.sleep(nanoseconds: 800_000_000)
                continue
            }
        }
        throw DesktopAttentionError(message: "传达超时")
    }
    func persistCursor() {
        defaults.set(tracker.cursor, forKey: "cursor.\(baseURL.absoluteString)")
        defaults.set(tracker.pendingID, forKey: "pending.\(baseURL.absoluteString)")
    }
    var isChatWindowVisible: Bool {
        guard let chatWindow else { return false }
        return chatWindow.isVisible && !chatWindow.isMiniaturized
    }
    private func synchronizeBubbleWithChatWindow() {
        if isChatWindowVisible { bubble.isHidden = true }
    }
    @objc func openChat() {
        if chatWindow == nil {
            let config = WKWebViewConfiguration()
            config.websiteDataStore = demo || testProfile ? .nonPersistent() : .default()
            let contentSize = NSSize(width: 1000, height: 740)
            let container = NSView(frame: NSRect(origin: .zero, size: contentSize))
            container.autoresizingMask = [.width, .height]
            let browser = WKWebView(frame: container.bounds, configuration: config)
            browser.autoresizingMask = [.width, .height]
            browser.navigationDelegate = self; browser.uiDelegate = self
            browser.allowsBackForwardNavigationGestures = false
            container.addSubview(browser)
            let window = NSWindow(contentRect: NSRect(origin: .zero, size: contentSize), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window.title = demo ? "有间 · 桌面预览（演示）" : "有间 · 和林雨薇聊聊"
            window.minSize = NSSize(width: 600, height: 500); window.isReleasedWhenClosed = false
            window.contentView = container; window.setContentSize(contentSize); window.delegate = self; window.center()
            web = browser; chatWindow = window
            if demo { browser.loadHTMLString("<meta charset='utf-8'><body style='background:#f6f0e9;font:20px -apple-system;padding:60px;color:#54434b'><h2>聊天窗口已打开</h2><p>这是独立演示，不会发送消息或更改正式聊天记录。</p><p>正常启动时，这里连接你现有的有间聊天、记忆和声音设置。</p></body>", baseURL: nil) }
            else { browser.load(URLRequest(url: baseURL)) }
        }
        if chatWindow?.isMiniaturized == true { chatWindow?.deminiaturize(nil) }
        NSApp.activate(ignoringOtherApps: true); chatWindow?.makeKeyAndOrderFront(nil)
        if !demo { selectLin() }
        // Opening is only a local preview acknowledgement. The web app owns server-side read receipts.
        tracker.acknowledge(); persistCursor(); bubble.isHidden = true; bubble.isMessage = false; updateMenu()
    }
    func windowDidDeminiaturize(_ notification: Notification) {
        guard let restoredWindow = notification.object as? NSWindow, restoredWindow === chatWindow else { return }
        synchronizeBubbleWithChatWindow()
    }
    func windowDidBecomeKey(_ notification: Notification) {
        guard let activeWindow = notification.object as? NSWindow, activeWindow === chatWindow else { return }
        synchronizeBubbleWithChatWindow()
    }
    func selectLin() {
        web?.evaluateJavaScript("document.querySelector('.role-button[data-role=\"miyue\"]')?.click()", completionHandler: nil)
    }
    func finishChatCheck(_ result: [String: Any]) {
        guard !chatCheckFinished, CommandLine.arguments.contains("--test-profile"), let directory = argument("--check-chat") else { return }
        chatCheckFinished = true
        let root = URL(fileURLWithPath: directory, isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: root.appendingPathComponent("chat-check.json"))
        }
        print("Native chat self-check: \(result["ok"] ?? false)"); fflush(stdout)
        NSApp.terminate(nil)
    }
    func captureChatCheck(_ view: WKWebView) {
        guard CommandLine.arguments.contains("--test-profile"), let directory = argument("--check-chat"), !chatCheckFinished else { return }
        view.evaluateJavaScript("({width:innerWidth,height:innerHeight,fixture:document.body.innerText.includes('桌面连接测试')})") { [weak self] value,error in
            guard let self else { return }
            let metrics = value as? [String:Any] ?? [:]
            let valid = (metrics["fixture"] as? Bool == true) && view.bounds.width > 500 && view.bounds.height > 400 && error == nil
            view.takeSnapshot(with: nil) { image,snapshotError in
                var result: [String:Any] = ["ok": valid && image != nil && snapshotError == nil, "viewport": metrics, "frame": NSStringFromRect(view.frame)]
                if let image, let tiff=image.tiffRepresentation, let png=NSBitmapImageRep(data:tiff)?.representation(using:.png,properties:[:]) {
                    let root=URL(fileURLWithPath:directory,isDirectory:true)
                    try? FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
                    try? png.write(to:root.appendingPathComponent("chat.png"))
                    result["snapshotBytes"] = png.count
                }
                self.finishChatCheck(result)
            }
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if CommandLine.arguments.contains("--test-profile"), argument("--check-chat") != nil {
            DispatchQueue.main.asyncAfter(deadline:.now()+0.5) { [weak self] in self?.captureChatCheck(webView) }
        }
        if testProfile {
            let url = webView.url?.absoluteString ?? "nil"
            fputs("[desktop-test] WKWebView didFinish url=\(url) frame=\(NSStringFromRect(webView.frame)) bounds=\(NSStringFromRect(webView.bounds)) windowVisible=\(webView.window?.isVisible == true)\n", stderr)
        }
        if !demo {
            webView.evaluateJavaScript("""
            (()=>{let n=0;const t=setInterval(()=>{const b=document.querySelector('.role-button[data-role="miyue"]');if(b){b.click();clearInterval(t)}else if(++n>50)clearInterval(t)},200)})();
            """, completionHandler: nil)
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "about" || (url.scheme == baseURL.scheme && url.host == baseURL.host && url.port == baseURL.port) {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            if action.navigationType == .linkActivated, ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }; return nil
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let picker = NSOpenPanel(); picker.canChooseFiles = true; picker.canChooseDirectories = false
        picker.allowsMultipleSelection = parameters.allowsMultipleSelection
        guard let chatWindow else { completionHandler(nil); return }
        picker.beginSheetModal(for: chatWindow) { result in completionHandler(result == .OK ? picker.urls : nil) }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        webView.loadHTMLString("<meta charset='utf-8'><body style='font:18px -apple-system;padding:48px;background:#faf5ee;color:#51434b'><h2>有间服务暂时没有连接</h2><p>请启动有间后台；连接恢复后会自动重新打开聊天。</p><p>也可以从菜单栏选择「重新连接」。</p></body>", baseURL: nil)
    }
    var displayedOutfitID: String? {
        demo ? (wardrobePreviewOutfitID ?? wardrobe?.current.outfitId) : wardrobe?.current.outfitId
    }
    var displayedOutfit: WardrobeSnapshot.Outfit? {
        guard let id = displayedOutfitID else { return nil }
        return wardrobe?.catalog.first(where: { $0.id == id })
    }
    func richAppearanceLines(_ snapshot: AppearanceSnapshot) -> [String] {
        let current = snapshot.current, manifest = snapshot.manifest
        let hair = manifest.hairstyles.first(where: { $0.id == current.hairstyleId })?.name ?? current.hairstyleId
        let outfit = manifest.outfits.first(where: { $0.id == current.outfitId })?.name ?? current.outfitId
        let palette = manifest.palettes?.first(where: { $0.id == current.paletteId })?.name
        let pose = manifest.poses.first(where: { $0.id == current.poseId })?.name ?? current.poseId
        let expression = manifest.expressions.first(where: { $0.id == current.expressionId })?.name ?? current.expressionId
        let look = [hair, outfit, palette].compactMap { $0 }.joined(separator: " · ")
        var lines = ["当前形象：\(look)", "姿态与表情：\(pose) · \(expression)"]
        if let sceneID = current.sceneId,
           let scene = manifest.scenes.first(where: { $0.id == sceneID }) {
            let season = current.season.flatMap { $0 == "auto" ? nil : ["spring":"春季", "summer":"夏季", "autumn":"秋季", "winter":"冬季"][$0] }
            lines.append("场景：\(scene.name)\(season.map { " · \($0)" } ?? "")")
        } else { lines.append("场景：人物单独显示") }
        return lines
    }
    func acceptWardrobe(_ snapshot: WardrobeSnapshot) {
        if let wardrobe, snapshot.revision < wardrobe.revision { return }
        guard wardrobe != snapshot else { return }
        wardrobe = snapshot
        if !demo, let encoded = try? JSONEncoder().encode(snapshot) { defaults.set(encoded, forKey: confirmedWardrobeKey) }
        if !demo { wardrobePreviewOutfitID = nil }
        refreshPetAppearance()
        refreshWardrobeWindow()
    }
    func loadConfirmedWardrobe() {
        guard let data = defaults.data(forKey: confirmedWardrobeKey),
              let snapshot = try? JSONDecoder().decode(WardrobeSnapshot.self, from: data) else { return }
        wardrobe = snapshot
    }
    func acceptAppearance(_ snapshot: AppearanceSnapshot) {
        if let appearance, snapshot.revision < appearance.revision { return }
        guard appearance != snapshot else { return }
        appearance = snapshot
        photoLibrary.update(manifest: snapshot.manifest)
        if !demo, let encoded = try? JSONEncoder().encode(snapshot) { defaults.set(encoded, forKey: confirmedAppearanceKey) }
        defaults.set(snapshot.settings.automatic, forKey: "appearance.automatic")
        defaults.set(snapshot.settings.locked, forKey: "appearance.locked")
        defaults.set(snapshot.settings.sceneCardEnabled, forKey: "appearance.sceneCardEnabled")
        defaults.set(snapshot.settings.reduceMotion, forKey: "appearance.reduceMotion")
        refreshPetAppearance()
        visualStudio.update(snapshot: snapshot)
    }
    func loadConfirmedAppearance() {
        guard let data = defaults.data(forKey: confirmedAppearanceKey),
              let snapshot = try? JSONDecoder().decode(AppearanceSnapshot.self, from: data) else { return }
        appearance = snapshot
        photoLibrary.update(manifest: snapshot.manifest)
    }
    func refreshPetAppearance(animated: Bool = true) {
        let pose = requestedPose
        character.setPose(pose, animated: animated)
        let resolved = appearance.flatMap { photoLibrary.resolved(selection: $0.current) }
        let outfitID = displayedOutfitID ?? WardrobeSnapshot.demo.current.outfitId
        let legacy = appearance == nil ? photoLibrary.legacyAsset(outfitID: outfitID, poseID: displayedPhotoPoseID) : nil
        let asset = prefersPhotoRenderer ? (resolved?.asset ?? legacy) : nil
        let uploaded = prefersPhotoRenderer && shouldRenderUploadedScene(snapshot: sceneImageStudio.snapshot,
                                                                          activeImage: sceneImageStudio.activeImage)
        sceneCanvas.uploadedSceneEnabled = uploaded
        sceneCanvas.uploadedView.image = sceneImageStudio.activeImage
        sceneCanvas.uploadedView.fit = sceneImageStudio.snapshot?.active?.fit ?? "contain"
        photoPet.asset = asset
        sceneCanvas.isHidden = !uploaded && asset == nil
        pet.isHidden = uploaded || asset != nil
        pet.isPlaying = !uploaded && asset == nil && panel?.isVisible == true
        let appearanceSettings = appearance?.settings
        sceneCanvas.sceneCardEnabled = appearanceSettings?.sceneCardEnabled ?? defaults.bool(forKey: "appearance.sceneCardEnabled")
        sceneCanvas.reduceMotion = appearanceSettings?.reduceMotion ?? defaults.bool(forKey: "appearance.reduceMotion")
        sceneCanvas.scene = appearance.flatMap { photoLibrary.scene(id: $0.current.sceneId) }
        sceneCanvas.backdrop = appearance.flatMap { photoLibrary.sceneImage(id: $0.current.sceneId) }
        sceneCanvas.setMotionRequested(panel?.isVisible == true)
        photoPet.setAccessibilityHidden(uploaded || asset == nil)
        pet.setAccessibilityHidden(uploaded || asset != nil)
        positionBubbleAboveHead()
    }
    func postAppearance(selection: VisualSelection, settings: AppearanceSnapshot.Settings) {
        guard !demo else {
            if let manifest = photoLibrary.manifest {
                appearance = AppearanceSnapshot(manifest: manifest, current: selection, settings: settings,
                                                revision: (appearance?.revision ?? 0) + 1, resolution: nil)
                refreshPetAppearance(); visualStudio.update(snapshot: appearance!)
            }
            return
        }
        guard connected, appearanceOnline else {
            showAppearanceError(WardrobeServiceError(message: "形象服务暂时不可用；当前桌面没有改变。")); return
        }
        var patch: [String: Any] = [
            "hairstyleId": selection.hairstyleId, "outfitId": selection.outfitId,
            "poseId": selection.poseId, "expressionId": selection.expressionId,
            "automatic": settings.automatic, "locked": settings.locked,
            "sceneCardEnabled": settings.sceneCardEnabled, "reduceMotion": settings.reduceMotion
        ]
        if let id = selection.assetId { patch["assetId"] = id }
        if let id = selection.sceneId { patch["sceneId"] = id } else { patch["sceneId"] = NSNull() }
        if let id = selection.paletteId { patch["paletteId"] = id } else { patch["paletteId"] = NSNull() }
        if let season = selection.season { patch["season"] = season } else { patch["season"] = NSNull() }
        Task { @MainActor in
            do {
                var request = URLRequest(url: endpoint("api/appearance")); request.httpMethod = "POST"; request.timeoutInterval = 8
                request.cachePolicy = .reloadIgnoringLocalCacheData
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: patch)
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse, data.count < 20_000_000 else { throw URLError(.badServerResponse) }
                guard http.statusCode == 200 else {
                    let detail = (try? JSONDecoder().decode(WardrobeErrorPayload.self, from: data).error) ?? "服务拒绝了不可用的照片组合。"
                    throw WardrobeServiceError(message: detail)
                }
                acceptAppearance(try JSONDecoder().decode(AppearanceSnapshot.self, from: data))
            } catch { showAppearanceError(error) }
        }
    }
    func showAppearanceError(_ error: Error) {
        visualStudio.applicationFailed(error.localizedDescription.isEmpty ? "没有应用；请检查当前组合后重试。" : error.localizedDescription)
        let alert = NSAlert(); alert.alertStyle = .warning
        alert.messageText = "形象设置没有应用"
        alert.informativeText = error.localizedDescription.isEmpty ? "请选择一个完整可用的照片组合。" : error.localizedDescription
        alert.addButton(withTitle: "好"); NSApp.activate(ignoringOtherApps: true)
        if let window = visualStudio.window, window.isVisible { alert.beginSheetModal(for: window) } else { alert.runModal() }
    }
    func postWardrobe(_ patch: [String: Any]) {
        guard !demo, connected, wardrobeOnline, !wardrobeBusy else { return }
        wardrobeBusy = true; updateMenu(); refreshWardrobeWindow()
        Task { @MainActor in
            defer { wardrobeBusy = false; updateMenu(); refreshWardrobeWindow() }
            do {
                var request = URLRequest(url: endpoint("api/wardrobe"))
                request.httpMethod = "POST"
                request.timeoutInterval = 8
                request.cachePolicy = .reloadIgnoringLocalCacheData
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: patch)
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse, data.count < 1_000_000 else { throw URLError(.badServerResponse) }
                guard http.statusCode == 200 else {
                    let detail = (try? JSONDecoder().decode(WardrobeErrorPayload.self, from: data).error) ?? "有间服务没有接受这次修改。"
                    throw WardrobeServiceError(message: detail)
                }
                let canonical = try JSONDecoder().decode(WardrobeSnapshot.self, from: data)
                wardrobeOnline = true
                acceptWardrobe(canonical)
            } catch {
                if error is URLError { wardrobeOnline = false }
                showWardrobeError(error)
            }
        }
    }
    func showWardrobeError(_ error: Error) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "衣柜设置没有保存"
        alert.informativeText = error.localizedDescription.isEmpty ? "请确认有间服务已连接后再试。" : error.localizedDescription
        alert.addButton(withTitle: "好")
        NSApp.activate(ignoringOtherApps: true)
        if let wardrobeWindow, wardrobeWindow.isVisible { alert.beginSheetModal(for: wardrobeWindow) }
        else { alert.runModal() }
    }
    func wardrobeImage(outfitID: String, pose: String) -> NSImage? {
        photoLibrary.legacyAsset(outfitID: outfitID, poseID: pose)?.image
    }
    func makeWardrobeImageCard(outfitID: String, pose: String, title: String, frame: NSRect) -> NSView {
        let card = NSView(frame: frame)
        card.wantsLayer = true
        card.layer?.backgroundColor = NSColor(calibratedRed: 1, green: 0.985, blue: 0.97, alpha: 0.42).cgColor
        card.layer?.cornerRadius = 18
        card.layer?.borderWidth = 1
        card.layer?.borderColor = NSColor(calibratedRed: 0.84, green: 0.76, blue: 0.72, alpha: 0.8).cgColor
        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: 14, weight: .semibold)
        label.textColor = NSColor(calibratedRed: 0.38, green: 0.27, blue: 0.30, alpha: 1)
        label.frame = NSRect(x: 18, y: frame.height - 40, width: frame.width - 36, height: 22)
        card.addSubview(label)
        let imageView = NSImageView(frame: NSRect(x: 16, y: 16, width: frame.width - 32, height: frame.height - 62))
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.imageAlignment = .alignCenter
        imageView.wantsLayer = true
        imageView.layer?.backgroundColor = NSColor.clear.cgColor
        imageView.layer?.cornerRadius = 12
        imageView.image = wardrobeImage(outfitID: outfitID, pose: pose)
        card.addSubview(imageView)
        if imageView.image == nil {
            let missing = NSTextField(wrappingLabelWithString: "透明抠图资源缺失\n\(pose == "idle" ? "站立" : "阅读")图暂时无法显示")
            missing.alignment = .center
            missing.font = .systemFont(ofSize: 14)
            missing.textColor = .secondaryLabelColor
            missing.frame = NSRect(x: 34, y: frame.height / 2 - 28, width: frame.width - 68, height: 56)
            card.addSubview(missing)
        }
        return card
    }
    @objc func openWardrobeReview() {
        if wardrobeWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 980, height: 720), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            window.title = "林雨薇 · 穿搭样稿"
            window.appearance = NSAppearance(named: .aqua)
            window.isReleasedWhenClosed = false
            window.center()
            wardrobeWindow = window
        }
        NSApp.activate(ignoringOtherApps: true)
        wardrobeWindow?.makeKeyAndOrderFront(nil)
        refreshWardrobeWindow()
    }
    func refreshWardrobeWindow() {
        guard let window = wardrobeWindow, window.isVisible, let wardrobe, let outfit = displayedOutfit else { return }
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 980, height: 720))
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor(calibratedRed: 0.965, green: 0.935, blue: 0.90, alpha: 1).cgColor

        let title = NSTextField(labelWithString: outfit.name)
        title.font = .systemFont(ofSize: 26, weight: .bold)
        title.textColor = NSColor(calibratedRed: 0.30, green: 0.21, blue: 0.24, alpha: 1)
        title.frame = NSRect(x: 38, y: 664, width: 330, height: 34)
        content.addSubview(title)
        let description = NSTextField(wrappingLabelWithString: outfit.description)
        description.font = .systemFont(ofSize: 13)
        description.textColor = .secondaryLabelColor
        description.frame = NSRect(x: 38, y: 626, width: 560, height: 34)
        content.addSubview(description)

        let popup = NSPopUpButton(frame: NSRect(x: 650, y: 665, width: 150, height: 30), pullsDown: false)
        for entry in wardrobe.catalog {
            popup.addItem(withTitle: entry.name)
            popup.lastItem?.representedObject = entry.id
        }
        if let index = wardrobe.catalog.firstIndex(where: { $0.id == outfit.id }) { popup.selectItem(at: index) }
        popup.target = self; popup.action = #selector(reviewOutfitChanged(_:))
        popup.isEnabled = demo || (connected && wardrobeOnline && !wardrobeBusy)
        popup.toolTip = demo ? "演示预览，不会保存" : "选择后保存为当前桌面造型"
        content.addSubview(popup)

        let poses = NSSegmentedControl(labels: ["双图", "站立", "阅读"], trackingMode: .selectOne, target: self, action: #selector(reviewPoseChanged(_:)))
        poses.frame = NSRect(x: 810, y: 665, width: 140, height: 30)
        poses.selectedSegment = wardrobeReviewPose == "idle" ? 1 : wardrobeReviewPose == "reading" ? 2 : 0
        content.addSubview(poses)

        let notice = NSTextField(labelWithString: "透明照片抠图 · 桌面角色使用同一组静态素材")
        notice.font = .systemFont(ofSize: 12, weight: .medium)
        notice.textColor = NSColor(calibratedRed: 0.58, green: 0.34, blue: 0.30, alpha: 1)
        notice.alignment = .center
        notice.frame = NSRect(x: 36, y: 584, width: 908, height: 24)
        content.addSubview(notice)

        if wardrobeReviewPose == "both" {
            content.addSubview(makeWardrobeImageCard(outfitID: outfit.id, pose: "idle", title: "站立样稿", frame: NSRect(x: 38, y: 34, width: 440, height: 536)))
            content.addSubview(makeWardrobeImageCard(outfitID: outfit.id, pose: "reading", title: "阅读样稿", frame: NSRect(x: 502, y: 34, width: 440, height: 536)))
        } else {
            let poseTitle = wardrobeReviewPose == "idle" ? "站立样稿" : "阅读样稿"
            content.addSubview(makeWardrobeImageCard(outfitID: outfit.id, pose: wardrobeReviewPose, title: poseTitle, frame: NSRect(x: 270, y: 34, width: 440, height: 536)))
        }
        window.contentView = content
    }
    @objc func reviewOutfitChanged(_ sender: NSPopUpButton) {
        guard let id = sender.selectedItem?.representedObject as? String else { return }
        if demo {
            wardrobePreviewOutfitID = id; refreshPetAppearance(); refreshWardrobeWindow(); updateMenu()
        } else {
            refreshWardrobeWindow()
            postWardrobe(["outfitId": id])
        }
    }
    @objc func reviewPoseChanged(_ sender: NSSegmentedControl) {
        wardrobeReviewPose = sender.selectedSegment == 1 ? "idle" : sender.selectedSegment == 2 ? "reading" : "both"
        refreshWardrobeWindow()
    }
    @objc func chooseWardrobe(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        if demo {
            wardrobePreviewOutfitID = id; refreshPetAppearance(); refreshWardrobeWindow(); updateMenu()
        } else { postWardrobe(["outfitId": id]) }
    }
    @objc func toggleWardrobeAutomatic() {
        guard let automatic = wardrobe?.settings.automatic else { return }
        postWardrobe(["automatic": !automatic])
    }
    @objc func toggleWardrobeLock() {
        guard let locked = wardrobe?.settings.locked else { return }
        postWardrobe(["locked": !locked])
    }
    func makeWardrobeMenu() -> NSMenu {
        let menu = NSMenu(title: "衣柜")
        guard let wardrobe, let outfit = displayedOutfit else {
            let unavailable = NSMenuItem(title: "衣柜状态暂不可用", action: nil, keyEquivalent: "")
            unavailable.isEnabled = false; menu.addItem(unavailable)
            return menu
        }
        let suffix = demo ? " · 演示预览" : wardrobeBusy ? " · 保存中…" : ""
        let current = NSMenuItem(title: "当前造型：\(outfit.name)\(suffix)", action: nil, keyEquivalent: "")
        current.isEnabled = false; menu.addItem(current)
        if prefersPhotoRenderer && !usingPhotoRenderer {
            let fallback = NSMenuItem(title: photoLibrary.hasAssets ? "当前照片缺失，已显示 3D 备用角色" : "照片资源缺失，已显示 3D 备用角色", action: nil, keyEquivalent: "")
            fallback.isEnabled = false; menu.addItem(fallback)
        }
        menu.addItem(.separator())
        let choiceEnabled = demo || (connected && wardrobeOnline && !wardrobeBusy)
        for entry in wardrobe.catalog {
            let item = NSMenuItem(title: demo ? "预览 \(entry.name)" : entry.name, action: #selector(chooseWardrobe(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = entry.id; item.state = entry.id == outfit.id ? .on : .off
            item.isEnabled = choiceEnabled; menu.addItem(item)
        }
        menu.addItem(.separator())
        let writable = !demo && connected && wardrobeOnline && !wardrobeBusy
        let automatic = NSMenuItem(title: "每日 07:00 自动更换", action: #selector(toggleWardrobeAutomatic), keyEquivalent: "")
        automatic.target = self; automatic.state = wardrobe.settings.automatic ? .on : .off; automatic.isEnabled = writable
        menu.addItem(automatic)
        let locked = NSMenuItem(title: "锁定当前造型", action: #selector(toggleWardrobeLock), keyEquivalent: "")
        locked.target = self; locked.state = wardrobe.settings.locked ? .on : .off; locked.isEnabled = writable
        menu.addItem(locked)
        let review = NSMenuItem(title: "查看穿搭样稿", action: #selector(openWardrobeReview), keyEquivalent: "")
        review.target = self; menu.addItem(review)
        return menu
    }
    func makeMenu() -> NSMenu {
        let menu = NSMenu()
        func item(_ title: String, _ selector: Selector?, value: Any? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: selector, keyEquivalent: ""); i.target = self; i.representedObject = value; menu.addItem(i); return i
        }
        let richMode = appearance != nil && prefersPhotoRenderer
        _ = item("林雨薇 · \(demo ? "演示模式" : connected ? "已连接有间" : "正在重连")", nil)
        if sceneCanvas.uploadedSceneEnabled {
            _ = item("场景图片 · \(sceneImageStudio.snapshot?.active?.name ?? "已上传")",nil)
        } else if richMode, let appearance {
            for line in richAppearanceLines(appearance) { _ = item(line, nil) }
        } else { _ = item(poseStatus, nil) }
        if let world { _ = item(world.world.location, nil) }
        menu.addItem(.separator())
        _ = item(tracker.pendingCount > 0 ? "打开聊天（\(tracker.pendingCount) 条新消息）" : "打开聊天", #selector(openChat))
        _ = item("场景图片 · 上传与切换…", #selector(openVisualStudio))
        _ = item("图片素材库 · 批量上传与分类…", #selector(openImageLibrary))
        _ = item("持续生活 · 状态与安排…", #selector(openRuntimeSettings))
        _ = item("原有形象（备用）…", #selector(openLegacyVisualStudio))
        if !richMode {
            let wardrobeItem = item("衣柜", nil); wardrobeItem.submenu = makeWardrobeMenu()
        }
        let rendererMenu = NSMenu(); let renderer = item("角色外观", nil); renderer.submenu = rendererMenu
        let photo = NSMenuItem(title: "照片角色", action: #selector(chooseRenderer(_:)), keyEquivalent: "")
        photo.target = self; photo.representedObject = "photo"; photo.state = prefersPhotoRenderer ? .on : .off
        photo.isEnabled = photoLibrary.hasAssets; rendererMenu.addItem(photo)
        let old3D = NSMenuItem(title: "原 3D 角色（备用）", action: #selector(chooseRenderer(_:)), keyEquivalent: "")
        old3D.target = self; old3D.representedObject = "old3d"; old3D.state = prefersPhotoRenderer ? .off : .on
        rendererMenu.addItem(old3D)
        if appearance == nil && !photoLibrary.hasCompleteLegacySet {
            let resourceStatus = NSMenuItem(title: "照片资源不完整", action: nil, keyEquivalent: "")
            resourceStatus.isEnabled = false; rendererMenu.addItem(resourceStatus)
        }
        if let error = photoLibrary.manifestLoadError {
            let resourceError = NSMenuItem(title: error, action: nil, keyEquivalent: "")
            resourceError.isEnabled = false; rendererMenu.addItem(resourceError)
        }
        if !richMode {
            let auto = item("跟随生活状态", #selector(choosePose(_:)), value: "auto"); auto.state = manualPose == nil ? .on : .off
            let poses = NSMenu(); let parent = item("预览姿态", nil); parent.submenu = poses
            for pose in CompanionPose.allCases {
                let missingPhotoPose = prefersPhotoRenderer && ![CompanionPose.idle, .reading].contains(pose)
                let title = missingPhotoPose ? "\(pose.title)（暂无照片，显示站立）" : pose.title
                let i = NSMenuItem(title: title, action: #selector(choosePose(_:)), keyEquivalent: ""); i.target = self; i.representedObject = pose.rawValue; i.state = manualPose == pose ? .on : .off; poses.addItem(i)
            }
        }
        let sizes = NSMenu(); item("角色大小", nil).submenu = sizes
        for (name, factor) in [("小",0.8),("标准",1.0),("大",1.2)] {
            let i = NSMenuItem(title: name, action: #selector(chooseSize(_:)), keyEquivalent: ""); i.target = self; i.representedObject = factor; i.state = abs(scale - factor) < 0.01 ? .on : .off; sizes.addItem(i)
        }
        let privacy = item("隐藏气泡里的消息正文", #selector(togglePrivacy)); privacy.state = privatePreview ? .on : .off
        if richMode && !sceneCanvas.uploadedSceneEnabled, let appearance {
            let automatic = item("自动搭配与跟随生活状态", #selector(toggleAppearanceAutomatic)); automatic.state = appearance.settings.automatic ? .on : .off
            let locked = item("锁定当前形象", #selector(toggleAppearanceLock)); locked.state = appearance.settings.locked ? .on : .off
            let card = item("桌面显示场景卡片", #selector(toggleSceneCard)); card.state = appearance.settings.sceneCardEnabled ? .on : .off
            let reduce = item("减少环境动态", #selector(toggleSceneMotion)); reduce.state = appearance.settings.reduceMotion ? .on : .off
        }
        _ = item("收起当前气泡", #selector(dismissBubble))
        _ = item(panel.isVisible ? "暂时隐藏角色" : "显示角色", #selector(togglePet))
        _ = item("把角色移回屏幕右下角", #selector(resetPosition))
        _ = item("重新连接", #selector(reconnect))
        menu.addItem(.separator())
        _ = item("退出桌面陪伴", #selector(quit)).keyEquivalent = "q"
        return menu
    }
    func updateMenu() {
        status.menu = makeMenu()
        let appearanceStatus = appearance.flatMap { richAppearanceLines($0).dropFirst().first }
        status.button?.toolTip = tracker.pendingCount > 0 ? "林雨薇有新消息" : "有间桌面 · \(appearanceStatus ?? poseStatus)"
    }
    @objc func chooseRenderer(_ sender: NSMenuItem) {
        guard let renderer = sender.representedObject as? String, renderer == "photo" || renderer == "old3d" else { return }
        defaults.set(renderer, forKey: "pet.renderer")
        refreshPetAppearance()
        updateMenu()
    }
    @objc func openImageLibrary() {
        NSWorkspace.shared.open(baseURL.appendingPathComponent("image-library.html"))
    }
    @objc func openRuntimeSettings() {
        NSWorkspace.shared.open(baseURL.appendingPathComponent("runtime.html"))
    }
    @objc func openVisualStudio() {
        sceneImageStudio.show()
    }
    @objc func openLegacyVisualStudio() {
        let message: String?
        if appearance != nil { message = appearanceOnline || demo ? nil : "正在使用上次确认的形象；服务恢复后才能应用修改。" }
        else if let error = photoLibrary.manifestLoadError { message = error }
        else { message = photoLibrary.manifest == nil ? "形象清单尚未安装；暂时保留旧衣柜。" : "服务尚未提供形象状态，可先浏览本机已完成照片。" }
        visualStudio.show(snapshot: appearance, current: appearance?.current, message: message)
    }
    @objc func toggleSceneCard() {
        guard let appearance else { return }
        let settings = AppearanceSnapshot.Settings(automatic: appearance.settings.automatic, locked: appearance.settings.locked,
                                                   sceneCardEnabled: !appearance.settings.sceneCardEnabled,
                                                   reduceMotion: appearance.settings.reduceMotion)
        postAppearance(selection: appearance.current, settings: settings)
    }
    @objc func toggleAppearanceAutomatic() {
        guard let appearance else { return }
        let settings = AppearanceSnapshot.Settings(automatic: !appearance.settings.automatic, locked: appearance.settings.locked,
                                                   sceneCardEnabled: appearance.settings.sceneCardEnabled,
                                                   reduceMotion: appearance.settings.reduceMotion)
        postAppearance(selection: appearance.current, settings: settings)
    }
    @objc func toggleAppearanceLock() {
        guard let appearance else { return }
        let settings = AppearanceSnapshot.Settings(automatic: appearance.settings.automatic, locked: !appearance.settings.locked,
                                                   sceneCardEnabled: appearance.settings.sceneCardEnabled,
                                                   reduceMotion: appearance.settings.reduceMotion)
        postAppearance(selection: appearance.current, settings: settings)
    }
    @objc func toggleSceneMotion() {
        guard let appearance else { return }
        let settings = AppearanceSnapshot.Settings(automatic: appearance.settings.automatic, locked: appearance.settings.locked,
                                                   sceneCardEnabled: appearance.settings.sceneCardEnabled,
                                                   reduceMotion: !appearance.settings.reduceMotion)
        postAppearance(selection: appearance.current, settings: settings)
    }
    @objc func choosePose(_ sender: NSMenuItem) {
        manualPose = CompanionPose(rawValue: sender.representedObject as? String ?? "")
        refreshPetAppearance()
        if !bubble.isMessage {
            bubble.show(manualPose == nil ? "外观会跟随她当前的生活状态。" : "只预览动作，不会更改她的经历或聊天。", title: poseStatus, message: false)
            previewUntil = Date().addingTimeInterval(5)
        }
        updateMenu()
    }
    @objc func chooseSize(_ sender: NSMenuItem) { guard let factor = sender.representedObject as? Double else { return }; defaults.set(factor, forKey: "scale"); resize(factor); clampPosition(); savePosition(); updateMenu() }
    func resize(_ factor: CGFloat) {
        panel.setContentSize(NSSize(width: 300 * factor, height: 478 * factor))
        panel.contentView?.setBoundsSize(NSSize(width: 300, height: 478))
    }
    @objc func togglePrivacy() { defaults.set(!privatePreview, forKey: "privatePreview"); if bubble.isMessage, let lastMessage { showMessage(lastMessage) }; updateMenu() }
    @objc func dismissBubble() { bubble.isHidden = true; bubble.isMessage = false; tracker.acknowledge(); persistCursor(); updateMenu() }
    @objc func togglePet() {
        if panel.isVisible { panel.orderOut(nil); pet.isPlaying = false; sceneCanvas.setMotionRequested(false) }
        else { panel.orderFrontRegardless(); pet.isPlaying = !pet.isHidden; sceneCanvas.setMotionRequested(true) }
        updateMenu()
    }
    @objc func resetPosition() {
        if let frame = NSScreen.main?.visibleFrame { panel.setFrameOrigin(NSPoint(x: frame.maxX - panel.frame.width - 20, y: frame.minY + 12)) }
        panel.orderFrontRegardless(); pet.isPlaying = !pet.isHidden; sceneCanvas.setMotionRequested(true); savePosition(); updateMenu()
    }
    @objc func reconnect() { lastLifeCheck = .distantPast; if !demo { poll(); web?.load(URLRequest(url: baseURL)) } }
    @objc func woke() { lastLifeCheck = .distantPast; if !demo { poll() } }
    @objc func screenChanged() { clampPosition(); savePosition() }
    func clampPosition() {
        guard let screen = NSScreen.screens.max(by: { a,b in
            let x = a.visibleFrame.intersection(panel.frame), y = b.visibleFrame.intersection(panel.frame)
            return (x.isNull ? 0 : x.width*x.height) < (y.isNull ? 0 : y.width*y.height)
        }) else { return }
        let f = screen.visibleFrame, p = panel.frame
        panel.setFrameOrigin(NSPoint(x: max(f.minX, min(p.minX, f.maxX-p.width)), y: max(f.minY, min(p.minY, f.maxY-p.height))))
    }
    func savePosition() { defaults.set(panel.frame.minX, forKey: "x"); defaults.set(panel.frame.minY, forKey: "y") }
    func updateMousePassThrough() {
        guard panel.isVisible else { return }
        positionBubbleAboveHead()
        if !bubble.isHidden && !bubble.isMessage && connected && Date() > previewUntil { bubble.isHidden = true }
        // Hit-test the active renderer. Clear alpha in the photo lets desktop clicks pass through.
        let windowPoint = panel.convertPoint(fromScreen: NSEvent.mouseLocation)
        let local = usingPhotoRenderer ? photoPet.convert(windowPoint, from: nil) : pet.convert(windowPoint, from: nil)
        let bubblePoint = bubble.convert(windowPoint, from: nil)
        let overBubble = !bubble.isHidden && bubble.bounds.contains(bubblePoint)
        let overPet = usingPhotoRenderer
            ? (sceneCanvas.uploadedSceneEnabled ? sceneCanvas.uploadedView.containsImage(at:sceneCanvas.uploadedView.convert(windowPoint,from:nil)) : photoPet.containsOpaquePixel(at: local))
            : pet.bounds.contains(local) && !pet.hitTest(local, options: [.boundingBoxOnly: false]).isEmpty
        if NSEvent.pressedMouseButtons == 0 { panel.ignoresMouseEvents = !(overBubble || overPet) }
    }
    func positionBubbleAboveHead() {
        guard !bubble.isHidden else { return }
        if sceneCanvas.uploadedSceneEnabled {
            let rect=sceneCanvas.uploadedView.displayedRect
            let anchor=panel.contentView?.convert(NSPoint(x:rect.midX,y:rect.maxY),from:sceneCanvas.uploadedView) ?? .zero
            bubble.setFrameOrigin(NSPoint(x:15,y:max(75,min(344,anchor.y+8))));bubble.tailAnchor=135;return
        }
        if usingPhotoRenderer, let head = photoPet.opaqueHeadAnchor() {
            let contentHead = panel.contentView?.convert(head, from: photoPet) ?? head
            let y = max(75, min(344, contentHead.y + 14))
            let tail = max(26, min(244, contentHead.x - bubble.frame.minX))
            if abs(bubble.frame.minY - y) > 1.5 { bubble.setFrameOrigin(NSPoint(x: 15, y: y)) }
            if abs(bubble.tailAnchor - tail) > 1.5 { bubble.tailAnchor = tail; bubble.needsDisplay = true }
            return
        }
        guard let head = character.scene.rootNode.childNode(withName: "character.head", recursively: true)?.presentation else { return }
        let corners = [-0.8, 0.8].flatMap { x in [-0.9, 0.95].map { y in
            pet.projectPoint(head.convertPosition(SCNVector3(x, y, 0.2), to: nil))
        }}
        let center = pet.projectPoint(head.convertPosition(SCNVector3Zero, to: nil))
        let top = corners.map { CGFloat($0.y) }.max() ?? 320
        let y = max(75, min(344, top + 14))
        let tail = max(26, min(244, CGFloat(center.x) - bubble.frame.minX))
        if abs(bubble.frame.minY - y) > 1.5 { bubble.setFrameOrigin(NSPoint(x: 15, y: y)) }
        if abs(bubble.tailAnchor - tail) > 1.5 { bubble.tailAnchor = tail; bubble.needsDisplay = true }
    }
    @objc func quit() { savePosition(); NSApp.terminate(nil) }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { panel.orderFrontRegardless(); pet.isPlaying = !pet.isHidden; sceneCanvas.setMotionRequested(true); updateMenu(); return true }
    func applicationWillTerminate(_ notification: Notification) { pollTimer?.invalidate(); mouseTimer?.invalidate(); sceneCanvas.setMotionRequested(false) }
    func exportSnapshots() {
        guard let directory = snapshotsDirectory else { return }
        try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        if photoLibrary.hasAssets {
            if let manifest = photoLibrary.manifest {
                for record in manifest.approvedAssets {
                    let selection = VisualSelection(assetId: record.id, hairstyleId: record.hairstyleId,
                                                    outfitId: record.outfitId, poseId: record.poseId,
                                                    expressionId: record.expressionId, paletteId: record.paletteId)
                    guard let asset = photoLibrary.resolved(selection: selection)?.asset else { continue }
                    photoPet.asset = asset
                    sceneCanvas.isHidden = false
                    photoPet.display()
                    guard let bitmap = photoPet.bitmapImageRepForCachingDisplay(in: photoPet.bounds) else { continue }
                    photoPet.cacheDisplay(in: photoPet.bounds, to: bitmap)
                    try? bitmap.representation(using: .png, properties: [:])?.write(
                        to: URL(fileURLWithPath: directory).appendingPathComponent("\(record.id ?? record.file.replacingOccurrences(of: "/", with: "-"))).png")
                    )
                }
            } else {
                for outfitID in ["everyday", "soft-knit", "homewear"] {
                    for poseID in ["idle", "reading"] {
                        guard let asset = photoLibrary.legacyAsset(outfitID: outfitID, poseID: poseID) else { continue }
                        photoPet.asset = asset; sceneCanvas.isHidden = false; photoPet.display()
                        guard let bitmap = photoPet.bitmapImageRepForCachingDisplay(in: photoPet.bounds) else { continue }
                        photoPet.cacheDisplay(in: photoPet.bounds, to: bitmap)
                        try? bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(outfitID)-\(poseID).png"))
                    }
                }
            }
            refreshPetAppearance(animated: false)
        } else {
            for (index, pose) in CompanionPose.allCases.enumerated() {
                DispatchQueue.main.asyncAfter(deadline: .now() + Double(index) * 1.6 + 1) { [weak self] in
                    guard let self else { return }; self.character.setPose(pose, animated: false)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                        let bitmap = NSBitmapImageRep(data: self.pet.snapshot().tiffRepresentation!)!
                        try? bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("old3d-\(pose.rawValue).png"))
                    }
                }
            }
        }
    }
}

func argument(_ key: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: key), index + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index + 1]
}

guard let baseURL = companionBaseURL(argument("--base-url") ?? "http://127.0.0.1:8765/") else {
    fputs("仅支持本机 http://127.0.0.1:端口 或 localhost 服务地址。\n", stderr); exit(2)
}
let isDemo = CommandLine.arguments.contains("--demo")
let app = NSApplication.shared
if !isDemo, !CommandLine.arguments.contains("--test-profile"), let identifier = Bundle.main.bundleIdentifier,
   let other = NSRunningApplication.runningApplications(withBundleIdentifier: identifier).first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
    other.activate(options: []); exit(0)
}
let delegate = DesktopApp(baseURL: baseURL, demo: isDemo, snapshotsDirectory: argument("--snapshots"))
app.delegate = delegate
app.run()
