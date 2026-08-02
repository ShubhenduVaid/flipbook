// sckrec — record a single window's own content with ScreenCaptureKit.
//
// Why this and not ffmpeg + avfoundation: display capture records the composited
// screen, so it captures whatever is visually on top. When Claude drives Chrome in
// the background while the user reads the terminal — the normal case for this tool —
// display capture records the terminal. SCK captures the target window's own
// content even when it is occluded, behind other windows, or on another Space, and
// it never captures anything else on screen.
//
// Modes:
//   sckrec --list
//   sckrec --out FILE [--bundle ID | --window-id N] [--title-contains S]
//          [--fps N] [--seconds N] [--show-cursor 0|1]
//
// Stops on: --seconds elapsed, "q" or EOF on stdin, or SIGINT.
// Progress and the chosen window are reported on stderr as JSON lines.

import AppKit
import AVFoundation
import Foundation
import ScreenCaptureKit

// A bare CLI has no window-server connection and ScreenCaptureKit needs one
// (otherwise: "Assertion failed: (did_initialize), function CGS_REQUIRE_INIT").
// Registering as a prohibited-activation app supplies it without ever showing a
// Dock icon or stealing focus from the user's frontmost app.
_ = NSApplication.shared
NSApplication.shared.setActivationPolicy(.prohibited)

func arg(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}
func flag(_ name: String) -> Bool { CommandLine.arguments.contains(name) }

func emit(_ obj: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: obj),
        var s = String(data: d, encoding: .utf8)
    else { return }
    s += "\n"
    FileHandle.standardError.write(s.data(using: .utf8)!)
}

func fail(_ msg: String, code: Int32 = 1) -> Never {
    emit(["event": "error", "message": msg])
    exit(code)
}

guard #available(macOS 15.0, *) else {
    fail("ScreenCaptureKit window recording requires macOS 15 or later")
}

/// Resume-once wrapper: several stop triggers race, only the first may resume.
final class StopSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var resumed = false
    private var cont: CheckedContinuation<String, Never>?
    private var pending: String?

    func wait() async -> String {
        await withCheckedContinuation { c in
            lock.lock()
            if let p = pending {
                lock.unlock()
                c.resume(returning: p)
            } else {
                cont = c
                lock.unlock()
            }
        }
    }

    func fire(_ reason: String) {
        lock.lock()
        if resumed {
            lock.unlock()
            return
        }
        resumed = true
        let c = cont
        cont = nil
        if c == nil { pending = reason }
        lock.unlock()
        c?.resume(returning: reason)
    }
}

final class Delegate: NSObject, SCRecordingOutputDelegate, SCStreamDelegate, @unchecked Sendable {
    let finished = DispatchSemaphore(value: 0)
    var failure: String?

    func recordingOutputDidStartRecording(_ o: SCRecordingOutput) {
        emit(["event": "started"])
    }
    func recordingOutput(_ o: SCRecordingOutput, didFailWithError error: Error) {
        failure = error.localizedDescription
        finished.signal()
    }
    func recordingOutputDidFinishRecording(_ o: SCRecordingOutput) {
        finished.signal()
    }
    func stream(_ s: SCStream, didStopWithError error: Error) {
        failure = "stream stopped: \(error.localizedDescription)"
        finished.signal()
    }
}

func describe(_ w: SCWindow) -> [String: Any] {
    [
        "windowId": w.windowID,
        "app": w.owningApplication?.applicationName ?? "",
        "bundleId": w.owningApplication?.bundleIdentifier ?? "",
        "title": w.title ?? "",
        // Origin as well as size: titles and sizes collide routinely (two Chrome
        // windows showing the same page), but position makes a window unique, and it
        // is the only field that can be matched against Chrome's own AppleScript
        // bounds to identify the exact window a caller means.
        "x": Int(w.frame.origin.x),
        "y": Int(w.frame.origin.y),
        "width": Int(w.frame.width),
        "height": Int(w.frame.height),
        "onScreen": w.isOnScreen,
    ]
}

