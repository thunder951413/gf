import AppKit

/// A small, resolution-independent mark: a conversation with a heart inside.
/// Draw it directly so the menu item never depends on SF Symbol availability.
enum MenuBarIcon {
    static func makeDrawing() -> NSImage {
        let drawing = NSImage(size: NSSize(width: 20, height: 18), flipped: false) { _ in
            NSColor.black.setStroke()
            NSColor.black.setFill()

            let bubble = NSBezierPath()
            bubble.move(to: NSPoint(x: 5, y: 16))
            bubble.line(to: NSPoint(x: 15, y: 16))
            bubble.curve(to: NSPoint(x: 18, y: 13), controlPoint1: NSPoint(x: 16.7, y: 16), controlPoint2: NSPoint(x: 18, y: 14.7))
            bubble.line(to: NSPoint(x: 18, y: 7))
            bubble.curve(to: NSPoint(x: 15, y: 4), controlPoint1: NSPoint(x: 18, y: 5.3), controlPoint2: NSPoint(x: 16.7, y: 4))
            bubble.line(to: NSPoint(x: 9, y: 4))
            bubble.line(to: NSPoint(x: 5, y: 1.5))
            bubble.line(to: NSPoint(x: 5, y: 4))
            bubble.curve(to: NSPoint(x: 2, y: 7), controlPoint1: NSPoint(x: 3.3, y: 4), controlPoint2: NSPoint(x: 2, y: 5.3))
            bubble.line(to: NSPoint(x: 2, y: 13))
            bubble.curve(to: NSPoint(x: 5, y: 16), controlPoint1: NSPoint(x: 2, y: 14.7), controlPoint2: NSPoint(x: 3.3, y: 16))
            bubble.close()
            bubble.lineWidth = 1.5
            bubble.lineJoinStyle = .round
            bubble.stroke()

            let heart = NSBezierPath()
            heart.move(to: NSPoint(x: 10, y: 6.8))
            heart.curve(to: NSPoint(x: 6.1, y: 11), controlPoint1: NSPoint(x: 9, y: 7.7), controlPoint2: NSPoint(x: 6.1, y: 9.3))
            heart.curve(to: NSPoint(x: 10, y: 12.2), controlPoint1: NSPoint(x: 6.1, y: 13.5), controlPoint2: NSPoint(x: 8.8, y: 14.1))
            heart.curve(to: NSPoint(x: 13.9, y: 11), controlPoint1: NSPoint(x: 11.2, y: 14.1), controlPoint2: NSPoint(x: 13.9, y: 13.5))
            heart.curve(to: NSPoint(x: 10, y: 6.8), controlPoint1: NSPoint(x: 13.9, y: 9.3), controlPoint2: NSPoint(x: 11, y: 7.7))
            heart.close()
            heart.fill()
            return true
        }
        return drawing
    }

    static func makeImage() -> NSImage {
        let drawing = makeDrawing()
        // Provide concrete pixel representations to the system-hosted menu bar.
        // The drawing closure remains local to this process.
        let image = NSImage(size: drawing.size)
        for scale in [1, 2, 3] {
            let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil,
                pixelsWide: 20 * scale, pixelsHigh: 18 * scale,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
            bitmap.size = drawing.size
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
            drawing.draw(in: NSRect(origin: .zero, size: drawing.size))
            NSGraphicsContext.restoreGraphicsState()
            image.addRepresentation(bitmap)
        }
        image.isTemplate = true
        image.accessibilityDescription = "有间桌面"
        return image
    }
}
