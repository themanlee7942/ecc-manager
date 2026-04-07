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

**Requirements:** Node.js 18+, Git

```bash
git clone https://github.com/themanlee7942/ecc-manager
cd ecc-manager
node server.js
```

Open **http://localhost:7700**

---

## Workflow

### 1. Pull ECC

Click **↓ Pull ECC** in the header. This clones the ECC repo as a versioned local snapshot.
All components are read directly from it — no hardcoded lists.

### 2. Create a Project

Click the project selector → **+ New Project**. Give it the same name as your actual project.

### 3. Browse and Preview Components

Browse by category in the left sidebar. **Click any component name** to preview its content
before installing — single files open inline, directories show a file tree you can navigate.

### 4. Install

Check the components you want and click **↓ Install**, or use the **Install** button on each row.

- **Agents** — installed as `.claude/agents/*.md`
- **Skills** — installed as individual files in `.claude/skills/*/`
- **Rules** — individual guideline files copied to `.claude/rules/*/`
- **Hooks** — each hook entry merged individually into `.claude/settings.json`
- **MCP Servers** — server config written directly into `.claude/settings.json` (add your API keys after)
- **Commands** — installed as `.claude/commands/*.md` slash command definitions

> **Note:** `multi-*` commands (`/multi-plan`, `/multi-execute`, etc.) require the
> separate [ccg-workflow](https://www.npmjs.com/package/ccg-workflow) runtime — run `npx ccg-workflow`
> once in your project after installing them.

### 5. Configure Settings

Under **⚙ Settings**, configure Claude's behavior for this project:

| Setting | Recommended | Effect |
|---------|-------------|--------|
| Default Model | `sonnet` | Cost-efficient for most tasks |
| MAX_THINKING_TOKENS | `10000` | ~70% cost reduction on extended thinking |
| CLAUDE_AUTOCOMPACT_PCT_OVERRIDE | `50` | Compacts earlier, keeps quality in long sessions |
| CLAUDE_CODE_SUBAGENT_MODEL | `haiku` | Cheaper model for delegated subagent work |

Click **Apply** on each setting to write it to `.claude/settings.json`.

### 6. Deploy to Your Project

Enter the path to your actual project directory and click **Deploy**.
This copies the managed `.claude/` folder into your project.

```bash
# Or use a symlink so changes sync automatically:
ln -s ~/ecc-manager/projects/my-project/.claude /path/to/my-project/.claude
```

---

## LM Studio Assist *(optional)*

If you have [LM Studio](https://lmstudio.ai) installed, you can use a local LLM to automatically
recommend which components to install based on your project description.

**How it works:**
1. Start LM Studio and enable the local server (default: `http://localhost:1234`)
2. In ECC Manager, open **LM Studio Assist** from the sidebar
3. Point it at your LM Studio server URL and describe your project
4. Click **Analyze** — the LM reviews every component in the library and scores its relevance
5. Components scoring above your threshold (default: 95%) are pre-selected for install
6. Review the results, adjust the selection, and click **Install Selected**

You can tune the threshold ("Install if more than X% matches my project") to be more or less
selective. No data leaves your machine — everything runs through the local server.

This feature is entirely optional. The manual browse-and-install workflow works without it.

---

## Component Categories

| Category | What gets installed |
|----------|---------------------|
| ⚙ Settings | Model, token limits, subagent model → `settings.json` |
| 📏 Rules | Coding guidelines for your language → `.claude/rules/` |
| 🪝 Hooks | Automation triggered by Claude events → merged into `settings.json` |
| 🔌 MCP Servers | External tool integrations → `settings.json` (add API keys manually) |
| 🤖 Agents | Specialized subagents Claude can delegate to → `.claude/agents/` |
| ⚡ Skills | Workflow patterns and instructions → `.claude/skills/` |
| / Commands | Slash command definitions → `.claude/commands/` |

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

## Multi-Machine Sync

`state.json` tracks all your projects and what's installed. Copy it to another machine and run:

```bash
node server.js
# Pull ECC once to re-clone the component library
# Your project state loads automatically
```

Or symlink `state.json` to iCloud / Dropbox to keep machines in sync.

---

## Troubleshooting

**Port 7700 in use** — Kill the other process or change `PORT` at the top of `server.js`.

**Pull fails** — Git must be installed (`git --version`) and you need internet access.

**Nothing shows in the sidebar** — Pull ECC first. Only Settings are available before the first pull.

**Install fails with "not found in catalog"** — Re-select your project after pulling ECC so the catalog refreshes.

**Deploy fails** — The destination directory must already exist. The tool won't create parent directories.

---

## Credits

Components provided by [everything-claude-code](https://github.com/affaan-m/everything-claude-code) by [@affaan-m](https://github.com/affaan-m).
