import AppKit

struct PhotoPetAsset {
    let image: NSImage
    let mask: PhotoAlphaMask
    var pixelWidth: Int { mask.width }
    var pixelHeight: Int { mask.height }

    init?(url: URL, alphaThreshold: UInt8 = 12) {
        guard let sourceData = try? Data(contentsOf: url),
              let representation = NSBitmapImageRep(data: sourceData),
              representation.hasAlpha, !representation.isPlanar,
              representation.bitsPerSample == 8, representation.samplesPerPixel >= 2,
              let data = representation.bitmapData else { return nil }
        let width = representation.pixelsWide, height = representation.pixelsHigh
        let alphaOffset = representation.bitmapFormat.contains(.alphaFirst) ? 0 : representation.samplesPerPixel - 1
        var alpha = [UInt8](repeating: 0, count: width * height)
        for y in 0..<height {
            let row = data + y * representation.bytesPerRow
            for x in 0..<width { alpha[y * width + x] = row[x * representation.samplesPerPixel + alphaOffset] }
        }
        guard let mask = PhotoAlphaMask(width: width, height: height, alpha: alpha, threshold: alphaThreshold) else { return nil }
        let decoded = NSImage(size: NSSize(width: width, height: height))
        decoded.addRepresentation(representation); decoded.isTemplate = false
        image = decoded; self.mask = mask
    }
}

struct ResolvedPhotoAsset {
    let record: VisualAssetRecord?
    let asset: PhotoPetAsset
    let isLegacyFallback: Bool
}

final class PhotoPetLibrary {
    private(set) var manifest: VisualManifest?
    private(set) var manifestLoadError: String?
    private(set) var visualAssets: [String: PhotoPetAsset] = [:]
    private(set) var legacyAssets: [String: PhotoPetAsset] = [:]
    private(set) var sceneImages: [String: NSImage] = [:]
    private let resourceURL: URL?
    private var recentFiles: [String] = []
    private let photoCacheLimit = 6

    init(resourceURL: URL?) {
        self.resourceURL = resourceURL
        loadLegacyAssets()
        if let resourceURL {
            let catalogURL = resourceURL.appendingPathComponent("visual-catalog.json")
            if FileManager.default.fileExists(atPath: catalogURL.path) {
                do { update(manifest: try JSONDecoder().decode(VisualManifest.self, from: Data(contentsOf: catalogURL))) }
                catch { manifestLoadError = "形象清单无法读取：\(error.localizedDescription)" }
            }
        }
    }

    func update(manifest: VisualManifest) {
        guard self.manifest != manifest else { return }
        self.manifest = manifest
        manifestLoadError = nil
        let valid = Set(manifest.approvedAssets.map(\.file))
        visualAssets = visualAssets.filter { valid.contains($0.key) }
        recentFiles.removeAll { !valid.contains($0) }
        sceneImages.removeAll(keepingCapacity: true)
        guard let resourceURL else { return }
        for scene in manifest.scenes where scene.isReady {
            guard let file = scene.backgroundFile,
                  let url = safeResourceURL(relativePath: file, under: resourceURL),
                  let image = NSImage(contentsOf: url) else { continue }
            sceneImages[scene.id] = image
        }
    }

    private func cachedPhoto(file: String) -> PhotoPetAsset? {
        if file.hasPrefix("wardrobe-v1/cutouts/") {
            let key = URL(fileURLWithPath: file).deletingPathExtension().lastPathComponent
            if let legacy = legacyAssets[key] { return legacy }
        }
        if let cached = visualAssets[file] {
            recentFiles.removeAll { $0 == file }; recentFiles.append(file); return cached
        }
        guard let root = resourceURL, let url = safeResourceURL(relativePath: file, under: root),
              let asset = PhotoPetAsset(url: url) else { return nil }
        visualAssets[file] = asset; recentFiles.append(file)
        while recentFiles.count > photoCacheLimit { visualAssets.removeValue(forKey: recentFiles.removeFirst()) }
        return asset
    }

    private func loadLegacyAssets() {
        guard let resourceURL else { return }
        for outfitID in ["everyday", "soft-knit", "homewear"] {
            for poseID in ["idle", "reading"] {
                let key = "\(outfitID)-\(poseID)"
                if let asset = PhotoPetAsset(url: resourceURL.appendingPathComponent("wardrobe-v1/cutouts/\(key).png")) { legacyAssets[key] = asset }
            }
        }
    }

