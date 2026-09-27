// List on-screen windows of an app: "<id>\t<x>,<y>,<w>,<h>\t<title>"   usage: wins [owner=Google Chrome]
import CoreGraphics
import Foundation
let owner = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Google Chrome"
let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list where (w[kCGWindowOwnerName as String] as? String) == owner && (w[kCGWindowLayer as String] as? Int) == 0 {
  let b = w[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
  guard (b["Height"] ?? 0) > 200 else { continue }
  print("\(w[kCGWindowNumber as String] ?? 0)\t\(Int(b["X"] ?? 0)),\(Int(b["Y"] ?? 0)),\(Int(b["Width"] ?? 0)),\(Int(b["Height"] ?? 0))\t\(w[kCGWindowName as String] as? String ?? "")")
}
