# Security

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/ShubhenduVaid/flipbook/security/advisories/new)
rather than a public issue. You'll get an acknowledgement within a few days.

## What Flipbook does on your machine

Flipbook records the screen, so it is worth being precise about its reach:

- **It captures only the window it was asked to**, via ScreenCaptureKit window capture on
  macOS. Display capture exists only as an explicit `target: "display"` fallback.
- **Nothing leaves the machine.** `src/` makes no network calls (rubric criterion S3
  checks this on every push). Recordings are written under `~/.flipbook`, or
  `FLIPBOOK_HOME`, and are never uploaded.
- **Session ids cannot escape the data directory**, and neither can deletion (criteria S2
  and S7). `prune_recordings` is a dry run unless `confirm: true` is passed.
- **No shell interpolation.** Every subprocess is spawned with an argument array
  (criterion S1).
- **Two local build steps**, both described in the README under "What it runs on your
  machine": restoring the bundled ffmpeg binary with `npm rebuild ffmpeg-static`, and
  compiling the ScreenCaptureKit recorder from `native/sckrec.swift` with `swiftc`.

The full list of security criteria is in [docs/VALIDATION-RUBRIC.md](docs/VALIDATION-RUBRIC.md).
