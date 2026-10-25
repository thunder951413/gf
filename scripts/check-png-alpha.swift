import AppKit
import Foundation
let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let image = NSBitmapImageRep(data: data)!
let w = image.pixelsWide, h = image.pixelsHigh
let corners = [(0,0),(w-1,0),(0,h-1),(w-1,h-1)]
let alphas = corners.map { image.colorAt(x: $0.0, y: $0.1)?.alphaComponent ?? 1 }
print(alphas.allSatisfy { $0 < 0.01 } ? "transparent" : "opaque")
