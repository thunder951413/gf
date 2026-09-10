import AppKit

final class VisualStudioController: NSObject, NSWindowDelegate {
    private let library: PhotoPetLibrary
    private let defaults: UserDefaults
    private let applyHandler: (VisualSelection, AppearanceSnapshot.Settings) -> Void
    private(set) var window: NSWindow?
    private var snapshot: AppearanceSnapshot?
    private var selection: VisualSelection?
    private var settings: AppearanceSnapshot.Settings
    private var statusText = "选择一个已经完成的写实形象组合。"
    private var previewCanvas: NativeSceneCanvas?
    private var isDirty = false
    private var pendingSelection: VisualSelection?
    private var pendingSettings: AppearanceSnapshot.Settings?

    init(library: PhotoPetLibrary, defaults: UserDefaults,
         apply: @escaping (VisualSelection, AppearanceSnapshot.Settings) -> Void) {
        self.library = library
        self.defaults = defaults
        self.applyHandler = apply
        settings = AppearanceSnapshot.Settings(
            automatic: defaults.object(forKey: "appearance.automatic") as? Bool ?? true,
            locked: defaults.bool(forKey: "appearance.locked"),
            sceneCardEnabled: defaults.bool(forKey: "appearance.sceneCardEnabled"),
            reduceMotion: defaults.bool(forKey: "appearance.reduceMotion"))
        super.init()
    }

