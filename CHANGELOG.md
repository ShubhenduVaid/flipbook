# Changelog

Versions follow [semver](https://semver.org). Each release is also an annotated
`flipbook--v<version>` tag whose message matches its entry here.

## 1.3.0

Analysis now works on Linux and Windows, and Flipbook is published beyond the Claude Code
plugin marketplace. Four bugs found by running the analysis on recordings it had never
seen are fixed.

### Fixed

- **A toast was reported as a capture fault.** In a viewport-only video (Playwright,
  Cypress) of a dark, centred page, a toast appearing in the corner and then going away
  produced two "the recorded window changed the geometry it was painting" warnings. Each
  one advised ignoring every frame after the toast, which threw away the very evidence
  the tool exists to capture. Content appearing, content leaving, and an overlay being
  dismissed are now told apart from a real viewport override.
- **A loading state that runs straight into its result was never selected.** A heavy
  spinner or skeleton animation that ended the moment the result appeared merged with it
  into one burst of change, and only the result was kept. Each burst now also nominates
  its first frame (`change-onset`) when budget allows.
- **The automatic crop cut the result off.** `roi: "auto"` ignored any region that changed
  only once, so a confirmation panel that appears and stays fell outside the crop. A
  single change now counts when it is part of a solid region, not speckle.
- **Contact-sheet cells were unlabelled off macOS**, while the caption still said they
  were labelled. Labels are now drawn with `drawtext` or, where the ffmpeg build lacks it
  (the bundled Linux build does), with libass. The font is found on macOS, Linux and
  Windows, or set with `FLIPBOOK_FONT`. If labels truly cannot be drawn, the caption says
  so and explains how to read the sheet.
- `doctor` could not measure free disk space before the first recording, and on Linux.

### Added

- **Analysis on any platform.** `doctor` now reports whether the machine can record,
  analyse, or neither. Off macOS it reports "analysis only" rather than four blocking
  failures, and `start_recording` refuses up front, pointing at `analyze_recording`,
  instead of creating a failed session and suggesting Xcode.
- **New distribution channels:**
  - npm, as `@shubhenduvaid/flipbook`, with a `flipbook-mcp` bin, so it runs through
    `npx` in any MCP client.
  - The MCP Registry, as `io.github.ShubhenduVaid/flipbook`.
  - A Claude Desktop extension (`.mcpb`) attached to each GitHub release.
  - One-click install links for Cursor and VS Code.
- **A release workflow** that publishes to npm, the MCP Registry and GitHub Releases from
  the release tag. It uses trusted publishing and OIDC, so no tokens are stored.
- **The central claim is now a CI check.** A synthetic fixture drawn by ffmpeg (spinner,
  confirmation, vanishing toast) runs through the real server in CI on Linux, Windows
  and macOS. The run asserts that all three moments are selected.
- The manifest linter now also checks `server.json` and the `.mcpb` manifest, including
  that the extension's tool list matches the server's.

## Earlier versions

See the annotated [tags](https://github.com/ShubhenduVaid/flipbook/tags). 1.2.0 added
segment stats, capture-anomaly detection, region of interest, mark-relative drill-down,
shareable clips and disk pruning.
