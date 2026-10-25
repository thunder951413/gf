import AppKit
import UniformTypeIdentifiers
import ImageIO

struct SceneImageRecord: Codable, Equatable {
    let id: String
    let name: String
    let imageUrl: String?
    let fit: String
}
struct SceneImageSnapshot: Codable, Equatable {
    let enabled: Bool
    let activeSceneId: String?
    let revision: Int
    let scenes: [SceneImageRecord]
    var active: SceneImageRecord? { scenes.first { $0.id == activeSceneId } }
}

func sceneImageURL(_ path: String, baseURL: URL) -> URL? {
    guard path.range(of: #"^/api/scene-images/files/[a-f0-9]{64}\.(png|jpg|jpeg|webp)$"#, options: .regularExpression) != nil else { return nil }
    return URL(string: path, relativeTo: baseURL)?.absoluteURL
}
func sceneImageRect(imageSize: NSSize, bounds: NSRect, fit: String) -> NSRect {
    guard imageSize.width > 0, imageSize.height > 0 else { return .zero }
    let x = bounds.width / imageSize.width, y = bounds.height / imageSize.height
    let scale = fit == "cover" ? max(x,y) : min(x,y)
    let size = NSSize(width: imageSize.width * scale, height: imageSize.height * scale)
    return NSRect(x: bounds.midX-size.width/2, y: bounds.midY-size.height/2, width: size.width, height: size.height)
}

// Clamp the visible artwork, allowing transparent window margins to cross the edge.
func characterPanelOrigin(proposed: NSPoint, visible: NSRect, screen: NSRect, gap: CGFloat = 2) -> NSPoint {
    NSPoint(x: max(screen.minX + gap - visible.minX, min(proposed.x, screen.maxX - gap - visible.maxX)),
            y: max(screen.minY + gap - visible.minY, min(proposed.y, screen.maxY - gap - visible.maxY)))
}

func shouldAcceptSceneImageSnapshot(_ incoming: SceneImageSnapshot, over current: SceneImageSnapshot?) -> Bool {
    current.map { incoming.revision >= $0.revision } ?? true
}

func shouldRenderUploadedScene(snapshot: SceneImageSnapshot?, activeImage: NSImage?) -> Bool {
    snapshot?.enabled == true && activeImage != nil
}

final class UploadedSceneView: NSView {
    var image: NSImage? { didSet { if image !== oldValue { rebuildAlphaMask() };needsDisplay = true } }
    var fit = "contain" { didSet { needsDisplay = true } }
    var clicked: (() -> Void)?
    var attention: (() -> Void)?
    var moved: (() -> Void)?
    var showMenu: ((NSEvent) -> Void)?
    private var origin = NSPoint.zero, start = NSPoint.zero
    private var dragged = false
    private var alphaMask: PhotoAlphaMask?
    private lazy var gestures = DesktopAttentionGestureRouter(
        onSingle: { [weak self] in self?.clicked?() },
        onAttention: { [weak self] in self?.attention?() }
    )
    private func rebuildAlphaMask(){
        alphaMask=nil
        guard let data=image?.tiffRepresentation,let rep=NSBitmapImageRep(data:data),rep.hasAlpha,!rep.isPlanar,rep.bitsPerSample==8,let bytes=rep.bitmapData else{return}
        let offset=rep.bitmapFormat.contains(.alphaFirst) ? 0:rep.samplesPerPixel-1
        var alpha=[UInt8](repeating:0,count:rep.pixelsWide*rep.pixelsHigh)
        for y in 0..<rep.pixelsHigh{for x in 0..<rep.pixelsWide{alpha[y*rep.pixelsWide+x]=bytes[y*rep.bytesPerRow+x*rep.samplesPerPixel+offset]}}
        alphaMask=PhotoAlphaMask(width:rep.pixelsWide,height:rep.pixelsHigh,alpha:alpha,threshold:12)
    }
    func containsImage(at point:NSPoint)->Bool {
        guard let image,bounds.contains(point) else{return false}
        let rect=sceneImageRect(imageSize:image.size,bounds:bounds,fit:fit)
        guard rect.contains(point) else{return false}
        return alphaMask?.contains(normalizedX:Double((point.x-rect.minX)/rect.width),normalizedYFromBottom:Double((point.y-rect.minY)/rect.height),neighbourRadius:1) ?? true
    }
    override var isOpaque: Bool { false }
    var displayedRect: NSRect { image.map { sceneImageRect(imageSize:$0.size,bounds:bounds,fit:fit).intersection(bounds) } ?? bounds }
    var visibleArtworkRect: NSRect {
        guard let image, let alphaMask else { return displayedRect }
        let rect = sceneImageRect(imageSize: image.size, bounds: bounds, fit: fit)
        let opaque = alphaMask.opaqueSourceRect
        return NSRect(x: rect.minX + rect.width * opaque.x, y: rect.minY + rect.height * opaque.yFromBottom,
                      width: rect.width * opaque.width, height: rect.height * opaque.height).intersection(bounds)
    }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let image else {
            ("请为这个场景上传图片" as NSString).draw(at:NSPoint(x:16,y:bounds.midY),withAttributes:[.font:NSFont.systemFont(ofSize:13),.foregroundColor:NSColor.secondaryLabelColor]);return
        }
        NSGraphicsContext.saveGraphicsState();NSBezierPath(rect:bounds).addClip()
        image.draw(in:sceneImageRect(imageSize:image.size,bounds:bounds,fit:fit),from:.zero,operation:.sourceOver,fraction:1,respectFlipped:false,hints:[.interpolation:NSImageInterpolation.high])
        NSGraphicsContext.restoreGraphicsState()
    }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { gestures.mouseDown(clickCount:event.clickCount); start=NSEvent.mouseLocation;origin=window?.frame.origin ?? .zero;dragged=false }
    override func mouseDragged(with event: NSEvent) { let p=NSEvent.mouseLocation;if hypot(p.x-start.x,p.y-start.y)>3{dragged=true};if dragged{window?.setFrameOrigin(NSPoint(x:origin.x+p.x-start.x,y:origin.y+p.y-start.y))} }
    override func mouseUp(with event: NSEvent) { if dragged { gestures.cancel(); moved?() } else { gestures.mouseUp(clickCount:event.clickCount,dragged:false) } }
    override func rightMouseDown(with event: NSEvent) { gestures.cancel(); showMenu?(event) }
    override func accessibilityPerformPress() -> Bool { clicked?();return true }
}

