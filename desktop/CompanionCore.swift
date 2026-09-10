import Foundation

struct DesktopMessage: Decodable, Equatable {
    let id: String
    let speaker: String
    let text: String
}

struct ConversationSnapshot: Decodable { let messages: [DesktopMessage] }
struct DesktopAttentionResponse: Decodable { let messages: [DesktopMessage] }
struct InboxSnapshot: Decodable {
    struct Item: Decodable { let messageId: String; let role: String }
    let items: [Item]
}

struct WardrobeSnapshot: Codable, Equatable {
    struct Outfit: Codable, Equatable {
        let id: String
        let name: String
        let description: String
    }
    struct Settings: Codable, Equatable {
        let automatic: Bool
        let locked: Bool
    }
    struct Current: Codable, Equatable {
        let outfitId: String
        let name: String
        let description: String
        let changedAt: String
        let reason: String
    }

    let roleId: String
    let catalog: [Outfit]
    let settings: Settings
    let current: Current
    let nextChangeAt: String?
    let revision: Int

    static let demo = WardrobeSnapshot(
        roleId: "miyue",
        catalog: [
            Outfit(id: "everyday", name: "日常格纹", description: "棕色与炭灰格纹衬衫外套，内搭象牙白 T 恤，蓝色牛仔裤和白色运动鞋。"),
            Outfit(id: "soft-knit", name: "温柔针织", description: "燕麦色针织开衫，象牙白上衣，灰蓝色中长裙和奶油色平底鞋。"),
            Outfit(id: "homewear", name: "舒适居家", description: "柔和暗玫瑰色宽松棉质长袖居家上衣，奶油色全长居家长裤和米色拖鞋。")
        ],
        settings: Settings(automatic: true, locked: false),
        current: Current(outfitId: "everyday", name: "日常格纹", description: "棕色与炭灰格纹衬衫外套，内搭象牙白 T 恤，蓝色牛仔裤和白色运动鞋。", changedAt: "", reason: "demo"),
        nextChangeAt: nil,
        revision: 0
    )
}

struct VisualCatalogChoice: Codable, Equatable {
    let id: String
    let name: String
    let status: String
    let description: String?
    let backgroundFile: String?
    let season: String?
    let atmosphere: String?
    let placement: VisualPlacement?
    let weatherRegion: VisualPlacement?
    let compatibleOutfitIds: [String]?

    var isReady: Bool { status == "ready" }
}

struct VisualPalette: Codable, Equatable {
    let id: String
    let name: String
    let colorHex: String?
}

/// Normalized image coordinates with an origin at the top left, as stored in the catalog.
struct VisualPlacement: Codable, Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    var isValid: Bool {
        x >= 0 && y >= 0 && width > 0 && height > 0 &&
        x + width <= 1.0001 && y + height <= 1.0001
    }
}

struct VisualAssetRecord: Codable, Equatable {
    let id: String?
    let identityId: String
    let hairstyleId: String
    let outfitId: String
    let poseId: String
    let expressionId: String
    let paletteId: String?
    let file: String
    let status: String
    let width: Int
    let height: Int
    let recolorMasks: [String: String]?

    var isApproved: Bool { status == "approved" }

    func matches(_ selection: VisualSelection) -> Bool {
        guard isApproved,
              selection.hairstyleId == hairstyleId,
              selection.outfitId == outfitId,
              selection.poseId == poseId,
              selection.expressionId == expressionId else { return false }
        return selection.paletteId == paletteId || (selection.paletteId == nil && paletteId == nil)
    }
}

struct VisualManifest: Codable, Equatable {
    struct Identity: Codable, Equatable {
        let id: String
        let name: String
        let age: Int
    }

    let version: Int
    let identity: Identity
    let hairstyles: [VisualCatalogChoice]
    let outfits: [VisualCatalogChoice]
    let scenes: [VisualCatalogChoice]
    let poses: [VisualCatalogChoice]
    let expressions: [VisualCatalogChoice]
    let palettes: [VisualPalette]?
    let assets: [VisualAssetRecord]

    var approvedAssets: [VisualAssetRecord] { assets.filter(\.isApproved) }
    func matchingAsset(for selection: VisualSelection) -> VisualAssetRecord? {
        if let assetId = selection.assetId,
           let exactID = approvedAssets.first(where: { $0.id == assetId }), exactID.matches(selection) { return exactID }
        return approvedAssets.first(where: { $0.matches(selection) })
    }
}

struct VisualSelection: Codable, Equatable {
    var assetId: String?
    var hairstyleId: String
    var outfitId: String
    var sceneId: String?
    var poseId: String
    var expressionId: String
    var paletteId: String?
    var season: String?

    init(assetId: String? = nil, hairstyleId: String, outfitId: String, sceneId: String? = nil,
         poseId: String, expressionId: String, paletteId: String? = nil, season: String? = nil) {
        self.assetId = assetId
        self.hairstyleId = hairstyleId
        self.outfitId = outfitId
        self.sceneId = sceneId
        self.poseId = poseId
        self.expressionId = expressionId
        self.paletteId = paletteId
        self.season = season
    }
}

