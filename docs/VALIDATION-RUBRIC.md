# Validation rubric

flipbook exists because screenshots let you claim a flow works without evidence. It would
be poor form for the tool itself to make unchecked claims, so this is the rubric flipbook
is held to.

Written **before** the fixes it was used to find, so it describes what the project ought to
be rather than what it happens to be. Run it with:

```bash
node scripts/validate.mjs
```

Each criterion is `PASS`, `FAIL`, or `MANUAL`. `MANUAL` means the check needs macOS, Chrome
and Screen Recording permission and so cannot run in CI — the validator prints the command
to run instead of quietly passing. A criterion that cannot be checked mechanically is still
listed, because an unmeasured promise is exactly what this document exists to prevent.

---

## P — Promises

Everything the README asserts. If a claim cannot survive this section it should be removed
from the README rather than softened.

| ID | Criterion | Evidence |
|---|---|---|
| P1 | An analysis returns **no more than 7 images** | `analyze_recording` over the fixture; count `image` blocks |
| P2 | The whole payload stays under the **12,500-token** no-truncation ceiling | `images × 1600 + chars/4`, computed from the real response |
| P3 | All four channels are present: contact sheet, detail frames, timeline, `resource_link` | Block types in the response |
| P4 | Images are **native image blocks**, not base64 stringified into text | `type === "image"` with a `mimeType` |
| P5 | Tools return **evidence, never a verdict** | No `PASS`/`FAIL`/`✅`/`❌` verdict language in any tool response |
| P6 | The timeline survives a rubric long enough to force truncation | Analyse with a 6,000-character rubric; timeline block still present and marked trimmed |
| P7 | A **transient toast and a spinner** are captured — the things a screenshot pair misses | `npm run test:e2e` (MANUAL) |
| P8 | Capture works while the browser is **occluded** | `npm run test:e2e:occluded` (MANUAL) |
| P9 | User-supplied `.mov`, `.gif` and stills directories are analysable | `analyze_recording` with `path` (MANUAL — needs ffmpeg) |
| P10 | Recording does not interfere with Claude-in-Chrome tools | Drive the browser during a capture (MANUAL) |

## N — Naming

The package has been renamed twice. Nothing should still carry an older identity, and no
identity should be stated in two places that can disagree.

| ID | Criterion | Evidence |
|---|---|---|
| N1 | **One source of truth** for name and version — no hardcoded semver outside the manifests | Grep `src/`, `test/`, `scripts/` for version literals |
| N2 | No stale identifiers anywhere (`video-qa`, `video-mcp`, `VIDEO_QA`, `browser-replay`) | Grep the tracked tree |
| N3 | The three manifests agree on name, version and license | `scripts/lint-manifests.mjs` |
| N4 | Every skill directory matches its frontmatter `name` | Parse `skills/*/SKILL.md` |
| N5 | Skill and command names are consistent with the package | Names contain no concept the plugin name already implies |
| N6 | `allowed-tools` in `commands/record.md` matches the real namespaced tool names | `mcp__plugin_<plugin>_<server>__<tool>` derived from the manifests |

## S — Security

The tool records screens and spawns processes. Both deserve scrutiny.

| ID | Criterion | Evidence |
|---|---|---|
| S1 | **No shell interpolation** — every subprocess uses `execFile`/`spawn` with an argument array | Grep for `exec(`, `execSync`, `shell: true` |
| S2 | Caller-supplied `session_id` **cannot escape** the data directory | Traversal id rejected by every tool boundary |
| S3 | No network egress from `src/` | No `fetch`, `http`, `https`, `net` imports |
| S4 | Recordings stay under `FLIPBOOK_HOME` and are never uploaded | Path construction confined to `DATA_HOME` |
| S5 | The hook cannot break the tool call it observes | `hooks/record-action.mjs` exits 0 on every path |
| S6 | Nothing in the published tree contains a real screen capture | No tracked `.mov`/`.mp4`, and the demo image is from a throwaway profile |

## Q — Quality

| ID | Criterion | Evidence |
|---|---|---|
| Q1 | Lint and format clean | `npm run lint` |
| Q2 | **No dead exports** — nothing is exported that no other module imports | Static scan of `export` vs imports |
| Q3 | Unit suite passes | `npm test` |
| Q4 | MCP protocol suite passes | `npm run test:mcp` (MANUAL) |
| Q5 | Every MCP tool has a substantive description and an input schema | `tools/list` over a live server |
| Q6 | Error paths return actionable messages, not stack traces | Missing file, bad type, no source |

## D — Docs

| ID | Criterion | Evidence |
|---|---|---|
| D1 | `docs/ARCHITECTURE.md` exists and **mentions every file under `src/`** | Cross-reference the tree |
| D2 | The README's numeric claims are true (unit test count, protocol check count) | Compare against actual counts |
| D3 | Every tool in the README's table exists on the server, and vice versa | Compare table against `tools/list` |
| D4 | The two documented ways to record nothing are still accurate | Present in README and surfaced by `doctor` |

---

## On scoring

There is no aggregate score. A percentage would let a security failure be averaged away by
passing style checks, which is precisely the kind of reassuring-but-empty summary this
project exists to argue against. Every criterion is reported individually, and any `FAIL`
fails the run.
