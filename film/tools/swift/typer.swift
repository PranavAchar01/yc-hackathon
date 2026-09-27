// Type text into the frontmost window as real key events, at a human pace. usage: typer "<text>" [ms-per-key=90] [--enter]
import CoreGraphics
import Foundation
let a = CommandLine.arguments
let text = a.count > 1 ? a[1] : ""; let ms = a.count > 2 ? UInt32(a[2]) ?? 90 : 90
let src = CGEventSource(stateID: .hidSystemState)
if let i = a.firstIndex(of: "--backspace"), i + 1 < a.count, let n = Int(a[i + 1]) {
  for _ in 0..<n { for down in [true, false] { CGEvent(keyboardEventSource: src, virtualKey: 51, keyDown: down)?.post(tap: .cghidEventTap) }; usleep(30_000) }
  exit(0)
}
for ch in text.utf16 {
  var c = ch
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
    e?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c)
    e?.post(tap: .cghidEventTap)
  }
  usleep(ms * 1000)
}
if a.contains("--enter") {
  usleep(400_000)
  var cr: UniChar = 13
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: src, virtualKey: 36, keyDown: down)
    e?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &cr)
    e?.post(tap: .cghidEventTap)
  }
}
