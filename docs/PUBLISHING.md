# Publishing

Where Flipbook is listed, how each listing gets there, and what the maintainer has to do
by hand. Most of it is automated by [the release workflow](../.github/workflows/release.yml)
once the one-time setup below is done. The rest are one-off submissions that need the
maintainer's own accounts.

Checked against each destination's documentation in September 2026. Items marked
*unverified* come from secondary sources, because the site itself could not be reached
when this was written. Check them before relying on them.

## At a glance

| Destination | How it gets there | Per release | One-time setup |
|---|---|---|---|
| Claude Code — this repo's marketplace | `marketplace.json` on `main` | merge + tag | — |
| npm `@shubhenduvaid/flipbook` | release workflow | automatic | first publish by hand; trusted publisher |
| MCP Registry | release workflow | automatic | none (OIDC) |
| GitHub Releases (`.mcpb`) | release workflow | automatic | none |
| Anthropic's plugin directory | developer portal | automatic after approval | submit once |
| Glama | crawls GitHub | automatic | claim the listing |
| PulseMCP, VS Code gallery | ingest the MCP Registry | automatic | — |
| claude-plugins.dev, claudemarketplaces.com | crawl GitHub | automatic | — |
| punkpeye/awesome-mcp-servers | pull request | — | after Glama |
| mcpservers.org, mcp.so | web forms | — | submit once |
| hesreallyhim/awesome-claude-code | issue form (a human must submit) | — | submit once |
| Smithery | `.mcpb` upload | per release | account |

## 1. First release: order matters

npm trusted publishing cannot create a package, and the MCP Registry verifies ownership
by reading `mcpName` from the package that is already on npm. So the very first version
goes to npm by hand, **before** the tag is pushed:

```bash
git checkout main && git pull            # with the version bump merged
npm ci && npm run lint:manifests && npm test && npm run test:mcp
npm login                                # an account with 2FA
npm publish --access public              # publishes @shubhenduvaid/flipbook
```

Then push the tag as described under "Cutting a release" in the README. The workflow sees
that the version is already on npm, skips that step, and publishes the rest.

## 2. npm trusted publishing (once, after the first publish)

On npmjs.com, open the package, then **Settings → Trusted publishing → GitHub Actions**:

| Field | Value |
|---|---|
| Organization or user | `ShubhenduVaid` |
| Repository | `flipbook` |
| Workflow filename | `release.yml` |
| Environment | `release` |

Every field is case-sensitive, and npm does not check them when you save. Under
**Allowed actions**, tick **npm publish**. Configurations created after 2026-09-03 default
to staged publishing only; left that way, each release waits for `npm stage approve`,
and the MCP Registry step fails until you approve it.

Then set **Publishing access → Require two-factor authentication and disallow tokens**,
since nothing needs a token any more.

## 3. MCP Registry

Automatic. The workflow logs in with GitHub OIDC, which grants the
`io.github.ShubhenduVaid/*` namespace, and publishes `server.json`. The namespace is
case-sensitive and must match the GitHub username as spelled.

To publish by hand:

```bash
brew install mcp-publisher     # or download it from the registry's GitHub releases
mcp-publisher validate
mcp-publisher login github     # device flow
mcp-publisher publish
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.ShubhenduVaid/flipbook"
```

Published versions are immutable, and `server.json`'s `description` is limited to 100
characters (`npm run lint:manifests` enforces that).

## 4. Anthropic's plugin directory

This is the listing that reaches claude.ai's plugin directory and Claude Code users
(installed as `flipbook@synced`). It needs a paid Claude plan and GitHub push access to
this repo.

1. Go to https://claude.ai/directory/manage → **Submit new** → **Plugin bundle**.
2. Enter the source: `ShubhenduVaid/flipbook`, at the release tag (e.g. `flipbook--v1.3.0`).
3. Click **Validate**, then fill in the listing, data handling (nothing leaves the machine)
   and compliance steps, and **Submit for review**.
4. After approval, later versions are picked up from pushes. Each one is validated and
   security-scanned, and you choose **Publish**.

