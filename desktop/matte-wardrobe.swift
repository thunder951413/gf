import Foundation
import Vision
import CoreImage
import AppKit

// Offline preprocessing, explicitly authorized by the user. Never runs in the desktop app.
// https://developer.apple.com/documentation/vision/vninstancemaskobservation
let args = CommandLine.arguments
guard args.count == 3 else { fatalError("Usage: matte-wardrobe <sources-directory> <cutouts-directory>") }
let input = URL(fileURLWithPath: args[1], isDirectory: true)
let output = URL(fileURLWithPath: args[2], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let context = CIContext()
for url in try FileManager.default.contentsOfDirectory(at: input, includingPropertiesForKeys: nil).filter({ $0.pathExtension == "png" }).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
    try autoreleasepool {
        let handler = VNImageRequestHandler(url: url, options: [:])
        let request = VNGenerateForegroundInstanceMaskRequest()
        try handler.perform([request])
        guard let result = request.results?.first, !result.allInstances.isEmpty else { fatalError("No foreground: \(url.lastPathComponent)") }
        let pixels = try result.generateMaskedImage(ofInstances: result.allInstances, from: handler, croppedToInstancesExtent: false)
        var mask = CIImage(cvPixelBuffer: pixels).applyingFilter("CIColorMatrix",parameters:[
            "inputRVector":CIVector(x:0,y:0,z:0,w:1), "inputGVector":CIVector(x:0,y:0,z:0,w:1),
            "inputBVector":CIVector(x:0,y:0,z:0,w:1), "inputAVector":CIVector(x:0,y:0,z:0,w:0),
            "inputBiasVector":CIVector(x:0,y:0,z:0,w:1)])
        let original = CIImage(contentsOf: url)!
        var chairDetails: CIImage?
        // Vision sometimes omits thin oak chair supports. Restore only original warm
        // wood pixels inside the observed chair area, never synthesize replacement pixels.
        if url.lastPathComponent.contains("reading") {
            let source = NSBitmapImageRep(data: try Data(contentsOf: url))!
            let repair = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: source.pixelsWide, pixelsHigh: source.pixelsHigh, bitsPerSample: 8, samplesPerPixel: 1, hasAlpha: false, isPlanar: false, colorSpaceName: .deviceWhite, bytesPerRow: source.pixelsWide, bitsPerPixel: 8)!
            memset(repair.bitmapData!, 0, repair.bytesPerRow * repair.pixelsHigh)
            let cushion = NSBezierPath()
            let points: [(CGFloat,CGFloat)] = [(531,841),(645,837),(710,819),(780,806),(806,807),(816,834),(807,855),(768,879),(731,887),(531,884)]
            cushion.move(to: NSPoint(x:points[0].0,y:points[0].1))
            for p in points.dropFirst() { cushion.line(to:NSPoint(x:p.0,y:p.1)) }; cushion.close()
            for y in 450..<min(1380,source.pixelsHigh) {
                for x in 250..<min(880,source.pixelsWide) {
                    let c=source.colorAt(x:x,y:y)!.usingColorSpace(.deviceRGB)!
                    let wood=c.redComponent-c.blueComponent > 0.12 && c.greenComponent-c.blueComponent > 0.05 && c.redComponent-c.greenComponent > 0.035
                    let seat=url.lastPathComponent == "everyday-reading.png" && cushion.contains(NSPoint(x:x,y:y))
                    if wood || seat { repair.bitmapData![y*repair.bytesPerRow+x] = 255 }
                }
            }
            mask = mask.applyingFilter("CIMaximumCompositing",parameters:[kCIInputBackgroundImageKey:CIImage(cgImage:repair.cgImage!)])
            chairDetails = CIImage(cgImage:repair.cgImage!).applyingFilter("CIMorphologyMinimum",parameters:[kCIInputRadiusKey:2.0])
        }
        // Remove the narrow halo of the baked source background, feather below a
        // display pixel. Kept at original resolution for stable outfit/pose alignment.
        mask = mask.applyingFilter("CIMorphologyMinimum",parameters:[kCIInputRadiusKey:10.0])
        if let chairDetails { mask = mask.applyingFilter("CIMaximumCompositing",parameters:[kCIInputBackgroundImageKey:chairDetails]) }
        mask = mask.applyingFilter("CIGaussianBlur",parameters:[kCIInputRadiusKey:0.5]).cropped(to:original.extent)
        let transparentBackground=CIImage(color:.clear).cropped(to:original.extent)
        let image=original.applyingFilter("CIBlendWithMask",parameters:[kCIInputBackgroundImageKey:transparentBackground,kCIInputMaskImageKey:mask])
        let destination = output.appendingPathComponent(url.lastPathComponent)
        try context.writePNGRepresentation(of: image, to: destination, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
        guard let rep = NSBitmapImageRep(data: try Data(contentsOf: destination)), rep.hasAlpha else { fatalError("Missing alpha") }
        var clear = 0, solid = 0, edge = 0
        for y in stride(from: 0, to: rep.pixelsHigh, by: 4) {
            for x in stride(from: 0, to: rep.pixelsWide, by: 4) {
                let a = rep.colorAt(x: x, y: y)!.alphaComponent
                if a < 0.01 { clear += 1 } else if a > 0.99 { solid += 1 } else { edge += 1 }
            }
        }
        guard clear > 1000, solid > 1000 else { fatalError("Invalid foreground coverage") }
        print("\(url.lastPathComponent): \(rep.pixelsWide)x\(rep.pixelsHigh), instances=\(result.allInstances.count), alpha clear=\(clear) solid=\(solid) edge=\(edge)")
        fflush(stdout)
    }
}