struct AppearanceSnapshot: Codable, Equatable {
    struct Settings: Codable, Equatable {
        let automatic: Bool
        let locked: Bool
        let sceneCardEnabled: Bool
        let reduceMotion: Bool
    }
    struct Resolution: Codable, Equatable {
        let requested: VisualSelection?
        let rendered: VisualSelection?
        let reason: String?
    }

    let manifest: VisualManifest
    let current: VisualSelection
    let settings: Settings
    let revision: Int
    let resolution: Resolution?
}

func firstCompatibleVisualSelection(in manifest: VisualManifest, preferredSceneID: String? = nil) -> VisualSelection? {
    guard let asset = manifest.approvedAssets.first else { return nil }
    let sceneID = preferredSceneID.flatMap { id in manifest.scenes.contains(where: { $0.id == id && $0.isReady }) ? id : nil }
        ?? manifest.scenes.first(where: \.isReady)?.id
    return VisualSelection(assetId: asset.id, hairstyleId: asset.hairstyleId, outfitId: asset.outfitId,
                           sceneId: sceneID, poseId: asset.poseId, expressionId: asset.expressionId,
                           paletteId: asset.paletteId, season: manifest.scenes.first(where: { $0.id == sceneID })?.season)
}

// IDs, not timestamps: a user turn and its reply can share the same timestamp.
struct MessageTracker {
    var cursor: String?
    var pendingID: String?
    private(set) var pendingCount = 0
    private var initialized = false
    private var seen = Set<String>()
    // IDs returned by the synchronous desktop endpoint. Do not let a stale poll
    // forget them before the conversation snapshot has caught up.
    private var awaitingPollConfirmation = Set<String>()

    init(cursor: String? = nil, pendingID: String? = nil) {
        self.cursor = cursor; self.pendingID = pendingID
    }

    mutating func ingest(_ messages: [DesktopMessage], unreadIDs: Set<String> = []) -> DesktopMessage? {
        let assistants = messages.filter { $0.speaker == "assistant" }
        var incoming: [DesktopMessage]
        if initialized {
            incoming = assistants.filter { !seen.contains($0.id) && !awaitingPollConfirmation.contains($0.id) }
        } else if let cursor, let index = assistants.firstIndex(where: { $0.id == cursor }) {
            incoming = assistants.dropFirst(index + 1).filter { !seen.contains($0.id) && !awaitingPollConfirmation.contains($0.id) }
        } else {
            // First install or a cleared/replaced history must not replay old conversations.
            incoming = assistants.filter { unreadIDs.contains($0.id) && !seen.contains($0.id) && !awaitingPollConfirmation.contains($0.id) }
        }
        if !initialized, let pendingID, let pending = assistants.first(where: { $0.id == pendingID }),
           !seen.contains(pending.id), !incoming.contains(where: { $0.id == pending.id }) { incoming.insert(pending, at: 0) }
        initialized = true
        let snapshotIDs = Set(assistants.map(\.id))
        seen.formUnion(snapshotIDs)
        if awaitingPollConfirmation.isSubset(of: snapshotIDs) {
            awaitingPollConfirmation.removeAll()
            cursor = assistants.last?.id
        } else if awaitingPollConfirmation.isEmpty {
            cursor = assistants.last?.id
        }
        guard let latest = incoming.last else { return nil }
        pendingID = latest.id
        pendingCount += Set(incoming.map(\.id)).count
        return latest
    }

    mutating func acknowledge() { pendingID = nil; pendingCount = 0 }

    /// The attention endpoint returns saved messages before the next polling pass.
    /// Remember them here so that polling cannot present or count them twice.
    mutating func recordDelivered(_ messages: [DesktopMessage]) -> DesktopMessage? {
        let incoming = messages.filter { $0.speaker == "assistant" && !seen.contains($0.id) }
        guard let latest = incoming.last else { return nil }
        for message in incoming { seen.insert(message.id) }
        awaitingPollConfirmation.formUnion(incoming.map(\.id))
        cursor = latest.id
        pendingID = latest.id
        pendingCount += Set(incoming.map(\.id)).count
        return latest
    }
}

struct LifeSnapshot: Decodable {
    struct World: Decodable {
        let activity: String
        let location: String
        struct Event: Decodable { let type: String }
        let event: Event?
    }
    let world: World
    let wardrobe: WardrobeSnapshot?

    var poseID: String {
        let activity = world.activity
        if ["夜间休息", "睡觉", "睡眠", "入睡", "午睡"].contains(where: activity.contains) { return "sleeping" }
        // A retrospective is not the activity it describes.
        if activity.hasPrefix("已经回到家") || activity.hasPrefix("回到家") { return "resting" }
        if ["读书", "阅读", "翻书", "重读", "看书"].contains(where: activity.contains) { return "reading" }
        if ["休息", "看电影", "观影"].contains(where: activity.contains) { return "resting" }
        if ["散步", "逛街", "步行", "街巷", "出发", "途中"].contains(where: activity.contains) { return "walking" }
        if world.event?.type == "reading" { return "reading" }
        return "idle"
    }
}

