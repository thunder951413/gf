import AppKit

/// Build the app icon from the same mark used in the status item.
@main
enum RenderAppIcon {
    static func main() throws {
        let directory = URL(fileURLWithPath: CommandLine.arguments[1])
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let mark = MenuBarIcon.makeDrawing()
        let artwork = NSImage(size: NSSize(width: 1024, height: 1024), flipped: false) { _ in
            NSColor(calibratedRed: 0.455, green: 0.275, blue: 0.341, alpha: 1).setFill()
            NSBezierPath(roundedRect: NSRect(x: 48, y: 48, width: 928, height: 928), xRadius: 208, yRadius: 208).fill()
            let creamMark = NSImage(size: mark.size, flipped: false) { rect in
                mark.draw(in: rect)
                NSColor(calibratedRed: 0.969, green: 0.933, blue: 0.902, alpha: 1).setFill()
                rect.fill(using: .sourceIn)
                return true
            }
            creamMark.draw(in: NSRect(x: 172, y: 206, width: 680, height: 612))
            return true
        }
        for size in [16, 32, 128, 256, 512] {
            for scale in [1, 2] {
                let pixels = size * scale
                let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
                bitmap.size = NSSize(width: 1024, height: 1024)
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
                artwork.draw(in: NSRect(x: 0, y: 0, width: 1024, height: 1024))
                NSGraphicsContext.restoreGraphicsState()
                let suffix = scale == 2 ? "@2x" : ""
                try bitmap.representation(using: .png, properties: [:])!.write(
                    to: directory.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
            }
        }
    }
}
