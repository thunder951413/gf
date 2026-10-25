import AppKit
import Foundation

let root = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
let imageKey = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : "source"
let data = try Data(contentsOf: root)
let plan = try JSONSerialization.jsonObject(with: data) as! [String: Any]
let rows = plan["images"] as! [[String: Any]]
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

let columns = 4, batch = 12, cellW = 400, cellH = 650
for start in stride(from: 0, to: rows.count, by: batch) {
    let end = min(start + batch, rows.count)
    let count = end - start
    let width = columns * cellW, height = ((count + columns - 1) / columns) * cellH
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                               isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSColor(white: 0.87, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()
    for index in start..<end {
        let row = rows[index]
        let local = index - start
        let col = local % columns, line = local / columns
        let x = col * cellW, y = height - (line + 1) * cellH
        if let path = row[imageKey] as? String, let image = NSImage(contentsOfFile: path) {
            image.draw(in: NSRect(x: x + 12, y: y + 42, width: cellW - 24, height: cellH - 50),
                       from: .zero, operation: .sourceOver, fraction: 1)
        }
        let name = "\(index) \(row["character"] as? String ?? "") \(row["variant"] as? Int ?? 0)"
        (name as NSString).draw(at: NSPoint(x: x + 12, y: y + 10), withAttributes: [
            .font: NSFont.systemFont(ofSize: 18, weight: .bold),
            .foregroundColor: NSColor.black
        ])
    }
    NSGraphicsContext.restoreGraphicsState()
    let file = output.appendingPathComponent(String(format: "sheet_%02d.png", start / batch + 1))
    try rep.representation(using: .png, properties: [:])!.write(to: file)
    print(file.path)
}
