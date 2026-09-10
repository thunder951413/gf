import Foundation
import AppKit

@main struct CoreTests {
    @MainActor static func main() async throws {
        var gestures = AttentionGestureState()
        assert(gestures.mouseUp(clickCount: 1, dragged: false) == .scheduleSingle, "First click must wait for the double-click interval before opening chat")
        assert(gestures.mouseUp(clickCount: 2, dragged: false) == .attention, "Second click must become one care request")
        assert(gestures.mouseUp(clickCount: 3, dragged: false) == .scheduleSingle, "Third click starts a fresh pair")
        assert(gestures.mouseUp(clickCount: 4, dragged: false) == .attention, "Fourth click completes the second pair without a stray single click")
        assert(gestures.mouseUp(clickCount: 1, dragged: true) == .cancel, "Dragging must cancel a pending desktop click")
        assert(gestures.cancel() == .cancel, "Right-click cancellation must suppress a delayed single click")
        var delayedSingles = 0, delayedAttention = 0
        let callbackRouter = DesktopAttentionGestureRouter(delay: 0.01,
                                                            onSingle: { delayedSingles += 1 },
                                                            onAttention: { delayedAttention += 1 })
        callbackRouter.mouseUp(clickCount: 1, dragged: false)
        try? await Task.sleep(for: .milliseconds(30))
        assert(delayedSingles == 1 && delayedAttention == 0, "A lone click must invoke its delayed single callback")
        callbackRouter.mouseUp(clickCount: 1, dragged: false)
        callbackRouter.mouseDown(clickCount: 2)
        try? await Task.sleep(for: .milliseconds(30))
        assert(delayedSingles == 1, "Holding the second click must cancel the first click's delayed callback")
        callbackRouter.mouseUp(clickCount: 2, dragged: false)
        assert(delayedAttention == 1, "The completed pair must invoke exactly one attention callback")
        var attention = DesktopAttentionCoordinator()
        let start = Date(timeIntervalSinceReferenceDate: 1_000)
        assert(attention.receiveDouble(at: start) == .start(.care), "The first double-click requests care")
        assert(attention.receiveDouble(at: start.addingTimeInterval(30)) == .queuedAffection, "A nearby repeat while generating queues affection")
        assert(attention.receiveDouble(at: start.addingTimeInterval(31)) == .queuedAffection, "Repeated gestures must coalesce into one follow-up")
        assert(attention.complete() == .affection && attention.inFlight, "The retained follow-up must be affectionate and start after the first reply")
        assert(attention.complete() == nil && !attention.inFlight, "Only one coalesced follow-up may run")
        assert(attention.receiveDouble(at: start.addingTimeInterval(122)) == .start(.care), "A later double-click returns to care")
        let displayBounds=NSRect(x:0,y:0,width:300,height:350)
        let wideContain=sceneImageRect(imageSize:NSSize(width:1600,height:900),bounds:displayBounds,fit:"contain")
        assert(abs(wideContain.width/wideContain.height-16.0/9.0)<0.001 && displayBounds.contains(wideContain),"Full scene image must preserve its own aspect ratio and stay fully visible")
        let wideCover=sceneImageRect(imageSize:NSSize(width:1600,height:900),bounds:displayBounds,fit:"cover")
        assert(abs(wideCover.width/wideCover.height-16.0/9.0)<0.001 && wideCover.width>displayBounds.width && wideCover.height==displayBounds.height,"Cover may crop but must never stretch")
        let tallContain=sceneImageRect(imageSize:NSSize(width:900,height:1600),bounds:displayBounds,fit:"contain")
        assert(tallContain.height==350 && tallContain.width<300)
        let uploadBase=URL(string:"http://127.0.0.1:8765/")!
        assert(sceneImageURL("/api/scene-images/files/"+String(repeating:"a",count:64)+".png",baseURL:uploadBase)?.host=="127.0.0.1")
        for bad in ["https://example.com/a.png","/api/scene-images/files/../../secret","/api/scene-images/files/test.svg","//evil.test/x.png"]{assert(sceneImageURL(bad,baseURL:uploadBase)==nil)}
        let uploadCanvas=NativeSceneCanvas(frame:displayBounds);uploadCanvas.uploadedSceneEnabled=true
        assert(uploadCanvas.figureView.isHidden && !uploadCanvas.uploadedView.isHidden,"Whole-scene mode must hide the legacy figure; never draw another person over uploaded photo")
        uploadCanvas.uploadedSceneEnabled=false
        assert(!uploadCanvas.figureView.isHidden && uploadCanvas.uploadedView.isHidden)
        let rep=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:64,pixelsHigh:64,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:256,bitsPerPixel:32)!
        for y in 0..<64{for x in 0..<64{let i=y*256+x*4;rep.bitmapData![i]=255;rep.bitmapData![i+1]=120;rep.bitmapData![i+2]=120;rep.bitmapData![i+3]=x<32 ? 255:0}}
        let transparent=NSImage(size:NSSize(width:64,height:64));transparent.addRepresentation(rep)
        func testImage(_ width: Int) -> NSImage {
            let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: width,
                                       bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                       colorSpaceName: .deviceRGB, bytesPerRow: width * 4, bitsPerPixel: 32)!
            memset(rep.bitmapData!, 255, width * width * 4)
            let image = NSImage(size: NSSize(width: width, height: width)); image.addRepresentation(rep)
            return image
        }
        let uploaded=UploadedSceneView(frame:NSRect(x:0,y:0,width:100,height:100));uploaded.image=transparent
        assert(uploaded.containsImage(at:NSPoint(x:20,y:50)),"Visible uploaded pixels should remain clickable")
        assert(!uploaded.containsImage(at:NSPoint(x:80,y:50)),"Transparent uploaded pixels must pass desktop clicks through")
        final class RequestLog { var paths: [String] = [] }
        let log = RequestLog()
        let suite = "local.youjian.desktop.core-tests.\(ProcessInfo.processInfo.processIdentifier)"
        let sceneDefaults = UserDefaults(suiteName: suite)!
        defer { sceneDefaults.removePersistentDomain(forName: suite) }
        let sceneCache = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(suite)
        defer { try? FileManager.default.removeItem(at: sceneCache) }
        let hashA = String(repeating: "a", count: 64), hashB = String(repeating: "b", count: 64)
        let hashC = String(repeating: "c", count: 64), hashD = String(repeating: "d", count: 64)
        let activePath = "/api/scene-images/files/\(hashA).png"
        let inactivePath = "/api/scene-images/files/\(hashB).png"
        let slowPath = "/api/scene-images/files/\(hashC).png"
        let newerPath = "/api/scene-images/files/\(hashD).png"
        let activeRecord = SceneImageRecord(id: "active", name: "Active", imageUrl: activePath, fit: "contain")
        let inactiveRecord = SceneImageRecord(id: "inactive", name: "Inactive", imageUrl: inactivePath, fit: "contain")
        let controller = SceneImageStudioController(baseURL: uploadBase, defaults: sceneDefaults,
                                                     cacheDirectory: sceneCache,
                                                     imageLoader: { url in
            log.paths.append(url.lastPathComponent)
            if url.lastPathComponent.hasPrefix(hashB) { throw URLError(.cannotLoadFromNetwork) }
            if url.lastPathComponent.hasPrefix(hashC) {
                try? await Task.sleep(for: .milliseconds(50))
                return testImage(10)
            }
            if url.lastPathComponent.hasPrefix(hashD) { return testImage(20) }
            return transparent
        }, onChange: {})
        let disabled = SceneImageSnapshot(enabled: false, activeSceneId: "active", revision: 2, scenes: [activeRecord, inactiveRecord])
        await controller.accept(disabled)
        assert(controller.snapshot == disabled, "An unavailable inactive scene must not block a newer metadata update")
        assert(!log.paths.contains(where: { $0.hasPrefix(hashB) }), "Only the active scene should be fetched during metadata acceptance")
        assert(!shouldRenderUploadedScene(snapshot: controller.snapshot, activeImage: controller.activeImage), "Disabled scene metadata must keep the fallback renderer visible")
        let missingActive = SceneImageSnapshot(enabled: true, activeSceneId: "inactive", revision: 3, scenes: [activeRecord, inactiveRecord])
        await controller.accept(missingActive)
        assert(controller.snapshot == missingActive && controller.activeImage == nil, "A missing active image must retain metadata but not an obsolete image")
        assert(!shouldRenderUploadedScene(snapshot: controller.snapshot, activeImage: controller.activeImage), "An unavailable active scene must fall back instead of showing an empty canvas")
        await controller.accept(missingActive)
        assert(log.paths.filter { $0.hasPrefix(hashB) }.count == 2, "An unavailable active scene must retry on the next refresh")
        await controller.accept(disabled)
        assert(controller.snapshot == missingActive, "A stale image load or snapshot must not replace a newer revision")
        let slowRecord = SceneImageRecord(id: "slow", name: "Slow", imageUrl: slowPath, fit: "contain")
        let newerRecord = SceneImageRecord(id: "newer", name: "Newer", imageUrl: newerPath, fit: "contain")
        let slowSnapshot = SceneImageSnapshot(enabled: true, activeSceneId: "slow", revision: 4, scenes: [slowRecord])
        let newerSnapshot = SceneImageSnapshot(enabled: true, activeSceneId: "newer", revision: 5, scenes: [newerRecord])
        let slowAccept = Task { @MainActor in await controller.accept(slowSnapshot) }
        await Task.yield()
        await controller.accept(newerSnapshot)
        await slowAccept.value
        assert(controller.snapshot == newerSnapshot && controller.activeImage?.size == NSSize(width: 20, height: 20), "A delayed old image load must not replace a newer active scene")
        let sceneRestart = SceneImageStudioController(baseURL: uploadBase, defaults: sceneDefaults, cacheDirectory: sceneCache,
                                                      imageLoader: { _ in throw URLError(.cannotLoadFromNetwork) }, onChange: {})
        assert(sceneRestart.snapshot == newerSnapshot && sceneRestart.activeImage?.size == NSSize(width: 20, height: 20), "A downloaded active scene must restore from its cached image after restart")
        assert(shouldRenderUploadedScene(snapshot: sceneRestart.snapshot, activeImage: sceneRestart.activeImage), "A cached active scene must remain renderable after restart")
        try FileManager.default.removeItem(at: sceneCache.appendingPathComponent(sceneImageURL(newerPath, baseURL: uploadBase)!.lastPathComponent))
        let cacheMissRestart = SceneImageStudioController(baseURL: uploadBase, defaults: sceneDefaults, cacheDirectory: sceneCache,
                                                          imageLoader: { _ in throw URLError(.cannotLoadFromNetwork) }, onChange: {})
        assert(cacheMissRestart.snapshot == newerSnapshot && cacheMissRestart.activeImage == nil, "A missing cached active scene must preserve its metadata without an obsolete image")
        assert(!shouldRenderUploadedScene(snapshot: cacheMissRestart.snapshot, activeImage: cacheMissRestart.activeImage), "A restart cache miss must use the fallback renderer")
        func message(_ id: String, _ speaker: String = "assistant") -> DesktopMessage { DesktopMessage(id: id, speaker: speaker, text: id) }
        var first = MessageTracker()
        assert(first.ingest([message("old")]) == nil, "Fresh install must baseline old messages")
        assert(first.ingest([message("old"),message("user","user")]) == nil)
        assert(first.ingest([message("old"),message("a"),message("b")])?.id == "b")
        assert(first.pendingCount == 2)
        assert(first.ingest([message("old"),message("a"),message("b")]) == nil, "Repeated poll must not re-notify")
        var earlyDelivery = MessageTracker()
        _ = earlyDelivery.recordDelivered([message("early-care")])
        assert(earlyDelivery.ingest([message("old"), message("early-care")]) == nil, "First poll after an immediate response must not replay it")
        assert(earlyDelivery.pendingCount == 1)
        var immediate = MessageTracker()
        _ = immediate.ingest([message("old")])
        assert(immediate.recordDelivered([message("care-reply")])?.id == "care-reply")
        assert(immediate.pendingCount == 1)
        assert(immediate.ingest([message("old")]) == nil && immediate.cursor == "care-reply", "A stale poll must not move the cursor behind an immediate attention reply")
        assert(immediate.ingest([message("old"), message("care-reply")]) == nil, "A synchronous attention reply must not be counted again by polling")
        assert(immediate.pendingCount == 1, "Polling must not regress the delivered attention count")
        var restarted = MessageTracker(cursor:first.cursor,pendingID:first.pendingID)
        assert(restarted.ingest([message("old"),message("a"),message("b")])?.id == "b", "Unopened bubble survives restart")
        restarted.acknowledge()
        assert(restarted.pendingID == nil && restarted.pendingCount == 0)
        var reconnect = MessageTracker(cursor:"a")
        assert(reconnect.ingest([message("old"),message("a"),message("b"),message("c")])?.id == "c")
        assert(reconnect.pendingCount == 2, "Catch all messages since saved cursor")
        var reset = MessageTracker(cursor:"removed")
        assert(reset.ingest([message("new-history")]) == nil, "Do not replay replaced history")
        var unread = MessageTracker()
        assert(unread.ingest([message("old"),message("proactive")],unreadIDs:["proactive"])?.id == "proactive")
        func life(_ activity: String, type: String? = nil) throws -> LifeSnapshot {
            let world: [String:Any] = ["activity":activity,"location":"苏州","event":type.map{["type":$0]} as Any? ?? NSNull()]
            return try JSONDecoder().decode(LifeSnapshot.self,from:JSONSerialization.data(withJSONObject:["world":world]))
        }
        assert(try! life("夜间休息").poseID == "sleeping")
        assert(try! life("重读一本书").poseID == "reading")
        assert(try! life("吃午饭并休息").poseID == "resting")
        assert(try! life("沿街散步").poseID == "walking")
        assert(try! life("自由活动").poseID == "idle", "An ongoing reading pursuit must not force current reading")
        assert(try! life("已经回到家，回想刚才的过程：沿街散步",type:"local_walk").poseID == "resting")
        assert(photoPoseID(for: "reading") == "reading")
        for pose in ["idle", "walking", "resting", "sleeping"] {
            assert(photoPoseID(for: pose) == "idle", "An unsupported photo pose must use the neutral still")
        }
        var asymmetricAlpha = [UInt8](repeating: 0, count: 4 * 4)
        asymmetricAlpha[0 * 4 + 0] = 255 // head at image top-left
        asymmetricAlpha[1 * 4 + 0] = 255 // body
        asymmetricAlpha[3 * 4 + 2] = 255 // foot at image bottom-right
        let asymmetricMask = PhotoAlphaMask(width: 4, height: 4, alpha: asymmetricAlpha)!
        assert(asymmetricMask.normalizedHeadAnchor.yFromBottom > 0.8, "Head anchor must be above the body")
        assert(asymmetricMask.contains(normalizedX: 0.125, normalizedYFromBottom: 0.875), "Visible head must be clickable")
        assert(!asymmetricMask.contains(normalizedX: 0.125, normalizedYFromBottom: 0.125), "Vertically mirrored clear area must pass through")
        assert(asymmetricMask.contains(normalizedX: 0.625, normalizedYFromBottom: 0.125), "Visible foot must be clickable")
        assert(PhotoAlphaMask(width: 2, height: 2, alpha: [255,255,255,255]) == nil, "Fully opaque rectangles must be rejected")
        assert(PhotoAlphaMask(width: 2, height: 2, alpha: [0,0,0,0]) == nil, "Fully clear images must be rejected")
        let encodedWardrobe = try JSONEncoder().encode(WardrobeSnapshot.demo)
        let decodedWardrobe = try JSONDecoder().decode(WardrobeSnapshot.self, from: encodedWardrobe)
        assert(decodedWardrobe == .demo, "Confirmed wardrobe must survive local persistence")
        let visualJSON: [String: Any] = [
            "version": 1,
            "identity": ["id": "lin-yuwei-v1", "name": "林雨薇", "age": 27],
            "hairstyles": [["id": "long", "name": "长发", "status": "ready"]],
            "outfits": [["id": "coat", "name": "外套", "status": "ready"]],
            "scenes": [["id": "snow", "name": "雪夜", "status": "ready", "season": "winter",
                        "backgroundFile": "scenes/snow.png",
                        "placement": ["x": 0.2, "y": 0.1, "width": 0.6, "height": 0.8]]],
            "poses": [["id": "idle", "name": "站立", "status": "ready"]],
            "expressions": [["id": "soft-smile", "name": "浅笑", "status": "ready"]],
            "palettes": [["id": "blue", "name": "灰蓝", "colorHex": "#93A6C3"]],
            "assets": [["id": "look-blue", "identityId": "lin-yuwei-v1", "hairstyleId": "long",
                        "outfitId": "coat", "poseId": "idle", "expressionId": "soft-smile",
                        "paletteId": "blue", "file": "looks/blue.png", "status": "approved", "width": 1024, "height": 1536]]
        ]
        let visualManifest = try JSONDecoder().decode(VisualManifest.self, from: JSONSerialization.data(withJSONObject: visualJSON))
        let validVisual = firstCompatibleVisualSelection(in: visualManifest)!
        assert(validVisual.assetId == "look-blue" && validVisual.sceneId == "snow")
        assert(visualManifest.matchingAsset(for: validVisual)?.file == "looks/blue.png")
        var unavailableVisual = validVisual; unavailableVisual.paletteId = nil
        assert(visualManifest.matchingAsset(for: unavailableVisual) == nil, "A missing palette variant must not silently substitute another photo")
        assert(visualManifest.scenes[0].placement?.isValid == true, "Top-left normalized placement must be validated")
        guard let assetsIndex = CommandLine.arguments.firstIndex(of: "--assets-root"), assetsIndex + 1 < CommandLine.arguments.count else {
            fatalError("Desktop tests require --assets-root")
        }
        let assetsRoot = URL(fileURLWithPath: CommandLine.arguments[assetsIndex + 1], isDirectory: true)
        let actualData = try Data(contentsOf: assetsRoot.appendingPathComponent("visual-catalog.json"))
        let actualManifest = try JSONDecoder().decode(VisualManifest.self, from: actualData)
        let actualLibrary = PhotoPetLibrary(resourceURL: assetsRoot)
        assert(actualLibrary.manifestLoadError == nil, actualLibrary.manifestLoadError ?? "Actual catalog must decode")
        assert(!actualManifest.approvedAssets.isEmpty, "Actual catalog must contain approved assets")
        for record in actualManifest.approvedAssets {
            let selection = VisualSelection(assetId: record.id, hairstyleId: record.hairstyleId, outfitId: record.outfitId,
                                            poseId: record.poseId, expressionId: record.expressionId, paletteId: record.paletteId)
            assert(actualLibrary.resolved(selection: selection) != nil, "Approved asset must load: \(record.id ?? record.file)")
        }
        assert(actualLibrary.visualAssets.count <= 6, "Photograph cache must remain bounded")
        for scene in actualManifest.scenes where scene.isReady && scene.backgroundFile != nil {
            assert(actualLibrary.sceneImage(id: scene.id) != nil, "Ready scene background must load: \(scene.id)")
        }
        assert(companionBaseURL("http://127.0.0.1:8765/") != nil)
        assert(companionBaseURL("http://localhost:8877") != nil)
        for invalid in ["https://evil.com", "http://127.0.0.1.evil.com", "http://user:secret@localhost", "file:///tmp/x", "http://localhost/path", "http://localhost?token=x"] { assert(companionBaseURL(invalid) == nil) }
        assert(bubbleExcerpt(String(repeating:"雨",count:100),privatePreview:false).count == 67)
        assert(!bubbleExcerpt("私密聊天",privatePreview:true).contains("私密聊天"))
        print("Desktop core checks passed: messaging, life/photo mapping, real approved visual assets and scenes, exact matching, layout bounds, URL boundary and private preview.")
    }
}