    func show(snapshot: AppearanceSnapshot?, current: VisualSelection?, message: String? = nil) {
        if let snapshot {
            self.snapshot = snapshot
            if window?.isVisible != true || !isDirty {
                selection = snapshot.current
                settings = snapshot.settings
                isDirty = false
            }
            if let reason = snapshot.resolution?.reason { statusText = "服务已采用可用形象：\(reason)" }
        } else if let current { selection = current }
        if selection == nil, let manifest = snapshot?.manifest ?? library.manifest {
            selection = firstCompatibleVisualSelection(in: manifest)
        }
        if let message { statusText = message }
        if window == nil {
            let created = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 760),
                                   styleMask: [.titled, .closable, .miniaturizable, .resizable],
                                   backing: .buffered, defer: false)
            created.title = "林雨薇 · 形象工坊"
            created.minSize = NSSize(width: 1120, height: 760)
            created.isReleasedWhenClosed = false
            created.appearance = NSAppearance(named: .aqua)
            created.delegate = self
            if !created.setFrameUsingName("VisualStudioWindow") { created.center() }
            created.setFrameAutosaveName("VisualStudioWindow")
            window = created
        }
        rebuild()
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func update(snapshot: AppearanceSnapshot) {
        self.snapshot = snapshot
        if window?.isVisible != true { return }
        if pendingSelection == snapshot.current && pendingSettings == snapshot.settings {
            selection = snapshot.current; settings = snapshot.settings
            pendingSelection = nil; pendingSettings = nil; isDirty = false
            statusText = "已应用到当前桌面。"
        } else if isDirty {
            statusText = "后台形象有更新；你尚未应用的选择已保留。"
        } else {
            selection = snapshot.current; settings = snapshot.settings
            statusText = snapshot.resolution?.reason.map { "服务已采用可用形象：\($0)" } ?? "已同步当前形象。"
        }
        rebuild()
    }

    func applicationFailed(_ message: String) {
        pendingSelection = nil; pendingSettings = nil
        statusText = message
        if window?.isVisible == true { rebuild() }
    }

    private var manifest: VisualManifest? { snapshot?.manifest ?? library.manifest }
    private var approved: [VisualAssetRecord] { manifest?.approvedAssets ?? [] }

    private func rebuild() {
        guard let window else { return }
        let root = NSView(frame: NSRect(origin: .zero, size: window.contentLayoutRect.size))
        root.autoresizingMask = [.width, .height]
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor(calibratedRed: 0.94, green: 0.91, blue: 0.88, alpha: 1).cgColor

        let preview = NativeSceneCanvas(frame: NSRect(x: 24, y: 62, width: 674, height: max(570, root.bounds.height - 86)))
        preview.autoresizingMask = [.height]
        preview.sceneCardEnabled = selection?.sceneId != nil
        preview.reduceMotion = settings.reduceMotion
        preview.scene = library.scene(id: selection?.sceneId)
        preview.backdrop = library.sceneImage(id: selection?.sceneId)
        if let selection, let resolved = library.resolved(selection: selection) { preview.figureView.asset = resolved.asset }
        preview.figureView.setAccessibilityElement(true)
        preview.figureView.setAccessibilityLabel("当前写实形象预览")
        root.addSubview(preview); previewCanvas = preview

        let title = label("形象工坊", size: 27, weight: .bold)
        title.frame = NSRect(x: 730, y: root.bounds.height - 62, width: 350, height: 36)
        title.autoresizingMask = [.minXMargin, .minYMargin]; root.addSubview(title)
        let subtitle = NSTextField(wrappingLabelWithString: "给她挑一套穿搭、一个表情和今天的风景。这里只列出已经准备好的完整形象。")
        subtitle.font = .systemFont(ofSize: 12); subtitle.textColor = .secondaryLabelColor
        subtitle.frame = NSRect(x: 730, y: root.bounds.height - 112, width: 350, height: 42)
        subtitle.autoresizingMask = [.minXMargin, .minYMargin]; root.addSubview(subtitle)

        var y = root.bounds.height - 157
        addPopup(title: "完整形象", dimension: "asset", y: &y, to: root)
        addPopup(title: "发型", dimension: "hairstyle", y: &y, to: root)
        addPopup(title: "穿搭", dimension: "outfit", y: &y, to: root)
        addPopup(title: "配色", dimension: "palette", y: &y, to: root)
        addPopup(title: "姿态", dimension: "pose", y: &y, to: root)
        addPopup(title: "表情", dimension: "expression", y: &y, to: root)
        addPopup(title: "场景", dimension: "scene", y: &y, to: root)
        addPopup(title: "季节", dimension: "season", y: &y, to: root)

        let sceneCard = checkbox("桌面显示场景卡片", checked: settings.sceneCardEnabled,
                                 action: #selector(settingChanged(_:)), tag: 1)
        sceneCard.frame = NSRect(x: 730, y: y - 4, width: 180, height: 24); sceneCard.autoresizingMask = [.minXMargin, .minYMargin]; root.addSubview(sceneCard)
        let reduce = checkbox("减少环境动态", checked: settings.reduceMotion,
                              action: #selector(settingChanged(_:)), tag: 2)
        reduce.frame = NSRect(x: 920, y: y - 4, width: 160, height: 24); reduce.autoresizingMask = [.minXMargin, .minYMargin]; root.addSubview(reduce)
        y -= 38
        let automatic = checkbox("自动选择合适形象", checked: settings.automatic,
                                  action: #selector(settingChanged(_:)), tag: 3)
        automatic.frame = NSRect(x: 730, y: y, width: 180, height: 24); automatic.autoresizingMask = [.minXMargin, .minYMargin]; root.addSubview(automatic)
        let locked = checkbox("锁定当前形象", checked: settings.locked,
                              action: #selector(settingChanged(_:)), tag: 4)
        locked.frame = NSRect(x: 920, y: y, width: 160, height: 24); locked.autoresizingMask = [.minXMargin, .minYMargin]; root.addSubview(locked)

        let status = NSTextField(wrappingLabelWithString: resolvedStatus())
        status.font = .systemFont(ofSize: 12, weight: .medium)
        status.textColor = library.resolved(selection: selection ?? emptySelection()) == nil ? .systemOrange : NSColor(calibratedRed: 0.36, green: 0.29, blue: 0.31, alpha: 1)
        status.frame = NSRect(x: 730, y: 70, width: 350, height: 42); status.autoresizingMask = [.minXMargin, .maxYMargin]
        root.addSubview(status)

        let apply = NSButton(title: "应用到当前桌面", target: self, action: #selector(applySelection))
        apply.bezelStyle = .rounded; apply.keyEquivalent = "\r"
        apply.isEnabled = pendingSelection == nil && selection.flatMap { library.resolved(selection: $0) } != nil && sceneIsCompatible(selection)
        apply.frame = NSRect(x: 904, y: 26, width: 176, height: 34); apply.autoresizingMask = [.minXMargin, .maxYMargin]; root.addSubview(apply)
        let reset = NSButton(title: "恢复自动", target: self, action: #selector(resetAutomatic))
        reset.bezelStyle = .rounded; reset.frame = NSRect(x: 730, y: 26, width: 100, height: 34); reset.autoresizingMask = [.minXMargin, .maxYMargin]; root.addSubview(reset)
        let full = NSButton(title: "全屏预览", target: self, action: #selector(toggleFullscreen))
        full.bezelStyle = .rounded; full.frame = NSRect(x: 837, y: 26, width: 68, height: 34); full.autoresizingMask = [.minXMargin, .maxYMargin]; root.addSubview(full)
        window.contentView = root
    }

    private func addPopup(title: String, dimension: String, y: inout CGFloat, to root: NSView) {
        let caption = label(title, size: 11, weight: .medium); caption.textColor = .secondaryLabelColor
        caption.frame = NSRect(x: 730, y: y, width: 100, height: 18); caption.autoresizingMask = [.minXMargin, .minYMargin]; root.addSubview(caption)
        y -= 22
        let popup = NSPopUpButton(frame: NSRect(x: 730, y: y, width: 350, height: 26), pullsDown: false)
        popup.identifier = NSUserInterfaceItemIdentifier(dimension); popup.target = self; popup.action = #selector(popupChanged(_:))
        popup.autoresizingMask = [.minXMargin, .minYMargin]
        populate(popup, dimension: dimension); root.addSubview(popup)
        y -= 32
    }

    private func populate(_ popup: NSPopUpButton, dimension: String) {
        guard let manifest, let selection else { popup.addItem(withTitle: "暂无可用形象"); popup.isEnabled = false; return }
        if dimension == "asset" {
            for asset in approved {
                popup.addItem(withTitle: lookName(asset, manifest: manifest)); popup.lastItem?.representedObject = asset.id ?? asset.file
            }
            if let index = approved.firstIndex(where: { ($0.id ?? $0.file) == (selection.assetId ?? manifest.matchingAsset(for: selection)?.file) }) { popup.selectItem(at: index) }
            return
        }
        if dimension == "scene" {
            popup.addItem(withTitle: "人物单独显示"); popup.lastItem?.representedObject = ""
            let scenes = manifest.scenes.filter { $0.isReady && ($0.compatibleOutfitIds?.contains(selection.outfitId) ?? true) }
            for scene in scenes {
                let season = scene.season.flatMap { $0 == "all" ? nil : seasonName($0) }
                popup.addItem(withTitle: season.map { "\(scene.name) · \($0)" } ?? scene.name)
                popup.lastItem?.representedObject = scene.id
            }
            popup.selectItem(at: max(0, scenes.firstIndex(where: { $0.id == selection.sceneId }).map { $0 + 1 } ?? 0))
            return
        }
        if dimension == "season" {
            popup.addItem(withTitle: "自动（跟随场景）"); popup.lastItem?.representedObject = "auto"
            let seasons = Set(manifest.scenes.filter {
                $0.isReady && $0.season != nil && $0.season != "all" && ($0.compatibleOutfitIds?.contains(selection.outfitId) ?? true)
            }.compactMap(\.season))
            for id in ["spring", "summer", "autumn", "winter"] where seasons.contains(id) {
                popup.addItem(withTitle: seasonName(id)); popup.lastItem?.representedObject = id
            }
            popup.selectItem(withTitle: selection.season.flatMap { $0 == "auto" || $0 == "all" ? "自动（跟随场景）" : seasonName($0) } ?? "自动（跟随场景）")
            return
        }
        let ids = Set(approved.map { value(of: dimension, asset: $0) })
        let choices: [(String, String)]
        switch dimension {
        case "hairstyle": choices = manifest.hairstyles.filter { ids.contains($0.id) }.map { ($0.id, $0.name) }
        case "outfit": choices = manifest.outfits.filter { ids.contains($0.id) }.map { ($0.id, $0.name) }
        case "pose": choices = manifest.poses.filter { ids.contains($0.id) }.map { ($0.id, $0.name) }
        case "expression": choices = manifest.expressions.filter { ids.contains($0.id) }.map { ($0.id, $0.name) }
        case "palette": choices = (manifest.palettes ?? []).filter { ids.contains($0.id) }.map { ($0.id, $0.name) }
        default: choices = []
        }
        for (id, name) in choices { popup.addItem(withTitle: name); popup.lastItem?.representedObject = id }
        if let index = choices.firstIndex(where: { $0.0 == selectedValue(of: dimension, selection: selection) }) { popup.selectItem(at: index) }
    }

    @objc private func popupChanged(_ sender: NSPopUpButton) {
        guard let dimension = sender.identifier?.rawValue,
              let value = sender.selectedItem?.representedObject as? String,
              var current = selection else { return }
        if dimension == "scene" {
            current.sceneId = value.isEmpty ? nil : value
            let scene = manifest?.scenes.first(where: { $0.id == current.sceneId })
            current.season = scene?.season == "all" ? "auto" : (scene?.season ?? "auto")
            selection = current; isDirty = true
            statusText = value.isEmpty ? "将以透明人物形式显示。" : "场景只影响背景与环境动态，不会改变照片光照。"
            rebuild(); return
        }
        if dimension == "season" {
            if value == "auto" { current.season = "auto"; selection = current; isDirty = true; statusText = "季节将跟随所选场景。"; rebuild(); return }
            guard let scene = manifest?.scenes.first(where: {
                $0.isReady && $0.season == value && ($0.compatibleOutfitIds?.contains(current.outfitId) ?? true)
            }) else { statusText = "这个季节还没有与当前穿搭匹配的场景。"; rebuild(); return }
            current.sceneId = scene.id; current.season = value; selection = current; isDirty = true
            statusText = "已选择\(seasonName(value))场景：\(scene.name)。"; rebuild(); return
        }
        if dimension == "asset", let picked = approved.first(where: { ($0.id ?? $0.file) == value }) {
            selection = selection(from: picked, preserving: current); isDirty = true; statusText = "已选择完整写实照片。"
            rebuild(); return
        }
        let candidates = approved.filter { self.value(of: dimension, asset: $0) == value }
        guard let best = candidates.max(by: { compatibilityScore($0, current) < compatibilityScore($1, current) }) else {
            statusText = "这个选择还没有可用照片。"; rebuild(); return
        }
        selection = selection(from: best, preserving: current); isDirty = true
        statusText = "已切换到最接近当前设置的完整照片组合。"
        rebuild()
    }

    @objc private func settingChanged(_ sender: NSButton) {
        let on = sender.state == .on
        switch sender.tag {
        case 1: settings = .init(automatic: settings.automatic, locked: settings.locked, sceneCardEnabled: on, reduceMotion: settings.reduceMotion)
        case 2: settings = .init(automatic: settings.automatic, locked: settings.locked, sceneCardEnabled: settings.sceneCardEnabled, reduceMotion: on)
        case 3: settings = .init(automatic: on, locked: settings.locked, sceneCardEnabled: settings.sceneCardEnabled, reduceMotion: settings.reduceMotion)
        case 4: settings = .init(automatic: settings.automatic, locked: on, sceneCardEnabled: settings.sceneCardEnabled, reduceMotion: settings.reduceMotion)
        default: return
        }
        isDirty = true
        rebuild()
    }

    @objc private func resetAutomatic() {
        settings = .init(automatic: true, locked: false, sceneCardEnabled: settings.sceneCardEnabled, reduceMotion: settings.reduceMotion)
        isDirty = true; statusText = "已清除手动锁定；应用后会恢复自动选择。"; rebuild()
    }
    @objc private func applySelection() {
        guard let selection, library.resolved(selection: selection) != nil else { statusText = "照片资源缺失，无法应用。"; rebuild(); return }
        defaults.set(settings.automatic, forKey: "appearance.automatic")
        defaults.set(settings.locked, forKey: "appearance.locked")
        defaults.set(settings.sceneCardEnabled, forKey: "appearance.sceneCardEnabled")
        defaults.set(settings.reduceMotion, forKey: "appearance.reduceMotion")
        pendingSelection = selection; pendingSettings = settings
        applyHandler(selection, settings)
        statusText = "正在应用并等待服务确认…"; rebuild()
    }
    @objc private func toggleFullscreen() { window?.toggleFullScreen(nil) }
    func windowWillClose(_ notification: Notification) {
        previewCanvas?.setMotionRequested(false); isDirty = false; pendingSelection = nil; pendingSettings = nil
    }
    func windowDidMiniaturize(_ notification: Notification) { previewCanvas?.setMotionRequested(false) }
    func windowDidDeminiaturize(_ notification: Notification) { previewCanvas?.setMotionRequested(true) }

    private func selection(from asset: VisualAssetRecord, preserving previous: VisualSelection) -> VisualSelection {
        VisualSelection(assetId: asset.id, hairstyleId: asset.hairstyleId, outfitId: asset.outfitId,
                        sceneId: previous.sceneId, poseId: asset.poseId, expressionId: asset.expressionId,
                        paletteId: asset.paletteId, season: previous.season)
    }
    private func compatibilityScore(_ asset: VisualAssetRecord, _ current: VisualSelection) -> Int {
        (asset.hairstyleId == current.hairstyleId ? 1 : 0) + (asset.outfitId == current.outfitId ? 1 : 0) +
        (asset.poseId == current.poseId ? 1 : 0) + (asset.expressionId == current.expressionId ? 1 : 0) +
        (asset.paletteId == current.paletteId ? 1 : 0)
    }
    private func value(of dimension: String, asset: VisualAssetRecord) -> String {
        switch dimension { case "hairstyle": return asset.hairstyleId; case "outfit": return asset.outfitId
        case "pose": return asset.poseId; case "expression": return asset.expressionId
        case "palette": return asset.paletteId ?? ""; default: return asset.id ?? asset.file }
    }
    private func selectedValue(of dimension: String, selection: VisualSelection) -> String {
        switch dimension { case "hairstyle": return selection.hairstyleId; case "outfit": return selection.outfitId
        case "pose": return selection.poseId; case "expression": return selection.expressionId
        case "palette": return selection.paletteId ?? ""; default: return selection.assetId ?? "" }
    }
    private func lookName(_ asset: VisualAssetRecord, manifest: VisualManifest) -> String {
        let names = [manifest.hairstyles.first { $0.id == asset.hairstyleId }?.name,
                     manifest.outfits.first { $0.id == asset.outfitId }?.name,
                     manifest.palettes?.first { $0.id == asset.paletteId }?.name,
                     manifest.poses.first { $0.id == asset.poseId }?.name,
                     manifest.expressions.first { $0.id == asset.expressionId }?.name].compactMap { $0 }
        return names.joined(separator: " · ")
    }
    private func resolvedStatus() -> String {
        guard let selection else { return "暂无可用照片。" }
        guard let resolved = library.resolved(selection: selection) else { return "照片文件缺失；这个组合不能应用。" }
        guard sceneIsCompatible(selection) else { return "当前穿搭与场景不匹配；请选择列表中的可用场景后再应用。" }
        let name = resolved.record.flatMap { record in manifest.map { lookName(record, manifest: $0) } } ?? "已准备好的照片"
        return "\(statusText)\n匹配照片：\(name)"
    }
    private func sceneIsCompatible(_ selection: VisualSelection?) -> Bool {
        guard let selection, let sceneId = selection.sceneId else { return true }
        guard let scene = manifest?.scenes.first(where: { $0.id == sceneId && $0.isReady }) else { return false }
        guard scene.compatibleOutfitIds?.contains(selection.outfitId) ?? true else { return false }
        return selection.season == nil || selection.season == "auto" || scene.season == "all" || scene.season == selection.season
    }
    private func emptySelection() -> VisualSelection { .init(hairstyleId: "", outfitId: "", poseId: "", expressionId: "") }
    private func seasonName(_ id: String) -> String { ["spring":"春季", "summer":"夏季", "autumn":"秋季", "winter":"冬季"][id] ?? id }
    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight) -> NSTextField {
        let field = NSTextField(labelWithString: text); field.font = .systemFont(ofSize: size, weight: weight)
        field.textColor = NSColor(calibratedRed: 0.27, green: 0.20, blue: 0.23, alpha: 1); return field
    }
    private func checkbox(_ title: String, checked: Bool, action: Selector, tag: Int) -> NSButton {
        let button = NSButton(checkboxWithTitle: title, target: self, action: action); button.state = checked ? .on : .off; button.tag = tag; return button
    }
}
