import AppKit
import Foundation
// Offline garment-only variants; neither skin nor image alpha is recolored.
let args=CommandLine.arguments
guard args.count==6 else {fatalError("recolor-visual source output mask blue-garment hex")}
guard args[4]=="blue-garment" else {fatalError("Only approved blue garment masks are supported")}
let source=NSBitmapImageRep(data:try Data(contentsOf:URL(fileURLWithPath:args[1])))!
let output=source.copy() as! NSBitmapImageRep
let w=source.pixelsWide,h=source.pixelsHigh
let mask=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:w,pixelsHigh:h,bitsPerSample:8,samplesPerPixel:1,hasAlpha:false,isPlanar:false,colorSpaceName:.deviceWhite,bytesPerRow:w,bitsPerPixel:8)!
memset(mask.bitmapData!,0,mask.bytesPerRow*h)
let hex=UInt32(args[5].replacingOccurrences(of:"#",with:""),radix:16)!
let tr=Double((hex>>16)&255)/255,tg=Double((hex>>8)&255)/255,tb=Double(hex&255)/255
let tl=0.2126*tr+0.7152*tg+0.0722*tb
var count=0,pixel=[Int](repeating:0,count:4)
for y in 0..<h { for x in 0..<w {
 source.getPixel(&pixel,atX:x,y:y)
 let r=Double(pixel[0])/255,g=Double(pixel[1])/255,b=Double(pixel[2])/255, yn=Double(y)/Double(h)
 let selected = yn>0.30 && yn<0.86 && b-r>0.025 && b-g>0.025
 guard selected,pixel[3]>0 else {continue}
 let luminance=0.2126*r+0.7152*g+0.0722*b
 // Luminance-preserving chroma replacement retains fabric folds and highlights.
 let nr=max(0,min(1,luminance+(tr-tl))), ng=max(0,min(1,luminance+(tg-tl))), nb=max(0,min(1,luminance+(tb-tl)))
 pixel[0]=Int((nr*255).rounded());pixel[1]=Int((ng*255).rounded());pixel[2]=Int((nb*255).rounded())
 output.setPixel(&pixel,atX:x,y:y);mask.bitmapData![y*mask.bytesPerRow+x]=255;count+=1
}}
guard count>10000 else {fatalError("Garment mask too small: \(count)")}
for (bitmap,file) in [(output,args[2]),(mask,args[3])] {let url=URL(fileURLWithPath:file);try FileManager.default.createDirectory(at:url.deletingLastPathComponent(),withIntermediateDirectories:true);try bitmap.representation(using:.png,properties:[:])!.write(to:url)}
// Verify decoded exported PNG, not just in-memory edits.
let check=NSBitmapImageRep(data:try Data(contentsOf:URL(fileURLWithPath:args[2])))!
var a=[Int](repeating:0,count:4),b=[Int](repeating:0,count:4),outside=0,changed=0
for y in 0..<h {for x in 0..<w {source.getPixel(&a,atX:x,y:y);check.getPixel(&b,atX:x,y:y);guard a[3]==b[3] else {fatalError("Alpha changed")};if mask.bitmapData![y*mask.bytesPerRow+x]==0 {guard a==b else {fatalError("Outside mask changed")};outside+=1}else if a != b {changed+=1}}}
print("\(URL(fileURLWithPath:args[2]).lastPathComponent): mask=\(count), changed=\(changed), outside unchanged=\(outside), alpha identical")