    func resolved(selection: VisualSelection) -> ResolvedPhotoAsset? {
        guard let record = manifest?.matchingAsset(for: selection), let asset = cachedPhoto(file: record.file) else { return nil }
        return ResolvedPhotoAsset(record: record, asset: asset, isLegacyFallback: false)
    }
    func legacyAsset(outfitID: String, poseID: String) -> PhotoPetAsset? { legacyAssets["\(outfitID)-\(photoPoseID(for: poseID))"] }
    func scene(id: String?) -> VisualCatalogChoice? {
        guard let id else { return nil }
        return manifest?.scenes.first(where: { $0.id == id && $0.isReady })
    }
    func sceneImage(id: String?) -> NSImage? { id.flatMap { sceneImages[$0] } }
    var hasAssets: Bool { manifest?.approvedAssets.isEmpty == false || !legacyAssets.isEmpty }
    var hasCompleteLegacySet: Bool { legacyAssets.count == 6 }

    private func safeResourceURL(relativePath: String, under root: URL) -> URL? {
        guard !relativePath.isEmpty, !relativePath.hasPrefix("/") else { return nil }
        let base = root.standardizedFileURL
        let candidate = base.appendingPathComponent(relativePath).standardizedFileURL
        guard candidate.path.hasPrefix(base.path + "/") else { return nil }
        return candidate
    }
}

final class PhotoPetView: NSView {
    var clicked: (() -> Void)?
    var attention: (() -> Void)?
    var showMenu: ((NSEvent) -> Void)?
    var moved: (() -> Void)?
    var asset: PhotoPetAsset? { didSet { needsDisplay = true } }
    var trimTransparentMargins = false { didSet { needsDisplay = true } }
    private var startMouse = NSPoint.zero
    private var startOrigin = NSPoint.zero
    private var dragged = false
    private lazy var gestures = DesktopAttentionGestureRouter(
        onSingle: { [weak self] in self?.clicked?() },
        onAttention: { [weak self] in self?.attention?() }
    )
    override var isOpaque: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private var sourceRect: NSRect {
        guard let asset else { return .zero }
        guard trimTransparentMargins else { return NSRect(origin: .zero, size: asset.image.size) }
        let visible = asset.mask.opaqueSourceRect
        return NSRect(x: CGFloat(visible.x) * asset.image.size.width,
                      y: CGFloat(visible.yFromBottom) * asset.image.size.height,
                      width: CGFloat(visible.width) * asset.image.size.width,
                      height: CGFloat(visible.height) * asset.image.size.height)
    }
    var imageRect: NSRect {
        guard asset != nil else { return .zero }
        let source = sourceRect
        let imageRatio = source.width / max(1, source.height)
        let viewRatio = bounds.width / max(1, bounds.height)
        if imageRatio > viewRatio {
            let height = bounds.width / imageRatio
            return NSRect(x: 0, y: (bounds.height - height) / 2, width: bounds.width, height: height)
        }
        let width = bounds.height * imageRatio
        return NSRect(x: (bounds.width - width) / 2, y: 0, width: width, height: bounds.height)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let asset else { return }
        // Approved color variants are separate photographs, preserving face, white balance and contrast.
        asset.image.draw(in: imageRect, from: sourceRect, operation: .sourceOver, fraction: 1,
                         respectFlipped: false, hints: [.interpolation: NSImageInterpolation.high])
    }
    func containsOpaquePixel(at point: NSPoint) -> Bool {
        guard let asset else { return false }
        let rect = imageRect
        guard rect.width > 0, rect.height > 0, rect.contains(point) else { return false }
        let source = sourceRect
        let imageX = source.minX + ((point.x - rect.minX) / rect.width) * source.width
        let imageY = source.minY + ((point.y - rect.minY) / rect.height) * source.height
        return asset.mask.contains(normalizedX: Double(imageX / asset.image.size.width),
                                   normalizedYFromBottom: Double(imageY / asset.image.size.height), neighbourRadius: 1)
    }
    func opaqueHeadAnchor() -> NSPoint? {
        guard let asset else { return nil }
        let rect = imageRect, source = sourceRect, anchor = asset.mask.normalizedHeadAnchor
        let x = (CGFloat(anchor.x) * asset.image.size.width - source.minX) / source.width
        let y = (CGFloat(anchor.yFromBottom) * asset.image.size.height - source.minY) / source.height
        return NSPoint(x: rect.minX + x * rect.width, y: rect.minY + y * rect.height)
    }
    func opaqueFootAnchor() -> NSPoint? {
        guard let asset else { return nil }
        let rect = imageRect, source = sourceRect, anchor = asset.mask.normalizedFootAnchor
        let x = (CGFloat(anchor.x) * asset.image.size.width - source.minX) / source.width
        let y = (CGFloat(anchor.yFromBottom) * asset.image.size.height - source.minY) / source.height
        return NSPoint(x: rect.minX + x * rect.width, y: rect.minY + y * rect.height)
    }
    override func mouseDown(with event: NSEvent) { gestures.mouseDown(clickCount:event.clickCount); startMouse = NSEvent.mouseLocation; startOrigin = window?.frame.origin ?? .zero; dragged = false }
    override func mouseDragged(with event: NSEvent) {
        let point = NSEvent.mouseLocation
        if hypot(point.x - startMouse.x, point.y - startMouse.y) > 3 { dragged = true }
        if dragged { window?.setFrameOrigin(NSPoint(x: startOrigin.x + point.x - startMouse.x, y: startOrigin.y + point.y - startMouse.y)) }
    }
    override func mouseUp(with event: NSEvent) { if dragged { gestures.cancel(); moved?() } else { gestures.mouseUp(clickCount: event.clickCount, dragged: false) } }
    override func rightMouseDown(with event: NSEvent) { gestures.cancel(); showMenu?(event) }
    override func accessibilityPerformPress() -> Bool { clicked?(); return true }
}

