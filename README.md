# ECC Manager

A local web UI to manage [Claude Code](https://claude.ai/code) configurations per project.
Pulls components from [everything-claude-code](https://github.com/affaan-m/everything-claude-code)
and installs them into each project's `.claude/` directory — **never touches `~/.claude/`**.

---

## What is everything-claude-code?

[everything-claude-code](https://github.com/affaan-m/everything-claude-code) (ECC) is a curated
library of **agents, skills, commands, rules, hooks, and MCP server configs** that extend how
Claude Code works on your projects. Think of it as a plugin ecosystem for Claude — each component
teaches Claude a new capability, enforces a coding standard, or connects it to an external tool.

ECC's own installer gives you everything at once. That's great if you know what you want — but
most people don't need every agent and every rule on every project.

**ECC Manager is the visual alternative.** Browse the full library, read what each component does
before installing it, pick only what this project needs, and get a ready-to-use `.claude/`
directory — no commands, no config files to edit by hand.

---

## Quick Start

**Requirements:** Node.js 18+, Git. **No database. No `npm install`.**

ECC Manager is a single Node.js script with zero runtime dependencies — state is
stored as JSON files on disk, the UI is a single static HTML page, and there is
no build step. Clone and run.

```bash
git clone https://github.com/themanlee7942/ecc-manager
cd ecc-manager
node server.js
```

Open **http://localhost:7700**

The active ECC version is shown in the bottom-left corner of the sidebar once you've pulled
at least one snapshot.

---

## Workflow

### 1. Pull ECC

Click **↓ Pull ECC** in the header. This clones the ECC repo as a versioned local snapshot
under `versions/<verId>/`. You can pull multiple versions; the most recent becomes the active
catalog. All components are read directly from the active snapshot — no hardcoded lists.

### 2. Create a Project

Click the project selector → **+ New Project**. Give it the same name as your actual project.
Each project pins itself to the ECC version that was active when you created or last upgraded
it. If a newer version is pulled later, the UI surfaces an upgrade prompt so you can move at
your own pace.

### 3. Browse and Preview Components

Browse by category in the left sidebar. **Click any component name** to preview its content
before installing:

- **Single files** (rules, agents, commands, single-file platform configs) render the file
  inline.
- **Directory components** (skills, hidden-root platform configs like `.cursor/`) open a
  list of every file's full relative path. Click any path in the list to load that file's
  content; nothing is auto-loaded so the popup is a clean "what's about to be installed"
  view.
- **Hooks and MCP** rows pull the matching block out of `hooks/hooks.json` /
  `mcp-configs/mcp-servers.json` and pretty-print just that single entry's JSON.

### 4. Install

Check the components you want and click **↓ Install**, or use the **Install** button on each row.

- **Agents** — installed as `.claude/agents/<name>.md`
- **Skills** — each skill installed as `.claude/skills/<name>/` containing `SKILL.md`
- **Rules** — guideline files copied under `.claude/rules/`
- **Hooks** — each hook entry merged individually into `.claude/settings.json`
- **MCP Servers** — server config written directly into `.claude/settings.json` (add your API keys after)
- **Commands** — installed as `.claude/commands/<name>.md` slash command definitions

> **Note:** `multi-*` commands (`/multi-plan`, `/multi-execute`, etc.) require the
> separate [ccg-workflow](https://www.npmjs.com/package/ccg-workflow) runtime — run `npx ccg-workflow`
> once in your project after installing them.

> **Quarantined components:** ECC v2 manifests can mark components as requiring manual setup
> (e.g. external auth, host-specific tooling). These are listed but not auto-installed; the
> UI shows the manifest's setup notes so you can install them by hand if needed.

### 5. Configure Settings

Click **⚙ Settings** in the sidebar to browse the full Claude Code settings catalog
(86 entries). Recommended settings are grouped at the top in a **Recommended Settings**
section; everything else is under **All Claude Code Settings**. Apply only the entries
that matter for your project — most users only need the four recommended ones.

Each entry shows a status badge so you know whether it's safe to set at the project level:

| Badge | Meaning |
|-------|---------|
| **✓ set** | Currently applied in this project's `settings.json` |
| **in catalog** | The catalog entry is in sync with upstream Claude Code docs (informational only — does not mean it's applied to your project) |
| **managed only** | Set by your organization's policy file — cannot be overridden at the project level |
| **local only** | Only valid in `.claude/settings.local.json` (per-machine, never committed) |
| **~/.claude.json** | Belongs in your global Claude config, not in a project file — ECC Manager won't write it |
| **not project-safe** | Should never be set at the project level |

Recommended starting values:

| Setting | Recommended | Effect |
|---------|-------------|--------|
| Default Model | `sonnet` | Cost-efficient for most tasks |
| MAX_THINKING_TOKENS | `10000` | ~70% cost reduction on extended thinking |
| CLAUDE_AUTOCOMPACT_PCT_OVERRIDE | `50` | Compacts earlier, keeps quality in long sessions |
| CLAUDE_CODE_SUBAGENT_MODEL | `haiku` | Cheaper model for delegated subagent work |

The catalog supports select, boolean, and JSON-valued settings. Click **Apply** to write to
`.claude/settings.json`, or **Remove** to clear it back out.

### 6. Manage Agent Docs (`CLAUDE.md` / `AGENTS.md`)

The sidebar shows two managed agent docs at the top — `CLAUDE.md` and `AGENTS.md`.
Each opens in the same editor surface with the same workflow:

- **Edit & Save** — write project-specific instructions for the doc
- **Preview ECC Default** — read the curated default that ships with the active ECC version
- **Compare** — side-by-side diff between your current doc and the ECC default
- **Replace With ECC Default** — overwrite your file with the curated default (a timestamped
  backup is created automatically first)
- **Backups** — per-doc timestamped backups under `.claude/.backups/<FILE>.<ts>.bak`. Each
  restore also creates a fresh backup of whatever is currently in place, so you can always go
  back. Backups are preserved indefinitely; nothing is deleted automatically.

Status indicators tell you whether each doc matches the current ECC default, is customized,
or is missing. When the active ECC version doesn't ship a default for a particular doc, the
editor still saves manual edits — only the default-only buttons (Preview / Compare /
Replace) are disabled.

### 7. Custom Library *(global, shared across projects)*

Your own templates and components, shared across every project. The sidebar groups them:

- **Markdown / JSON templates** *(copy/paste only — not auto-applied)*
  - **Custom CLAUDE.md / Custom AGENTS.md** — alternate drafts
  - **Custom settings.local.json** — reusable per-machine settings drafts (copy into `.claude/settings.local.json`)
  - **Other md files** — anything that isn't part of Claude (`design.md`, `architecture.md`, …)
  - Each entry has a `name` + optional `description`; two entries can share a name (each has its own id), useful for keeping multiple `design.md` drafts side by side.
- **Custom Components** — typed components that ride the install/apply flow: rules, hooks, MCP, agents, skills, commands. They also appear in the matching ECC category list with an **Apply / Re-apply** button so you don't have to switch views.

**Click any row name** to preview content read-only. Hooks/MCP show pretty-printed JSON; markdown renders verbatim.

**Apply targets** for components default to:

| Kind     | Default                                |
|----------|----------------------------------------|
| rules    | `rules/custom/<slug>.md`               |
| agents   | `agents/<slug>.md`                     |
| skills   | `skills/<slug>/SKILL.md`               |
| commands | `commands/<slug>.md`                   |
| hooks    | merged into `settings.json`            |
| mcp      | merged into `settings.json`            |

Override the folder/file in the create modal — e.g. put a rule under `rules/team/` so multiple custom rules don't collide. For tools that read config from the project root (`.cursor/`, `.codex/`, `.gemini/`, `.opencode/`, `.windsurf/`, `.zed/`, `.agents/`, `.continue/`, `.claude-plugin/`), set the hidden directory as your target folder and deploy relocates it to `<deployPath>/<root>/`. Sensitive dot-dirs (`.git/`, `.ssh/`, `.env`, `.docker/`, `.aws/`) are *not* on the allowlist and never relocate.

**Hooks/MCP merge** is schema-aware: identical entries skip, new entries add, conflicts surface a Cancel / Skip / Append As New / Replace modal. Replace backs up `settings.json` first; Skip-only applies are reported as a **No-op** so nothing gets falsely recorded.

**Backups everywhere** — apply backs up any existing target before overwriting, and deploy aborts before relocating any project-root file if it can't snapshot what's already there. Deleting a Custom Library entry never removes copies already applied to projects.

### 8. Deploy to Your Project

Enter the path to your actual project directory and click **Deploy**.
This copies the managed `.claude/` folder into your project. Custom components applied
to recognized agent/tool roots (`.cursor/`, `.codex/`, …) are relocated from
`<deployPath>/.claude/<root>/` to `<deployPath>/<root>/` so each tool reads its config
from the project root as expected.

```bash
# Or use a symlink so changes sync automatically:
ln -s ~/ecc-manager/projects/my-project/.claude /path/to/my-project/.claude
```

---

## LM Studio Assist — *the recommended way to pick components*

**Optional, but this is by far the easiest way to use ECC Manager.** Manually scanning 200+ components per project is tedious; an LLM can do it in one pass.

Install [LM Studio](https://lmstudio.ai), enable its local server, then open **LM Studio Assist** from the sidebar. Point it at the server URL, describe your project, click **Analyze**. Components scoring above your threshold (default 95%) are pre-selected — review and click **Install Selected**.

**Everything runs locally — no data leaves your machine.**

**Persistent cache** — a full analysis can take ~1 hour, so results save per *(project, ECC version, description)* and re-render instantly on reopen. Three actions surface based on cache state:

| Action | When |
|--------|------|
| **Analyze** | No saved analysis yet |
| **Analyze Missing/Failed** | Previous run partial — re-scores only the gaps |
| **Re-analyze** | Wipes cache, runs fresh |

Editing the project description invalidates the cache; threshold changes don't (they only re-evaluate pre-selection).

---

## Component Categories

| Category | What gets installed |
|----------|---------------------|
| ⚙ Settings | Catalog of 86 settings → `settings.json` |
| 📏 Rules | Coding guidelines for your language → `.claude/rules/` |
| 🪝 Hooks | Automation triggered by Claude events → merged into `settings.json` |
| 🔌 MCP Servers | External tool integrations → `settings.json` (add API keys manually) |
| 🤖 Agents | Specialized subagents Claude can delegate to → `.claude/agents/` |
| ⚡ Skills | Workflow patterns and instructions → `.claude/skills/` |
| / Commands | Slash command definitions → `.claude/commands/` |
| 📝 Managed Agent Docs | `CLAUDE.md` and `AGENTS.md` with diff/replace/restore against ECC defaults |
| 🟢 Custom Library | Copy/paste templates (Custom CLAUDE.md / AGENTS.md / settings.local.json / Other md files) plus typed components (rules / hooks / MCP / agents / skills / commands), all global and shared across projects |

---

## Version Management

ECC Manager tracks every version of ECC you pull as an independent snapshot under
`versions/<verId>/`. The header shows the active version; the sidebar footer shows it
again as a small `v<verId>` label. Each project records the version it was last
synchronized to, so:

- Pulling a new ECC version doesn't disturb existing projects
- Projects on older versions show an upgrade banner with a one-click migration
- You can keep a stable project pinned to an older version while experimenting with newer
  components in a different project

---

## MCP Servers

MCP server configs are written to `settings.json` automatically on install.
Servers that need credentials will show a **needs KEY_NAME** badge — add those values manually:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_your_token" }
    }
  }
}
```

---

## State Layout

State is sharded — one tiny global index plus one shard per (project, ECC version) — so writes during long LM Studio analyses don't rewrite a single mega-JSON.

```text
state/
  state.json                          # global index — versions, project list, LM config
  <eccVersion>-<projectName>.json     # one shard per (project, ECC version)
  backups/                            # legacy + corruption snapshots
  shared/                             # global, NOT version- or project-scoped
    CLAUDE.md/<id>/{meta.json, content.md}            # Custom CLAUDE.md templates
    AGENTS.md/<id>/{meta.json, content.md}            # Custom AGENTS.md templates
    settings.local.json/<id>/{meta.json, content.md}  # Custom settings.local.json templates
    other/<id>/{meta.json, content.md}                # "Other md files" templates
    custom-components/<kind>/<slug>/                  # rules / hooks / mcp / agents / skills / commands
```

`<id>` is opaque 8-hex (names can repeat). Component `<slug>`s are unique within a kind because each maps to one apply target.

Writes are atomic (temp file + rename); a corrupt shard is quarantined to `backups/` and reset without touching others. Pre-shard `state.json` files migrate automatically on first launch (original copied into `backups/legacy-state.json.bak.<ts>`).

## Multi-Machine Sync

Stop the server on both ends, then:

```bash
rsync -a state/ user@other-host:~/ecc-manager/state/
```

Run **Pull ECC** once on the new machine to re-clone the component library.

> Symlinking `state/` to iCloud / Dropbox / OneDrive is fine as one-way backup, **not safe during an active LM Studio analysis** — the cache writes ~100 files/hour and cloud-sync conflict files will pile up.

## Rollback to single-file `state.json`

1. Stop the server.
2. Copy the most recent `state/backups/legacy-state.json.bak.<ts>` back to `state.json` in the project root.
3. Remove `state/`.
4. Run the older ECC Manager code.

Migration is non-destructive — the backup is a verbatim copy.

---

## Diagnostics

ECC Manager keeps an in-memory event tally for each session. Snapshot it at any time:

```bash
curl http://localhost:7700/api/diagnostics
```

Returns counters for events like `lm.run.start`, `lm.result.saved`, `lm.cache.clear`,
`state.migrated`. No PII, no network egress — purely local. Useful when filing issues:
attach the snapshot so the maintainer can see what the session did.

For machine-readable logs, run:

```bash
ECC_LOG_FORMAT=json node server.js
```

Each log line becomes a one-line JSON object you can pipe into `jq`.

## Tests

```bash
npm test
```

Unit tests cover the settings catalog, sharded state + schema migrations, LM Studio cache, catalog scanning, component install, managed-doc workflow, Custom Library, hooks/MCP merge with conflict resolution, and project-root deploy + defensive backups. Integration tests boot a real HTTP server and exercise the cache, managed-doc, and Custom Library routes end-to-end.

---

## Troubleshooting

**Port 7700 in use** — Kill the other process or change `PORT` at the top of `server.js`.

**Pull fails** — Git must be installed (`git --version`) and you need internet access.

**Nothing shows in the sidebar** — Pull ECC first. Only Settings are available before the first pull.

**Install fails with "not found in catalog"** — Re-select your project after pulling ECC so the catalog refreshes.

**"Failed to fetch ECC default" on a CLAUDE.md preview** — The active ECC version doesn't ship a `CLAUDE.md` template. Pull a newer version (v2.0.0-rc.1+) or skip the replace flow.

**Deploy fails** — The destination directory must already exist. The tool won't create parent directories.

**Deploy aborts with "preflight failure(s) on project-root targets"** — A custom component you applied to a project-root path (e.g. `.cursor/agents/foo.md`) conflicts with what's already at the deploy destination — typically because the destination has a directory where the component expects a file (or vice versa), or an ancestor directory is a file. The error response lists each conflicting `src`. Resolve those paths in your real project, then re-run deploy. The real project-root files are unchanged when this fires.

**Custom Library "No-op Apply"** — Every conflict was Skip-resolved, or the incoming hook/MCP entries already exist verbatim in `settings.json`. Nothing was written and the component was deliberately *not* recorded as applied. Re-run with **Replace** or **Append As New** if you want the changes to land.

---

## Credits

Components provided by [everything-claude-code](https://github.com/affaan-m/everything-claude-code) by [@affaan-m](https://github.com/affaan-m).