Expect the first version to be **held for human review** rather than rejected. Two things
trigger that: dependencies install from a lockfile, and scripts the validator cannot
follow (`doctor` runs `npm rebuild ffmpeg-static` and compiles the Swift recorder). Both
are disclosed in the README under "What it runs on your machine" — point the reviewer
there.

Checked by `claude plugin validate . --strict` and the pre-submission checklist:
- the name is kebab-case and not reserved;
- the README is 40+ words;
- there is a `LICENSE`;
- there are no `.DS_Store` or other junk files;
- every file is under 5 MiB, and the repo is well under the size limits;
- the local MCP server is started as `node ${CLAUDE_PLUGIN_ROOT}/…`.

`anthropics/claude-plugins-official` is curated by Anthropic and does not take
submissions; ask a partner contact if that ever matters. `anthropics/claude-plugins-community`
is a read-only mirror of the directory, and pull requests to it are closed.

## 5. Glama

Glama crawls public GitHub repos with MCP servers. Log in at https://glama.ai/mcp/servers
with GitHub, find or add `ShubhenduVaid/flipbook`, and claim it. `glama.json` names the
maintainer. Glama builds the server in a Linux container and introspects it. That works,
because the server starts on Linux and reports "analysis only". Its quality score draws
on the license, tool descriptions, CI and GitHub releases that match package versions,
all of which are in place.

## 6. Lists and directories

- **punkpeye/awesome-mcp-servers:** needs the Glama listing claimed and scored first, or
  a bot blocks the merge. Fork, add one line alphabetically under *Browser Automation*,
  and open a pull request:
  ```
  - [ShubhenduVaid/flipbook](https://github.com/ShubhenduVaid/flipbook) [![ShubhenduVaid/flipbook MCP server](https://glama.ai/mcp/servers/ShubhenduVaid/flipbook/badges/score.svg)](https://glama.ai/mcp/servers/ShubhenduVaid/flipbook) 📇 🏠 🍎 🪟 🐧 - Records a browser window while an agent drives it and returns labelled keyframes and a timeline; analyses Playwright/Cypress videos on any OS.
  ```
- **mcpservers.org:** web form at https://mcpservers.org/submit. Its GitHub list,
  wong2/awesome-mcp-servers, takes no pull requests. *Form fields unverified.*
- **mcp.so:** web form at https://mcp.so/submit. *Unverified.*
- **PulseMCP:** manual submissions were paused in September 2026. It ingests the MCP
  Registry, so nothing to do. *Unverified.*
- **hesreallyhim/awesome-claude-code:** use the "recommend a resource" issue form (no
  pull requests), submitted by a human. The repo must be 14+ days old with ongoing
  commits, or have 100+ stars. One factual line, no emojis.
- **claude-plugins.dev** and **claudemarketplaces.com:** index GitHub repos with a valid
  `.claude-plugin/marketplace.json` automatically. *Unverified.*

## 7. Clients with install links

- **Cursor:** the README's install button is a `cursor.com/en/install-mcp` link, whose
  `config` is base64 of `{"command":"npx","args":["-y","@shubhenduvaid/flipbook"]}`.
  Cursor's own marketplace lists plugins (a `.cursor-plugin/` manifest) rather than bare
  MCP servers, and is not targeted.
- **VS Code:** the README's button wraps a `vscode:mcp/install?…` link. VS Code's MCP
  gallery is fed by the MCP Registry. *Whether it is curated is unverified.*
- **Claude Desktop:** the `.mcpb` on each GitHub release. Anthropic's directory no longer
  accepts desktop extensions — local servers are listed as plugins (section 4) — so the
  release asset is the distribution.

## 8. Smithery (*unverified*)

Smithery takes local stdio servers as `.mcpb` bundles:

```bash
npm i -g smithery@latest
smithery auth login
smithery mcp publish dist/flipbook-<version>-darwin-arm64.mcpb -n shubhenduvaid/flipbook
```

A known issue (smithery-cli#806) means Smithery wants per-tool input schemas that the
`.mcpb` format does not carry, which lowers its quality score. It is worth doing once that
is fixed.