Task {
    do {
        // onScreenWindowsOnly: false is essential — it is what lets us find a Chrome
        // window sitting on another Space or fully behind the terminal.
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: false)
        let windows = content.windows

        if flag("--list") {
            let rows =
                windows
                .filter { $0.frame.width > 100 && $0.frame.height > 100 }
                .sorted { $0.frame.width * $0.frame.height > $1.frame.width * $1.frame.height }
                .map(describe)
            let data = try JSONSerialization.data(withJSONObject: rows)
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write("\n".data(using: .utf8)!)
            exit(0)
        }

        guard let outPath = arg("--out") else { fail("missing --out", code: 2) }
        let fps = max(1, min(60, Int(arg("--fps") ?? "30") ?? 30))
        let seconds = Double(arg("--seconds") ?? "0") ?? 0
        let showCursor = (arg("--show-cursor") ?? "1") != "0"

        var candidates = windows.filter { $0.frame.width > 200 && $0.frame.height > 200 }

        if let wid = arg("--window-id"), let n = UInt32(wid) {
            candidates = candidates.filter { $0.windowID == n }
        } else {
            let bundleID = arg("--bundle") ?? "com.google.Chrome"
            candidates = candidates.filter {
                $0.owningApplication?.bundleIdentifier == bundleID
            }
            if let needle = arg("--title-contains"), !needle.isEmpty {
                let lowered = needle.lowercased()
                let narrowed = candidates.filter {
                    ($0.title ?? "").lowercased().contains(lowered)
                }
                if !narrowed.isEmpty { candidates = narrowed }
            }
        }

        // Largest window wins: Chrome keeps small helper and status windows around
        // that would otherwise be picked arbitrarily.
        guard
            let window = candidates.max(by: {
                $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
            })
        else {
            fail("no matching window found (is the app running with a visible window?)")
        }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let scale = filter.pointPixelScale
        let rect = filter.contentRect

        let cfg = SCStreamConfiguration()
        // pointPixelScale removes all the retina guesswork display capture needs.
        cfg.width = Int(rect.width * CGFloat(scale))
        cfg.height = Int(rect.height * CGFloat(scale))
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        cfg.showsCursor = showCursor
        cfg.capturesAudio = false
        cfg.queueDepth = 8

        var info = describe(window)
        info["event"] = "window"
        info["captureWidth"] = cfg.width
        info["captureHeight"] = cfg.height
        info["scale"] = scale
        emit(info)

        let delegate = Delegate()
        let stream = SCStream(filter: filter, configuration: cfg, delegate: delegate)

        let rcfg = SCRecordingOutputConfiguration()
        rcfg.outputURL = URL(fileURLWithPath: outPath)
        rcfg.outputFileType = .mov
        rcfg.videoCodecType = .h264
        let recOut = SCRecordingOutput(configuration: rcfg, delegate: delegate)
        try stream.addRecordingOutput(recOut)

        try await stream.startCapture()

        let stop = StopSignal()

        let sigsrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
        sigsrc.setEventHandler { stop.fire("signal") }
        sigsrc.resume()
        signal(SIGINT, SIG_IGN)

        if seconds > 0 {
            DispatchQueue.global().asyncAfter(deadline: .now() + seconds) {
                stop.fire("duration")
            }
        }
        // stdin is the primary channel: the parent writes "q\n" for a clean stop, and
        // EOF covers the case where the parent dies without saying anything.
        DispatchQueue.global().async {
            while let line = readLine(strippingNewline: true) {
                if line.trimmingCharacters(in: .whitespaces).lowercased() == "q" {
                    stop.fire("stdin")
                    return
                }
            }
            stop.fire("eof")
        }

        let reason = await stop.wait()
        emit(["event": "stopping", "reason": reason])

        try? await stream.stopCapture()
        _ = delegate.finished.wait(timeout: .now() + 15)

        if let f = delegate.failure { fail(f) }

        let attrs = try? FileManager.default.attributesOfItem(atPath: outPath)
        let bytes = (attrs?[.size] as? Int) ?? 0
        emit(["event": "finished", "path": outPath, "bytes": bytes, "reason": reason])
        exit(0)
    } catch {
        fail(error.localizedDescription)
    }
}

// Must be NSApplication.run(), not dispatchMain(): while recording, ScreenCaptureKit
// puts the purple capture indicator in the menu bar, and building it instantiates an
// NSWindow — which AppKit requires to happen on a real main thread with a real
// AppKit run loop. Under dispatchMain() that work lands on a dispatch worker and
// throws "NSWindow should only be instantiated on the main thread", killing the
// process mid-capture and leaving an unfinalised file with no moov atom.
NSApplication.shared.run()