// Only these two photographic poses exist. Unsupported life states use the neutral still.
func photoPoseID(for poseID: String) -> String { poseID == "reading" ? "reading" : "idle" }

struct PhotoAlphaMask {
    let width: Int
    let height: Int
    let alpha: [UInt8]
    let headX: Int
    let headYFromTop: Int
    let opaqueMinX: Int
    let opaqueMinYFromTop: Int
    let opaqueMaxX: Int
    let opaqueMaxYFromTop: Int
    let footX: Int

    init?(width: Int, height: Int, alpha: [UInt8], threshold: UInt8 = 12) {
        guard width > 0, height > 0, alpha.count == width * height else { return nil }
        var minX = width, minY = height, maxX = -1, maxY = -1
        var hasClearPixel = false
        for y in 0..<height {
            for x in 0..<width {
                if alpha[y * width + x] >= threshold {
                    minX = min(minX, x); maxX = max(maxX, x)
                    minY = min(minY, y); maxY = max(maxY, y)
                } else {
                    hasClearPixel = true
                }
            }
        }
        // A fully opaque image would display as a rectangular source photograph.
        guard maxX >= minX, maxY >= minY, hasClearPixel else { return nil }

        let bandDepth = max(1, min(24, height / 20))
        let headBandBottom = min(maxY, minY + bandDepth)
        var xTotal = 0, count = 0
        for y in minY...headBandBottom {
            for x in minX...maxX where alpha[y * width + x] >= threshold {
                xTotal += x; count += 1
            }
        }
        self.width = width
        self.height = height
        self.alpha = alpha
        headX = count > 0 ? xTotal / count : (minX + maxX) / 2
        headYFromTop = minY
        opaqueMinX = minX
        opaqueMinYFromTop = minY
        opaqueMaxX = maxX
        opaqueMaxYFromTop = maxY
        let footBandTop = max(minY, maxY - max(2, height / 80))
        var footTotal = 0, footCount = 0
        for y in footBandTop...maxY {
            for x in minX...maxX where alpha[y * width + x] >= threshold { footTotal += x; footCount += 1 }
        }
        footX = footCount > 0 ? footTotal / footCount : (minX + maxX) / 2
    }

    func isOpaque(imageX: Int, imageYFromTop: Int, threshold: UInt8 = 12) -> Bool {
        guard imageX >= 0, imageYFromTop >= 0, imageX < width, imageYFromTop < height else { return false }
        return alpha[imageYFromTop * width + imageX] >= threshold
    }

    func contains(normalizedX: Double, normalizedYFromBottom: Double, neighbourRadius: Int = 0) -> Bool {
        guard normalizedX >= 0, normalizedX <= 1, normalizedYFromBottom >= 0, normalizedYFromBottom <= 1 else { return false }
        let x = min(width - 1, Int(normalizedX * Double(width)))
        // PNG/NSBitmapImageRep rows are top-to-bottom; AppKit view coordinates are bottom-to-top.
        let yFromTop = min(height - 1, Int((1 - normalizedYFromBottom) * Double(height)))
        for dy in -neighbourRadius...neighbourRadius {
            for dx in -neighbourRadius...neighbourRadius where isOpaque(imageX: x + dx, imageYFromTop: yFromTop + dy) { return true }
        }
        return false
    }

    var normalizedHeadAnchor: (x: Double, yFromBottom: Double) {
        ((Double(headX) + 0.5) / Double(width), 1 - (Double(headYFromTop) + 0.5) / Double(height))
    }

    var opaqueSourceRect: (x: Double, yFromBottom: Double, width: Double, height: Double) {
        let x = Double(opaqueMinX) / Double(width)
        let y = Double(height - 1 - opaqueMaxYFromTop) / Double(height)
        return (x, y, Double(opaqueMaxX - opaqueMinX + 1) / Double(width),
                Double(opaqueMaxYFromTop - opaqueMinYFromTop + 1) / Double(height))
    }

    var normalizedFootAnchor: (x: Double, yFromBottom: Double) {
        ((Double(footX) + 0.5) / Double(width), 1 - (Double(opaqueMaxYFromTop) + 0.5) / Double(height))
    }
}

func companionBaseURL(_ raw: String) -> URL? {
    guard let url = URL(string: raw), url.scheme == "http",
          ["127.0.0.1", "localhost", "[::1]"].contains(url.host ?? ""),
          url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
          url.path.isEmpty || url.path == "/" else { return nil }
    return url
}

func bubbleExcerpt(_ text: String, privatePreview: Bool) -> String {
    if privatePreview { return "给你留了一条消息，点开看看。" }
    let singleLine = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return singleLine.count > 66 ? String(singleLine.prefix(66)) + "…" : singleLine
}
