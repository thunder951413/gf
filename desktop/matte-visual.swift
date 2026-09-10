import Foundation
import Vision
import CoreImage
import AppKit

// Offline alpha preparation of approved sources. A small edge trim preserves fingers.
// Input pixels are retained; this tool never generates or changes a face or garment.
let args=CommandLine.arguments
guard args.count >= 3 else { fatalError("Usage: matte-visual source.png output.png [edge-radius]") }
let source=URL(fileURLWithPath:args[1]), target=URL(fileURLWithPath:args[2])
let radius=args.count>3 ? Double(args[3])! : 2.0
let context=CIContext(), handler=VNImageRequestHandler(url:source,options:[:])
let request=VNGenerateForegroundInstanceMaskRequest()
try handler.perform([request])
guard let observation=request.results?.first, !observation.allInstances.isEmpty else { fatalError("No foreground") }
let buffer=try observation.generateMaskedImage(ofInstances:observation.allInstances,from:handler,croppedToInstancesExtent:false)
let original=CIImage(contentsOf:source)!
var mask=CIImage(cvPixelBuffer:buffer).applyingFilter("CIColorMatrix",parameters:["inputRVector":CIVector(x:0,y:0,z:0,w:1),"inputGVector":CIVector(x:0,y:0,z:0,w:1),"inputBVector":CIVector(x:0,y:0,z:0,w:1),"inputAVector":CIVector(x:0,y:0,z:0,w:0),"inputBiasVector":CIVector(x:0,y:0,z:0,w:1)])
    .applyingFilter("CIMorphologyMinimum",parameters:[kCIInputRadiusKey:radius])
    .applyingFilter("CIGaussianBlur",parameters:[kCIInputRadiusKey:0.35]).cropped(to:original.extent)
