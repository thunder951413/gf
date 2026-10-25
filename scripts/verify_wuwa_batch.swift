import AppKit
import Foundation

let root = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/Users/surfing/tools/life/output/wuwa_female_photoreal"
let data = try Data(contentsOf: URL(fileURLWithPath: root + "/generation-plan.json"))
let plan = try JSONSerialization.jsonObject(with: data) as! [String: Any]
let items = plan["images"] as! [[String: Any]]
var missing: [String] = []
var badAlpha: [String] = []
var badSize: [String] = []
var touchingEdge: [String] = []
for item in items {
    let path = item["target"] as! String
    guard let png = try? Data(contentsOf: URL(fileURLWithPath: path)),
          let image = NSBitmapImageRep(data: png) else {
        missing.append(path)
        continue
    }
    if image.pixelsWide < 700 || image.pixelsHigh < 1000 { badSize.append(path) }
    let w = image.pixelsWide, h = image.pixelsHigh
    let corners = [(0,0), (w-1,0), (0,h-1), (w-1,h-1)]
    if corners.contains(where: { image.colorAt(x: $0.0, y: $0.1)?.alphaComponent ?? 1 > 0.01 }) {
        badAlpha.append(path)
    }
    let xs = stride(from: 0, to: w, by: 8)
    let ys = stride(from: 0, to: h, by: 8)
    let edge = xs.contains(where: { (image.colorAt(x: $0, y: 0)?.alphaComponent ?? 0) > 0.1 || (image.colorAt(x: $0, y: h-1)?.alphaComponent ?? 0) > 0.1 })
        || ys.contains(where: { (image.colorAt(x: 0, y: $0)?.alphaComponent ?? 0) > 0.1 || (image.colorAt(x: w-1, y: $0)?.alphaComponent ?? 0) > 0.1 })
    if edge { touchingEdge.append(path) }
}
print("expected \(items.count) missing \(missing.count) badAlpha \(badAlpha.count) badSize \(badSize.count) touchingEdge \(touchingEdge.count)")
for (name, values) in [("missing",missing),("badAlpha",badAlpha),("badSize",badSize),("touchingEdge",touchingEdge)] where !values.isEmpty {
    print(name + ": " + values.joined(separator: ", "))
}
