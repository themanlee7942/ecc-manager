# ECC Manager

A local web UI to manage per-project [Claude Code](https://claude.ai/code) configurations.
Installs components from [everything-claude-code](https://github.com/affaan-m/everything-claude-code)
into project-scoped `.claude/` directories — **never touches `~/.claude/`**.

---

## Why

Claude Code loads configuration in priority order:

```
.claude/settings.json    ← project level  ← what this tool manages
~/.claude/settings.json  ← user global
```

Project-level config **overrides** global. ECC Manager lets you curate exactly which
agents, skills, rules, hooks, and MCP servers each project gets — without cross-project
contamination and without editing files by hand.

---

## Features

- Browse and install 200+ ECC components: agents, skills, commands, rules, hooks, MCP servers
- Per-project `.claude/` directories, fully isolated
- Hooks install directly into `settings.json` (individual hook selection — not all-or-nothing)
- MCP servers read dynamically from ECC's `mcp-configs/mcp-servers.json`
- Settings UI writes `model`, `MAX_THINKING_TOKENS`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `CLAUDE_CODE_SUBAGENT_MODEL`
- Deploy button copies `.claude/` to your actual project directory
- Activity log panel with copy-to-clipboard
- Installed components panel (right sidebar) with jump-to navigation
- Version-aware: each ECC pull is stored separately, projects pin to a version
- Zero npm dependencies — Node.js built-ins only

---

## Quick Start

**Requirements:** Node.js 18+, Git

```bash
git clone https://github.com/your-username/ecc-manager
cd ecc-manager
node server.js
```

Open **http://localhost:7700**

---

## Usage

### 1. Pull ECC

Click **↓ Pull ECC** in the header. This clones the [everything-claude-code](https://github.com/affaan-m/everything-claude-code)
repo and stores it as a versioned snapshot. Click again anytime to pull the latest.

### 2. Create a Project

Click your project name in the header → **+ New Project**. Enter a name and optional deploy path.

### 3. Install Components

Select a project, browse by category in the left sidebar, check components, click **↓ Install**.
Each component shows its source filename (`agent-sort.md`, `tdd-workflow/`, etc.) so you know exactly what gets copied.

### 4. Configure Settings

Under **⚙ Settings**, set:
- **Default Model** — `sonnet` recommended for most work
- **MAX_THINKING_TOKENS** — `10000` recommended (~70% cost reduction)
- **CLAUDE_AUTOCOMPACT_PCT_OVERRIDE** — `50` recommended
- **CLAUDE_CODE_SUBAGENT_MODEL** — `haiku` recommended for delegated tasks

Click **Apply** to write directly to `projects/[name]/.claude/settings.json`.

### 5. Deploy

Set the deploy path (e.g. `/Users/you/projects/my-app`) and click **Deploy**.
This copies `projects/[name]/.claude/` into your actual project. The path is saved automatically.

Or use a symlink for always-in-sync behavior:

```bash
ln -s ~/ecc-manager/projects/my-project/.claude /path/to/actual/project/.claude
```

---

## Component Categories

| Category | Source | What it does |
|----------|--------|--------------|
| ⚙ Settings | UI only | Writes `settings.json` fields |
| 📏 Rules | `rules/*/` | Always-follow coding guidelines |
| 🪝 Hooks | `hooks/hooks.json` | Per-event automation (PreToolUse, Stop, etc.) |
| 🔌 MCP Servers | `mcp-configs/mcp-servers.json` | External integrations |
| 🤖 Agents | `agents/*.md` | Specialized subagents for delegation |
| ⚡ Skills | `skills/*/` | Workflow and pattern libraries |
| / Commands | `commands/*.md` | Slash command definitions |

All categories except Settings are scanned dynamically from the pulled ECC version —
new components appear automatically without any changes to this tool.

---

## MCP Setup

After marking an MCP server as installed, add it to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "your_token_here" }
    }
  }
}
```

See [ECC mcp-configs](https://github.com/affaan-m/everything-claude-code/blob/main/mcp-configs/mcp-servers.json) for all server configurations.

---

## Directory Structure

```
ecc-manager/
├── server.js              ← HTTP server (Node.js built-ins only, zero deps)
├── index.html             ← UI (single file, no framework)
├── state.json             ← auto-created: all project states
└── projects/
    ├── .ecc-versions/
    │   └── 1.10.0/        ← versioned ECC snapshot (git clone)
    ├── my-backend/
    │   └── .claude/
    │       ├── agents/
    │       ├── skills/
    │       ├── commands/
    │       ├── rules/
    │       └── settings.json
    └── client-app/
        └── .claude/
            └── settings.json
```

---

## state.json

Auto-created on first run. Tracks all project configurations and installed components.
Back it up or commit it to reproduce your setup on another machine.

```json
{
  "cacheUpdatedAt": "2026-04-06T00:00:00Z",
  "cacheAvailable": true,
  "activeVersion": "1.10.0",
  "projects": {
    "my-backend": {
      "name": "my-backend",
      "deployPath": "/Users/you/projects/my-backend",
      "eccVersion": "1.10.0",
      "components": {
        "rule-common":        { "installed": true,  "installedAt": "2026-04-06T00:00:00Z" },
        "setting-model":      { "installed": true,  "value": "sonnet" },
        "skill-tdd-workflow": { "installed": false }
      }
    }
  }
}
```

---

## Multi-Machine Sync

Copy or sync `state.json` to a new machine, then:

```bash
node server.js
# open http://localhost:7700
# click ↓ Pull ECC to re-clone
# existing project state loads automatically
```

Or symlink `state.json` to iCloud / Dropbox for automatic sync.

---

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/catalog?version=<id>` | Component list for a version |
| GET | `/api/versions` | All pulled versions |
| GET | `/api/projects` | All projects |
| POST | `/api/projects` | Create project |
| PATCH | `/api/projects/:name` | Update deploy path / description |
| DELETE | `/api/projects/:name` | Delete project + files |
| GET | `/api/projects/:name` | Project detail + component states |
| POST | `/api/install` | `{ project, ids[] }` |
| POST | `/api/remove` | `{ project, ids[] }` |
| POST | `/api/deploy` | `{ project }` |
| POST | `/api/settings` | `{ project, id, value }` |
| POST | `/api/update-cache` | Pull latest ECC |

---

## Troubleshooting

**Port 7700 in use** — Another process is on that port. Kill it or change `PORT` in `server.js`.

**Pull fails** — Check internet connection. Git must be installed (`git --version`).

**Component not found after pull** — The ECC version may not include that component yet. Pull again to get the latest.

**Deploy fails** — The deploy path parent directory must exist. The tool copies into `<deployPath>/.claude/` — it won't create the parent.

**settings.json looks wrong** — The tool merges into `settings.json`, never replaces it. Inspect `projects/[name]/.claude/settings.json` directly.

---

## Credits

Components provided by [everything-claude-code](https://github.com/affaan-m/everything-claude-code).