// These two approved seated sources need their original chair restored: Vision
// segments the person only. Region/color masks preserve the real photographed wood.
if ["short-academic.png","short-academic-v3.png","long-homewear-cup.png"].contains(source.lastPathComponent) {
    let rep=NSBitmapImageRep(data:try Data(contentsOf:source))!
    let repair=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:rep.pixelsWide,pixelsHigh:rep.pixelsHigh,bitsPerSample:8,samplesPerPixel:1,hasAlpha:false,isPlanar:false,colorSpaceName:.deviceWhite,bytesPerRow:rep.pixelsWide,bitsPerPixel:8)!
    memset(repair.bitmapData!,0,repair.bytesPerRow*repair.pixelsHigh)
    func polygon(_ points:[(Double,Double)]) -> NSBezierPath { let p=NSBezierPath();p.move(to:NSPoint(x:points[0].0,y:points[0].1));for v in points.dropFirst(){p.line(to:NSPoint(x:v.0,y:v.1))};p.close();return p }
    let back=source.lastPathComponent=="short-academic-v3.png"
        ? polygon([(733,528),(780,529),(796,540),(807,563),(817,600),(817,835),(808,890),(782,920),(734,909)])
        : polygon([(747,531),(780,532),(800,544),(807,569),(815,824),(808,864),(780,852),(746,807)])
    let seat=polygon([(289,878),(327,871),(538,903),(689,911),(753,928),(766,947),(534,941),(309,917),(286,907)])
    for y in 480..<1380 { for x in 240..<860 {
        let c=rep.colorAt(x:x,y:y)!.usingColorSpace(.deviceRGB)!
        let wood=c.redComponent-c.blueComponent>0.12 && c.greenComponent-c.blueComponent>0.05 && c.redComponent-c.greenComponent>0.035
        let cushion=source.lastPathComponent.hasPrefix("short-academic") && (back.contains(NSPoint(x:x,y:y)) || seat.contains(NSPoint(x:x,y:y)))
        if wood || cushion { repair.bitmapData![y*repair.bytesPerRow+x]=255 }
    }}
    let details=CIImage(cgImage:repair.cgImage!).applyingFilter("CIMorphologyMinimum",parameters:[kCIInputRadiusKey:1.0]).applyingFilter("CIGaussianBlur",parameters:[kCIInputRadiusKey:0.4])
    mask=mask.applyingFilter("CIMaximumCompositing",parameters:[kCIInputBackgroundImageKey:details]).cropped(to:original.extent)
}
// Restore only the observed original armchair silhouette. Explicit geometry avoids
// confusing neutral upholstery with the equally neutral studio background.
if source.lastPathComponent == "long-soft-knit-resting.png" {
 let rep=NSBitmapImageRep(data:try Data(contentsOf:source))!
 let repair=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:rep.pixelsWide,pixelsHigh:rep.pixelsHigh,bitsPerSample:8,samplesPerPixel:1,hasAlpha:false,isPlanar:false,colorSpaceName:.deviceWhite,bytesPerRow:rep.pixelsWide,bitsPerPixel:8)!
 memset(repair.bitmapData!,0,repair.bytesPerRow*repair.pixelsHigh)
 let body=NSBezierPath();body.move(to:NSPoint(x:300,y:532));body.line(to:NSPoint(x:742,y:523))
 body.curve(to:NSPoint(x:895,y:576),controlPoint1:NSPoint(x:846,y:522),controlPoint2:NSPoint(x:890,y:538))
 body.line(to:NSPoint(x:909,y:659));body.curve(to:NSPoint(x:971,y:742),controlPoint1:NSPoint(x:944,y:681),controlPoint2:NSPoint(x:973,y:714))
 body.curve(to:NSPoint(x:940,y:1050),controlPoint1:NSPoint(x:966,y:833),controlPoint2:NSPoint(x:957,y:970))
 body.curve(to:NSPoint(x:904,y:1178),controlPoint1:NSPoint(x:930,y:1149),controlPoint2:NSPoint(x:926,y:1178))
 body.line(to:NSPoint(x:157,y:1165));body.curve(to:NSPoint(x:96,y:756),controlPoint1:NSPoint(x:123,y:1136),controlPoint2:NSPoint(x:116,y:909))
 body.curve(to:NSPoint(x:203,y:661),controlPoint1:NSPoint(x:88,y:708),controlPoint2:NSPoint(x:169,y:676))
 body.curve(to:NSPoint(x:300,y:532),controlPoint1:NSPoint(x:209,y:565),controlPoint2:NSPoint(x:238,y:549));body.close()
 var shapes=[body]
 for points in [[(183.0,1165.0),(230,1165),(204,1308),(173,1312),(172,1296)],[(253.0,1167.0),(287,1169),(275,1210),(249,1206)],[(819.0,1175.0),(858,1176),(884,1325),(857,1331),(848,1322)]] {let p=NSBezierPath();p.move(to:NSPoint(x:points[0].0,y:points[0].1));for v in points.dropFirst(){p.line(to:NSPoint(x:v.0,y:v.1))};p.close();shapes.append(p)}
 for y in 520..<1340 {for x in 90..<975 {if shapes.contains(where:{$0.contains(NSPoint(x:x,y:y))}) {repair.bitmapData![y*repair.bytesPerRow+x]=255}}}
 let details=CIImage(cgImage:repair.cgImage!).applyingFilter("CIMorphologyMinimum",parameters:[kCIInputRadiusKey:1.5]).applyingFilter("CIGaussianBlur",parameters:[kCIInputRadiusKey:0.4])
 mask=mask.applyingFilter("CIMaximumCompositing",parameters:[kCIInputBackgroundImageKey:details])
}
// Narrow cool-gray source-background gaps in the swimsuit pose are not skin or
// fabric. Vision can otherwise bridge the gap between an arm and the torso.
if source.lastPathComponent == "long-swimwear-idle.png" {
 let rep=NSBitmapImageRep(data:try Data(contentsOf:source))!
 let keep=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:rep.pixelsWide,pixelsHigh:rep.pixelsHigh,bitsPerSample:8,samplesPerPixel:1,hasAlpha:false,isPlanar:false,colorSpaceName:.deviceWhite,bytesPerRow:rep.pixelsWide,bitsPerPixel:8)!
 memset(keep.bitmapData!,255,keep.bytesPerRow*keep.pixelsHigh)
 for y in 450..<1400 {for x in 300..<730 {let c=rep.colorAt(x:x,y:y)!.usingColorSpace(.deviceRGB)!;let d=c.blueComponent-c.redComponent;if c.redComponent>0.6 && d>0.006 && d<0.08 && c.greenComponent>=c.redComponent {keep.bitmapData![y*keep.bytesPerRow+x]=0}}}
 mask=mask.applyingFilter("CIMinimumCompositing",parameters:[kCIInputBackgroundImageKey:CIImage(cgImage:keep.cgImage!)]).applyingFilter("CIMorphologyMinimum",parameters:[kCIInputRadiusKey:1.0]).applyingFilter("CIGaussianBlur",parameters:[kCIInputRadiusKey:0.35])
}
// Observed cool studio background bridges between the revised bare-leg poses.
// Restrict to lower-leg regions above the shoes; this never changes RGB pixels.
let revisedLegPoses=["short-idle-v3.png","ponytail-idle-v3.png","ponytail-shorts-v3.png","long-swimwear-idle-v3.png","long-lingerie-idle-v3.png","long-bodycon-turning-v3.png"]
if revisedLegPoses.contains(source.lastPathComponent) {
 let rep=NSBitmapImageRep(data:try Data(contentsOf:source))!
 let keep=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:rep.pixelsWide,pixelsHigh:rep.pixelsHigh,bitsPerSample:8,samplesPerPixel:1,hasAlpha:false,isPlanar:false,colorSpaceName:.deviceWhite,bytesPerRow:rep.pixelsWide,bitsPerPixel:8)!
 memset(keep.bitmapData!,255,keep.bytesPerRow*keep.pixelsHigh)
 let startY=source.lastPathComponent=="long-swimwear-idle-v3.png" ? 450:800
 for y in startY..<1250 {for x in 310..<720 {
  let c=rep.colorAt(x:x,y:y)!.usingColorSpace(.deviceRGB)!
  let d=c.blueComponent-c.redComponent
  if c.redComponent>0.6 && d>0.006 && d<0.08 && c.greenComponent>=c.redComponent {keep.bitmapData![y*keep.bytesPerRow+x]=0}
 }}
 mask=mask.applyingFilter("CIMinimumCompositing",parameters:[kCIInputBackgroundImageKey:CIImage(cgImage:keep.cgImage!)]).applyingFilter("CIMorphologyMinimum",parameters:[kCIInputRadiusKey:0.5]).applyingFilter("CIGaussianBlur",parameters:[kCIInputRadiusKey:0.35])
}
let image=original.applyingFilter("CIBlendWithMask",parameters:[kCIInputBackgroundImageKey:CIImage(color:.clear).cropped(to:original.extent),kCIInputMaskImageKey:mask])
try FileManager.default.createDirectory(at:target.deletingLastPathComponent(),withIntermediateDirectories:true)
try context.writePNGRepresentation(of:image,to:target,format:.RGBA8,colorSpace:CGColorSpace(name:CGColorSpace.sRGB)!)
let rep=NSBitmapImageRep(data:try Data(contentsOf:target))!
var clear=0,solid=0
for y in stride(from:0,to:rep.pixelsHigh,by:4) { for x in stride(from:0,to:rep.pixelsWide,by:4) { let a=rep.colorAt(x:x,y:y)!.alphaComponent; if a<0.01 { clear+=1 }; if a>0.99 { solid+=1 } } }
guard rep.hasAlpha,clear>1000,solid>1000 else { fatalError("Invalid mask") }
print("\(target.lastPathComponent) \(rep.pixelsWide)x\(rep.pixelsHigh) instances=\(observation.allInstances.count) clear=\(clear) solid=\(solid) trim=\(radius)")
