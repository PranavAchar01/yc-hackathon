// click <x> <y>: one left click at screen points (CGEvent), then the cursor stays there.
import CoreGraphics
import Foundation
let a = CommandLine.arguments
guard a.count == 3, let x = Double(a[1]), let y = Double(a[2]) else { print("usage: click <x> <y>"); exit(2) }
let p = CGPoint(x: x, y: y)
for t in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
  CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(60_000)
}