private struct SceneImageError: LocalizedError { let message:String;var errorDescription:String?{message} }
private struct SceneImageErrorBody: Decodable { let error:String }

final class SceneImageStudioController: NSObject, NSWindowDelegate {
    let baseURL: URL
    private let defaults: UserDefaults
    private let onChange: () -> Void
    private(set) var snapshot: SceneImageSnapshot?
    private(set) var window: NSWindow?
    private(set) var activeImage: NSImage?
    private var images: [String:NSImage] = [:]
    private var selectedID: String?
    private var pendingData: Data?
    private var pendingMIME: String?
    private var pendingImage: NSImage?
    private var fit = "contain"
    private var dirty = false, refreshing = false, busy = false
    private var message = "为每个场景上传一张完整图片，再应用到桌面。"
    private var popup: NSPopUpButton?
    private var fitPopup: NSPopUpButton?
    private let cacheDirectory: URL?
    private let imageLoader: (URL) async throws -> NSImage
    private var key: String { "sceneImages.confirmed."+baseURL.absoluteString }
    private var cache: URL {
        cacheDirectory ?? FileManager.default.urls(for:.cachesDirectory,in:.userDomainMask)[0]
            .appendingPathComponent("local.youjian.desktop/scene-images/\(baseURL.host ?? "localhost")-\(baseURL.port ?? 80)",isDirectory:true)
    }
    init(baseURL:URL,defaults:UserDefaults,cacheDirectory: URL? = nil,
         imageLoader: @escaping (URL) async throws -> NSImage = { url in
             var request = URLRequest(url: url); request.timeoutInterval = 15
             let (data, response) = try await CompanionServer.session.data(for: request)
             try SceneImageStudioController.check(data, response)
             guard data.count <= 12 * 1024 * 1024, let image = SceneImageStudioController.decode(data) else {
                 throw SceneImageError(message: "图片无法读取，请选择 PNG、JPEG 或 WebP 图片。")
             }
             return image
         },onChange:@escaping ()->Void){
        self.baseURL=baseURL;self.defaults=defaults;self.cacheDirectory=cacheDirectory;self.imageLoader=imageLoader;self.onChange=onChange;super.init()
        if let data=defaults.data(forKey:key),let saved=try? JSONDecoder().decode(SceneImageSnapshot.self,from:data){snapshot=saved;selectedID=saved.activeSceneId
            for scene in saved.scenes { if let path=scene.imageUrl, let url=sceneImageURL(path,baseURL:baseURL),let data=try? Data(contentsOf:cache.appendingPathComponent(url.lastPathComponent)),let image=Self.decode(data){images[path]=image} }
            activeImage=saved.active?.imageUrl.flatMap{images[$0]}
        }
    }
    static func decode(_ data:Data)->NSImage? {
        guard let source=CGImageSourceCreateWithData(data as CFData,nil),let properties=CGImageSourceCopyPropertiesAtIndex(source,0,nil) as? [CFString:Any],let w=properties[kCGImagePropertyPixelWidth] as? Int,let h=properties[kCGImagePropertyPixelHeight] as? Int,w>0,h>0,w<=12000,h<=12000,w*h<=40_000_000 else{return nil}
        let options:[CFString:Any]=[kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceThumbnailMaxPixelSize:2048,kCGImageSourceCreateThumbnailWithTransform:true]
        guard let cg=CGImageSourceCreateThumbnailAtIndex(source,0,options as CFDictionary) else{return nil}
        return NSImage(cgImage:cg,size:NSSize(width:cg.width,height:cg.height))
    }
    func show(){
        if window==nil { let w=NSWindow(contentRect:NSRect(x:0,y:0,width:950,height:700),styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false);w.title="林晓薇 · 场景图片";w.minSize=NSSize(width:900,height:650);w.isReleasedWhenClosed=false;w.delegate=self;w.appearance=NSAppearance(named:.aqua);w.center();window=w }
        rebuild();NSApp.activate(ignoringOtherApps:true);window?.makeKeyAndOrderFront(nil);refresh();Task { @MainActor in await self.loadSelectedPreview() }
    }
    func refresh(){
        guard !refreshing && !busy else{return};refreshing=true
        Task { @MainActor in
            defer{refreshing=false}
            do { var request=URLRequest(url:baseURL.appendingPathComponent("api/scene-images"));request.timeoutInterval=8;request.cachePolicy = .reloadIgnoringLocalCacheData
                let(data,response)=try await CompanionServer.session.data(for:request);try Self.check(data,response)
                await accept(try JSONDecoder().decode(SceneImageSnapshot.self,from:data))
            }catch{ if window?.isVisible==true { message="暂时无法同步；已保存的图片仍可使用。";rebuild() } }
        }
    }
    private static func check(_ data:Data,_ response:URLResponse)throws {
        guard let http=response as? HTTPURLResponse else{throw URLError(.badServerResponse)}
        guard http.statusCode==200 else{throw SceneImageError(message:(try? JSONDecoder().decode(SceneImageErrorBody.self,from:data).error) ?? "图片没有保存，请重试。")}
    }
    @MainActor func accept(_ value:SceneImageSnapshot) async {
        guard shouldAcceptSceneImageSnapshot(value, over: snapshot) else { return }
        snapshot=value;activeImage=value.active?.imageUrl.flatMap{images[$0]}
        if selectedID==nil || !value.scenes.contains(where:{$0.id==selectedID}) {selectedID=value.activeSceneId ?? value.scenes.first?.id}
        if !dirty {fit=value.scenes.first{$0.id==selectedID}?.fit ?? "contain"}
        if let data=try? JSONEncoder().encode(value){defaults.set(data,forKey:key)}
        let urls=Set(value.scenes.compactMap(\.imageUrl));images=images.filter{urls.contains($0.key)}
        let filenames=Set(urls.compactMap{sceneImageURL($0,baseURL:baseURL)?.lastPathComponent})
        for file in (try? FileManager.default.contentsOfDirectory(at:cache,includingPropertiesForKeys:nil)) ?? [] {
            if sceneImageURL("/api/scene-images/files/"+file.lastPathComponent,baseURL:baseURL) != nil && !filenames.contains(file.lastPathComponent){try? FileManager.default.removeItem(at:file)}
        }
        onChange();if window?.isVisible==true{rebuild()}
        if value.enabled { await loadImage(for: value.active, matching: value) }
    }
    @MainActor private func loadImage(for scene: SceneImageRecord?, matching value: SceneImageSnapshot) async {
        guard let path=scene?.imageUrl,images[path] == nil,let url=sceneImageURL(path,baseURL:baseURL) else { return }
        guard let image=try? await imageLoader(url), snapshot == value else { return }
        images[path]=image
        try? FileManager.default.createDirectory(at:cache,withIntermediateDirectories:true)
        if let data=image.tiffRepresentation { try? data.write(to:cache.appendingPathComponent(url.lastPathComponent),options:.atomic) }
        activeImage=value.active?.imageUrl.flatMap{images[$0]}
        onChange();if window?.isVisible==true{rebuild()}
    }
    @MainActor private func loadSelectedPreview() async {
        guard let snapshot, let scene=snapshot.scenes.first(where:{$0.id==selectedID}) else { return }
        await loadImage(for: scene, matching: snapshot)
    }
    private func send(_ patch:[String:Any]){
        guard !busy else{return};busy=true;message="正在保存…";rebuild()
        Task { @MainActor in
            defer{busy=false;rebuild()}
            do {var request=URLRequest(url:baseURL.appendingPathComponent("api/scene-images"));request.httpMethod="POST";request.timeoutInterval=45;request.setValue("application/json",forHTTPHeaderField:"Content-Type");request.httpBody=try JSONSerialization.data(withJSONObject:patch)
                let(data,response)=try await CompanionServer.session.data(for:request);try Self.check(data,response)
                let value=try JSONDecoder().decode(SceneImageSnapshot.self,from:data)
                await accept(value);pendingData=nil;pendingMIME=nil;pendingImage=nil;dirty=false;fit=value.scenes.first{$0.id==selectedID}?.fit ?? "contain";message=value.enabled ? "已保存，桌面正在显示你指定的图片。":"已保存。选择有图片的场景即可应用。"
            }catch{message="保存失败：\(error.localizedDescription)；选择的图片已保留，可重试。"}
        }
    }
    private func rebuild(){
        guard let window else{return};let root=NSView(frame:NSRect(origin:.zero,size:window.contentLayoutRect.size));root.autoresizingMask=[.width,.height];root.wantsLayer=true;root.layer?.backgroundColor=NSColor.windowBackgroundColor.cgColor
        let preview=UploadedSceneView(frame:NSRect(x:20,y:30,width:root.bounds.width-350,height:root.bounds.height-60));preview.autoresizingMask=[.width,.height];preview.image=pendingImage ?? snapshot?.scenes.first{$0.id==selectedID}?.imageUrl.flatMap{images[$0]};preview.fit=fit;preview.setAccessibilityLabel("上传图片预览");root.addSubview(preview)
        let x=root.bounds.width-305
        func text(_ value:String,_ y:CGFloat,_ height:CGFloat=28,_ size:CGFloat=13){let l=NSTextField(wrappingLabelWithString:value);l.font = .systemFont(ofSize:size);l.frame=NSRect(x:x,y:y,width:280,height:height);l.autoresizingMask=[.minXMargin,.minYMargin];root.addSubview(l)}
        text("场景图片",root.bounds.height-66,36,26)
        text("上传你满意的整张图片。人物、衣服、表情和环境都以图片为准。",root.bounds.height-125,48)
        text("场景",root.bounds.height-166)
        let scene=NSPopUpButton(frame:NSRect(x:x,y:root.bounds.height-195,width:280,height:28),pullsDown:false);scene.autoresizingMask=[.minXMargin,.minYMargin];scene.target=self;scene.action=#selector(selectScene(_:));scene.isEnabled = !busy
        for row in snapshot?.scenes ?? [] {scene.addItem(withTitle:row.name+(row.imageUrl==nil ? " · 未上传":""));scene.lastItem?.representedObject=row.id;if row.id==selectedID{scene.select(scene.lastItem)}}
        if scene.numberOfItems==0 {scene.addItem(withTitle:"正在加载场景…");scene.isEnabled=false};root.addSubview(scene);popup=scene
        func button(_ title:String,_ action:Selector,_ y:CGFloat,_ enabled:Bool=true){let b=NSButton(title:title,target:self,action:action);b.bezelStyle = .rounded;b.frame=NSRect(x:x,y:y,width:280,height:34);b.autoresizingMask=[.minXMargin,.minYMargin];b.isEnabled=enabled && !busy;root.addSubview(b)}
        button("选择图片…",#selector(chooseImage),root.bounds.height-245,selectedID != nil)
        text("PNG / JPEG / WebP，最大 12 MB。支持透明背景，不会自动抠图或拉伸。",root.bounds.height-305,48,12)
        text("显示方式",root.bounds.height-341)
        let fitChoice=NSPopUpButton(frame:NSRect(x:x,y:root.bounds.height-370,width:280,height:28),pullsDown:false);fitChoice.addItems(withTitles:["完整显示（保持比例）","铺满画面（裁切边缘）"]);fitChoice.selectItem(at:fit=="cover" ? 1:0);fitChoice.target=self;fitChoice.action=#selector(changeFit(_:));fitChoice.isEnabled = !busy;fitChoice.autoresizingMask=[.minXMargin,.minYMargin];root.addSubview(fitChoice);fitPopup=fitChoice
        let hasImage=pendingImage != nil || snapshot?.scenes.first{$0.id==selectedID}?.imageUrl != nil
        button("保存并应用到桌面",#selector(apply),root.bounds.height-422,hasImage)
        button("移除这个场景的图片",#selector(remove),root.bounds.height-464,snapshot?.scenes.first{$0.id==selectedID}?.imageUrl != nil)
        button("暂用原有角色",#selector(disable),root.bounds.height-506,snapshot?.enabled == true)
        text(message,30,85,12)
        window.contentView=root
    }
    @objc private func selectScene(_ sender:NSPopUpButton){selectedID=sender.selectedItem?.representedObject as? String;pendingData=nil;pendingMIME=nil;pendingImage=nil;dirty=false;fit=snapshot?.scenes.first{$0.id==selectedID}?.fit ?? "contain";message="预览这个场景，点击保存并应用后才会切换桌面。";rebuild();Task { @MainActor in await self.loadSelectedPreview() }}
    @objc private func changeFit(_ sender:NSPopUpButton){fit=sender.indexOfSelectedItem==1 ? "cover":"contain";dirty=true;rebuild()}
    @objc private func chooseImage(){
        guard let window else{return};let picker=NSOpenPanel();picker.allowedContentTypes=[.png,.jpeg,UTType(filenameExtension:"webp")!];picker.allowsMultipleSelection=false;picker.canChooseDirectories=false
        picker.beginSheetModal(for:window){[weak self] response in guard let self,response == .OK,let url=picker.url else{return}
            do {let size=try url.resourceValues(forKeys:[.fileSizeKey]).fileSize ?? 0;guard size>0,size<=12*1024*1024 else{throw SceneImageError(message:"图片不能超过 12 MB。")};let data=try Data(contentsOf:url);guard let image=Self.decode(data) else{throw SceneImageError(message:"图片格式无效，或尺寸超过 12000 像素 / 4000 万像素。")}
                let ext=url.pathExtension.lowercased();let mime=ext=="png" ? "image/png":ext=="webp" ? "image/webp":"image/jpeg"
                pendingData=data;pendingMIME=mime;pendingImage=image;dirty=true;message="已选择 \(url.lastPathComponent)。确认预览后保存并应用。"
            }catch{message=error.localizedDescription};rebuild()
        }
    }
    @objc private func apply(){guard let id=selectedID else{return};var patch:[String:Any]=["sceneId":id,"fit":fit,"activeSceneId":id,"enabled":true];if let data=pendingData,let mime=pendingMIME{patch["image"]="data:\(mime);base64,"+data.base64EncodedString()};send(patch)}
    @objc private func remove(){guard let id=selectedID else{return};send(["sceneId":id,"image":NSNull()])}
    @objc private func disable(){send(["enabled":false])}
}