/// Composes an approved photograph over a photographic backdrop. The figure remains still;
/// only restrained rain or snow in a catalog-defined region can animate.
final class NativeSceneCanvas: NSView {
    let figureView = PhotoPetView(frame: .zero)
    let uploadedView = UploadedSceneView(frame: .zero)
    var uploadedSceneEnabled = false { didSet { figureView.isHidden = uploadedSceneEnabled; uploadedView.isHidden = !uploadedSceneEnabled; updateScene() } }
    var scene: VisualCatalogChoice? { didSet { updateScene() } }
    var backdrop: NSImage? { didSet { needsDisplay = true } }
    var sceneCardEnabled = false { didSet { updateScene() } }
    var reduceMotion = false { didSet { updateMotionState() } }
    private var motionRequested = true
    private var phase: CGFloat = 0
    private var timer: Timer?

    override init(frame frameRect: NSRect) { super.init(frame: frameRect); wantsLayer = true; addSubview(figureView);addSubview(uploadedView);uploadedView.isHidden=true }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { timer?.invalidate() }
    override var isOpaque: Bool { false }
    private var compositionRect: NSRect {
        let ratio: CGFloat = 2.0 / 3.0
        if bounds.width / max(1, bounds.height) > ratio {
            let width = bounds.height * ratio
            return NSRect(x: bounds.midX - width / 2, y: bounds.minY, width: width, height: bounds.height)
        }
        let height = bounds.width / ratio
        return NSRect(x: bounds.minX, y: bounds.midY - height / 2, width: bounds.width, height: height)
    }
    override func layout() {
        super.layout()
        uploadedView.frame = bounds
        figureView.trimTransparentMargins = sceneCardEnabled
        let composition = compositionRect
        if sceneCardEnabled, let placement = scene?.placement, placement.isValid {
            figureView.frame = NSRect(x: composition.minX + composition.width * CGFloat(placement.x),
                                      y: composition.minY + composition.height * CGFloat(1 - placement.y - placement.height),
                                      width: composition.width * CGFloat(placement.width), height: composition.height * CGFloat(placement.height))
        } else if sceneCardEnabled {
            figureView.frame = NSRect(x: composition.minX + composition.width * 0.14,
                                      y: composition.minY + composition.height * 0.03,
                                      width: composition.width * 0.72, height: composition.height * 0.92)
        } else { figureView.frame = bounds }
    }
    func setMotionRequested(_ active: Bool) { motionRequested = active; updateMotionState() }
    private func updateScene() { needsLayout = true; needsDisplay = true; updateMotionState() }
    private func updateMotionState() {
        let atmosphere = scene?.atmosphere ?? "none"
        let shouldRun = !uploadedSceneEnabled && motionRequested && !reduceMotion && sceneCardEnabled && !isHidden &&
            window?.isVisible == true && window?.isMiniaturized == false && atmosphere != "none"
        if shouldRun, timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 15.0, repeats: true) { [weak self] _ in
                guard let self else { return }; self.phase = (self.phase + 0.002).truncatingRemainder(dividingBy: 1); self.needsDisplay = true
            }
        } else if !shouldRun { timer?.invalidate(); timer = nil }
    }
    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); updateMotionState() }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard sceneCardEnabled && !uploadedSceneEnabled else { return }
        let card = compositionRect.insetBy(dx: 2, dy: 2), clip = NSBezierPath(roundedRect: card, xRadius: 22, yRadius: 22)
        NSGraphicsContext.saveGraphicsState(); clip.addClip()
        if let backdrop {
            backdrop.draw(in: card, from: NSRect(origin: .zero, size: backdrop.size), operation: .sourceOver, fraction: 1, respectFlipped: false,
                          hints: [.interpolation: NSImageInterpolation.high])
        } else { NSColor(calibratedRed: 0.14, green: 0.13, blue: 0.16, alpha: 0.96).setFill(); card.fill() }
        let ambient = reduceMotion ? 0.08 : 0.08 + 0.012 * sin(phase * .pi * 2)
        NSGradient(colors: [NSColor(calibratedWhite: 1, alpha: ambient), NSColor(calibratedWhite: 0, alpha: 0.08)])?.draw(in: card, angle: 82)
        drawContactShadow(in: card)
        drawAtmosphere(in: card)
        NSGraphicsContext.restoreGraphicsState()
        NSColor(calibratedWhite: 1, alpha: 0.18).setStroke(); clip.lineWidth = 1; clip.stroke()
    }

    private func drawContactShadow(in card: NSRect) {
        guard let localFoot = figureView.opaqueFootAnchor() else { return }
        let foot = convert(localFoot, from: figureView)
        let width = min(card.width * 0.40, max(24, figureView.frame.width * 0.65))
        guard let context=NSGraphicsContext.current?.cgContext,
              let gradient=CGGradient(colorsSpace:CGColorSpaceCreateDeviceRGB(),
                                      colors:[NSColor(calibratedWhite:0,alpha:0.14).cgColor,NSColor.clear.cgColor] as CFArray,
                                      locations:[0,1]) else { return }
        context.saveGState()
        context.translateBy(x:foot.x,y:max(card.minY+2,foot.y+1))
        context.scaleBy(x:width/2,y:7)
        context.drawRadialGradient(gradient,startCenter:.zero,startRadius:0,endCenter:.zero,endRadius:1,options:[])
        context.restoreGState()
    }

    private func drawAtmosphere(in card: NSRect) {
        guard !reduceMotion, let kind = scene?.atmosphere, kind == "rain" || kind == "snow" else { return }
        let area: NSRect
        if let region = scene?.weatherRegion, region.isValid {
            let x = card.minX + card.width * CGFloat(region.x)
            let y = card.minY + card.height * CGFloat(1 - region.y - region.height)
            let width = card.width * CGFloat(region.width)
            let height = card.height * CGFloat(region.height)
            area = NSRect(x: x, y: y, width: width, height: height)
        } else { area = card }
        NSGraphicsContext.saveGraphicsState(); NSBezierPath(rect: area).addClip()
        for index in 0..<22 {
            let seed = CGFloat((index * 37) % 101) / 101
            let x = area.minX + area.width * CGFloat((Double(seed) + Double(phase) * (kind == "rain" ? 0.12 : 0.025)).truncatingRemainder(dividingBy: 1))
            let travel = CGFloat((Double(index) * 0.071 + Double(phase) * (kind == "rain" ? 4.2 : 0.75)).truncatingRemainder(dividingBy: 1))
            let y = area.maxY - area.height * travel
            if kind == "rain" {
                NSColor(calibratedWhite: 0.92, alpha: 0.20).setStroke()
                let drop = NSBezierPath(); drop.move(to: NSPoint(x: x, y: y)); drop.line(to: NSPoint(x: x - 2, y: y - 11)); drop.lineWidth = 0.7; drop.stroke()
            } else {
                NSColor(calibratedWhite: 1, alpha: 0.34).setFill(); let d: CGFloat = index % 3 == 0 ? 2.4 : 1.5
                NSBezierPath(ovalIn: NSRect(x: x, y: y, width: d, height: d)).fill()
            }
        }
        NSGraphicsContext.restoreGraphicsState()
    }
}
