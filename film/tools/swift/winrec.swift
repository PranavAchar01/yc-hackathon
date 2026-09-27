// Record ONE window (by CGWindowID) with ScreenCaptureKit, even when other windows cover it.
// usage: winrec <windowID> <out.mov> <stopfile> [fps=30]
// Stops when <stopfile> exists or the window closes. Writes H.264 via AVAssetWriter.
import Foundation
import AppKit
import ScreenCaptureKit
import AVFoundation
import CoreMedia

let args = CommandLine.arguments
guard args.count >= 4, let wid = UInt32(args[1]) else { print("usage: winrec <windowID> <out.mov> <stopfile> [fps]"); exit(2) }
let outURL = URL(fileURLWithPath: args[2]); let stopFile = args[3]
let fps = args.count > 4 ? Int32(args[4]) ?? 30 : 30
try? FileManager.default.removeItem(at: outURL)

final class Rec: NSObject, SCStreamOutput, SCStreamDelegate {
  var writer: AVAssetWriter!; var input: AVAssetWriterInput!; var started = false; var done = false
  func setup(w: Int, h: Int) throws {
    writer = try AVAssetWriter(outputURL: outURL, fileType: .mov)
    input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: w, AVVideoHeightKey: h,
      AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 24_000_000, AVVideoExpectedSourceFrameRateKey: fps]])
    input.expectsMediaDataInRealTime = true
    writer.add(input)
  }
  func stream(_ s: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sb.isValid, !done else { return }
    // skip frames without new content
    if let att = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
       let st = att.first?[.status] as? Int, st != SCFrameStatus.complete.rawValue { return }
    if !started { writer.startWriting(); writer.startSession(atSourceTime: sb.presentationTimeStamp); started = true }
    if input.isReadyForMoreMediaData { input.append(sb) }
  }
  func stream(_ s: SCStream, didStopWithError e: Error) { done = true }
}

_ = NSApplication.shared
let rec = Rec()
Task {
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let win = content.windows.first(where: { $0.windowID == wid }) else { print("window \(wid) not found"); exit(3) }
    let filter = SCContentFilter(desktopIndependentWindow: win)
    let cfg = SCStreamConfiguration()
    let scale = 2
    cfg.width = Int(win.frame.width) * scale; cfg.height = Int(win.frame.height) * scale
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: fps)
    cfg.showsCursor = true; cfg.queueDepth = 8
    try rec.setup(w: cfg.width, h: cfg.height)
    let stream = SCStream(filter: filter, configuration: cfg, delegate: rec)
    try stream.addStreamOutput(rec, type: .screen, sampleHandlerQueue: DispatchQueue(label: "rec"))
    try await stream.startCapture()
    print("recording window \(wid) \(cfg.width)x\(cfg.height)")
    while !FileManager.default.fileExists(atPath: stopFile) && !rec.done { try await Task.sleep(nanoseconds: 200_000_000) }
    try? await stream.stopCapture()
    rec.done = true
    rec.input.markAsFinished()
    await rec.writer.finishWriting()
    print("wrote \(outURL.path)")
    exit(0)
  } catch { print("error: \(error)"); exit(1) }
}
RunLoop.main.run()
