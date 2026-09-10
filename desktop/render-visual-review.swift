import AppKit

// Render this app's own scenes into a review artifact, without screen capture.
@main struct VisualReview {
 static func main() throws {
  let args=CommandLine.arguments;guard args.count==3 else {fatalError("render-review assets-root output.png")}
  _=NSApplication.shared
  let library=PhotoPetLibrary(resourceURL:URL(fileURLWithPath:args[1]))
  guard let catalog=library.manifest else {fatalError(library.manifestLoadError ?? "Missing catalog")}
  let entries=[
   ("春日窗边 · 休息","original-long-soft-knit-resting-soft-smile-original","spring-study"),
   ("高马尾 · 本地换色","bob-soft-knit-wave-happy-sage","autumn-cafe"),
   ("夏日海岸 · 马尾","ponytail-shorts-walking-curious-original","summer-coast"),
   ("短发 · 樱花水手服","short-academic-sitting-shy-original","study"),
   ("修身连衣裙 · 转身","original-long-bodycon-dress-turning-soft-smile-original","private-bedroom"),
   ("冬日居所 · 入睡","original-long-homewear-sleeping-tired-original","winter-home")
  ]
  let result=NSImage(size:NSSize(width:1020,height:1100));result.lockFocus();NSColor(calibratedRed:0.95,green:0.93,blue:0.90,alpha:1).setFill();NSRect(x:0,y:0,width:1020,height:1100).fill();result.unlockFocus()
  for(i,item) in entries.enumerated(){
   let record=catalog.assets.first{$0.id==item.1}!
   let selected=VisualSelection(assetId:record.id,hairstyleId:record.hairstyleId,outfitId:record.outfitId,sceneId:item.2,poseId:record.poseId,expressionId:record.expressionId,paletteId:record.paletteId)
   let view=NativeSceneCanvas(frame:NSRect(x:0,y:0,width:320,height:480));view.scene=library.scene(id:item.2);view.backdrop=library.sceneImage(id:item.2);view.sceneCardEnabled=true;view.reduceMotion=true;view.figureView.asset=library.resolved(selection:selected)!.asset
   let window=NSWindow(contentRect:view.frame,styleMask:.borderless,backing:.buffered,defer:false);window.isReleasedWhenClosed=false;window.contentView=view;view.layoutSubtreeIfNeeded();view.displayIfNeeded()
   let rep=view.bitmapImageRepForCachingDisplay(in:view.bounds)!;view.cacheDisplay(in:view.bounds,to:rep)
   let x=CGFloat(i%3)*340+10,y=CGFloat(1-i/3)*550+25
   result.lockFocus();NSImage(cgImage:rep.cgImage!,size:view.bounds.size).draw(in:NSRect(x:x,y:y,width:320,height:480));(item.0 as NSString).draw(at:NSPoint(x:x+8,y:y+496),withAttributes:[.font:NSFont.systemFont(ofSize:17,weight:.medium),.foregroundColor:NSColor(calibratedRed:0.31,green:0.25,blue:0.27,alpha:1)]);result.unlockFocus()
  }
  let url=URL(fileURLWithPath:args[2]);try FileManager.default.createDirectory(at:url.deletingLastPathComponent(),withIntermediateDirectories:true);try NSBitmapImageRep(data:result.tiffRepresentation!)!.representation(using:.png,properties:[:])!.write(to:url)
  print(url.path)
 }
}
