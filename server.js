#!/usr/bin/env node
/**
 * ECC Manager Server — Version-Aware, Project-Scoped
 * Never touches ~/.claude/
 * Each ECC pull → new versioned folder (old versions preserved)
 * node server.js  →  http://localhost:7700
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { execSync, spawnSync } = require('child_process');
const stateStore = require('./state-store');

// Simple proxy fetch using Node built-ins (no CORS restrictions)
function nodeFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   opts.method || 'GET',
      headers:  opts.headers || {},
      timeout:  opts.timeout || 8000,
    };
    const req = lib.request(reqOpts, res => {
      let body = '';
      res.on('data', d => {
        body += d;
        if (body.length > MAX_RESPONSE_BYTES) {
          req.destroy();
          reject(new Error('Response too large'));
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const PORT                 = 7700;
const ROOT                 = __dirname;
const PROJECTS_DIR         = process.env.ECC_PROJECTS_DIR  || path.join(ROOT, 'projects');
const VERSIONS_DIR         = path.join(PROJECTS_DIR, '.ecc-versions');
// STATE_FILE points at the LEGACY single-file state location. After v1 of the
// sharded layout this is no longer the active source of truth; state-store.js
// owns the authoritative paths. Kept for migration + ECC_STATE_FILE test
// compat. Use stateStore.indexStatePath() / stateStore.stateDir() for new code.
const STATE_FILE           = process.env.ECC_STATE_FILE    || path.join(ROOT, 'state.json');
const HTML_FILE            = path.join(ROOT, 'index.html');
const SETTINGS_CATALOG_FILE = process.env.ECC_CATALOG_FILE || path.join(ROOT, 'config', 'claude-settings-catalog.json');
const ECC_REPO_URL          = process.env.ECC_REPO_URL     || 'https://github.com/affaan-m/everything-claude-code.git';
const CORS_ORIGIN           = `http://localhost:${PORT}`;
const MAX_BACKUPS           = 10;
const MAX_RESPONSE_BYTES    = 8 * 1024 * 1024; // 8 MB

// ─── Static catalog (settings + MCP — no source files, always present) ────────

const STATIC_SETTINGS = [
  { id:'setting-model',          type:'setting', priority:1, name:'Default Model',
    description:'sonnet = cost-efficient (80%+ tasks), opus = deep reasoning, haiku = fastest',
    settingKey:'model', defaultValue:'sonnet', inputType:'select', options:['sonnet','opus','haiku'] },
  { id:'setting-thinking-tokens',type:'setting', priority:1, name:'MAX_THINKING_TOKENS',
    description:'Hidden thinking token cap. Recommended: 10000 (~70% cost reduction vs default 31999).',
    settingKey:'env.MAX_THINKING_TOKENS', defaultValue:'10000', inputType:'number' },
  { id:'setting-autocompact',    type:'setting', priority:1, name:'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
    description:'Context % before auto-compaction. Recommended: 50 (earlier = better quality in long sessions).',
    settingKey:'env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', defaultValue:'50', inputType:'number' },
  { id:'setting-subagent-model', type:'setting', priority:1, name:'CLAUDE_CODE_SUBAGENT_MODEL',
    description:'Model for subagent tasks. Haiku = significant cost reduction for delegated work.',
    settingKey:'env.CLAUDE_CODE_SUBAGENT_MODEL', defaultValue:'haiku', inputType:'select', options:['haiku','sonnet','opus'] },
];

// MCP servers are scanned dynamically from mcp-configs/mcp-servers.json in scanCatalog.
// This fallback is used only when no ECC version is available.
const FALLBACK_MCP = [
  { id:'mcp-github',             type:'mcp', priority:4, name:'github',             description:'GitHub operations - PRs, issues, repos',                        mcpKey:'github',             requiresKey:'GITHUB_PERSONAL_ACCESS_TOKEN' },
  { id:'mcp-supabase',           type:'mcp', priority:4, name:'supabase',           description:'Supabase database operations',                                   mcpKey:'supabase' },
  { id:'mcp-vercel',             type:'mcp', priority:4, name:'vercel',             description:'Vercel deployments and projects',                                 mcpKey:'vercel' },
  { id:'mcp-railway',            type:'mcp', priority:4, name:'railway',            description:'Railway deployments',                                             mcpKey:'railway' },
  { id:'mcp-playwright',         type:'mcp', priority:4, name:'playwright',         description:'Browser automation and testing via Playwright',                   mcpKey:'playwright' },
  { id:'mcp-context7',           type:'mcp', priority:4, name:'context7',           description:'Live documentation lookup',                                       mcpKey:'context7' },
  { id:'mcp-memory',             type:'mcp', priority:4, name:'memory',             description:'Persistent memory across sessions',                               mcpKey:'memory' },
  { id:'mcp-sequential-thinking',type:'mcp', priority:4, name:'sequential-thinking',description:'Chain-of-thought reasoning',                                      mcpKey:'sequential-thinking' },
];

// ─── Dynamic catalog — scanned from version directory ─────────────────────────

function readFrontmatter(filePath) {
  try {
    const txt = fs.readFileSync(filePath, 'utf8');
    const m   = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return {};
    const out = {};
    m[1].split('\n').forEach(line => {
      const i = line.indexOf(':');
      if (i < 0) return;
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
    });
    return out;
  } catch { return {}; }
}

function getVersionId(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.version) return pkg.version;
  } catch {}
  try {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 });
    if (r.status !== 0) throw new Error('git failed');
    const hash = r.stdout.toString().trim();
    return `${new Date().toISOString().split('T')[0]}-${hash}`;
  } catch {}
  return `pull-${Date.now()}`;
}

const _catalogCache = {};
let _lastPullTime = 0;

function scanCatalog(vDir) {
  const items = [...STATIC_SETTINGS];

  // MCP Servers: mcp-configs/mcp-servers.json
  const mcpFile = path.join(vDir, 'mcp-configs', 'mcp-servers.json');
  if (fs.existsSync(mcpFile)) {
    try {
      const md = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
      Object.entries(md.mcpServers || {}).forEach(([key, cfg]) => {
        const envKeys = Object.keys(cfg.env || {});
        items.push({
          id: `mcp-${key}`,
          type: 'mcp',
          priority: 4,
          name: key,
          description: cfg.description || '',
          mcpKey: key,
          requiresKey: envKeys.length ? envKeys.join(', ') : null,
          mcpConfig: cfg,
        });
      });
    } catch (e) { log('warn', `Failed to parse mcp-servers.json in ${vDir}: ${e.message}`); }
  } else {
    items.push(...FALLBACK_MCP);
  }

  // Rules: rules/*/*.md — individual files, one item per file
  const rulesDir = path.join(vDir, 'rules');
  if (fs.existsSync(rulesDir)) {
    fs.readdirSync(rulesDir).sort().forEach(lang => {
      const langDir = path.join(rulesDir, lang);
      try { if (!fs.statSync(langDir).isDirectory()) return; } catch { return; }
      fs.readdirSync(langDir).sort().filter(f => f.endsWith('.md')).forEach(f => {
        const fm = readFrontmatter(path.join(langDir, f));
        items.push({
          id: `rule-${lang}-${f.slice(0, -3)}`,
          type: 'rule', priority: 2,
          name: f,
          description: fm.description || `${lang}/${f}`,
          sourcePath: `rules/${lang}/${f}`,
          targetPath: `rules/${lang}/${f}`,
        });
      });
    });
  }

  // Hooks: hooks/hooks.json → one installable item per hook entry, merged into settings.json
  const hooksFile = path.join(vDir, 'hooks', 'hooks.json');
  if (fs.existsSync(hooksFile)) {
    try {
      const hd = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
      Object.entries(hd.hooks || {}).forEach(([event, entries]) => {
        (entries || []).forEach(entry => {
          const hookId = entry.id || `${event}-${items.length}`;
          const safeId = hookId.replace(/[^a-zA-Z0-9_-]/g, '-');
          items.push({
            id: `hook-${safeId}`,
            type: 'hook',
            priority: 3,
            name: entry.description ? entry.description.slice(0, 60) : hookId,
            description: `[${event}] ${entry.description || ''}`,
            hookId,
            hookEvent: event,
            sourcePath: 'hooks/hooks.json',
          });
        });
      });
    } catch (e) { log('warn', `Failed to parse hooks.json in ${vDir}: ${e.message}`); }
  }

  // Agents: agents/*.md
  const agentsDir = path.join(vDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    fs.readdirSync(agentsDir).sort().forEach(f => {
      if (!f.endsWith('.md')) return;
      const slug = f.slice(0, -3);
      const fm   = readFrontmatter(path.join(agentsDir, f));
      items.push({ id:`agent-${slug}`, type:'agent', priority:5,
        name: f, description: fm.description || '',
        sourcePath:`agents/${f}`, targetPath:`agents/${f}` });
    });
  }

  // Skills: skills/* — one item per skill directory
  const skillsDir = path.join(vDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    fs.readdirSync(skillsDir).sort().forEach(skill => {
      const skillDir = path.join(skillsDir, skill);
      try { if (!fs.statSync(skillDir).isDirectory()) return; } catch { return; }
      const skillFm = readFrontmatter(path.join(skillDir, 'SKILL.md'));
      items.push({
        id: `skill-${skill}`,
        type: 'skill', priority: 6,
        name: skill,
        description: skillFm.description || skill,
        sourcePath: `skills/${skill}`,
        targetPath: `skills/${skill}`,
      });
    });
  }

  // Commands: commands/*.md
  const commandsDir = path.join(vDir, 'commands');
  if (fs.existsSync(commandsDir)) {
    fs.readdirSync(commandsDir).sort().forEach(f => {
      if (!f.endsWith('.md')) return;
      const slug = f.slice(0, -3);
      const fm   = readFrontmatter(path.join(commandsDir, f));
      items.push({ id:`command-${slug}`, type:'command', priority:7,
        name: f, description: fm.description || `/${slug} command`,
        sourcePath:`commands/${f}`, targetPath:`commands/${f}` });
    });
  }

  return items;
}

function kindPriority(kind) {
  const m = { rules: 2, hooks: 3, mcp: 4, agents: 5, skills: 6, orchestration: 6, commands: 7, platform: 1 };
  return m[kind] || 8;
}

// Per-platform leaf metadata. Each entry in the platform-configs manifest
// module is a self-contained config bundle for a different AI agent / IDE,
// so users want per-platform pick-and-choose ("I use Claude + Cursor, not
// Codex"). These descriptions are surfaced verbatim in the catalog UI.
const PLATFORM_LEAF_META = {
  '.claude-plugin': {
    name: 'Claude Code plugin manifest',
    description: 'Plugin manifest + marketplace metadata for Claude Code (.claude-plugin/). Install if you publish a Claude Code plugin or want this project to register as one.',
  },
  '.codex': {
    name: 'Codex configs',
    description: 'OpenAI Codex agent configs (.codex/agents, AGENTS.md, config.toml). Install if you use Codex.',
  },
  '.cursor': {
    name: 'Cursor configs',
    description: 'Cursor IDE rules, skills, and hooks (.cursor/). Install if you use Cursor.',
  },
  '.gemini': {
    name: 'Gemini configs',
    description: 'Google Gemini CLI configs (.gemini/). Install if you use Gemini.',
  },
  '.opencode': {
    name: 'OpenCode configs',
    description: 'OpenCode tools, prompts, and plugins (.opencode/). Install if you use OpenCode.',
  },
  'mcp-configs': {
    name: 'MCP catalog source',
    description: 'Source files for the MCP server catalog (mcp-configs/mcp-servers.json). Optional — the per-server entries (mcp-github, mcp-firecrawl, …) are read directly from the ECC version, so you only need this if you fork or self-host the catalog.',
  },
  'scripts/auto-update.js': {
    name: 'ECC auto-update script',
    description: 'Background script that checks for newer ECC versions and prompts to upgrade.',
  },
  'scripts/setup-package-manager.js': {
    name: 'Package-manager setup',
    description: 'Script that detects pnpm / yarn / bun / npm and writes the appropriate workspace config.',
  },
};

// Convert a platform path to a slug. Drops the leading dot used for hidden
// dirs (.cursor → cursor) and common config-file extensions so script paths
// produce readable IDs. Distinct from relPathToLeafSlug, which is tuned for
// markdown-leaf disambiguation in rules/agents/commands.
function platformLeafSlug(p) {
  return p
    .replace(/\.(js|mjs|cjs|json|ts|toml|yaml|yml)$/i, '')
    .replace(/^\./, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

// Walk a manifest path entry and return every .md file inside (recursive).
// `p` is project-relative (e.g. "rules", "agents/code-reviewer.md", "AGENTS.md").
// Returns [{ relPath }] sorted lexicographically. Empty array when the path
// doesn't exist, isn't a .md file, or is a directory containing no markdown.
function walkMarkdownLeaves(vDir, p) {
  const abs = path.join(vDir, p);
  let stat;
  try { stat = fs.statSync(abs); } catch { return []; }
  if (stat.isFile()) {
    return p.toLowerCase().endsWith('.md') ? [{ relPath: p }] : [];
  }
  if (!stat.isDirectory()) return [];
  const out = [];
  const stack = [p];
  while (stack.length) {
    const subPath = stack.shift();
    let entries;
    try { entries = fs.readdirSync(path.join(vDir, subPath)).sort(); } catch { continue; }
    for (const e of entries) {
      const childRel = path.posix.join(subPath, e);
      let cs;
      try { cs = fs.statSync(path.join(vDir, childRel)); } catch { continue; }
      if (cs.isDirectory()) stack.push(childRel);
      else if (cs.isFile() && e.toLowerCase().endsWith('.md')) out.push({ relPath: childRel });
    }
  }
  return out;
}

// Convert a relative path to a stable, collision-resistant catalog ID slug.
// `.agents/foo.md` → `dot-agents-foo` (avoids colliding with `agents/foo.md`).
// `rules/common/coding-style.md` → `rules-common-coding-style`.
function relPathToLeafSlug(relPath) {
  return relPath
    .replace(/\.md$/i, '')
    .replace(/^\./, 'dot-')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function scanCatalogV2(vDir) {
  const items = [...STATIC_SETTINGS];

  // MCP Servers (same as v1)
  const mcpFile = path.join(vDir, 'mcp-configs', 'mcp-servers.json');
  if (fs.existsSync(mcpFile)) {
    try {
      const md = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
      Object.entries(md.mcpServers || {}).forEach(([key, cfg]) => {
        const envKeys = Object.keys(cfg.env || {});
        items.push({
          id: `mcp-${key}`,
          type: 'mcp', priority: 4,
          name: key,
          description: cfg.description || '',
          mcpKey: key,
          requiresKey: envKeys.length ? envKeys.join(', ') : null,
          mcpConfig: cfg,
        });
      });
    } catch (e) { log('warn', `Failed to parse mcp-servers.json in ${vDir}: ${e.message}`); }
  } else {
    items.push(...FALLBACK_MCP);
  }

  let modules = [];
  try {
    const mf = path.join(vDir, 'manifests', 'install-modules.json');
    modules = JSON.parse(fs.readFileSync(mf, 'utf8')).modules || [];
  } catch (e) { log('warn', `Failed to read v2 manifest for ${vDir}: ${e.message}`); return items; }

  for (const mod of modules) {
    const { id: modId, kind, description, paths = [] } = mod;
    if (!paths.length) { log('warn', `v2 module "${modId}" (kind: ${kind}) has no paths — skipped`); continue; }

    if (kind === 'skills' || kind === 'orchestration') {
      paths.forEach(p => {
        if (!p.startsWith('skills/')) return;
        const skillName = p.slice('skills/'.length);
        const skillFm   = readFrontmatter(path.join(vDir, p, 'SKILL.md'));
        items.push({
          id: `skill-${skillName}`,
          type: 'skill', priority: 6,
          name: skillName,
          description: skillFm.description || skillName,
          sourcePath: p,
          targetPath: p,
          moduleId: modId,
        });
      });
      continue;
    }

    // Hooks: emit one catalog entry per hook entry in hooks/hooks.json (same
    // shape v1 produced — pick which hooks to install individually). v2's
    // hook commands self-resolve their script paths via $CLAUDE_PLUGIN_ROOT
    // and ~/.claude/plugins/, so installation is identical to v1: merge the
    // hook entry into the project's .claude/settings.json. The runtime is
    // expected to come from a global ECC plugin install.
    if (kind === 'hooks') {
      const hooksFile = path.join(vDir, 'hooks', 'hooks.json');
      let leafCount = 0;
      if (fs.existsSync(hooksFile)) {
        try {
          const hd = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
          // Detect whether hook commands rely on the global ECC plugin
          // runtime ($CLAUDE_PLUGIN_ROOT / ~/.claude/plugins/...). If so,
          // surface a clear note in each hook's description so users know
          // these hooks fail at execution time without the global plugin.
          const rawHooksJson = JSON.stringify(hd);
          const needsGlobalRuntime =
            rawHooksJson.includes('CLAUDE_PLUGIN_ROOT') ||
            rawHooksJson.includes('plugins/cache') ||
            rawHooksJson.includes('scripts/hooks/plugin-hook-bootstrap.js');
          const runtimeNote = needsGlobalRuntime
            ? ' — Requires the ECC plugin globally installed (~/.claude/plugins/ecc/) or $CLAUDE_PLUGIN_ROOT set; otherwise the hook command will fail at execution time.'
            : '';
          Object.entries(hd.hooks || {}).forEach(([event, entries]) => {
            (entries || []).forEach(entry => {
              const hookId = entry.id || `${event}-${items.length}`;
              const safeId = hookId.replace(/[^a-zA-Z0-9_-]/g, '-');
              items.push({
                id: `hook-${safeId}`,
                type: 'hook',
                priority: 3,
                name: entry.description ? entry.description.slice(0, 60) : hookId,
                description: `[${event}] ${entry.description || ''}${runtimeNote}`,
                hookId,
                hookEvent: event,
                sourcePath: 'hooks/hooks.json',
                moduleId: modId,
                ...(needsGlobalRuntime ? { requiresRuntime: 'ecc-plugin' } : {}),
              });
              leafCount++;
            });
          });
        } catch (e) {
          log('warn', `Failed to parse hooks.json in ${vDir}: ${e.message}`);
        }
      }
      if (!leafCount) {
        // No hooks.json or empty — fall back to a single quarantined module
        // entry so the catalog still has *something* to surface.
        items.push({
          id: `module-${modId}`,
          type: 'hook', priority: 3,
          name: modId,
          description: description || modId,
          quarantined: true,
          quarantineReason: 'hooks/hooks.json is missing or empty in this version',
          paths,
          moduleId: modId,
        });
      }
      continue;
    }

    // Rules, agents, and commands: emit one catalog entry per .md leaf inside
    // the module's paths. v2 manifests group these under a single module
    // (e.g. rules-core with paths: ["rules"]), but users expect per-file
    // granularity like v1 had — pick which agents, which rules, which commands
    // to install individually. Hooks stay quarantined as a module entry; skills
    // are already per-skill (handled above); platform/orchestration stay
    // module-level because they bundle non-markdown infrastructure.
    //
    // ID convention: when the leaf lives under the kind's conventional folder
    // (rules/, agents/, commands/), strip that prefix so leaf IDs match v1's
    // (e.g. `rule-common-coding-style` for `rules/common/coding-style.md`).
    // Files outside the convention (e.g. `.agents/foo.md`, `AGENTS.md`) keep
    // the full path in the slug to stay collision-free.
    // Platform: emit one catalog entry per top-level path so users can pick
    // which AI-agent / IDE configs apply to them ("I use Claude + Cursor, not
    // Codex"). Unlike rules/agents/commands these aren't .md files — each path
    // is a hidden config dir or a single utility script — so we don't recurse
    // into the directory tree, we surface each path as a unit.
    //
    // Hidden top-level paths (.cursor, .codex, …) are deployed at the project
    // ROOT, not under .claude/, because each tool reads its config from the
    // project root. Non-hidden paths (mcp-configs, scripts/auto-update.js)
    // stay under .claude/ as ECC-internal data.
    if (kind === 'platform') {
      let leafCount = 0;
      for (const p of paths) {
        if (!fs.existsSync(path.join(vDir, p))) continue;
        const slug = platformLeafSlug(p);
        if (!slug) continue;
        const meta = PLATFORM_LEAF_META[p] || {
          name: p,
          description: `Platform config: ${p}`,
        };
        const isHiddenRoot = p.startsWith('.') && !p.includes('/');
        items.push({
          id: `platform-${slug}`,
          type: 'platform',
          priority: kindPriority(kind),
          name: meta.name,
          description: meta.description,
          sourcePath: p,
          targetPath: p,
          moduleId: modId,
          ...(isHiddenRoot ? { deployRoot: 'project' } : {}),
        });
        leafCount++;
      }
      if (!leafCount) {
        log('warn', `v2 platform module "${modId}" produced no leaves — paths: ${JSON.stringify(paths)}`);
      }
      continue;
    }

    if (kind === 'rules' || kind === 'agents' || kind === 'commands') {
      const compType = kind === 'rules' ? 'rule' : kind === 'agents' ? 'agent' : 'command';
      const prio = kindPriority(kind);
      const conventionalPrefix = `${kind}/`;
      let leafCount = 0;
      for (const p of paths) {
        let stat;
        try { stat = fs.statSync(path.join(vDir, p)); } catch { continue; }

        // Hidden directories (e.g. .agents/, .cursor-rules/) are opaque
        // bundles whose subtrees contain non-markdown siblings (yaml, json,
        // nested skills/, etc.). Flattening them into per-file .md leaves
        // produces broken installs that miss those siblings — see the real
        // ECC v2 case where .agents/skills/dmux-workflows/agents/openai.yaml
        // would silently disappear. Emit ONE bundle entry per hidden dir so
        // copyRecursive picks up the whole subtree.
        if (stat.isDirectory() && path.basename(p).startsWith('.')) {
          const slug = relPathToLeafSlug(p);
          if (!slug) continue;
          items.push({
            id: `${compType}-${slug}`,
            type: compType, priority: prio,
            name: p,
            description: description ? `${description} — bundle (${p}/)` : `Bundle: ${p}/`,
            sourcePath: p,
            targetPath: p,
            moduleId: modId,
          });
          leafCount++;
          continue;
        }

        // Non-hidden path (file or directory): per-file expansion.
        const leaves = walkMarkdownLeaves(vDir, p);
        for (const leaf of leaves) {
          const slugSrc = leaf.relPath.startsWith(conventionalPrefix)
            ? leaf.relPath.slice(conventionalPrefix.length)
            : leaf.relPath;
          const slug = relPathToLeafSlug(slugSrc);
          if (!slug) continue;
          const fm = readFrontmatter(path.join(vDir, leaf.relPath));
          items.push({
            id: `${compType}-${slug}`,
            type: compType, priority: prio,
            name: path.basename(leaf.relPath),
            description: fm.description || leaf.relPath,
            sourcePath: leaf.relPath,
            targetPath: leaf.relPath,
            moduleId: modId,
          });
          leafCount++;
        }
      }
      if (!leafCount) {
        log('warn', `v2 module "${modId}" (kind: ${kind}) produced no leaves — paths: ${JSON.stringify(paths)}`);
      }
      continue;
    }

    const typeMap = { rules: 'rule', agents: 'agent', commands: 'command', platform: 'platform' };
    const compType = typeMap[kind] || kind;
    items.push({
      id: `module-${modId}`,
      type: compType, priority: kindPriority(kind),
      name: modId,
      description: description || modId,
      paths,
      sourcePath: paths[0] || modId,
      targetPath: paths[0] || modId,
      moduleId: modId,
      multiPath: paths.length > 1,
    });
  }

  return items;
}

function getCatalog(vDir, verId) {
  if (!_catalogCache[verId]) {
    const isV2 = fs.existsSync(path.join(vDir, 'manifests', 'install-modules.json'));
    _catalogCache[verId] = isV2 ? scanCatalogV2(vDir) : scanCatalog(vDir);
  }
  return _catalogCache[verId];
}

// Strip internal-only fields before sending catalog items to the client
function clientComp(c) {
  const { paths, moduleId, multiPath, ...safe } = c;
  return safe;
}

// Resolve the best available version for a project, falling back to activeVersion
function resolveVersion(proj, state) {
  const verId = proj.eccVersion || state.activeVersion;
  if (!verId) return { verId: null, vDir: null };
  const vDir = versionDir(verId);
  if (!fs.existsSync(vDir)) return { verId: null, vDir: null };
  return { verId, vDir };
}

function getCatalogForProject(proj, state) {
  const { verId, vDir } = resolveVersion(proj, state);
  return vDir ? getCatalog(vDir, verId) : [...STATIC_SETTINGS];
}

// One-shot migration: when a v2 project has a legacy `module-X` install flag
// (from the pre-leaf catalog era), expand it into per-leaf install flags so
// the right panel and the LM panel reflect the per-file granularity the v1 UI
// had. Idempotent: deletes the legacy flag once leaves are recorded. No-op
// when the catalog hasn't loaded leaves yet (e.g. ECC version not on disk).
//
// Generic over module kinds: any `module-X` whose leaves now exist in the
// catalog (rules, agents, commands, platform, hooks) gets migrated. The
// migration is a no-op when no leaves exist (e.g. hooks.json missing in this
// version, ECC version not pulled, etc.) — the legacy flag is preserved.
const MIGRATABLE_LEAF_TYPES = new Set(['rule', 'agent', 'command', 'platform', 'hook']);

function migrateV2ModuleInstallsToLeaves(proj, catalog) {
  if (!proj || !proj.components) return 0;
  let migrated = 0;
  for (const [legacyId, entry] of Object.entries({ ...proj.components })) {
    if (!legacyId.startsWith('module-')) continue;
    if (!entry || !entry.installed) continue;
    const modId = legacyId.slice('module-'.length);
    // A leaf is any catalog entry under this moduleId that ISN'T the
    // legacy module-level entry itself. Without this guard, a quarantined
    // fallback (e.g. module-hooks-runtime when hooks.json is missing) would
    // be its own migration target and the install flag would be wiped.
    const leaves = catalog.filter(c =>
      c.moduleId === modId &&
      MIGRATABLE_LEAF_TYPES.has(c.type) &&
      c.id !== legacyId
    );
    if (!leaves.length) continue;
    const fallbackAt = entry.installedAt || new Date().toISOString();
    for (const leaf of leaves) {
      if (!proj.components[leaf.id]) {
        proj.components[leaf.id] = { installed: true, installedAt: fallbackAt };
        migrated++;
      }
    }
    delete proj.components[legacyId];
    log('info', `v2 module-install migrated: ${legacyId} → ${leaves.length} leaves`);
    diag('v2_module_install_migrated');
  }
  return migrated;
}

// ─── Logger + diagnostics ─────────────────────────────────────────────────────
//
// Logs are emitted in human format by default. When a context object is
// supplied as the third arg, an additional JSON line is emitted to make grep
// and jq workflows trivial. Structured output is gated by ECC_LOG_FORMAT=json.
//
// Diagnostic counters are an in-memory tally of named events. They are
// purely local — no network, no PII — and exposed via /api/diagnostics so
// users / support can self-serve a snapshot of their session.

const _diagCounters = Object.create(null);
const _diagBootedAt = new Date().toISOString();

function diag(event, by = 1) {
  if (!event) return;
  _diagCounters[event] = (_diagCounters[event] || 0) + by;
}

function log(level, msg, ctx) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const lvl = level.toUpperCase().padEnd(5);
  const useJson = process.env.ECC_LOG_FORMAT === 'json';
  if (useJson) {
    const entry = { ts: new Date().toISOString(), level, msg };
    if (ctx && typeof ctx === 'object') Object.assign(entry, ctx);
    console.log(JSON.stringify(entry));
    return;
  }
  if (ctx && typeof ctx === 'object') {
    const tail = Object.entries(ctx).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
    console.log(`[${ts}] [${lvl}] ${msg}${tail ? '  ' + tail : ''}`);
  } else {
    console.log(`[${ts}] [${lvl}] ${msg}`);
  }
}

// ─── Version Utilities ────────────────────────────────────────────────────────


function versionDir(verId) {
  return path.join(VERSIONS_DIR, verId);
}

// ─── State ────────────────────────────────────────────────────────────────────
//
// State is sharded: a small global index (state/state.json) plus one shard per
// project/version (state/<verId>-<projectName>.json). loadState() composes the
// legacy in-memory shape from index+shards so existing routes can keep mutating
// `state.projects[name]` directly. saveState() decomposes back to disk.
//
// For frequent writes during long LM runs, prefer saveProjectShard(name) which
// touches a single shard file instead of all of them.

let _stateCache       = null;
let _shardCacheByName = {}; // projectName -> { shard, file } loaded for save-back
let _lastMigration    = null; // { backupPath, migratedAt, projectsMigrated, source } | null

function _composeFromDisk() {
  stateStore.ensureDirSync(stateStore.stateDir());
  const migrationResult = stateStore.migrateIfNeeded();
  if (migrationResult) {
    _lastMigration = migrationResult;
    diag('state.migrated');
    log('info', 'storage migrated to sharded layout', migrationResult);
  }
  const { index } = stateStore.loadIndexRaw();
  const baseIndex = index || stateStore.emptyIndex();
  if (!index) stateStore.saveIndexRaw(baseIndex);

  const projects = {};
  _shardCacheByName = {};
  for (const [name, entry] of Object.entries(baseIndex.projects || {})) {
    const { shard, file } = stateStore.loadShardRaw(name, entry.eccVersion, entry.stateFile);
    if (!shard) continue;
    _shardCacheByName[name] = { shard, file, stateFile: entry.stateFile, eccVersion: entry.eccVersion };
    projects[name] = stateStore.composeProject(shard, entry);
  }
  const composed = {
    versions: baseIndex.versions || {},
    activeVersion: baseIndex.activeVersion || null,
    projects,
  };
  if (baseIndex.lmStudio) composed.lmStudio = baseIndex.lmStudio;
  return composed;
}

function loadState() {
  if (_stateCache) return _stateCache;
  _stateCache = _composeFromDisk();
  return _stateCache;
}

// Build (but do not write) the index document from the in-memory state.
function _buildIndexFromState(s) {
  const index = {
    schemaVersion: stateStore.INDEX_SCHEMA_VERSION,
    activeVersion: s.activeVersion || null,
    versions: s.versions || {},
    projects: {},
  };
  if (s.lmStudio) index.lmStudio = s.lmStudio;
  for (const [name, proj] of Object.entries(s.projects || {})) {
    const verId = proj.eccVersion || s.activeVersion || null;
    const stateFile = stateStore.projectStateFileName(verId, name);
    index.projects[name] = {
      name,
      eccVersion: verId,
      stateFile,
      createdAt: proj.createdAt || null,
      deployPath: proj.deployPath || '',
    };
  }
  return index;
}

// Per-project write queues serialize concurrent shard writes. Each entry holds
// a Promise representing the tail of that project's write chain.
const _shardWriteQueue = new Map();

function _enqueueShardWrite(projName, work) {
  const prior = _shardWriteQueue.get(projName) || Promise.resolve();
  const next = prior.then(work, work).catch(err => {
    log('error', `shard write [${projName}] failed: ${err.message}`);
    throw err;
  });
  // Always advance the queue; if `next` settles (success or failure) before any
  // additional caller queues onto it, drop the entry to avoid leaking history.
  _shardWriteQueue.set(projName, next);
  next.finally(() => {
    if (_shardWriteQueue.get(projName) === next) _shardWriteQueue.delete(projName);
  });
  return next;
}

function _writeOneShard(name, proj, indexEntry, fallbackActiveVersion) {
  const cached = _shardCacheByName[name];
  const shard = stateStore.decomposeProject(proj, {
    fallbackVersion: fallbackActiveVersion,
    existingShard: cached && cached.shard,
  });
  try {
    const file = stateStore.saveShardRaw(shard, name, indexEntry.eccVersion, indexEntry.stateFile);
    _shardCacheByName[name] = { shard, file, stateFile: indexEntry.stateFile, eccVersion: indexEntry.eccVersion };
    return file;
  } catch (err) {
    // On write failure, leave the prior cache entry intact so callers don't
    // observe a half-applied mutation.
    log('error', `saveShardRaw failed for [${name}] (${indexEntry.stateFile}): ${err.message}`);
    throw err;
  }
}

// saveState writes shards FIRST, then the index, then deletes orphan shards.
// The index is the commit point — if a crash happens before it lands, the new
// shards exist on disk but no project references them; old data is still valid.
function saveState(s) {
  _stateCache = s;
  const priorIndex = stateStore.loadIndexRaw().index || stateStore.emptyIndex();
  const priorNames = new Set(Object.keys(priorIndex.projects || {}));
  const currentNames = new Set(Object.keys(s.projects || {}));

  const newIndex = _buildIndexFromState(s);

  // 1. Shards
  for (const [name, proj] of Object.entries(s.projects || {})) {
    _writeOneShard(name, proj, newIndex.projects[name], s.activeVersion);
  }

  // 2. Index — single atomic commit point.
  stateStore.saveIndexRaw(newIndex);

  // 3. Cleanup: shards no longer referenced by the new index.
  for (const name of priorNames) {
    if (currentNames.has(name)) continue;
    const oldEntry = priorIndex.projects[name];
    if (oldEntry && oldEntry.stateFile) stateStore.deleteShardFile(oldEntry.stateFile);
    delete _shardCacheByName[name];
  }
}

// Save one project's shard (no index rewrite). Used during LM analysis loops.
// Serialized per-project via _enqueueShardWrite to avoid interleaved writes.
function saveProjectShard(projName) {
  if (!_stateCache || !_stateCache.projects[projName]) return Promise.resolve(null);
  return _enqueueShardWrite(projName, () => {
    const proj = _stateCache.projects[projName];
    if (!proj) return null;
    const cached = _shardCacheByName[projName];
    const verId = proj.eccVersion || _stateCache.activeVersion || null;
    const stateFile = (cached && cached.stateFile) || stateStore.projectStateFileName(verId, projName);
    return _writeOneShard(projName, proj, { eccVersion: verId, stateFile }, _stateCache.activeVersion);
  });
}

function projectDir(name) {
  return path.join(PROJECTS_DIR, name, '.claude');
}

function initProjectComponents() { return {}; }

// ─── File Utils ───────────────────────────────────────────────────────────────

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// Copy root ECC files (AGENTS.md, agent.yaml) into a .claude/ dir, skip if already present.
// Returns the array of basenames that were freshly copied (so callers can record
// metadata such as "this AGENTS.md is currently the unmodified ECC default").
const ECC_ROOT_FILES = ['AGENTS.md', 'agent.yaml'];
function copyEccRootFiles(vDir, claudeDir) {
  const copied = [];
  ECC_ROOT_FILES.forEach(f => {
    const src  = path.join(vDir, f);
    const dest = path.join(claudeDir, f);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      ensureDir(claudeDir);
      fs.copyFileSync(src, dest);
      log('info', `copied ${f} → ${dest}`);
      copied.push(f);
    }
  });
  return copied;
}

// ─── Managed agent docs (CLAUDE.md, AGENTS.md) ────────────────────────────────
//
// Generalizes the original CLAUDE.md workflow. A managed doc is a top-level
// file inside the managed project's .claude/ directory that can be edited
// manually, replaced with the ECC version's default copy, and rolled back via
// timestamped backups. Each docKey maps to one filename and one slot under
// proj.managedDocs[docKey].

// Top-level managed docs in a project's .claude/ directory. SKILLS.md is
// intentionally NOT here: there is no real top-level SKILLS.md convention.
// The skill artifact is `.claude/skills/<skill-name>/SKILL.md`, which is
// surfaced via the shared library's `skill` docKey, not as a managed doc.
const MANAGED_DOCS = {
  claude: { fileName: 'CLAUDE.md', stateKey: 'claude', legacyStateKey: 'claudeMd', label: 'CLAUDE.md' },
  agents: { fileName: 'AGENTS.md', stateKey: 'agents', label: 'AGENTS.md' },
};
const MANAGED_DOC_KEYS = Object.keys(MANAGED_DOCS);

function getManagedDocConfig(docKey) {
  if (typeof docKey !== 'string') return null;
  return MANAGED_DOCS[docKey] || null;
}

function getProjectManagedDocPath(projName, docKey) {
  const cfg = getManagedDocConfig(docKey);
  if (!cfg) return null;
  return path.join(projectDir(projName), cfg.fileName);
}

function backupNamePattern(docKey) {
  const cfg = getManagedDocConfig(docKey);
  if (!cfg) return null;
  const escaped = cfg.fileName.replace(/\./g, '\\.');
  // Match either the plain timestamp form or the collision-suffixed form
  // produced by `uniqueBackupName` (e.g. "CLAUDE.md.20260505T120000Z-2.bak").
  return new RegExp(`^${escaped}\\.\\d{8}T\\d{6}Z(?:-\\d+)?\\.bak$`);
}

function readProjectManagedDocMeta(proj, docKey) {
  if (!proj) return null;
  const cfg = getManagedDocConfig(docKey);
  if (!cfg) return null;
  const meta = proj.managedDocs && proj.managedDocs[cfg.stateKey];
  if (meta) return meta;
  if (cfg.legacyStateKey && proj[cfg.legacyStateKey]) return proj[cfg.legacyStateKey];
  return null;
}

function writeProjectManagedDocMeta(proj, docKey, meta) {
  const cfg = getManagedDocConfig(docKey);
  if (!cfg) return;
  if (!proj.managedDocs) proj.managedDocs = {};
  proj.managedDocs[cfg.stateKey] = { ...(proj.managedDocs[cfg.stateKey] || {}), ...meta };
  // Mirror to legacy slot for backward compatibility (claudeMd)
  if (cfg.legacyStateKey) {
    proj[cfg.legacyStateKey] = { ...(proj[cfg.legacyStateKey] || {}), ...meta };
  }
}

function getEccDefaultManagedDoc(proj, state, docKey) {
  const cfg = getManagedDocConfig(docKey);
  if (!cfg) return { available: false, verId: null, content: null, filePath: null };
  const { verId, vDir } = resolveVersion(proj, state);
  if (!verId || !vDir) return { available: false, verId: null, content: null, filePath: null };
  const defaultFile = path.join(vDir, cfg.fileName);
  if (!fs.existsSync(defaultFile)) return { available: false, verId, content: null, filePath: null };
  try {
    return { available: true, verId, content: fs.readFileSync(defaultFile, 'utf8'), filePath: cfg.fileName };
  } catch { return { available: false, verId, content: null, filePath: null }; }
}

function getManagedDocStatus(currentContent, eccDefault) {
  if (!eccDefault || !eccDefault.available) {
    if (currentContent === null) return 'missing';
    return 'no-default';
  }
  if (currentContent === null) return 'missing';
  if (currentContent === eccDefault.content) return 'matches-default';
  return 'customized';
}

// Build a backup filename like "<base>.<YYYYMMDDTHHmmssZ>.bak", appending a
// "-N" counter inside the basename when a backup with the same timestamp
// already exists so rapid successive backups never overwrite an earlier one.
// (The plan intentionally preserves backups indefinitely — collision = data
// loss, not a refresh.)
function uniqueBackupName(backupsDir, baseFileName) {
  const ts = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  let name = `${baseFileName}.${ts}.bak`;
  if (!fs.existsSync(path.join(backupsDir, name))) return name;
  for (let i = 2; i < 10000; i++) {
    const candidate = `${baseFileName}.${ts}-${i}.bak`;
    if (!fs.existsSync(path.join(backupsDir, candidate))) return candidate;
  }
  // Vanishingly unlikely fallback: include high-resolution suffix.
  return `${baseFileName}.${ts}-${process.hrtime.bigint().toString(36)}.bak`;
}

function backupProjectManagedDoc(projName, docKey) {
  const cfg = getManagedDocConfig(docKey);
  if (!cfg) return null;
  const fpath = getProjectManagedDocPath(projName, docKey);
  if (!fpath || !fs.existsSync(fpath)) return null;
  const backupsDir = path.join(projectDir(projName), '.backups');
  ensureDir(backupsDir);
  const backupName = uniqueBackupName(backupsDir, cfg.fileName);
  try {
    fs.copyFileSync(fpath, path.join(backupsDir, backupName));
  } catch (err) {
    log('error', `Failed to create ${cfg.fileName} backup for [${projName}]: ${err.message}`);
    throw err;
  }
  return path.join('.backups', backupName);
}

function listProjectManagedDocBackups(projName, docKey) {
  const cfg = getManagedDocConfig(docKey);
  if (!cfg) return [];
  const backupsDir = path.join(projectDir(projName), '.backups');
  if (!fs.existsSync(backupsDir)) return [];
  const prefix = `${cfg.fileName}.`;
  return fs.readdirSync(backupsDir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.bak'))
    .sort().reverse()
    .map(f => ({ name: f, relativePath: path.join('.backups', f) }));
}

// Legacy CLAUDE.md wrappers — keep stable API for existing tests/callers.

function getEccDefaultClaudeMd(proj, state) {
  return getEccDefaultManagedDoc(proj, state, 'claude');
}

function getClaudeMdStatus(currentContent, eccDefault) {
  if (!eccDefault || !eccDefault.available) return 'no-default';
  if (currentContent === null) return 'missing';
  if (currentContent === eccDefault.content) return 'matches-default';
  return 'customized';
}

function backupProjectClaudeMd(projName) {
  return backupProjectManagedDoc(projName, 'claude');
}

function listProjectClaudeMdBackups(projName) {
  return listProjectManagedDocBackups(projName, 'claude');
}

// Surface every backup file in `<project>/.claude/.backups/` regardless of
// origin so users (and the eventual UI) can see the deploy-time root-target
// snapshots and apply-time custom-component snapshots in one place. The
// per-doc managed-doc routes still serve the narrow filtered lists they
// always have — this generic list is additive.
function classifyBackupName(name) {
  for (const docKey of MANAGED_DOC_KEYS) {
    if (backupNamePattern(docKey).test(name)) return { kind: 'managed-doc', docKey };
  }
  if (/^settings\.json\.\d{8}T\d{6}Z(?:-\d+)?\.bak$/.test(name)) return { kind: 'settings-json' };
  // Deploy-time root snapshots flatten the path with `__` separators, so
  // "<dot-dir>__sub__file.md.<ts>.bak" is the recognisable shape. We also
  // catch apply-time backups (e.g. "foo.md.<ts>.bak") under the same kind
  // since they're recoverable the same way.
  if (/\.\d{8}T\d{6}Z(?:-\d+)?\.bak$/.test(name)) return { kind: 'apply-or-deploy' };
  return { kind: 'unknown' };
}

function listAllProjectBackups(projName) {
  const backupsDir = path.join(projectDir(projName), '.backups');
  if (!fs.existsSync(backupsDir)) return [];
  return fs.readdirSync(backupsDir)
    // Deploy-time root snapshots flatten paths like ".cursor/agents/foo.md"
    // into ".cursor__agents__foo.md.<ts>.bak", so the leading dot is part of
    // the meaningful filename — we only filter by the trailing .bak suffix.
    .filter(name => name.endsWith('.bak'))
    .sort().reverse()
    .map(name => {
      const full = path.join(backupsDir, name);
      let stat = null;
      try { stat = fs.statSync(full); } catch {}
      return {
        name,
        relativePath: path.join('.backups', name),
        size: stat ? stat.size : 0,
        mtime: stat ? stat.mtime.toISOString() : null,
        ...classifyBackupName(name),
      };
    });
}

// ─── Shared library: global markdown docs and custom components ───────────────
//
// `state/shared/` is global across projects. Two flavours live there:
//
//   state/shared/CLAUDE.md/<file>.md           → custom markdown doc templates
//   state/shared/AGENTS.md/<file>.md
//   state/shared/SKILLS.md/<file>.md
//   state/shared/custom-components/<kind>/<slug>/{component.json, content.md|json}
//
// These are not tied to any ECC version and never live in a project shard.
// Apply metadata (which custom component a project pulled in) DOES live in
// the project shard as `proj.customComponents`.

// Shared library doc kinds. The on-disk directory name usually matches the
// actual filename users will see/use:
//   - CLAUDE.md / AGENTS.md are project-root managed docs.
//   - `other` is the catch-all for arbitrary markdown templates (design.md,
//     architecture.md, roadmap.md, etc.) — not project-managed, just a
//     copy-paste library of markdown the user maintains across projects.
//
// Reusable per-skill SKILL.md templates live as `skills` custom components
// (state/shared/custom-components/skills/<slug>/) — the user-facing path
// remains skills/<slug>/SKILL.md when applied to a project. There is no
// separate `skill` shared-doc kind; clicking "Custom Skills" in the sidebar
// is the single entry point.
const SHARED_DOC_KIND_DIRS = {
  claude: 'CLAUDE.md',
  agents: 'AGENTS.md',
  'settings-local': 'settings.local.json',
  other:  'other',
};
const SHARED_DOC_KEYS = Object.keys(SHARED_DOC_KIND_DIRS);
const CUSTOM_COMPONENT_KINDS = ['rules', 'hooks', 'mcp', 'agents', 'skills', 'commands'];
const MARKDOWN_COMPONENT_KINDS = new Set(['rules', 'agents', 'skills', 'commands']);
const JSON_COMPONENT_KINDS = new Set(['hooks', 'mcp']);

function sharedDir() {
  return path.join(stateStore.stateDir(), 'shared');
}

function sharedDocDir(docKey) {
  const dirName = SHARED_DOC_KIND_DIRS[docKey];
  if (!dirName) return null;
  return path.join(sharedDir(), dirName);
}

function sharedComponentsRoot() {
  return path.join(sharedDir(), 'custom-components');
}

// One-shot migration from the legacy `state/shared/SKILL.md/<file>.md` layout
// into proper `skills` custom components at
// `state/shared/custom-components/skills/<slug>/{component.json, content.md}`.
//
// Why: earlier versions exposed "Custom SKILL.md" as a separate sidebar entry
// distinct from "Custom Skills". They've now been merged — Custom Skills is
// the single entry point. Any user content from the old location must survive
// the upgrade or it disappears from the UI without warning.
//
// Idempotent: skips files whose slug already exists as a custom skill, and
// short-circuits when no legacy directory is present. Runs at most once per
// process lifetime via `_legacySkillTemplatesMigrated`.
let _legacySkillTemplatesMigrated = false;
function migrateLegacySkillTemplates() {
  if (_legacySkillTemplatesMigrated) return;
  _legacySkillTemplatesMigrated = true;
  try {
    const legacyDir = path.join(sharedDir(), 'SKILL.md');
    if (!fs.existsSync(legacyDir)) return;
    const files = fs.readdirSync(legacyDir).filter(f => f.endsWith('.md') && !f.startsWith('.'));
    if (!files.length) return;
    let migrated = 0;
    for (const f of files) {
      const baseName = f.replace(/\.md$/i, '');
      const slug = safeSharedSlug(baseName);
      if (!slug) continue;
      // Don't clobber an existing custom skill of the same slug.
      if (fs.existsSync(path.join(sharedComponentsRoot(), 'skills', slug))) continue;
      const content = fs.readFileSync(path.join(legacyDir, f), 'utf8');
      const result = writeCustomComponent('skills', baseName, {
        name: baseName,
        description: 'Migrated from legacy Custom SKILL.md library',
        content,
      });
      if (result.ok) migrated++;
    }
    if (migrated > 0) log('info', `migrated ${migrated} legacy Custom SKILL.md template(s) to Custom Skills`);
  } catch (err) {
    log('warn', `legacy Custom SKILL.md migration failed: ${err.message}`);
  }
}

function sharedComponentKindDir(kind) {
  if (!CUSTOM_COMPONENT_KINDS.includes(kind)) return null;
  if (kind === 'skills') migrateLegacySkillTemplates();
  return path.join(sharedComponentsRoot(), kind);
}

function sharedComponentEntryDir(kind, slug) {
  const base = sharedComponentKindDir(kind);
  if (!base) return null;
  if (!safeSharedSlugPattern(slug)) return null;
  return path.join(base, slug);
}

// Validate-only check that a slug matches the on-disk pattern. Used in route
// handlers where the slug arrives over the wire and must be paranoid-safe.
function safeSharedSlugPattern(slug) {
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(slug) && !slug.includes('..');
}

// Convert a user-supplied display name into a deterministic on-disk slug.
// Empty result is rejected by the caller — we return null instead of throwing
// so route handlers can return a clean 400.
function safeSharedSlug(name) {
  if (typeof name !== 'string') return null;
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return null;
  if (!safeSharedSlugPattern(slug)) return null;
  return slug;
}

// Sanitize a user-supplied filename for shared markdown docs. Empty input,
// path-traversal, and absolute paths are rejected.
function safeSharedFileName(name) {
  if (typeof name !== 'string') return null;
  let trimmed = name.trim();
  if (!trimmed) return null;
  // Strip a trailing .md if present so we control the final extension.
  trimmed = trimmed.replace(/\.md$/i, '');
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return null;
  return `${slug}.md`;
}

// Defensive containment check: reject any operation whose resolved path
// escapes its declared base directory.
function assertPathInside(base, target) {
  const baseAbs = path.resolve(base);
  const targetAbs = path.resolve(target);
  const rel = path.relative(baseAbs, targetAbs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw Object.assign(new Error('Path escape detected'), { code: 'PATH_ESCAPE' });
  }
}

// Shared-doc storage layout (post-id refactor):
//
//   state/shared/<docKey>/<id>/meta.json    { id, name, description, createdAt, updatedAt }
//   state/shared/<docKey>/<id>/content.md   the markdown body
//
// Identity is the opaque `id` (8-hex random), NOT the user-supplied `name`.
// Two entries can therefore have the same display name with different
// descriptions (e.g. two design.md drafts annotated "v1 strict scope" and
// "v2 with auth"). The previous slug-as-filename scheme couldn't express
// that — names had to be unique.

const SHARED_DOC_ID_RE = /^[a-f0-9]{8}$/;

function generateSharedDocId() {
  const crypto = require('crypto');
  return crypto.randomBytes(4).toString('hex');
}

function sharedDocEntryDir(docKey, id) {
  if (!SHARED_DOC_ID_RE.test(id)) return null;
  const dir = sharedDocDir(docKey);
  if (!dir) return null;
  return path.join(dir, id);
}

// One-shot migration from the legacy `state/shared/<docKey>/<slug>.md`
// layout to the new id-based dir layout. Runs idempotently on every
// listSharedDocs / read* call so on-disk state always presents in the new
// shape regardless of when the user first opens the library.
//
// Each legacy *.md becomes a `<id>/` dir with name = filename minus .md,
// empty description, and createdAt = updatedAt = now (file mtime would be
// more accurate but the millisecond-level precision isn't worth a stat).
function migrateLegacySharedDocs(docKey) {
  const dir = sharedDocDir(docKey);
  if (!dir || !fs.existsSync(dir)) return;
  let migrated = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md') || f.startsWith('.')) continue;
    const full = path.join(dir, f);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    const name = f.replace(/\.md$/i, '');
    const id = generateSharedDocId();
    const entryDir = path.join(dir, id);
    if (fs.existsSync(entryDir)) continue; // collision — leave file alone
    try {
      const content = fs.readFileSync(full, 'utf8');
      ensureDir(entryDir);
      const now = new Date().toISOString();
      fs.writeFileSync(path.join(entryDir, 'meta.json'), JSON.stringify({
        id, name, description: '', createdAt: now, updatedAt: now,
      }, null, 2), 'utf8');
      fs.writeFileSync(path.join(entryDir, 'content.md'), content, 'utf8');
      fs.unlinkSync(full);
      migrated++;
    } catch (err) {
      log('warn', `legacy shared-doc migration failed for ${docKey}/${f}: ${err.message}`);
    }
  }
  if (migrated) log('info', `migrated ${migrated} legacy ${docKey} doc(s) to id-based layout`);
}

function listSharedDocs(docKey) {
  migrateLegacySharedDocs(docKey);
  const dir = sharedDocDir(docKey);
  if (!dir || !fs.existsSync(dir)) return [];
  const items = [];
  for (const id of fs.readdirSync(dir)) {
    if (!SHARED_DOC_ID_RE.test(id)) continue;
    const it = readSharedDocMeta(docKey, id);
    if (it) items.push(it);
  }
  // Sort by name first, then createdAt — duplicates with the same display
  // name still surface in a stable order.
  items.sort((a, b) => (a.name || '').localeCompare(b.name || '') || (a.createdAt || '').localeCompare(b.createdAt || ''));
  return items;
}

// Lighter read used by listSharedDocs that skips loading content.md so a big
// library of long markdown templates doesn't pull every body into memory
// just to render the sidebar list.
function readSharedDocMeta(docKey, id) {
  const entryDir = sharedDocEntryDir(docKey, id);
  if (!entryDir || !fs.existsSync(entryDir)) return null;
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(entryDir, 'meta.json'), 'utf8')); }
  catch { return null; }
  return {
    id: meta.id || id,
    name: meta.name || '',
    description: meta.description || '',
    createdAt: meta.createdAt || null,
    updatedAt: meta.updatedAt || null,
  };
}

function readSharedDoc(docKey, id) {
  migrateLegacySharedDocs(docKey);
  const entryDir = sharedDocEntryDir(docKey, id);
  if (!entryDir || !fs.existsSync(entryDir)) return null;
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(entryDir, 'meta.json'), 'utf8')); }
  catch { return null; }
  let content = '';
  try { content = fs.readFileSync(path.join(entryDir, 'content.md'), 'utf8'); } catch {}
  return {
    id: meta.id || id,
    name: meta.name || '',
    description: meta.description || '',
    content,
    createdAt: meta.createdAt || null,
    updatedAt: meta.updatedAt || null,
  };
}

function writeSharedDoc(docKey, payload) {
  const dir = sharedDocDir(docKey);
  if (!dir) return { ok: false, error: 'Unknown docKey' };
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  if (!name) return { ok: false, error: 'Name required' };
  ensureDir(dir);
  // Try a few times in case of an unbelievably bad random collision. 8 hex
  // chars = 32 bits, so birthday collisions only become realistic past ~65k
  // entries — but the loop is cheap and bounds an otherwise theoretical bug.
  let id = null;
  for (let i = 0; i < 8; i++) {
    const candidate = generateSharedDocId();
    if (!fs.existsSync(path.join(dir, candidate))) { id = candidate; break; }
  }
  if (!id) return { ok: false, error: 'Failed to allocate a unique id' };
  const entryDir = path.join(dir, id);
  ensureDir(entryDir);
  const now = new Date().toISOString();
  const meta = {
    id,
    name,
    description: typeof payload.description === 'string' ? payload.description : '',
    createdAt: now,
    updatedAt: now,
  };
  fs.writeFileSync(path.join(entryDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  fs.writeFileSync(path.join(entryDir, 'content.md'), typeof payload.content === 'string' ? payload.content : '', 'utf8');
  return { ok: true, id };
}

function updateSharedDoc(docKey, id, payload) {
  const existing = readSharedDoc(docKey, id);
  if (!existing) return { ok: false, error: 'Not found' };
  const entryDir = sharedDocEntryDir(docKey, id);
  const nextName = typeof payload.name === 'string' ? payload.name.trim() : existing.name;
  if (!nextName) return { ok: false, error: 'Name required' };
  const now = new Date().toISOString();
  const meta = {
    id,
    name: nextName,
    description: typeof payload.description === 'string' ? payload.description : existing.description,
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
  fs.writeFileSync(path.join(entryDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  if (typeof payload.content === 'string') {
    fs.writeFileSync(path.join(entryDir, 'content.md'), payload.content, 'utf8');
  }
  return { ok: true };
}

function deleteSharedDoc(docKey, id) {
  const entryDir = sharedDocEntryDir(docKey, id);
  if (!entryDir || !fs.existsSync(entryDir)) return false;
  fs.rmSync(entryDir, { recursive: true, force: true });
  return true;
}

function customComponentId(kind, slug) {
  return `custom-${kind}-${slug}`;
}

// Substitute `<slug>` placeholders inside a folder/file template with the
// real on-disk slug. The frontend create modal seeds inputs with `<slug>`
// before the user has typed a name; if they save without editing those
// fields, we'd otherwise persist the literal `<slug>` and write
// `rules/custom/<slug>.md` to disk on apply.
//
// The substitution is intentionally global (replace-all) so a user could
// reasonably write `skills/<slug>/<slug>.md` and have both occurrences
// resolved. It's a no-op when no placeholder is present.
function resolveSlugPlaceholders(value, slug) {
  if (typeof value !== 'string' || !value) return value;
  return value.replace(/<slug>/g, slug);
}

function defaultTargetForCustom(kind, slug) {
  if (kind === 'rules')    return { folder: 'rules/custom', file: `${slug}.md` };
  if (kind === 'agents')   return { folder: 'agents',       file: `${slug}.md` };
  if (kind === 'skills')   return { folder: `skills/${slug}`, file: 'SKILL.md' };
  if (kind === 'commands') return { folder: 'commands',     file: `${slug}.md` };
  if (kind === 'hooks')    return { folder: '',             file: 'settings.json' };
  if (kind === 'mcp')      return { folder: '',             file: 'settings.json' };
  return null;
}

function listCustomComponents(kind) {
  const dir = sharedComponentKindDir(kind);
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(d => safeSharedSlugPattern(d))
    .sort()
    .map(slug => readCustomComponent(kind, slug))
    .filter(Boolean);
}

function readCustomComponent(kind, slug) {
  const dir = sharedComponentEntryDir(kind, slug);
  if (!dir || !fs.existsSync(dir)) return null;
  const metaPath = path.join(dir, 'component.json');
  if (!fs.existsSync(metaPath)) return null;
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return null; }
  const contentFile = meta.contentFile || (MARKDOWN_COMPONENT_KINDS.has(kind) ? 'content.md' : 'content.json');
  const contentPath = path.join(dir, contentFile);
  let content = '';
  if (fs.existsSync(contentPath)) {
    content = fs.readFileSync(contentPath, 'utf8');
  }
  // Resolve any leftover `<slug>` placeholders from older entries that were
  // saved before the write-time normalization landed. Reads always return
  // realized paths so the UI never shows a literal `<slug>` again.
  const folder = resolveSlugPlaceholders(meta.defaultTargetFolder || (defaultTargetForCustom(kind, slug)?.folder ?? ''), slug);
  const file   = resolveSlugPlaceholders(meta.defaultFileName     || (defaultTargetForCustom(kind, slug)?.file   ?? ''), slug);
  return {
    id: meta.id || customComponentId(kind, slug),
    kind,
    slug,
    name: meta.name || slug,
    description: meta.description || '',
    defaultTargetFolder: folder,
    defaultFileName:     file,
    contentFile,
    content,
    createdAt: meta.createdAt || null,
    updatedAt: meta.updatedAt || null,
  };
}

// `validateCustomComponentContent` parses JSON-flavoured kinds early so we
// reject malformed payloads with a 400 instead of writing corrupt files to
// disk and only finding out at apply time.
function validateCustomComponentContent(kind, content) {
  if (MARKDOWN_COMPONENT_KINDS.has(kind)) {
    if (typeof content !== 'string') return { ok: false, error: 'Markdown content must be a string' };
    return { ok: true };
  }
  if (JSON_COMPONENT_KINDS.has(kind)) {
    if (typeof content !== 'string' || !content.trim()) return { ok: false, error: 'JSON content required' };
    let parsed;
    try { parsed = JSON.parse(content); }
    catch { return { ok: false, error: 'Invalid JSON' }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'JSON must be an object' };
    return { ok: true, parsed };
  }
  return { ok: false, error: 'Unknown component kind' };
}

function writeCustomComponent(kind, name, payload) {
  if (!CUSTOM_COMPONENT_KINDS.includes(kind)) return { ok: false, error: 'Unknown component kind' };
  const slug = safeSharedSlug(name);
  if (!slug) return { ok: false, error: 'Invalid name' };
  const content = typeof payload.content === 'string' ? payload.content : '';
  const valid = validateCustomComponentContent(kind, content);
  if (!valid.ok) return valid;
  const dir = sharedComponentEntryDir(kind, slug);
  if (fs.existsSync(dir)) return { ok: false, error: 'Component with this name already exists' };
  ensureDir(dir);
  const now = new Date().toISOString();
  const defaults = defaultTargetForCustom(kind, slug);
  const contentFile = MARKDOWN_COMPONENT_KINDS.has(kind) ? 'content.md' : 'content.json';
  const rawFolder = typeof payload.defaultTargetFolder === 'string' ? payload.defaultTargetFolder : (defaults?.folder ?? '');
  const rawFile   = typeof payload.defaultFileName     === 'string' ? payload.defaultFileName     : (defaults?.file   ?? '');
  const meta = {
    id: customComponentId(kind, slug),
    kind,
    name: typeof payload.name === 'string' ? payload.name : name,
    description: typeof payload.description === 'string' ? payload.description : '',
    defaultTargetFolder: resolveSlugPlaceholders(rawFolder, slug),
    defaultFileName:     resolveSlugPlaceholders(rawFile,   slug),
    contentFile,
    createdAt: now,
    updatedAt: now,
  };
  fs.writeFileSync(path.join(dir, 'component.json'), JSON.stringify(meta, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, contentFile), content, 'utf8');
  return { ok: true, slug, id: meta.id };
}

function updateCustomComponent(kind, slug, payload) {
  if (!CUSTOM_COMPONENT_KINDS.includes(kind)) return { ok: false, error: 'Unknown component kind' };
  if (!safeSharedSlugPattern(slug)) return { ok: false, error: 'Invalid slug' };
  const existing = readCustomComponent(kind, slug);
  if (!existing) return { ok: false, error: 'Component not found' };
  const dir = sharedComponentEntryDir(kind, slug);
  const next = { ...existing };
  if (typeof payload.name === 'string') next.name = payload.name;
  if (typeof payload.description === 'string') next.description = payload.description;
  if (typeof payload.defaultTargetFolder === 'string') next.defaultTargetFolder = resolveSlugPlaceholders(payload.defaultTargetFolder, slug);
  if (typeof payload.defaultFileName === 'string')     next.defaultFileName     = resolveSlugPlaceholders(payload.defaultFileName, slug);
  let content = existing.content;
  if (typeof payload.content === 'string') {
    const valid = validateCustomComponentContent(kind, payload.content);
    if (!valid.ok) return valid;
    content = payload.content;
  }
  const now = new Date().toISOString();
  const meta = {
    id: existing.id,
    kind,
    name: next.name,
    description: next.description,
    defaultTargetFolder: next.defaultTargetFolder,
    defaultFileName: next.defaultFileName,
    contentFile: existing.contentFile,
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
  fs.writeFileSync(path.join(dir, 'component.json'), JSON.stringify(meta, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, existing.contentFile), content, 'utf8');
  return { ok: true };
}

function deleteCustomComponent(kind, slug) {
  if (!CUSTOM_COMPONENT_KINDS.includes(kind)) return { ok: false, error: 'Unknown component kind' };
  if (!safeSharedSlugPattern(slug)) return { ok: false, error: 'Invalid slug' };
  const dir = sharedComponentEntryDir(kind, slug);
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: 'Component not found' };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

// ─── Custom-component apply (project-side) ────────────────────────────────────
//
// Apply rules: write to the managed project's .claude/ directory, never the
// real deploy path (deploy still runs `copyRecursive` afterwards). Existing
// targets get a timestamped backup before being overwritten so users never
// silently lose hand-edited content.

// Return the canonical relative path inside `.claude/` for a custom component
// apply, given a user-overridable target folder + filename. Folder/file are
// trusted only after they've been re-sanitized here — callers may have
// inherited them from `defaultTargetForCustom` or from raw user input.
function resolveApplyTargetPath(kind, slug, override = {}) {
  const defaults = defaultTargetForCustom(kind, slug) || { folder: '', file: '' };
  // Defensive `<slug>` substitution. `writeCustomComponent` normalizes at
  // save time, but this also covers older entries persisted before that
  // normalization landed and any caller that hands us an unresolved override.
  const folderRaw = resolveSlugPlaceholders(override.targetFolder ?? defaults.folder, slug);
  const fileRaw   = resolveSlugPlaceholders(override.fileName     ?? defaults.file,   slug);
  const folder = sanitizeRelFolder(folderRaw);
  const file   = sanitizeRelFile(fileRaw);
  if (folder == null || file == null) return null;
  const rel = folder ? path.join(folder, file) : file;
  return rel;
}

// Project-root deploy detection.
//
// The managed project's `.claude/` directory is the staging area. When the
// user picks a target whose first path segment is a *known agent/tool config
// root* — `.cursor`, `.codex`, `.gemini`, `.opencode`, `.agents`, etc. —
// that's a sibling-of-`.claude` config dir, not something Claude Code itself
// reads. Deploy relocates it from `<deployPath>/.claude/<rel>` to
// `<deployPath>/<rel>` so the host tool sees it.
//
// Allowlist instead of denylist: blindly relocating *any* hidden dir would
// happily push files into `.git/hooks/`, `.ssh/`, `.env*`, `.docker/`,
// `.aws/`, etc. Most of those are sensitive or actively dangerous.
//
// Keep this set in sync with `PLATFORM_LEAF_META` plus any well-known
// coding-agent dot-dirs that an ECC user would reasonably want to author
// custom components for. New entries should be reviewed for write-safety
// (config-only, not credentials) before being added.
const PROJECT_ROOT_DEPLOY_DIRS = new Set([
  '.agents',         // universal AGENTS.md / multi-agent context dir
  '.claude-plugin',  // Claude Code plugin manifest
  '.codex',          // OpenAI Codex
  '.continue',       // Continue
  '.cursor',         // Cursor IDE
  '.gemini',         // Google Gemini CLI
  '.opencode',       // OpenCode
  '.windsurf',       // Windsurf
  '.zed',            // Zed
]);

function isProjectRootDeployTarget(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  const firstSegment = rel.split(/[\\/]/)[0];
  return PROJECT_ROOT_DEPLOY_DIRS.has(firstSegment);
}

function sanitizeRelFolder(input) {
  if (input == null) return '';
  const s = String(input).trim();
  if (!s) return '';
  if (path.isAbsolute(s)) return null;
  if (s.split(/[\\/]/).some(seg => seg === '..' || seg === '.')) return null;
  // Normalize separators
  return s.replace(/\\/g, '/').replace(/\/+$/, '');
}

function sanitizeRelFile(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;
  if (s.includes('/') || s.includes('\\')) return null;
  if (s === '..' || s === '.') return null;
  return s;
}

function detectApplyCollision(projName, relPath, proj) {
  const dest = path.join(projectDir(projName), relPath);
  const result = { exists: false, source: null };
  if (fs.existsSync(dest)) {
    result.exists = true;
    result.source = 'manual';
  }
  // ECC-installed components claim the same .claude/<sourcePath>
  for (const [id, entry] of Object.entries(proj.components || {})) {
    if (!entry || !entry.installed) continue;
    if (entry.sourcePath && entry.sourcePath === relPath) {
      result.exists = true;
      result.source = `ecc:${id}`;
      return result;
    }
  }
  // Other custom components already applied to the same target
  for (const [id, entry] of Object.entries(proj.customComponents || {})) {
    if (entry && entry.targetPath && entry.targetPath === relPath) {
      result.exists = true;
      result.source = `custom:${id}`;
      return result;
    }
  }
  // Project-root targets ALSO collide with anything already at the final
  // deploy destination. Without this check, a user can safely "apply" to
  // .cursor/agents/foo.md (no staging-side conflict) and then auto-deploy
  // silently overwrites a hand-edited file at <deployPath>/.cursor/agents/foo.md.
  // We only run this when deployPath is a real absolute path — the staging
  // file alone is not authoritative for these dot-dir tools.
  if (!result.exists && isProjectRootDeployTarget(relPath) && proj.deployPath && path.isAbsolute(proj.deployPath)) {
    const finalDest = path.join(proj.deployPath, relPath);
    if (fs.existsSync(finalDest)) {
      result.exists = true;
      result.source = `project-root-file:${relPath}`;
    }
  }
  return result;
}

// Build a deterministic SHA-256 hash for a hook entry. Recursive key sorting
// + LF normalization makes equality robust across object spread reorderings
// and CRLF line endings copy-pasted from Windows config snippets.
function canonicalJson(value) {
  const crypto = require('crypto');
  function canon(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v.replace(/\r\n/g, '\n');
    if (typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(canon);
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) continue;
      out[k] = canon(v[k]);
    }
    return out;
  }
  return JSON.stringify(canon(value));
  // crypto referenced lazily so callers that never invoke this don't pull it in
  // (it's still required wherever hashHookEntry is called).
}

function hashHookEntry(entry) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(canonicalJson(entry)).digest('hex').slice(0, 16);
}

function applyMarkdownComponent(projName, kind, slug, override) {
  const comp = readCustomComponent(kind, slug);
  if (!comp) return { ok: false, error: 'Component not found' };
  if (!MARKDOWN_COMPONENT_KINDS.has(kind)) return { ok: false, error: 'Not a markdown component' };
  const state = loadState();
  const proj = state.projects[projName];
  if (!proj) return { ok: false, error: 'Project not found' };
  const rel = resolveApplyTargetPath(kind, slug, override);
  if (!rel) return { ok: false, error: 'Invalid target path' };
  const dest = path.join(projectDir(projName), rel);
  // Guard: dest must stay inside the managed project's .claude/ staging dir.
  // Even root-level deploy targets (.cursor/, .agents/, etc.) live under
  // .claude/<rel> at apply time — deploy relocates them later.
  try { assertPathInside(projectDir(projName), dest); }
  catch { return { ok: false, error: 'Target escapes project directory' }; }

  const collision = detectApplyCollision(projName, rel, proj);
  if (collision.exists && override.overwrite !== true) {
    return { ok: false, collision: true, conflictSource: collision.source, targetPath: rel };
  }

  // The apply modal lets users type any path. If they aim at a path whose
  // current entry on disk is a directory (e.g. an existing skill directory),
  // refuse cleanly — `writeFileSync` would otherwise throw EISDIR mid-apply
  // and leave the user with a half-applied state. Directory replacement is
  // out of scope for this iteration; the user can pick a different target
  // or remove the directory by hand.
  if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) {
    return { ok: false, error: 'Target path is an existing directory; pick a different file name', targetPath: rel };
  }

  // Backup existing file before overwrite so the user can roll back. Skills
  // commonly target a directory — when the file inside that directory exists,
  // we back up that inner file.
  let backupPath = null;
  if (fs.existsSync(dest) && fs.statSync(dest).isFile()) {
    const backupsDir = path.join(projectDir(projName), '.backups');
    ensureDir(backupsDir);
    const bak = uniqueBackupName(backupsDir, path.basename(dest));
    fs.copyFileSync(dest, path.join(backupsDir, bak));
    backupPath = path.join('.backups', bak);
  }

  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, comp.content, 'utf8');

  const deployRoot = isProjectRootDeployTarget(rel) ? 'project' : 'claude';

  if (!proj.customComponents) proj.customComponents = {};
  proj.customComponents[comp.id] = {
    kind,
    sourceId: comp.id,
    sourceUpdatedAt: comp.updatedAt,
    targetPath: rel,
    deployRoot,
    appliedAt: new Date().toISOString(),
    ...(backupPath ? { lastBackupPath: backupPath } : {}),
  };
  saveState(state);
  return { ok: true, targetPath: rel, deployRoot, backupPath };
}

// Walk `srcPath` (the file or directory being relocated to the deploy root)
// and back up any pre-existing files at the corresponding `destPath` into
// `stagingBackupsDir`. Returns `{ created, failed }` so callers can abort if
// any required snapshot could not be made — silently swallowing copy errors
// would let an overwrite proceed without a recovery path.
//
// This is defense in depth on top of `detectApplyCollision`: apply-time
// guards against known collisions, but the user might still hand-edit a file
// at `<deployPath>/.cursor/foo.md` between apply and deploy. Without this
// walk, deploy would clobber that edit without any way to recover.
function backupDeployTargets(srcPath, destPath, stagingBackupsDir, baseRelForName) {
  const created = [];
  const failed  = [];
  if (!fs.existsSync(srcPath)) return { created, failed };

  // Upfront ancestor preflight. The recursive walk catches dir-vs-non-dir
  // conflicts only when it descends — a single-file rel like
  // ".cursor/agents/foo.md" never recurses, so a non-directory at *any*
  // ancestor of destPath ("`.cursor/agents`" already exists as a file) would
  // slip past and crash `copyRecursive` mid-loop in pass 2 with ENOTDIR.
  // Walk every ancestor up to root and stop at the first existing one: if
  // it's a directory, the rest of the chain is fine; if not, that's the
  // conflict we have to surface.
  {
    let cur = path.dirname(destPath);
    while (cur && cur !== path.dirname(cur)) {
      if (fs.existsSync(cur)) {
        let st;
        try { st = fs.statSync(cur); }
        catch (err) {
          failed.push({ src: cur, error: `stat: ${err.message}` });
          return { created, failed };
        }
        if (!st.isDirectory()) {
          failed.push({
            src: cur,
            error: `type conflict: ancestor "${cur}" is a ${st.isFile() ? 'file' : 'special node'} but a directory is required to write ${destPath}`,
          });
          return { created, failed };
        }
        break;
      }
      cur = path.dirname(cur);
    }
  }

  function walk(srcAbs, destAbs, relForName) {
    let stat;
    try { stat = fs.statSync(srcAbs); } catch { return; }

    if (stat.isDirectory()) {
      // Type-conflict guard: we want to copy a directory into destAbs but
      // there's a non-directory there already. `copyRecursive` would later
      // try to mkdir on top of the file (or copy children into a path that
      // is a file), which throws partway through and leaves the deploy in
      // a half-applied state. Surface as `failed` so the abort gate fires.
      if (fs.existsSync(destAbs)) {
        let destStat;
        try { destStat = fs.statSync(destAbs); }
        catch (err) { failed.push({ src: destAbs, error: `stat: ${err.message}` }); return; }
        if (!destStat.isDirectory()) {
          failed.push({
            src: destAbs,
            error: `type conflict: source is a directory but destination is a ${destStat.isFile() ? 'file' : 'special node'}`,
          });
          return;
        }
      }
      let entries;
      try { entries = fs.readdirSync(srcAbs); }
      catch (err) { failed.push({ src: srcAbs, error: `readdir: ${err.message}` }); return; }
      for (const e of entries) walk(path.join(srcAbs, e), path.join(destAbs, e), path.join(relForName, e));
      return;
    }

    // src is a file. If destAbs doesn't exist, nothing to back up.
    if (!fs.existsSync(destAbs)) return;
    let destStat;
    try { destStat = fs.statSync(destAbs); }
    catch (err) { failed.push({ src: destAbs, error: `stat: ${err.message}` }); return; }

    if (destStat.isDirectory()) {
      // Type-conflict guard: we want to write a file but a directory is in
      // the way. `fs.copyFileSync` would throw EISDIR. Refuse before any
      // overwrite happens elsewhere.
      failed.push({
        src: destAbs,
        error: 'type conflict: source is a file but destination is a directory',
      });
      return;
    }
    if (!destStat.isFile()) return;

    // Dest is an existing file → snapshot before overwrite.
    try { ensureDir(stagingBackupsDir); }
    catch (err) {
      failed.push({ src: destAbs, error: `mkdir: ${err.message}` });
      return;
    }
    // Flatten the relative path into the backup basename so multiple files
    // from one relocation can coexist in the flat .backups/ dir.
    const safeBase = relForName.replace(/[\\/]/g, '__');
    const bak = uniqueBackupName(stagingBackupsDir, safeBase);
    try {
      fs.copyFileSync(destAbs, path.join(stagingBackupsDir, bak));
      created.push({ name: bak, sourcePath: destAbs, deployRel: relForName });
    } catch (err) {
      log('error', `deploy: failed to back up ${destAbs} → ${bak}: ${err.message}`);
      failed.push({ src: destAbs, dest: bak, error: err.message });
    }
  }
  walk(srcPath, destPath, baseRelForName);
  return { created, failed };
}

function backupSettingsJson(projName) {
  const settingsPath = path.join(projectDir(projName), 'settings.json');
  if (!fs.existsSync(settingsPath)) return null;
  const backupsDir = path.join(projectDir(projName), '.backups');
  ensureDir(backupsDir);
  const bak = uniqueBackupName(backupsDir, 'settings.json');
  fs.copyFileSync(settingsPath, path.join(backupsDir, bak));
  return path.join('.backups', bak);
}

// `conflictMode` controls what happens when an incoming entry collides with
// an existing one of the same id (hooks) or server name (mcp). The default
// `detect` records the conflict but does not mutate so the caller can prompt
// the user. `replace` overwrites in place. `append-as-new` keeps the existing
// entry and adds the new one alongside (with a derived id when needed so the
// new entry stays addressable). `skip` is a no-op for that conflict.
const VALID_CONFLICT_MODES = new Set(['detect', 'replace', 'append-as-new', 'skip']);

function appendUniqueIdSuffix(baseId, takenIds) {
  // Generate "<base>-2", "<base>-3", … so future remove/update operations can
  // address the appended entry distinctly from its sibling.
  let i = 2;
  while (takenIds.has(`${baseId}-${i}`)) i++;
  return `${baseId}-${i}`;
}

function mergeHooksPayload(existing, payload, conflictMode = 'detect') {
  // Accept two shapes:
  //   { hooks: { <eventName>: [ ...entries ] } }
  //   { event: '<eventName>', entry: { ... } }
  if (!VALID_CONFLICT_MODES.has(conflictMode)) conflictMode = 'detect';
  let normalized = {};
  if (payload && typeof payload === 'object') {
    if (payload.hooks && typeof payload.hooks === 'object') {
      for (const [evt, entries] of Object.entries(payload.hooks)) {
        normalized[evt] = Array.isArray(entries) ? entries : [];
      }
    } else if (payload.event && payload.entry && typeof payload.entry === 'object') {
      normalized[payload.event] = [payload.entry];
    }
  }
  const out = JSON.parse(JSON.stringify(existing && typeof existing === 'object' ? existing : {}));
  if (!out.hooks || typeof out.hooks !== 'object') out.hooks = {};
  const conflicts = [];
  let appended = 0;
  let skipped = 0;
  let replaced = 0;
  for (const [evt, newEntries] of Object.entries(normalized)) {
    if (!Array.isArray(out.hooks[evt])) out.hooks[evt] = [];
    for (const entry of newEntries) {
      if (!entry || typeof entry !== 'object') continue;
      const existingArr = out.hooks[evt];
      // Match by id when present; otherwise by content hash
      const newId   = entry.id || null;
      const newHash = hashHookEntry(entry);
      const matchIdx = existingArr.findIndex(e => {
        if (!e || typeof e !== 'object') return false;
        if (newId && e.id === newId) return true;
        if (!newId && hashHookEntry(e) === newHash) return true;
        return false;
      });
      if (matchIdx === -1) {
        existingArr.push(entry);
        appended++;
        continue;
      }
      const existingEntry = existingArr[matchIdx];
      if (hashHookEntry(existingEntry) === newHash) {
        skipped++;
        continue;
      }
      // Collision with different content — apply the requested resolution.
      if (conflictMode === 'replace') {
        existingArr[matchIdx] = entry;
        replaced++;
      } else if (conflictMode === 'append-as-new') {
        let appendEntry = entry;
        if (newId) {
          const taken = new Set(existingArr.map(e => e && e.id).filter(Boolean));
          appendEntry = { ...entry, id: appendUniqueIdSuffix(newId, taken) };
        }
        existingArr.push(appendEntry);
        appended++;
      } else if (conflictMode === 'skip') {
        skipped++;
      } else {
        conflicts.push({ event: evt, id: newId, index: matchIdx });
      }
    }
  }
  return { merged: out, conflicts, appended, skipped, replaced };
}

function mergeMcpPayload(existing, payload, conflictMode = 'detect') {
  if (!VALID_CONFLICT_MODES.has(conflictMode)) conflictMode = 'detect';
  let normalized = {};
  if (payload && typeof payload === 'object') {
    if (payload.mcpServers && typeof payload.mcpServers === 'object') {
      normalized = { ...payload.mcpServers };
    } else if (payload.mcp && payload.mcp.servers && typeof payload.mcp.servers === 'object') {
      normalized = { ...payload.mcp.servers };
    }
  }
  const out = JSON.parse(JSON.stringify(existing && typeof existing === 'object' ? existing : {}));
  if (!out.mcpServers || typeof out.mcpServers !== 'object') out.mcpServers = {};
  const conflicts = [];
  let added = 0;
  let skipped = 0;
  let replaced = 0;
  for (const [serverName, config] of Object.entries(normalized)) {
    if (!config || typeof config !== 'object') continue;
    const existingCfg = out.mcpServers[serverName];
    if (!existingCfg) {
      out.mcpServers[serverName] = config;
      added++;
      continue;
    }
    if (canonicalJson(existingCfg) === canonicalJson(config)) {
      skipped++;
      continue;
    }
    if (conflictMode === 'replace') {
      out.mcpServers[serverName] = config;
      replaced++;
    } else if (conflictMode === 'append-as-new') {
      // Servers are keyed by name. Pick the next free "<name>-N" key so the
      // new server is addressable alongside the original.
      const taken = new Set(Object.keys(out.mcpServers));
      const newKey = appendUniqueIdSuffix(serverName, taken);
      out.mcpServers[newKey] = config;
      added++;
    } else if (conflictMode === 'skip') {
      skipped++;
    } else {
      conflicts.push({ serverName });
    }
  }
  return { merged: out, conflicts, added, skipped, replaced };
}

function applyJsonComponent(projName, kind, slug, override) {
  const comp = readCustomComponent(kind, slug);
  if (!comp) return { ok: false, error: 'Component not found' };
  if (!JSON_COMPONENT_KINDS.has(kind)) return { ok: false, error: 'Not a JSON component' };
  const state = loadState();
  const proj = state.projects[projName];
  if (!proj) return { ok: false, error: 'Project not found' };
  let payload;
  try { payload = JSON.parse(comp.content); }
  catch { return { ok: false, error: 'Component content is not valid JSON' }; }
  const settingsPath = path.join(projectDir(projName), 'settings.json');
  let existing = {};
  if (fs.existsSync(settingsPath)) {
    try { existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
    catch {
      if (override.overwrite !== true) {
        return { ok: false, error: 'Existing settings.json is invalid JSON', requiresOverwrite: true };
      }
      existing = {};
    }
  }
  // First pass in detect mode so we can short-circuit when the user hasn't
  // approved a resolution. Then re-merge with the chosen mode so the merged
  // document actually reflects replace / append-as-new before we write it.
  const detectMerge = (kind === 'hooks')
    ? mergeHooksPayload(existing, payload, 'detect')
    : mergeMcpPayload(existing, payload, 'detect');

  if (detectMerge.conflicts.length && override.conflictMode !== 'replace' && override.conflictMode !== 'append-as-new' && override.conflictMode !== 'skip') {
    return { ok: false, conflicts: detectMerge.conflicts, requiresConflictResolution: true };
  }

  const resolutionMode = detectMerge.conflicts.length ? override.conflictMode : 'detect';
  const merge = (kind === 'hooks')
    ? mergeHooksPayload(existing, payload, resolutionMode)
    : mergeMcpPayload(existing, payload, resolutionMode);

  const changeCount = (merge.added || 0) + (merge.appended || 0) + (merge.replaced || 0);
  const mergeSummary = {
    added: merge.added || 0,
    appended: merge.appended || 0,
    replaced: merge.replaced || 0,
    skipped: merge.skipped || 0,
    conflicts: merge.conflicts,
  };

  // No-op short-circuit: if nothing was added, appended, or replaced, the
  // resulting JSON is identical to what's already on disk. Don't backup, don't
  // rewrite the file, and don't claim the custom component is "applied" —
  // that would mislead the user when (e.g.) they picked Skip on every conflict
  // or re-applied a component whose entries already exist verbatim.
  if (changeCount === 0) {
    return {
      ok: true,
      noop: true,
      targetPath: 'settings.json',
      backupPath: null,
      merge: mergeSummary,
    };
  }

  const backupPath = backupSettingsJson(projName);
  ensureDir(projectDir(projName));
  if (!merge.merged.$schema) merge.merged.$schema = 'https://json.schemastore.org/claude-code-settings.json';
  fs.writeFileSync(settingsPath, JSON.stringify(merge.merged, null, 2), 'utf8');
  if (!proj.customComponents) proj.customComponents = {};
  proj.customComponents[comp.id] = {
    kind,
    sourceId: comp.id,
    sourceUpdatedAt: comp.updatedAt,
    targetPath: 'settings.json',
    appliedAt: new Date().toISOString(),
    ...(backupPath ? { lastBackupPath: backupPath } : {}),
  };
  saveState(state);
  return {
    ok: true,
    targetPath: 'settings.json',
    backupPath,
    merge: mergeSummary,
  };
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return false;
  if (fs.statSync(src).isDirectory()) {
    ensureDir(dest);
    for (const e of fs.readdirSync(src)) copyRecursive(path.join(src, e), path.join(dest, e));
  } else {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
  return true;
}

function removeTarget(t) {
  if (!fs.existsSync(t)) return;
  if (fs.statSync(t).isDirectory()) fs.rmSync(t, { recursive: true, force: true });
  else fs.unlinkSync(t);
}

// ─── Nested path helpers ─────────────────────────────────────────────────────

function getNestedPath(obj, dotPath) {
  return dotPath.split('.').reduce((cur, k) => (cur != null ? cur[k] : undefined), obj);
}

function setNestedPath(obj, dotPath, value) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function deleteNestedPath(obj, dotPath) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) return;
    cur = cur[parts[i]];
  }
  delete cur[parts[parts.length - 1]];
  // Prune empty parent objects
  if (parts.length > 1) {
    const parent = parts.slice(0, -1).reduce((c, k) => c?.[k], obj);
    if (parent && typeof parent === 'object' && Object.keys(parent).length === 0) {
      deleteNestedPath(obj, parts.slice(0, -1).join('.'));
    }
  }
}

// ─── Settings catalog ─────────────────────────────────────────────────────────

let _settingsCatalog = null;

function loadSettingsCatalog() {
  if (_settingsCatalog) return _settingsCatalog;
  try {
    _settingsCatalog = JSON.parse(fs.readFileSync(SETTINGS_CATALOG_FILE, 'utf8'));
  } catch {
    _settingsCatalog = { sourceUrl: '', lastSyncedAt: '', catalogVersion: 1, recommendedSettingIds: [], settings: [] };
  }
  return _settingsCatalog;
}

function saveSettingsCatalogMeta(updates) {
  const cat = loadSettingsCatalog();
  Object.assign(cat, updates);
  _settingsCatalog = cat;
  fs.writeFileSync(SETTINGS_CATALOG_FILE, JSON.stringify(cat, null, 2));
}

function findCatalogEntry(id) {
  const cat = loadSettingsCatalog();
  return cat.settings.find(s => s.id === id) || STATIC_SETTINGS.find(s => s.id === id) || null;
}

function readSettings(projName) {
  const f = path.join(projectDir(projName), 'settings.json');
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; }
}

function writeSettings(projName, s) {
  ensureDir(projectDir(projName));
  if (!s.$schema) s.$schema = 'https://json.schemastore.org/claude-code-settings.json';
  const dest = path.join(projectDir(projName), 'settings.json');
  try {
    fs.writeFileSync(dest, JSON.stringify(s, null, 2));
  } catch (err) {
    log('error', `writeSettings failed for ${projName}: ${err.message}`);
    throw err;
  }
}

// ─── Install / Remove ─────────────────────────────────────────────────────────

function installComponent(comp, projName, state) {
  const now  = new Date().toISOString();
  const proj = state.projects[projName];

  if (comp.type === 'setting') {
    const s = readSettings(projName);
    const vPath = comp.valuePath || comp.settingKey;
    setNestedPath(s, vPath, comp.defaultValue);
    writeSettings(projName, s);
    proj.components[comp.id] = { installed: true, installedAt: now, value: comp.defaultValue };
    return { ok: true };
  }

  // Resolve version — auto-assign if project has none
  let verId = proj.eccVersion;
  if (!verId || !fs.existsSync(versionDir(verId))) {
    // 1. activeVersion in state
    if (state.activeVersion && fs.existsSync(versionDir(state.activeVersion))) {
      verId = state.activeVersion;
    }
    // 2. any version recorded in state.versions
    if (!verId) {
      const found = Object.keys(state.versions || {}).find(v => fs.existsSync(versionDir(v)));
      if (found) verId = found;
    }
    // 3. scan disk directly (handles state.json reset / missing entries)
    if (!verId && fs.existsSync(VERSIONS_DIR)) {
      const dirs = fs.readdirSync(VERSIONS_DIR)
        .filter(d => d !== '_tmp_pull' && fs.statSync(path.join(VERSIONS_DIR, d)).isDirectory());
      if (dirs.length) verId = dirs.sort().pop(); // latest alphabetically
    }
    if (verId) {
      proj.eccVersion   = verId;
      state.activeVersion = verId;
      log('info', `project "${projName}": auto-assigned version ${verId}`);
    }
  }

  if (comp.type === 'hook') {
    if (comp.quarantined) return { ok: false, error: comp.quarantineReason || 'This hook module requires a manual setup step and cannot be installed directly.' };
    // Merge the specific hook entry into project settings.json
    if (!verId) return { ok: false, error: 'No ECC version found. Click "↓ Pull ECC" first.' };
    const hf = path.join(versionDir(verId), 'hooks', 'hooks.json');
    if (!fs.existsSync(hf)) return { ok: false, error: 'hooks/hooks.json not found in ECC version.' };
    try {
      const eccHooks = JSON.parse(fs.readFileSync(hf, 'utf8')).hooks || {};
      const event    = comp.hookEvent;
      const hookId   = comp.hookId;
      const entry    = (eccHooks[event] || []).find(h => h.id === hookId);
      if (!entry) return { ok: false, error: `Hook id "${hookId}" not found in hooks.json` };
      const s = readSettings(projName);
      if (!s.hooks) s.hooks = {};
      if (!s.hooks[event]) s.hooks[event] = [];
      if (!s.hooks[event].find(x => x.id === hookId)) s.hooks[event].push(entry);
      writeSettings(projName, s);
    } catch (e) { return { ok: false, error: `Failed to merge hook: ${e.message}` }; }
    proj.components[comp.id] = { installed: true, installedAt: now };
    return { ok: true, note: `Hook merged into .claude/settings.json [${comp.hookEvent}]` };
  }

  if (comp.type === 'mcp') {
    if (comp.mcpConfig) {
      try {
        const s = readSettings(projName);
        if (!s.mcpServers) s.mcpServers = {};
        if (!s.mcpServers[comp.mcpKey]) s.mcpServers[comp.mcpKey] = comp.mcpConfig;
        writeSettings(projName, s);
      } catch (e) { return { ok: false, error: `Failed to write mcpServers: ${e.message}` }; }
    }
    proj.components[comp.id] = { installed: true, installedAt: now };
    const note = comp.requiresKey
      ? `Written to settings.json. Set env vars: ${comp.requiresKey}`
      : `Written to settings.json.`;
    return { ok: true, note };
  }

  if (!verId || !fs.existsSync(versionDir(verId))) {
    return { ok: false, error: 'No ECC version found. Click "↓ Pull ECC" first.' };
  }

  const pathList = comp.paths && comp.paths.length > 0 ? comp.paths : [comp.sourcePath];
  // Pre-check all sources before touching the filesystem (atomic on happy path)
  const missing = pathList.filter(p => !fs.existsSync(path.join(versionDir(verId), p)));
  if (missing.length) {
    return { ok: false, error: `Not found in version ${verId}: ${missing.join(', ')}` };
  }
  for (const p of pathList) {
    copyRecursive(path.join(versionDir(verId), p), path.join(projectDir(projName), p));
  }

  proj.components[comp.id] = { installed: true, installedAt: now };
  return { ok: true };
}

function removeComponent(comp, projName, state) {
  const proj = state.projects[projName];

  if (comp.type === 'setting') {
    const s = readSettings(projName);
    const vPath = comp.valuePath || comp.settingKey;
    deleteNestedPath(s, vPath);
    writeSettings(projName, s);
    proj.components[comp.id] = { installed: false, installedAt: null };
    return { ok: true };
  }

  if (comp.type === 'hook') {
    // Remove this specific hook entry from settings.json by id
    try {
      const s     = readSettings(projName);
      const event = comp.hookEvent;
      const hookId= comp.hookId;
      if (s.hooks && s.hooks[event]) {
        s.hooks[event] = s.hooks[event].filter(h => h.id !== hookId);
        if (!s.hooks[event].length) delete s.hooks[event];
        if (!Object.keys(s.hooks).length) delete s.hooks;
        writeSettings(projName, s);
      }
    } catch (e) { log('warn', `Failed to remove hook [${comp.hookId}] for ${projName}: ${e.message}`); }
    proj.components[comp.id] = { installed: false, installedAt: null };
    return { ok: true };
  }

  if (comp.type === 'mcp') {
    try {
      const s = readSettings(projName);
      if (s.mcpServers && s.mcpServers[comp.mcpKey]) {
        delete s.mcpServers[comp.mcpKey];
        if (!Object.keys(s.mcpServers).length) delete s.mcpServers;
        writeSettings(projName, s);
      }
    } catch (e) { log('warn', `Failed to remove MCP server [${comp.mcpKey}] for ${projName}: ${e.message}`); }
    proj.components[comp.id] = { installed: false, installedAt: null };
    return { ok: true };
  }

  const pathList = comp.paths && comp.paths.length > 0 ? comp.paths : [comp.targetPath];
  for (const p of pathList) {
    removeTarget(path.join(projectDir(projName), p));
  }
  proj.components[comp.id] = { installed: false, installedAt: null };
  return { ok: true };
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

const MAX_BODY = 1 * 1024 * 1024; // 1 MB

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => {
      d += c;
      if (d.length > MAX_BODY) {
        req.destroy();
        reject(Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' }));
      }
    });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': CORS_ORIGIN });
  res.end(JSON.stringify(data));
}

function safeName(n) { return /^[a-zA-Z0-9_-]+$/.test(n); }
function safeVerId(v) { return typeof v === 'string' && /^[a-zA-Z0-9_.:-]+$/.test(v); }

// Strip private hint fields (underscore-prefixed) from a project before sending
// it back to clients. _analysis and _stateFile are server-only state-store
// implementation details that must not leak into API responses.
function clientProj(proj) {
  if (!proj || typeof proj !== 'object') return proj;
  const out = {};
  for (const [k, v] of Object.entries(proj)) {
    if (k.startsWith('_')) continue;
    out[k] = v;
  }
  return out;
}

// ─── LM Studio candidate-file collection (shared by /files and /cache) ──────
//
// Both /api/lmstudio/files and /api/projects/:name/lmstudio/cache need the
// same catalog file list. Computing the SHA-256 catalog hash reads + hashes
// every component file, so we memoize the result per verId and invalidate
// when the version dir is replaced (pull-version, version delete).

const _lmCatalogHashCache = {};   // verId → 'sha256:...'

function _resetLmCatalogHashCache(verId) {
  if (verId) delete _lmCatalogHashCache[verId];
  else Object.keys(_lmCatalogHashCache).forEach(k => delete _lmCatalogHashCache[k]);
}

// Build LM analysis candidates from the CATALOG, not from raw filesystem
// scanning. This guarantees each candidate is keyed to a single catalog
// component-id, so results can never be silently dropped due to a
// file→component mapping miss. Multi-path modules (v2 manifests) collapse
// to one candidate per catalog entry — we read the first .md path as the
// representative file. Skills read SKILL.md inside their directory.
//
// Returns an array of { type, name, relPath, content, componentId } where
// componentId is always non-null. Callers downstream don't need a separate
// resolution step.
// Component types the LM Assist analysis intentionally skips:
//   setting  — configuration values (model = haiku, etc.) aren't ranked by
//              relevance, the user picks them directly.
//   platform — "do you use Cursor / Codex / Gemini?" is a toolchain choice
//              the user knows themselves; LLM relevance scoring adds nothing.
// Everything else (rule, agent, skill, command, hook, mcp) is content the
// LLM can meaningfully rank against the project description.
const LM_EXCLUDED_TYPES = new Set(['setting', 'platform']);

function collectLmCandidates(vDir, verId) {
  if (!fs.existsSync(vDir)) return null;
  const catalog = verId ? getCatalog(vDir, verId) : null;
  if (!catalog) return null;

  const candidates = [];
  function readFileOrEmpty(rel) {
    try { return fs.readFileSync(path.join(vDir, rel), 'utf8'); } catch { return ''; }
  }

  for (const c of catalog) {
    if (LM_EXCLUDED_TYPES.has(c.type)) continue;

    if (c.type === 'mcp') {
      // Synthesize a content blob the LM can score against.
      const envKeys = c.requiresKey ? c.requiresKey.split(/,\s*/) : [];
      candidates.push({
        type: 'mcp',
        name: c.mcpKey || c.name,
        relPath: `mcp-configs/mcp-servers.json#${c.mcpKey || c.name}`,
        componentId: c.id,
        content: `MCP Server: ${c.name}\n${c.description || ''}\nEnv: ${envKeys.join(', ')}`,
      });
      continue;
    }

    if (c.type === 'hook') {
      // v1: one catalog entry per hook entry; v2: one entry per hooks module.
      // Either way a synthetic blurb is the best we can do — the actual hook
      // implementation is in scripts/, not a single inspectable file.
      const tag = c.hookEvent ? `[${c.hookEvent}] ` : '';
      candidates.push({
        type: 'hook',
        name: c.hookId || c.name,
        relPath: c.hookId ? `hooks/hooks.json#${c.hookId}` : 'hooks/hooks.json',
        componentId: c.id,
        content: `${tag}${c.description || c.name}`,
      });
      continue;
    }

    if (c.type === 'skill') {
      // skills/<name> → score against SKILL.md inside the directory.
      const skillDir = c.sourcePath || (c.paths && c.paths[0]);
      if (!skillDir) continue;
      // sourcePath in v2 is the directory; in v1 it's also the directory.
      const skillMd = skillDir.endsWith('.md') ? skillDir : `${skillDir}/SKILL.md`;
      const fp = path.join(vDir, skillMd);
      if (!fs.existsSync(fp)) continue;
      candidates.push({
        type: 'skill',
        name: c.name,
        relPath: skillMd,
        componentId: c.id,
        content: readFileOrEmpty(skillMd),
      });
      continue;
    }

    // Agents, commands, rules, platforms, generic v2 modules.
    // paths[] (v2) supersedes sourcePath. Real ECC v2 manifests use a mix of:
    //   - direct file paths      e.g. ["agents/doc-updater.md"]
    //   - directory paths        e.g. ["rules"], ["commands"]
    //   - mixed dir + file       e.g. [".agents", "agents", "AGENTS.md"]
    // Resolution order:
    //   1. First .md path that exists   → score against the file body.
    //   2. Otherwise gather a markdown digest from any directory paths.
    //   3. Otherwise synthesize from module name + description so the entry
    //      is at least scoreable rather than silently dropped.
    const candidatePaths = (c.paths && c.paths.length) ? c.paths : (c.sourcePath ? [c.sourcePath] : []);

    const directMd = candidatePaths.find(p => p && p.endsWith('.md') && fs.existsSync(path.join(vDir, p)));
    if (directMd) {
      candidates.push({
        type: c.type,
        name: c.name,
        relPath: directMd,
        componentId: c.id,
        content: readFileOrEmpty(directMd),
      });
      continue;
    }

    const dirPaths = candidatePaths.filter(p => {
      try {
        const abs = path.join(vDir, p);
        return fs.existsSync(abs) && fs.statSync(abs).isDirectory();
      } catch { return false; }
    });

    if (dirPaths.length) {
      const digest = dirPaths
        .map(d => readDirMarkdownDigest(vDir, d, 12000))
        .filter(Boolean)
        .join('\n\n');
      candidates.push({
        type: c.type,
        name: c.name,
        relPath: dirPaths[0],
        componentId: c.id,
        content: digest || `Module: ${c.name}\n${c.description || ''}\nDirectories: ${dirPaths.join(', ')}`,
      });
      continue;
    }

    // No usable file or directory — score against module metadata so
    // bookkeeping ("totalItems") matches what actually gets persisted.
    candidates.push({
      type: c.type,
      name: c.name,
      relPath: candidatePaths[0] || c.id,
      componentId: c.id,
      content: `Module: ${c.name}\nKind: ${c.type}\n${c.description || ''}`,
    });
  }

  return candidates;
}

// Walk a directory rooted at `dirRel` (relative to `vDir`), concatenating .md
// files into a single digest capped at `budget` bytes. Each file is prefixed
// with its relative path. Skipped quietly when files can't be read.
function readDirMarkdownDigest(vDir, dirRel, budget) {
  const cap = Math.max(2048, budget || 12000);
  const out = [];
  let used = 0;
  function walk(rel) {
    if (used >= cap) return;
    const abs = path.join(vDir, rel);
    let stat;
    try { stat = fs.statSync(abs); } catch { return; }
    if (stat.isDirectory()) {
      let entries;
      try { entries = fs.readdirSync(abs).sort(); } catch { return; }
      for (const e of entries) {
        if (used >= cap) return;
        walk(path.join(rel, e));
      }
      return;
    }
    if (!rel.endsWith('.md')) return;
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { return; }
    const remaining = cap - used;
    if (remaining <= 80) return;
    const header = `### ${rel}\n`;
    const slice = content.length > remaining - header.length
      ? content.slice(0, remaining - header.length - 16) + '\n…[truncated]'
      : content;
    out.push(header + slice);
    used += header.length + slice.length + 2; // +2 for the joiner
  }
  walk(dirRel);
  return out.join('\n\n');
}

function catalogHashForVersion(verId, vDir) {
  if (!verId || !vDir) return null;
  if (_lmCatalogHashCache[verId]) return _lmCatalogHashCache[verId];
  const files = collectLmCandidates(vDir, verId);
  if (!files) return null;
  const hash = stateStore.hashCatalogForVersion(verId, files);
  _lmCatalogHashCache[verId] = hash;
  return hash;
}

function isLocalUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
  } catch { return false; }
}

function projectSummary(proj) {
  const installedCount = Object.values(proj.components || {}).filter(v => v.installed).length;
  return { installedCount };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p   = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': CORS_ORIGIN,
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,PATCH',
      'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  if (p === '/' || p === '/index.html') {
    if (fs.existsSync(HTML_FILE)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(HTML_FILE, 'utf8'));
    }
    return json(res, { error: 'index.html not found' }, 404);
  }

  // GET /api/catalog?version=<verId>
  if (p === '/api/catalog' && req.method === 'GET') {
    const qv      = url.searchParams.get('version');
    const vDir    = qv ? versionDir(qv) : null;
    const hasEcc  = !!(vDir && fs.existsSync(vDir));
    const components = hasEcc ? getCatalog(vDir, qv).map(clientComp) : [...STATIC_SETTINGS];
    return json(res, { components, needsEcc: !hasEcc });
  }

  // GET /api/versions
  if (p === '/api/versions' && req.method === 'GET') {
    const state = loadState();
    return json(res, { versions: state.versions || {}, activeVersion: state.activeVersion });
  }

  // POST /api/pull-version — clone/pull into new versioned folder
  if (p === '/api/pull-version' && req.method === 'POST') {
    const PULL_COOLDOWN_MS = 10 * 60 * 1000;
    if (Date.now() - _lastPullTime < PULL_COOLDOWN_MS)
      return json(res, { ok: false, error: 'Rate limited: wait 10 minutes between pulls.' }, 429);
    _lastPullTime = Date.now();
    const tmpDir = path.join(VERSIONS_DIR, '_tmp_pull');
    log('info', 'pull-version: cloning ECC repo…');
    try {
      ensureDir(VERSIONS_DIR);
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      const cloneResult = spawnSync('git', ['clone', ECC_REPO_URL, tmpDir], { timeout: 180000, stdio: 'pipe' });
      if (cloneResult.status !== 0) throw new Error((cloneResult.stderr?.toString() || 'git clone failed').slice(0, 300));
      const verId  = getVersionId(tmpDir);
      const pulledAt = new Date().toISOString();
      const dest   = versionDir(verId);
      const state  = loadState();
      if (!state.versions) state.versions = {};
      if (fs.existsSync(dest)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (!state.versions[verId]) state.versions[verId] = { verId, pulledAt };
        state.activeVersion = verId;
        saveState(state);
        log('info', `pull-version: ${verId} already exists — set as active`);
        return json(res, { ok: true, verId, alreadyExists: true, versions: state.versions });
      }
      fs.renameSync(tmpDir, dest);
      state.versions[verId] = { verId, pulledAt };
      state.activeVersion = verId;
      saveState(state);
      _resetLmCatalogHashCache(verId);
      log('info', `pull-version: pulled ${verId}`);
      return json(res, { ok: true, verId, info: state.versions[verId], versions: state.versions });
    } catch (e) {
      if (fs.existsSync(tmpDir)) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
      log('error', `pull-version FAILED: ${e.message}`);
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  // DELETE /api/versions/:verId — delete an old version folder
  const verDelMatch = p.match(/^\/api\/versions\/([^/]+)$/);
  if (verDelMatch && req.method === 'DELETE') {
    const verId = decodeURIComponent(verDelMatch[1]);
    const state = loadState();
    const users = Object.values(state.projects).filter(pr => pr.eccVersion === verId).map(pr => pr.name);
    if (users.length > 0) return json(res, { ok: false, error: `Still used by: ${users.join(', ')}` }, 409);
    const dir = versionDir(verId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    delete state.versions[verId];
    delete _catalogCache[verId];
    _resetLmCatalogHashCache(verId);
    if (state.activeVersion === verId) {
      const remaining = Object.keys(state.versions);
      state.activeVersion = remaining.length ? remaining[remaining.length - 1] : null;
    }
    saveState(state);
    log('info', `version deleted: ${verId}`);
    return json(res, { ok: true });
  }

  // GET /api/projects
  if (p === '/api/projects' && req.method === 'GET') {
    const state = loadState();
    const projects = Object.values(state.projects).map(pr => ({
      ...clientProj(pr),
      ...projectSummary(pr),
    }));
    return json(res, { projects, versions: state.versions || {}, activeVersion: state.activeVersion, projectsDir: PROJECTS_DIR });
  }

  // POST /api/projects
  if (p === '/api/projects' && req.method === 'POST') {
    const body = await parseBody(req);
    const { name, description = '', deployPath = '', eccVersion } = body;
    if (!name || !safeName(name)) return json(res, { ok: false, error: 'Invalid name. Use letters, numbers, hyphens, underscores.' }, 400);
    if (description.length > 500) return json(res, { ok: false, error: 'Description too long (max 500 chars).' }, 400);
    if (deployPath.length > 500) return json(res, { ok: false, error: 'Deploy path too long (max 500 chars).' }, 400);
    if (eccVersion && !/^[a-zA-Z0-9_.:-]+$/.test(eccVersion)) return json(res, { ok: false, error: 'Invalid version ID format.' }, 400);
    const state = loadState();
    if (state.projects[name]) return json(res, { ok: false, error: 'Project already exists.' }, 409);
    const resolvedVersion = eccVersion || state.activeVersion || null;
    ensureDir(projectDir(name));
    state.projects[name] = {
      name, description, deployPath,
      createdAt: new Date().toISOString(),
      eccVersion: resolvedVersion,
      components: initProjectComponents()
    };
    saveState(state);
    log('info', `project created: ${name} (version: ${resolvedVersion || 'none'})`);
    return json(res, { ok: true, project: clientProj(state.projects[name]) });
  }

  const projMatch = p.match(/^\/api\/projects\/([^/]+)$/);

  // DELETE /api/projects/:name
  if (projMatch && req.method === 'DELETE') {
    const name = projMatch[1];
    const state = loadState();
    if (!state.projects[name]) return json(res, { ok: false, error: 'Not found' }, 404);
    const dir = path.join(PROJECTS_DIR, name);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    delete state.projects[name];
    saveState(state);
    log('warn', `project deleted: ${name}`);
    return json(res, { ok: true });
  }

  // PATCH /api/projects/:name
  if (projMatch && req.method === 'PATCH') {
    const name = projMatch[1];
    const body = await parseBody(req);
    const state = loadState();
    if (!state.projects[name]) return json(res, { ok: false, error: 'Not found' }, 404);
    const proj = state.projects[name];
    if (body.description  !== undefined) proj.description  = body.description;
    if (body.deployPath   !== undefined) proj.deployPath   = body.deployPath;
    if (body.eccVersion !== undefined) {
      const oldVersion = proj.eccVersion;
      proj.eccVersion = body.eccVersion;
      // Reset component tracking when version changes — IDs differ between versions
      if (body.eccVersion !== oldVersion) proj.components = initProjectComponents();
    }
    if (body.analysisDesc !== undefined) {
      // Soft-stale: editing the description does NOT wipe LM scores. The cache
      // freshness check compares hash(current description) against the
      // descriptionHash recorded at scoring time — a mismatch is reported as
      // "stale" but the underlying scores remain. Re-analyze (explicit user
      // action) is the only path that discards them.
      proj.analysisDesc = body.analysisDesc;
    }
    if (body.pathLocked   !== undefined) proj.pathLocked   = body.pathLocked;
    saveState(state);
    return json(res, { ok: true });
  }

  // ─── Managed docs: CLAUDE.md, AGENTS.md ───────────────────────────────────
  //
  // The legacy /claudemd routes call into the same handlers with docKey="claude"
  // so the original UI continues to work. New UI uses /docs/:docKey directly.

  function readManagedDocFromDisk(name, docKey) {
    const fpath = getProjectManagedDocPath(name, docKey);
    if (!fpath) return null;
    return fs.existsSync(fpath) ? fs.readFileSync(fpath, 'utf8') : null;
  }

  // GET /api/projects/:name/docs/:docKey
  const docsGetMatch = p.match(/^\/api\/projects\/([^/]+)\/docs\/([^/]+)$/);
  if (docsGetMatch && req.method === 'GET') {
    const name = docsGetMatch[1];
    const docKey = docsGetMatch[2];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const cfg = getManagedDocConfig(docKey);
    if (!cfg) return json(res, { ok: false, error: 'Unknown docKey' }, 400);
    const state = loadState();
    const proj = state.projects[name];
    if (!proj) return json(res, { ok: false, error: 'Not found' }, 404);
    const content = readManagedDocFromDisk(name, docKey);
    const eccDefault = getEccDefaultManagedDoc(proj, state, docKey);
    const status = getManagedDocStatus(content, eccDefault);
    const meta = readProjectManagedDocMeta(proj, docKey);
    return json(res, {
      ok: true,
      docKey,
      fileName: cfg.fileName,
      content,
      exists: content !== null,
      defaultAvailable: eccDefault.available,
      defaultVersion: eccDefault.verId,
      defaultPath: eccDefault.filePath,
      status,
      lastDefaultSyncAt: (meta && meta.replacedAt) || null,
    });
  }

  // POST /api/projects/:name/docs/:docKey
  if (docsGetMatch && req.method === 'POST') {
    const name = docsGetMatch[1];
    const docKey = docsGetMatch[2];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const cfg = getManagedDocConfig(docKey);
    if (!cfg) return json(res, { ok: false, error: 'Unknown docKey' }, 400);
    const body = await parseBody(req);
    const state = loadState();
    const proj = state.projects[name];
    if (!proj) return json(res, { ok: false, error: 'Not found' }, 404);
    const fpath = getProjectManagedDocPath(name, docKey);
    ensureDir(projectDir(name));
    fs.writeFileSync(fpath, body.content || '', 'utf8');
    // Manual edit: mark `source: manual` so future status checks don't keep
    // claiming the file is the unmodified ECC default (or a restored backup).
    // Retain `sourceVersion`/`replacedAt` for historical reference.
    writeProjectManagedDocMeta(proj, docKey, {
      source: 'manual',
      updatedAt: new Date().toISOString(),
    });
    saveState(state);
    log('info', `${cfg.fileName} saved for [${name}]`);
    return json(res, { ok: true });
  }

  // GET /api/projects/:name/docs/:docKey/default
  const docsDefaultMatch = p.match(/^\/api\/projects\/([^/]+)\/docs\/([^/]+)\/default$/);
  if (docsDefaultMatch && req.method === 'GET') {
    const name = docsDefaultMatch[1];
    const docKey = docsDefaultMatch[2];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const cfg = getManagedDocConfig(docKey);
    if (!cfg) return json(res, { ok: false, error: 'Unknown docKey' }, 400);
    const state = loadState();
    const proj = state.projects[name];
    if (!proj) return json(res, { ok: false, error: 'Not found' }, 404);
    const eccDefault = getEccDefaultManagedDoc(proj, state, docKey);
    if (!eccDefault.available) return json(res, { ok: false, error: `No ECC default ${cfg.fileName} available` }, 404);
    return json(res, { ok: true, content: eccDefault.content, verId: eccDefault.verId });
  }

  // GET /api/projects/:name/docs/:docKey/diff
  const docsDiffMatch = p.match(/^\/api\/projects\/([^/]+)\/docs\/([^/]+)\/diff$/);
  if (docsDiffMatch && req.method === 'GET') {
    const name = docsDiffMatch[1];
    const docKey = docsDiffMatch[2];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    if (!getManagedDocConfig(docKey)) return json(res, { ok: false, error: 'Unknown docKey' }, 400);
    const state = loadState();
    const proj = state.projects[name];
    if (!proj) return json(res, { ok: false, error: 'Not found' }, 404);
    const current = readManagedDocFromDisk(name, docKey);
    const eccDefault = getEccDefaultManagedDoc(proj, state, docKey);
    const status = getManagedDocStatus(current, eccDefault);
    return json(res, { ok: true, current, defaultContent: eccDefault.available ? eccDefault.content : null, defaultVersion: eccDefault.verId, status });
  }

  // POST /api/projects/:name/docs/:docKey/replace-default
  const docsReplaceMatch = p.match(/^\/api\/projects\/([^/]+)\/docs\/([^/]+)\/replace-default$/);
  if (docsReplaceMatch && req.method === 'POST') {
    const name = docsReplaceMatch[1];
    const docKey = docsReplaceMatch[2];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const cfg = getManagedDocConfig(docKey);
    if (!cfg) return json(res, { ok: false, error: 'Unknown docKey' }, 400);
    const state = loadState();
    const proj = state.projects[name];
    if (!proj) return json(res, { ok: false, error: 'Not found' }, 404);
    const eccDefault = getEccDefaultManagedDoc(proj, state, docKey);
    if (!eccDefault.available) return json(res, { ok: false, error: `No ECC default ${cfg.fileName} available` }, 400);
    const backupPath = backupProjectManagedDoc(name, docKey);
    ensureDir(projectDir(name));
    fs.writeFileSync(getProjectManagedDocPath(name, docKey), eccDefault.content, 'utf8');
    writeProjectManagedDocMeta(proj, docKey, {
      source: 'ecc-default',
      sourceVersion: eccDefault.verId,
      sourcePath: eccDefault.filePath,
      replacedAt: new Date().toISOString(),
      ...(backupPath ? { lastBackupPath: backupPath } : {}),
    });
    saveState(state);
    log('info', `${cfg.fileName} replaced with ECC default for [${name}] from version ${eccDefault.verId}`);
    return json(res, { ok: true, backupPath, verId: eccDefault.verId });
  }

  // GET /api/projects/:name/docs/:docKey/backups
  const docsBackupsMatch = p.match(/^\/api\/projects\/([^/]+)\/docs\/([^/]+)\/backups$/);
  if (docsBackupsMatch && req.method === 'GET') {
    const name = docsBackupsMatch[1];
    const docKey = docsBackupsMatch[2];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    if (!getManagedDocConfig(docKey)) return json(res, { ok: false, error: 'Unknown docKey' }, 400);
    const state = loadState();
    if (!state.projects[name]) return json(res, { ok: false, error: 'Not found' }, 404);
    const backups = listProjectManagedDocBackups(name, docKey);
    return json(res, { ok: true, backups });
  }

  // GET /api/projects/:name/backups
  // Generic, unfiltered backup list for the project. Categorizes each entry
  // (managed-doc / settings-json / apply-or-deploy / unknown) so the UI can
  // surface deploy-time and apply-time snapshots that don't match a single
  // managed-doc filter pattern.
  const allBackupsMatch = p.match(/^\/api\/projects\/([^/]+)\/backups$/);
  if (allBackupsMatch && req.method === 'GET') {
    const name = allBackupsMatch[1];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const state = loadState();
    if (!state.projects[name]) return json(res, { ok: false, error: 'Not found' }, 404);
    return json(res, { ok: true, backups: listAllProjectBackups(name) });
  }

  // POST /api/projects/:name/docs/:docKey/restore
  const docsRestoreMatch = p.match(/^\/api\/projects\/([^/]+)\/docs\/([^/]+)\/restore$/);
  if (docsRestoreMatch && req.method === 'POST') {
    const name = docsRestoreMatch[1];
    const docKey = docsRestoreMatch[2];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const cfg = getManagedDocConfig(docKey);
    if (!cfg) return json(res, { ok: false, error: 'Unknown docKey' }, 400);
    const body = await parseBody(req);
    const state = loadState();
    const proj = state.projects[name];
    if (!proj) return json(res, { ok: false, error: 'Not found' }, 404);
    if (!body.backupName) return json(res, { ok: false, error: 'backupName required' }, 400);
    const pattern = backupNamePattern(docKey);
    if (!pattern.test(body.backupName)) return json(res, { ok: false, error: 'Invalid backup name format' }, 400);
    const backupsDir = path.join(projectDir(name), '.backups');
    const backupFile = path.join(backupsDir, body.backupName);
    if (!path.resolve(backupFile).startsWith(path.resolve(backupsDir))) return json(res, { ok: false, error: 'Invalid backup name' }, 400);
    if (!fs.existsSync(backupFile)) return json(res, { ok: false, error: 'Backup not found' }, 404);
    backupProjectManagedDoc(name, docKey);
    const content = fs.readFileSync(backupFile, 'utf8');
    ensureDir(projectDir(name));
    fs.writeFileSync(getProjectManagedDocPath(name, docKey), content, 'utf8');
    writeProjectManagedDocMeta(proj, docKey, {
      source: 'restored-backup',
      replacedAt: new Date().toISOString(),
    });
    saveState(state);
    log('info', `${cfg.fileName} restored from backup ${body.backupName} for [${name}]`);
    return json(res, { ok: true });
  }

  // ─── Legacy /claudemd compatibility ───────────────────────────────────────
  // The original UI calls /api/projects/:name/claudemd[...] directly. Forward
  // those calls into the same code path used by /docs/claude by handling each
  // legacy route here and delegating to the generic helpers. Bodies that have
  // already been consumed on the request stream are re-parsed via parseBody,
  // which only resolves once data is available — so we delegate by calling
  // the helpers directly rather than re-emitting the request.

  // GET /api/projects/:name/claudemd/default
  const claudeMdDefaultMatch = p.match(/^\/api\/projects\/([^/]+)\/claudemd\/default$/);
  if (claudeMdDefaultMatch && req.method === 'GET') {
    const name = claudeMdDefaultMatch[1];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const state = loadState();
    const proj = state.projects[name];
    if (!proj) return json(res, { ok: false, error: 'Not found' }, 404);
    const eccDefault = getEccDefaultManagedDoc(proj, state, 'claude');
    if (!eccDefault.available) return json(res, { ok: false, error: 'No ECC default CLAUDE.md available' }, 404);
    return json(res, { ok: true, content: eccDefault.content, verId: eccDefault.verId });
  }

  // GET /api/projects/:name/claudemd/diff
  const claudeMdDiffMatch = p.match(/^\/api\/projects\/([^/]+)\/claudemd\/diff$/);
  if (claudeMdDiffMatch && req.method === 'GET') {
    const name = claudeMdDiffMatch[1];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const state = loadState();
    const proj = state.projects[name];
    if (!proj) return json(res, { ok: false, error: 'Not found' }, 404);
    const current = readManagedDocFromDisk(name, 'claude');
    const eccDefault = getEccDefaultManagedDoc(proj, state, 'claude');
    const status = getManagedDocStatus(current, eccDefault);
    return json(res, { ok: true, current, defaultContent: eccDefault.available ? eccDefault.content : null, defaultVersion: eccDefault.verId, status });
  }

  // POST /api/projects/:name/claudemd/replace-default
  const claudeMdReplaceMatch = p.match(/^\/api\/projects\/([^/]+)\/claudemd\/replace-default$/);
  if (claudeMdReplaceMatch && req.method === 'POST') {
    const name = claudeMdReplaceMatch[1];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const state = loadState();
    const proj = state.projects[name];
    if (!proj) return json(res, { ok: false, error: 'Not found' }, 404);
    const eccDefault = getEccDefaultManagedDoc(proj, state, 'claude');
    if (!eccDefault.available) return json(res, { ok: false, error: 'No ECC default CLAUDE.md available' }, 400);
    const backupPath = backupProjectManagedDoc(name, 'claude');
    ensureDir(projectDir(name));
    fs.writeFileSync(getProjectManagedDocPath(name, 'claude'), eccDefault.content, 'utf8');
    writeProjectManagedDocMeta(proj, 'claude', {
      source: 'ecc-default',
      sourceVersion: eccDefault.verId,
      sourcePath: eccDefault.filePath,
      replacedAt: new Date().toISOString(),
      ...(backupPath ? { lastBackupPath: backupPath } : {}),
    });
    saveState(state);
    log('info', `CLAUDE.md replaced with ECC default for [${name}] from version ${eccDefault.verId}`);
    return json(res, { ok: true, backupPath, verId: eccDefault.verId });
  }

  // GET /api/projects/:name/claudemd/backups
  const claudeMdBackupsMatch = p.match(/^\/api\/projects\/([^/]+)\/claudemd\/backups$/);
  if (claudeMdBackupsMatch && req.method === 'GET') {
    const name = claudeMdBackupsMatch[1];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const state = loadState();
    if (!state.projects[name]) return json(res, { ok: false, error: 'Not found' }, 404);
    const backups = listProjectManagedDocBackups(name, 'claude');
    return json(res, { ok: true, backups });
  }

  // POST /api/projects/:name/claudemd/restore
  const claudeMdRestoreMatch = p.match(/^\/api\/projects\/([^/]+)\/claudemd\/restore$/);
  if (claudeMdRestoreMatch && req.method === 'POST') {
    const name = claudeMdRestoreMatch[1];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const body = await parseBody(req);
    const state = loadState();
    const proj = state.projects[name];
    if (!proj) return json(res, { ok: false, error: 'Not found' }, 404);
    if (!body.backupName) return json(res, { ok: false, error: 'backupName required' }, 400);
    if (!backupNamePattern('claude').test(body.backupName)) return json(res, { ok: false, error: 'Invalid backup name format' }, 400);
    // Pattern already accepts the collision-suffixed form produced by uniqueBackupName.
    const backupsDir = path.join(projectDir(name), '.backups');
    const backupFile = path.join(backupsDir, body.backupName);
    if (!path.resolve(backupFile).startsWith(path.resolve(backupsDir))) return json(res, { ok: false, error: 'Invalid backup name' }, 400);
    if (!fs.existsSync(backupFile)) return json(res, { ok: false, error: 'Backup not found' }, 404);
    backupProjectManagedDoc(name, 'claude');
    const content = fs.readFileSync(backupFile, 'utf8');
    ensureDir(projectDir(name));
    fs.writeFileSync(getProjectManagedDocPath(name, 'claude'), content, 'utf8');
    writeProjectManagedDocMeta(proj, 'claude', {
      source: 'restored-backup',
      replacedAt: new Date().toISOString(),
    });
    saveState(state);
    log('info', `CLAUDE.md restored from backup ${body.backupName} for [${name}]`);
    return json(res, { ok: true });
  }

  // GET/POST /api/projects/:name/claudemd
  const claudeMdMatch = p.match(/^\/api\/projects\/([^/]+)\/claudemd$/);
  if (claudeMdMatch && req.method === 'GET') {
    const name = claudeMdMatch[1];
    const state = loadState();
    const proj = state.projects[name];
    if (!proj) return json(res, { ok: false, error: 'Not found' }, 404);
    const content = readManagedDocFromDisk(name, 'claude');
    const eccDefault = getEccDefaultManagedDoc(proj, state, 'claude');
    const status = getManagedDocStatus(content, eccDefault);
    const meta = readProjectManagedDocMeta(proj, 'claude');
    return json(res, {
      ok: true, content, exists: content !== null,
      defaultAvailable: eccDefault.available,
      defaultVersion: eccDefault.verId,
      defaultPath: eccDefault.filePath,
      status,
      lastDefaultSyncAt: (meta && meta.replacedAt) || null,
    });
  }
  if (claudeMdMatch && req.method === 'POST') {
    const name = claudeMdMatch[1];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const body = await parseBody(req);
    const state = loadState();
    const proj = state.projects[name];
    if (!proj) return json(res, { ok: false, error: 'Not found' }, 404);
    const fpath = getProjectManagedDocPath(name, 'claude');
    ensureDir(projectDir(name));
    fs.writeFileSync(fpath, body.content || '', 'utf8');
    writeProjectManagedDocMeta(proj, 'claude', {
      source: 'manual',
      updatedAt: new Date().toISOString(),
    });
    saveState(state);
    log('info', `CLAUDE.md saved for [${name}]`);
    return json(res, { ok: true });
  }

  // ─── Shared library: client-facing config ────────────────────────────────
  // Returns small constants the frontend has to mirror to render previews
  // accurately (e.g. the project-root deploy allowlist). Keep this lean —
  // anything dynamic should be its own endpoint.
  if (p === '/api/shared/config' && req.method === 'GET') {
    return json(res, {
      ok: true,
      projectRootDeployDirs: Array.from(PROJECT_ROOT_DEPLOY_DIRS).sort(),
      sharedDocKeys: SHARED_DOC_KEYS,
      customComponentKinds: CUSTOM_COMPONENT_KINDS,
    });
  }

  // ─── Shared library: global markdown docs ────────────────────────────────
  // GET    /api/shared/docs/:docKey
  // POST   /api/shared/docs/:docKey
  // GET    /api/shared/docs/:docKey/:fileName
  // PUT    /api/shared/docs/:docKey/:id
  // DELETE /api/shared/docs/:docKey/:id
  //
  // The path segment after :docKey is now an opaque 8-hex id, not a slug.
  // Two entries can share a `name` so the URL has to key on something
  // unique and stable across renames.

  const sharedDocItemMatch = p.match(/^\/api\/shared\/docs\/([^/]+)\/([^/]+)$/);
  const sharedDocListMatch = p.match(/^\/api\/shared\/docs\/([^/]+)$/);

  if (sharedDocListMatch && req.method === 'GET') {
    const docKey = sharedDocListMatch[1];
    if (!SHARED_DOC_KEYS.includes(docKey)) return json(res, { ok: false, error: 'Unknown docKey' }, 400);
    return json(res, { ok: true, docKey, fileName: SHARED_DOC_KIND_DIRS[docKey], items: listSharedDocs(docKey) });
  }
  if (sharedDocListMatch && req.method === 'POST') {
    const docKey = sharedDocListMatch[1];
    if (!SHARED_DOC_KEYS.includes(docKey)) return json(res, { ok: false, error: 'Unknown docKey' }, 400);
    const body = await parseBody(req);
    const result = writeSharedDoc(docKey, body);
    if (!result.ok) return json(res, result, 400);
    return json(res, { ok: true, id: result.id });
  }
  if (sharedDocItemMatch && req.method === 'GET') {
    const [, docKey, id] = sharedDocItemMatch;
    if (!SHARED_DOC_KEYS.includes(docKey)) return json(res, { ok: false, error: 'Unknown docKey' }, 400);
    const item = readSharedDoc(docKey, id);
    if (!item) return json(res, { ok: false, error: 'Not found' }, 404);
    return json(res, { ok: true, ...item });
  }
  if (sharedDocItemMatch && req.method === 'PUT') {
    const [, docKey, id] = sharedDocItemMatch;
    if (!SHARED_DOC_KEYS.includes(docKey)) return json(res, { ok: false, error: 'Unknown docKey' }, 400);
    const body = await parseBody(req);
    const result = updateSharedDoc(docKey, id, body);
    if (!result.ok) return json(res, result, result.error === 'Not found' ? 404 : 400);
    return json(res, { ok: true });
  }
  if (sharedDocItemMatch && req.method === 'DELETE') {
    const [, docKey, id] = sharedDocItemMatch;
    if (!SHARED_DOC_KEYS.includes(docKey)) return json(res, { ok: false, error: 'Unknown docKey' }, 400);
    const removed = deleteSharedDoc(docKey, id);
    if (!removed) return json(res, { ok: false, error: 'Not found' }, 404);
    return json(res, { ok: true });
  }

  // ─── Shared library: custom components ───────────────────────────────────
  // GET    /api/shared/components/:kind
  // POST   /api/shared/components/:kind
  // GET    /api/shared/components/:kind/:slug
  // PUT    /api/shared/components/:kind/:slug
  // DELETE /api/shared/components/:kind/:slug
  // POST   /api/shared/components/:kind/:slug/apply

  const sharedCompApplyMatch = p.match(/^\/api\/shared\/components\/([^/]+)\/([^/]+)\/apply$/);
  const sharedCompItemMatch = p.match(/^\/api\/shared\/components\/([^/]+)\/([^/]+)$/);
  const sharedCompListMatch = p.match(/^\/api\/shared\/components\/([^/]+)$/);

  // GET /api/shared/components — returns every kind in one shot so the
  // frontend can render custom components in the main category lists
  // (Skills/Rules/Hooks/MCP/Agents/Commands) without N round-trips. Also
  // includes `sharedDocCounts` so the sidebar's Custom CLAUDE.md / AGENTS.md
  // entries can show item counts in the same render pass.
  if (p === '/api/shared/components' && req.method === 'GET') {
    const byKind = {};
    for (const kind of CUSTOM_COMPONENT_KINDS) byKind[kind] = listCustomComponents(kind);
    const sharedDocCounts = {};
    for (const docKey of SHARED_DOC_KEYS) sharedDocCounts[docKey] = listSharedDocs(docKey).length;
    return json(res, { ok: true, byKind, sharedDocCounts });
  }

  if (sharedCompListMatch && req.method === 'GET' && !sharedCompApplyMatch && !sharedCompItemMatch) {
    const kind = sharedCompListMatch[1];
    if (!CUSTOM_COMPONENT_KINDS.includes(kind)) return json(res, { ok: false, error: 'Unknown kind' }, 400);
    return json(res, { ok: true, kind, items: listCustomComponents(kind) });
  }
  if (sharedCompListMatch && req.method === 'POST' && !sharedCompApplyMatch && !sharedCompItemMatch) {
    const kind = sharedCompListMatch[1];
    if (!CUSTOM_COMPONENT_KINDS.includes(kind)) return json(res, { ok: false, error: 'Unknown kind' }, 400);
    const body = await parseBody(req);
    if (!body.name) return json(res, { ok: false, error: 'name required' }, 400);
    const result = writeCustomComponent(kind, body.name, body);
    if (!result.ok) return json(res, result, 400);
    return json(res, { ok: true, slug: result.slug, id: result.id });
  }
  if (sharedCompApplyMatch && req.method === 'POST') {
    const [, kind, slug] = sharedCompApplyMatch;
    if (!CUSTOM_COMPONENT_KINDS.includes(kind)) return json(res, { ok: false, error: 'Unknown kind' }, 400);
    if (!safeSharedSlugPattern(slug)) return json(res, { ok: false, error: 'Invalid slug' }, 400);
    const body = await parseBody(req);
    if (!body.project) return json(res, { ok: false, error: 'project required' }, 400);
    if (!safeName(body.project)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const state = loadState();
    if (!state.projects[body.project]) return json(res, { ok: false, error: 'Project not found' }, 404);
    const result = MARKDOWN_COMPONENT_KINDS.has(kind)
      ? applyMarkdownComponent(body.project, kind, slug, body)
      : applyJsonComponent(body.project, kind, slug, body);
    if (!result.ok) return json(res, result, result.error ? 400 : 409);
    return json(res, result);
  }
  if (sharedCompItemMatch && req.method === 'GET') {
    const [, kind, slug] = sharedCompItemMatch;
    if (!CUSTOM_COMPONENT_KINDS.includes(kind)) return json(res, { ok: false, error: 'Unknown kind' }, 400);
    if (!safeSharedSlugPattern(slug)) return json(res, { ok: false, error: 'Invalid slug' }, 400);
    const item = readCustomComponent(kind, slug);
    if (!item) return json(res, { ok: false, error: 'Not found' }, 404);
    return json(res, { ok: true, item });
  }
  if (sharedCompItemMatch && req.method === 'PUT') {
    const [, kind, slug] = sharedCompItemMatch;
    if (!CUSTOM_COMPONENT_KINDS.includes(kind)) return json(res, { ok: false, error: 'Unknown kind' }, 400);
    if (!safeSharedSlugPattern(slug)) return json(res, { ok: false, error: 'Invalid slug' }, 400);
    const body = await parseBody(req);
    const result = updateCustomComponent(kind, slug, body);
    if (!result.ok) return json(res, result, result.error === 'Component not found' ? 404 : 400);
    return json(res, { ok: true });
  }
  if (sharedCompItemMatch && req.method === 'DELETE') {
    const [, kind, slug] = sharedCompItemMatch;
    if (!CUSTOM_COMPONENT_KINDS.includes(kind)) return json(res, { ok: false, error: 'Unknown kind' }, 400);
    if (!safeSharedSlugPattern(slug)) return json(res, { ok: false, error: 'Invalid slug' }, 400);
    const result = deleteCustomComponent(kind, slug);
    if (!result.ok) return json(res, result, result.error === 'Component not found' ? 404 : 400);
    return json(res, { ok: true });
  }

  // GET /api/projects/:name
  if (projMatch && req.method === 'GET') {
    const name = projMatch[1];
    const state = loadState();
    if (!state.projects[name]) return json(res, { ok: false, error: 'Not found' }, 404);
    const proj  = state.projects[name];
    const cat   = getCatalogForProject(proj, state);
    if (migrateV2ModuleInstallsToLeaves(proj, cat) > 0) {
      saveProjectShard(name);
    }
    const components = cat.map(c => ({
      ...clientComp(c),
      installed:   proj.components[c.id]?.installed   || false,
      installedAt: proj.components[c.id]?.installedAt || null,
      value:       proj.components[c.id]?.value       || null,
    }));
    // Per-project applied state for custom components, keyed by id. Frontend
    // merges this with the global custom-component library to render Apply
    // affordances in the main category lists.
    const customApplied = {};
    for (const [id, entry] of Object.entries(proj.customComponents || {})) {
      if (!entry) continue;
      customApplied[id] = {
        kind:       entry.kind,
        targetPath: entry.targetPath || null,
        deployRoot: entry.deployRoot || null,
        appliedAt:  entry.appliedAt  || null,
        sourceUpdatedAt: entry.sourceUpdatedAt || null,
      };
    }
    const activeVersion       = state.activeVersion || null;
    const activeVersionExists = !!(activeVersion && fs.existsSync(versionDir(activeVersion)));
    const versionMismatch     = !!(activeVersionExists && proj.eccVersion && proj.eccVersion !== activeVersion);
    return json(res, { project: clientProj(proj), components, customApplied, summary: projectSummary(proj), versionMismatch, activeVersion });
  }

  // POST /api/install
  if (p === '/api/install' && req.method === 'POST') {
    const body = await parseBody(req);
    const { project: projName, ids = [] } = body;
    const state = loadState();
    if (!state.projects[projName]) return json(res, { ok: false, error: 'Project not found' }, 404);
    const proj  = state.projects[projName];
    const cat   = getCatalogForProject(proj, state);
    const results = {};
    for (const id of ids) {
      const comp = cat.find(c => c.id === id);
      if (!comp) { results[id] = { ok: false, error: 'Component not found in catalog for this version' }; log('error', `install [${projName}] ${id}: not in catalog`); continue; }
      results[id] = installComponent(comp, projName, state);
      if (results[id].ok) log('info', `install [${projName}] ${id}: ok${results[id].note ? ' — '+results[id].note : ''}`);
      else                log('error', `install [${projName}] ${id}: FAILED — ${results[id].error}`);
    }
    saveState(state);
    // Copy AGENTS.md + agent.yaml only when an agent or skill was successfully installed
    const agentOrSkillInstalled = ids.some(id => results[id]?.ok && (id.startsWith('agent-') || id.startsWith('skill-')));
    if (agentOrSkillInstalled) {
      const { vDir: iVDir, verId: iVerId } = resolveVersion(state.projects[projName], state);
      if (iVDir) {
        const copied = copyEccRootFiles(iVDir, projectDir(projName));
        // Record AGENTS.md as the unmodified ECC default ONLY when it was
        // freshly copied. Pre-existing user-edited AGENTS.md is left alone
        // and its prior metadata (manual/customized) stays intact.
        if (copied.includes('AGENTS.md')) {
          writeProjectManagedDocMeta(state.projects[projName], 'agents', {
            source: 'ecc-default',
            sourceVersion: iVerId,
            sourcePath: 'AGENTS.md',
            replacedAt: new Date().toISOString(),
          });
          saveState(state);
        }
      }
    }
    return json(res, { results });
  }

  // POST /api/remove
  if (p === '/api/remove' && req.method === 'POST') {
    const body = await parseBody(req);
    const { project: projName, ids = [] } = body;
    const state = loadState();
    if (!state.projects[projName]) return json(res, { ok: false, error: 'Project not found' }, 404);
    const proj  = state.projects[projName];
    const cat   = getCatalogForProject(proj, state);
    const results = {};
    for (const id of ids) {
      const comp = cat.find(c => c.id === id);
      if (!comp) { results[id] = { ok: false, error: 'Component not found in catalog for this version' }; log('error', `remove [${projName}] ${id}: not in catalog`); continue; }
      results[id] = removeComponent(comp, projName, state);
      if (results[id].ok) log('info', `remove [${projName}] ${id}: ok${results[id].note ? ' — '+results[id].note : ''}`);
      else                log('error', `remove [${projName}] ${id}: FAILED — ${results[id].error}`);
    }
    saveState(state);
    return json(res, { results });
  }

  // GET /api/preview?version=<verId>&path=<relPath>
  if (p === '/api/preview' && req.method === 'GET') {
    const verId   = url.searchParams.get('version');
    const relPath = url.searchParams.get('path');
    if (!verId || !relPath) return json(res, { ok: false, error: 'Missing version or path' }, 400);
    const vDir    = versionDir(verId);
    if (!fs.existsSync(vDir)) return json(res, { ok: false, error: 'Version not found' }, 404);
    // Prevent path traversal
    const full = path.resolve(vDir, relPath);
    if (!full.startsWith(path.resolve(vDir))) return json(res, { ok: false, error: 'Invalid path' }, 400);
    if (!fs.existsSync(full)) return json(res, { ok: false, error: 'File not found' }, 404);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      // Return recursive file listing
      function listDir(dir, base) {
        const entries = [];
        fs.readdirSync(dir).sort().forEach(name => {
          const abs  = path.join(dir, name);
          const rel  = path.join(base, name);
          if (fs.statSync(abs).isDirectory()) entries.push(...listDir(abs, rel));
          else entries.push(rel);
        });
        return entries;
      }
      return json(res, { ok: true, type: 'dir', files: listDir(full, relPath) });
    } else {
      const content = fs.readFileSync(full, 'utf8');
      return json(res, { ok: true, type: 'file', path: relPath, content });
    }
  }

  // GET /api/lmstudio — load config from state
  if (p === '/api/lmstudio' && req.method === 'GET') {
    const state = loadState();
    return json(res, { ok: true, lmStudio: state.lmStudio || { serverUrl: 'http://localhost:1234/v1/chat/completions', lmApiToken: '' } });
  }

  // POST /api/lmstudio — save config to state
  if (p === '/api/lmstudio' && req.method === 'POST') {
    const body  = await parseBody(req);
    if (body.serverUrl && !isLocalUrl(body.serverUrl))
      return json(res, { ok: false, error: 'serverUrl must point to localhost or 127.0.0.1' }, 400);
    const state = loadState();
    state.lmStudio = { serverUrl: body.serverUrl || '', lmApiToken: body.lmApiToken || '', threshold: Number(body.threshold) || 80 };
    saveState(state);
    return json(res, { ok: true });
  }

  // GET /api/lmstudio/status — server-side health probe via v1 API (no CORS issue)
  if (p === '/api/lmstudio/status' && req.method === 'GET') {
    const state = loadState();
    const rawUrl = (state.lmStudio?.serverUrl || 'http://localhost:1234/v1/chat/completions');
    if (!isLocalUrl(rawUrl)) return json(res, { ok: true, online: false, error: 'non-local serverUrl rejected' });
    const base  = rawUrl.replace(/\/v1\/.*$/, '');
    const probeUrl = `${base}/v1/models`;
    try {
      log('info', `lm-studio probe: ${probeUrl}`);
      const r = await nodeFetch(probeUrl, { timeout: 5000 });
      if (r.status >= 200 && r.status < 300) {
        log('info', `lm-studio: online`);
        return json(res, { ok: true, online: true, via: probeUrl });
      }
      log('info', `lm-studio: ${probeUrl} → ${r.status}`);
    } catch(e) {
      log('info', `lm-studio: probe failed — ${e.message}`);
    }
    log('info', 'lm-studio: offline');
    return json(res, { ok: true, online: false });
  }

  // POST /api/lmstudio/analyze — score one file against a project description
  // Prompt is defined server-side only; client sends { file: {name,type,content,relPath}, desc }
  if (p === '/api/lmstudio/analyze' && req.method === 'POST') {
    const body  = await parseBody(req);
    const { file, desc } = body;
    if (!file || !desc) return json(res, { ok: false, error: 'Missing file or desc' }, 400);
    const state = loadState();
    const target = state.lmStudio?.serverUrl || 'http://localhost:1234/v1/chat/completions';
    if (!isLocalUrl(target)) return json(res, { ok: false, error: 'serverUrl must point to localhost or 127.0.0.1' }, 400);
    const token  = state.lmStudio?.lmApiToken || '';

    const systemPrompt = `You are a configuration file relevance scorer for Claude Code projects.

Your job: given a user's PROJECT DESCRIPTION and a Claude configuration file, score how useful that file would be for a developer working on THAT project.

## What you are scoring
These files are Claude AI helpers — agents, skills, rules, commands, hooks — that assist developers while they code. You must evaluate whether the file's PURPOSE matches the project's tech stack and domain.

## Scoring scale
- 90-100: Directly targets this project's language, framework, or domain. An obvious must-have.
- 70-89: Broadly useful for this type of project. Nice to have.
- 50-69: Generic developer utility. Would help on any project, not specifically this one.
- 0-49: For a different language, framework, or domain that is NOT part of this project.

## Hard rules — apply these first
1. LANGUAGE MISMATCH → score 0-20. If the file is for C++, Flutter, Go, Java, C#, Rust, PHP, Swift, etc. and that language is NOT in the project description, score 0-20. Do not rationalize a higher score.
2. FRAMEWORK MISMATCH → score 0-25. If the file targets a specific framework not mentioned, score low.
3. DOMAIN MISMATCH → score 0-30. If the file is for ML/GAN, healthcare, game dev, etc. and the project is not in that domain, score 0-30.
4. GENERIC AGENT (code-reviewer, planner, tdd-guide, etc.) → score 50-70 max. These help any project but are not specific.
5. DIRECT MATCH → score 85+. Only when the file's specific language/framework/domain is explicitly stated in the project description.

## Key principle
The file being an "agent" or existing in the library does NOT make it relevant. Score the PURPOSE of the file against the project's actual needs.

Respond ONLY with valid JSON. No markdown, no code fences, no extra text.`;

    const userPrompt = `PROJECT DESCRIPTION:\n${desc}\n\n---\n\nFILE: ${file.name} (type: ${file.type})\n\nCONTENT:\n${file.content || ''}\n\n---\n\nApply the hard rules. Score in multiples of 5 (0, 5, 10, ... 95, 100). Give a reason in under 30 words.`;

    const payload = {
      model: 'local-model',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'claude_file_relevance', strict: 'true',
          schema: {
            type: 'object',
            properties: {
              file_name:       { type: 'string' },
              relevance_score: { type: 'number' },
              reason:          { type: 'string' },
            },
            required: ['file_name', 'relevance_score', 'reason'],
          },
        },
      },
      temperature: 0, max_tokens: 120, stream: false,
    };

    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      const r = await nodeFetch(target, { method: 'POST', headers, body: JSON.stringify(payload), timeout: 60000 });
      if (r.status >= 200 && r.status < 300) {
        return json(res, { ok: true, data: JSON.parse(r.body) });
      }
      return json(res, { ok: false, error: `LM Studio returned ${r.status}: ${r.body.slice(0, 200)}` });
    } catch(e) {
      return json(res, { ok: false, error: e.message });
    }
  }

  // GET /api/lmstudio/files?version=<verId> — collect all ECC files with content for LM analysis
  if (p === '/api/lmstudio/files' && req.method === 'GET') {
    const verId = url.searchParams.get('version');
    if (!verId) return json(res, { ok: false, error: 'No version specified' }, 400);
    if (!safeVerId(verId)) return json(res, { ok: false, error: 'Invalid version format' }, 400);
    const vDir = versionDir(verId);
    if (!fs.existsSync(vDir)) return json(res, { ok: false, error: 'Version not found' }, 404);
    const files = collectLmCandidates(vDir, verId);
    if (!files) return json(res, { ok: false, error: 'Version not found' }, 404);
    return json(res, { ok: true, files });
  }

  // ─── LM Studio per-project cache endpoints ─────────────────────────────────
  // Cache shape:
  //   analysis = { description, descriptionHash, eccVersion, catalogHash,
  //                status: not_run|in_progress|partial|complete, totalItems,
  //                completedItems, failedItems, startedAt, updatedAt, completedAt }
  //   components[id] = { matchingPerc, reasoning, analysisHash, catalogHash,
  //                      lmFilePath, lmFileType, analyzedAt, analysisStatus }

  // GET /api/projects/:name/lmstudio/cache?version=<verId>
  const lmCacheGetMatch = p.match(/^\/api\/projects\/([^/]+)\/lmstudio\/cache$/);
  if (lmCacheGetMatch && req.method === 'GET') {
    const name = lmCacheGetMatch[1];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const state = loadState();
    const proj = state.projects[name];
    if (!proj) return json(res, { ok: false, error: 'Not found' }, 404);
    const reqVer = url.searchParams.get('version');
    if (reqVer && !safeVerId(reqVer)) return json(res, { ok: false, error: 'Invalid version format' }, 400);
    const verId = reqVer || proj.eccVersion || state.activeVersion || null;
    const vDir = verId ? versionDir(verId) : null;
    const catalogHash = catalogHashForVersion(verId, vDir);
    const analysis = proj._analysis || {};
    const descHash = stateStore.hashAnalysisDesc(proj.analysisDesc || '');
    const fresh = !!analysis.descriptionHash &&
                  analysis.descriptionHash === descHash &&
                  (!analysis.catalogHash || analysis.catalogHash === catalogHash);
    const stale = !!analysis.descriptionHash && !fresh;
    const cat = getCatalogForProject(proj, state);

    // Map cached LM scores back to components present in the current catalog.
    const results = [];
    for (const [componentId, entry] of Object.entries(proj.components || {})) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.matchingPerc == null && entry.analysisStatus == null) continue;
      const comp = cat.find(c => c.id === componentId);
      results.push({
        componentId,
        relPath: entry.lmFilePath || (comp && comp.sourcePath) || null,
        type: entry.lmFileType || (comp && comp.type) || null,
        name: comp ? comp.name : componentId,
        matchingPerc: typeof entry.matchingPerc === 'number' ? entry.matchingPerc : null,
        reasoning: entry.reasoning || '',
        analysisStatus: entry.analysisStatus || 'complete',
        analyzedAt: entry.analyzedAt || null,
      });
    }

    return json(res, {
      ok: true,
      cacheHit: results.length > 0 && fresh,
      stale,
      verId,
      currentDescriptionHash: descHash,
      currentCatalogHash: catalogHash,
      analysis: {
        description: proj.analysisDesc || '',
        descriptionHash: analysis.descriptionHash || null,
        eccVersion: analysis.eccVersion || verId,
        catalogHash: analysis.catalogHash || null,
        thresholdAtRun: analysis.thresholdAtRun || null,
        status: analysis.status || 'not_run',
        totalItems: analysis.totalItems || 0,
        completedItems: analysis.completedItems || 0,
        failedItems: analysis.failedItems || 0,
        startedAt: analysis.startedAt || null,
        updatedAt: analysis.updatedAt || null,
        completedAt: analysis.completedAt || null,
      },
      results,
    });
  }

  // POST /api/projects/:name/lmstudio/analysis-description
  // Body: { description, version?, threshold?, totalItems?, lmStudio?, startRun? }
  // Saves the description (clearing LM cache if hash changed) and optionally
  // initializes a fresh analysis run (status=in_progress).
  const lmDescMatch = p.match(/^\/api\/projects\/([^/]+)\/lmstudio\/analysis-description$/);
  if (lmDescMatch && req.method === 'POST') {
    const name = lmDescMatch[1];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const body = await parseBody(req);
    const state = loadState();
    const proj = state.projects[name];
    if (!proj) return json(res, { ok: false, error: 'Not found' }, 404);
    const newDesc = body.description || '';
    if (newDesc.length > 50000) return json(res, { ok: false, error: 'Description too long' }, 400);
    if (body.version && !safeVerId(body.version)) return json(res, { ok: false, error: 'Invalid version format' }, 400);
    const verId = body.version || proj.eccVersion || state.activeVersion || null;
    const vDir = verId ? versionDir(verId) : null;
    const catalogHash = catalogHashForVersion(verId, vDir);
    const totalCandidates = (vDir && fs.existsSync(vDir)) ? (collectLmCandidates(vDir, verId) || []).length : 0;
    const newHash = stateStore.hashAnalysisDesc(newDesc);
    const oldScoredHash = proj._analysis && proj._analysis.descriptionHash;
    const descChanged = oldScoredHash !== newHash;
    // descriptionHash records the hash at SCORING time. We only update it on a
    // fresh run (startRun:true) — saving the description without scoring leaves
    // descriptionHash alone so the cache freshness check correctly reports
    // "stale" rather than spuriously matching.
    //
    // Three modes:
    //   startRun:true         hard reset — wipe LM scores, set run metadata
    //   resumeRun:true        soft start — preserve scores, mark in_progress
    //   (neither)             save description only (soft-stale)
    //
    // Validate mode constraints BEFORE any mutation so a 4xx response leaves
    // both in-memory state and disk untouched.
    if (body.startRun && body.resumeRun) {
      return json(res, { ok: false, error: 'startRun and resumeRun are mutually exclusive' }, 400);
    }
    if (body.resumeRun && oldScoredHash && oldScoredHash !== newHash) {
      // Resume would silently splice new-description scores into a result set
      // keyed off an older description's hash — i.e. mix two analyses that
      // were never directly compared. Force the caller to either re-analyze
      // (clear cache) or revert the description before resuming.
      return json(res, {
        ok: false,
        error: 'Description has changed since the cached run — resuming would mix scores from different descriptions. Re-analyze to refresh, or revert the description.',
        code: 'DESC_CHANGED_DURING_RESUME',
        scoredDescriptionHash: oldScoredHash,
        currentDescriptionHash: newHash,
      }, 409);
    }
    proj.analysisDesc = newDesc;
    proj._analysis = proj._analysis || {};
    proj._analysis.eccVersion = verId;
    if (body.startRun) {
      // Hard reset: discard prior LM scoring fields and start clean.
      const cleared = stateStore.clearLmAnalysisFields({
        analysis: proj._analysis,
        components: proj.components || {},
      });
      proj._analysis = { ...proj._analysis, ...cleared.analysis };
      proj.components = cleared.components;
      proj._analysis.descriptionHash = newHash;
      proj._analysis.catalogHash = catalogHash;
      proj._analysis.status = 'in_progress';
      proj._analysis.totalItems = typeof body.totalItems === 'number' ? body.totalItems : totalCandidates;
      proj._analysis.completedItems = 0;
      proj._analysis.failedItems = 0;
      proj._analysis.startedAt = new Date().toISOString();
      proj._analysis.updatedAt = proj._analysis.startedAt;
      proj._analysis.completedAt = null;
      if (typeof body.threshold === 'number') proj._analysis.thresholdAtRun = body.threshold;
      if (body.lmStudio) proj._analysis.lmStudio = body.lmStudio;
    } else if (body.resumeRun) {
      // Soft resume: keep all existing scores, just bump run metadata so the
      // UI reflects "in progress." Used by Analyze Missing/Failed — wiping
      // here would erase the very results the user explicitly wants to keep.
      proj._analysis.status = 'in_progress';
      proj._analysis.updatedAt = new Date().toISOString();
      proj._analysis.completedAt = null;
      // descriptionHash + catalogHash stay as recorded at the original run.
      // If totalItems looks stale, refresh to current candidate count.
      if (typeof body.totalItems === 'number') {
        proj._analysis.totalItems = body.totalItems;
      } else if (totalCandidates > (proj._analysis.totalItems || 0)) {
        proj._analysis.totalItems = totalCandidates;
      }
      if (typeof body.threshold === 'number') proj._analysis.thresholdAtRun = body.threshold;
      if (body.lmStudio) proj._analysis.lmStudio = body.lmStudio;
    }
    await saveProjectShard(name);
    const mode = body.startRun ? 'start' : (body.resumeRun ? 'resume' : 'desc');
    diag(`lm.run.${mode === 'desc' ? 'desc.save' : mode}`);
    log('info', `lm-cache description saved for [${name}]`, { descChanged, mode });
    return json(res, {
      ok: true,
      descriptionChanged: descChanged,
      currentDescriptionHash: newHash,
      scoredDescriptionHash: proj._analysis.descriptionHash || null,
      catalogHash,
      analysis: proj._analysis,
    });
  }

  // POST /api/projects/:name/lmstudio/result — persist one LM result immediately.
  // Body: { componentId, relPath?, type?, name?, matchingPerc, reasoning, status }
  const lmResultMatch = p.match(/^\/api\/projects\/([^/]+)\/lmstudio\/result$/);
  if (lmResultMatch && req.method === 'POST') {
    const name = lmResultMatch[1];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const body = await parseBody(req);
    const state = loadState();
    const proj = state.projects[name];
    if (!proj) return json(res, { ok: false, error: 'Not found' }, 404);
    if (!body.componentId) return json(res, { ok: false, error: 'Missing componentId' }, 400);
    const analysis = proj._analysis || {};
    const result = {
      componentId: body.componentId,
      relPath: body.relPath || null,
      type: body.type || null,
      name: body.name || null,
      matchingPerc: typeof body.matchingPerc === 'number' ? body.matchingPerc : 0,
      reasoning: body.reasoning || '',
      status: body.status || 'complete',
      analysisHash: analysis.descriptionHash || null,
      catalogHash: analysis.catalogHash || null,
      analyzedAt: new Date().toISOString(),
    };
    const shardLike = { analysis: proj._analysis || {}, components: proj.components || {} };
    stateStore.applyLmAnalysisResult(shardLike, result);
    proj._analysis = shardLike.analysis;
    proj.components = shardLike.components;
    await saveProjectShard(name);
    diag(result.status === 'failed' ? 'lm.result.failed' : 'lm.result.saved');
    return json(res, { ok: true, component: shardLike.components[body.componentId], analysis: proj._analysis });
  }

  // POST /api/projects/:name/lmstudio/results — batch-save LM results.
  // Body: { results: [...] }
  const lmResultsMatch = p.match(/^\/api\/projects\/([^/]+)\/lmstudio\/results$/);
  if (lmResultsMatch && req.method === 'POST') {
    const name = lmResultsMatch[1];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const body = await parseBody(req);
    const state = loadState();
    const proj = state.projects[name];
    if (!proj) return json(res, { ok: false, error: 'Not found' }, 404);
    const analysis = proj._analysis || {};
    const shardLike = { analysis, components: proj.components || {} };
    const incoming = Array.isArray(body.results) ? body.results : [];
    const saved = [];
    for (const r of incoming) {
      if (!r || !r.componentId) continue;
      stateStore.applyLmAnalysisResult(shardLike, {
        ...r,
        analysisHash: r.analysisHash || analysis.descriptionHash || null,
        catalogHash: r.catalogHash || analysis.catalogHash || null,
        analyzedAt: r.analyzedAt || new Date().toISOString(),
      });
      saved.push(r.componentId);
    }
    proj._analysis = shardLike.analysis;
    proj.components = shardLike.components;
    await saveProjectShard(name);
    return json(res, { ok: true, saved, analysis: proj._analysis });
  }

  // POST /api/projects/:name/lmstudio/clear-cache — wipe LM scores for project/version.
  const lmClearMatch = p.match(/^\/api\/projects\/([^/]+)\/lmstudio\/clear-cache$/);
  if (lmClearMatch && req.method === 'POST') {
    const name = lmClearMatch[1];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const state = loadState();
    const proj = state.projects[name];
    if (!proj) return json(res, { ok: false, error: 'Not found' }, 404);
    const shardLike = { analysis: proj._analysis || {}, components: proj.components || {} };
    stateStore.clearLmAnalysisFields(shardLike);
    proj._analysis = shardLike.analysis;
    proj.components = shardLike.components;
    await saveProjectShard(name);
    diag('lm.cache.clear');
    log('info', `lm-cache cleared for [${name}]`);
    return json(res, { ok: true });
  }

  // POST /api/projects/:name/lmstudio/mark-complete — finalize an analysis run.
  // Body: { status?: complete|partial }
  const lmMarkMatch = p.match(/^\/api\/projects\/([^/]+)\/lmstudio\/mark-complete$/);
  if (lmMarkMatch && req.method === 'POST') {
    const name = lmMarkMatch[1];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const body = await parseBody(req);
    const state = loadState();
    const proj = state.projects[name];
    if (!proj) return json(res, { ok: false, error: 'Not found' }, 404);
    proj._analysis = proj._analysis || {};
    const status = body.status === 'partial' ? 'partial' : 'complete';
    proj._analysis.status = status;
    const now = new Date().toISOString();
    proj._analysis.updatedAt = now;
    if (status === 'complete') proj._analysis.completedAt = now;
    await saveProjectShard(name);
    diag(`lm.run.${status}`);
    log('info', `lm-cache run ${status} for [${name}]`);
    return json(res, { ok: true, analysis: proj._analysis });
  }

  // POST /api/open-folder — open a directory in the OS file browser
  if (p === '/api/open-folder' && req.method === 'POST') {
    const body = await parseBody(req);
    const target = body.path;
    if (!target || !path.isAbsolute(target)) return json(res, { ok: false, error: 'Invalid path' }, 400);
    // Prevent path traversal outside allowed dirs
    const allowed = [PROJECTS_DIR, require('os').homedir()];
    if (!allowed.some(a => target.startsWith(a))) return json(res, { ok: false, error: 'Path not allowed' }, 403);
    ensureDir(target);
    let openBin, openArgs;
    if (process.platform === 'win32')        { openBin = 'explorer'; openArgs = [target]; }
    else if (process.platform === 'darwin')  { openBin = 'open';     openArgs = [target]; }
    else                                     { openBin = 'xdg-open'; openArgs = [target]; }
    try { spawnSync(openBin, openArgs, { timeout: 5000 }); } catch {}
    return json(res, { ok: true });
  }

  // GET /api/pick-folder — show native folder picker dialog (macOS only)
  if (p === '/api/pick-folder' && req.method === 'GET') {
    if (process.platform !== 'darwin') return json(res, { ok: false, error: 'Folder picker only supported on macOS' }, 400);
    try {
      const pickResult = spawnSync(
        'osascript', ['-e', 'POSIX path of (choose folder with prompt "Select deployment folder:")'],
        { timeout: 60000 }
      );
      if (pickResult.status !== 0) return json(res, { ok: false, cancelled: true });
      const chosen = pickResult.stdout.toString().trim();
      return json(res, { ok: true, path: chosen });
    } catch (e) {
      return json(res, { ok: false, cancelled: true });
    }
  }

  // POST /api/deploy
  if (p === '/api/deploy' && req.method === 'POST') {
    const body = await parseBody(req);
    const state = loadState();
    const proj  = state.projects[body.project];
    if (!proj)                          return json(res, { ok: false, error: 'Project not found' }, 404);
    if (!proj.deployPath)               return json(res, { ok: false, error: 'No deployPath set.' }, 400);
    if (!path.isAbsolute(proj.deployPath))
      return json(res, { ok: false, error: 'deployPath must be an absolute path.' }, 400);
    // Auto-create the deploy directory if it doesn't exist
    ensureDir(proj.deployPath);
    const src = projectDir(body.project);
    if (!fs.existsSync(src))            return json(res, { ok: false, error: '.claude/ directory is empty — install some components first.' }, 400);
    const dest = path.join(proj.deployPath, '.claude');
    copyRecursive(src, dest);
    // Never deploy .backups — strip it from the destination if it was copied
    const deployedBackups = path.join(dest, '.backups');
    if (fs.existsSync(deployedBackups)) fs.rmSync(deployedBackups, { recursive: true, force: true });

    // Relocate root-targeted components (deployRoot: 'project') out of .claude/
    // and into the deploy path itself, because tools like Cursor / Codex /
    // Gemini / OpenCode read their configs from the project root, not from a
    // nested .claude/ subdirectory. Two sources contribute root targets:
    //   1. ECC-installed components whose catalog entry has deployRoot: 'project'.
    //   2. Custom components applied to a project-root path (e.g. .agents/...).
    const deployCat = getCatalogForProject(proj, loadState());
    const rootTargets = new Set();
    for (const [id, entry] of Object.entries(proj.components || {})) {
      if (!entry || !entry.installed) continue;
      const comp = deployCat.find(c => c.id === id);
      if (!comp || comp.deployRoot !== 'project' || !comp.sourcePath) continue;
      rootTargets.add(comp.sourcePath);
    }
    for (const [, entry] of Object.entries(proj.customComponents || {})) {
      if (!entry || entry.deployRoot !== 'project' || !entry.targetPath) continue;
      rootTargets.add(entry.targetPath);
    }
    // Two-pass relocation. Pass 1 snapshots EVERY pre-existing file we'd
    // overwrite. If any snapshot fails, abort before touching any of the
    // real project-root files — the recoverability promise would otherwise
    // be a lie. Pass 2 actually does the relocation only after all snapshots
    // succeeded.
    const stagingBackupsDir = path.join(src, '.backups');
    const allBackups = [];
    const allFailures = [];
    for (const rel of rootTargets) {
      const insideClaude = path.join(dest, rel);
      const atRoot       = path.join(proj.deployPath, rel);
      if (!fs.existsSync(insideClaude)) continue;
      const result = backupDeployTargets(insideClaude, atRoot, stagingBackupsDir, rel);
      allBackups.push(...result.created);
      allFailures.push(...result.failed);
    }
    if (allFailures.length > 0) {
      log('error', `deploy [${body.project}] aborted before relocation: ${allFailures.length} preflight failure(s)`);
      const hasTypeConflict = allFailures.some(f => /type conflict/i.test(f.error || ''));
      const detail = hasTypeConflict
        ? 'A custom component target conflicts with a file/directory of the wrong type at the deploy path (e.g. component is a file but the project has a directory there). Rename the conflicting target or remove the offending path, then re-run deploy.'
        : 'Resolve the underlying error (disk full, permissions, missing parent dir) and re-run deploy.';
      return json(res, {
        ok: false,
        error: `Deploy aborted: ${allFailures.length} preflight failure(s) on project-root targets. The real project-root files are unchanged. ${detail}`,
        backupFailures: allFailures.map(f => ({ src: f.src, error: f.error })),
        deployedTo: null,
      }, 500);
    }
    if (allBackups.length) {
      log('info', `deploy [${body.project}] backed up ${allBackups.length} pre-existing project-root file(s)`);
    }
    for (const rel of rootTargets) {
      const insideClaude = path.join(dest, rel);
      const atRoot       = path.join(proj.deployPath, rel);
      if (!fs.existsSync(insideClaude)) continue;
      copyRecursive(insideClaude, atRoot);
      removeTarget(insideClaude);
    }

    // NOTE: deploy used to call `copyEccRootFiles(dVDir, dest)` here to
    // auto-materialize AGENTS.md / agent.yaml from the active ECC version
    // when the deploy target was missing them. With the managed-doc workflow
    // that's now a footgun: a user replacing CLAUDE.md and triggering an
    // auto-deploy would see AGENTS.md silently appear in the project's
    // .claude/ (especially when the deploy path == staging area), and the
    // right-panel would list it as "installed" without the user ever asking.
    // The install endpoint still auto-copies these files when an agent or
    // skill is installed (see /api/install), and the user can populate
    // AGENTS.md explicitly from the editor's Replace With ECC Default
    // action. Deploy itself now only carries what's already in staging.

    // Lock the path after first successful deploy
    if (!proj.pathLocked) {
      proj.pathLocked = true;
      saveState(state);
    }
    log('info', `deploy [${body.project}] → ${dest}`);
    return json(res, { ok: true, deployedTo: dest, pathLocked: true });
  }

  // GET /api/settings/catalog
  if (p === '/api/settings/catalog' && req.method === 'GET') {
    const cat = loadSettingsCatalog();
    return json(res, { ok: true, catalog: cat });
  }

  // GET /api/projects/:name/settings
  const projSettingsMatch = p.match(/^\/api\/projects\/([^/]+)\/settings$/);
  if (projSettingsMatch && req.method === 'GET') {
    const name = projSettingsMatch[1];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const state = loadState();
    if (!state.projects[name]) return json(res, { ok: false, error: 'Project not found' }, 404);
    const s = readSettings(name);
    const cat = loadSettingsCatalog();
    const installedSettings = {};
    for (const entry of cat.settings) {
      const vPath = entry.valuePath || entry.settingKey;
      if (!vPath) continue;
      const val = getNestedPath(s, vPath);
      if (val !== undefined) installedSettings[entry.id] = { installed: true, value: val };
    }
    for (const entry of STATIC_SETTINGS) {
      const vPath = entry.valuePath || entry.settingKey;
      if (!vPath) continue;
      const val = getNestedPath(s, vPath);
      if (val !== undefined) installedSettings[entry.id] = { installed: true, value: val };
    }
    return json(res, { ok: true, settings: s, installedSettings });
  }

  // POST /api/projects/:name/settings/apply
  const projSettingsApplyMatch = p.match(/^\/api\/projects\/([^/]+)\/settings\/apply$/);
  if (projSettingsApplyMatch && req.method === 'POST') {
    const name = projSettingsApplyMatch[1];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const body = await parseBody(req);
    const { id, value } = body;
    if (typeof id !== 'string' || !id) return json(res, { ok: false, error: 'Missing setting id' }, 400);
    if (value === undefined) return json(res, { ok: false, error: 'Missing value' }, 400);
    const state = loadState();
    if (!state.projects[name]) return json(res, { ok: false, error: 'Project not found' }, 404);
    const entry = findCatalogEntry(id);
    if (!entry) return json(res, { ok: false, error: 'Setting not found in catalog' }, 400);
    if (entry.status === 'managed-only' || entry.status === 'global') {
      return json(res, { ok: false, error: 'This setting cannot be written by ECC Manager.' }, 400);
    }
    // Server-side type coercion validation
    if (entry.inputType === 'number' && typeof value !== 'number') {
      return json(res, { ok: false, error: 'Expected a number' }, 400);
    }
    if (entry.inputType === 'boolean' && typeof value !== 'boolean') {
      return json(res, { ok: false, error: 'Expected a boolean' }, 400);
    }
    if (entry.inputType === 'select' && entry.options && !entry.options.includes(value)) {
      return json(res, { ok: false, error: `Value must be one of: ${entry.options.join(', ')}` }, 400);
    }
    if (['json-array', 'string-array', 'permission-array'].includes(entry.inputType) && !Array.isArray(value)) {
      return json(res, { ok: false, error: 'Expected an array' }, 400);
    }
    if (entry.inputType === 'json-object' && (typeof value !== 'object' || Array.isArray(value) || value === null)) {
      return json(res, { ok: false, error: 'Expected an object' }, 400);
    }
    const s = readSettings(name);
    const vPath = entry.valuePath || entry.settingKey;
    setNestedPath(s, vPath, value);
    writeSettings(name, s);
    state.projects[name].components[id] = { installed: true, installedAt: new Date().toISOString(), value };
    saveState(state);
    log('info', `setting/apply [${name}] ${vPath} = ${JSON.stringify(value)}`);
    return json(res, { ok: true });
  }

  // POST /api/projects/:name/settings/remove
  const projSettingsRemoveMatch = p.match(/^\/api\/projects\/([^/]+)\/settings\/remove$/);
  if (projSettingsRemoveMatch && req.method === 'POST') {
    const name = projSettingsRemoveMatch[1];
    if (!safeName(name)) return json(res, { ok: false, error: 'Invalid project name' }, 400);
    const body = await parseBody(req);
    const { id } = body;
    if (typeof id !== 'string' || !id) return json(res, { ok: false, error: 'Missing setting id' }, 400);
    const state = loadState();
    if (!state.projects[name]) return json(res, { ok: false, error: 'Project not found' }, 404);
    const entry = findCatalogEntry(id);
    if (!entry) return json(res, { ok: false, error: 'Setting not found in catalog' }, 400);
    const s = readSettings(name);
    const vPath = entry.valuePath || entry.settingKey;
    deleteNestedPath(s, vPath);
    writeSettings(name, s);
    // Always sync state.json regardless of whether the component was previously tracked
    state.projects[name].components[id] = { installed: false, installedAt: null };
    saveState(state);
    log('info', `setting/remove [${name}] ${vPath}`);
    return json(res, { ok: true });
  }

  // POST /api/settings (legacy — used by recommended settings apply buttons)
  if (p === '/api/settings' && req.method === 'POST') {
    const body = await parseBody(req);
    const { project: projName, id, value } = body;
    const comp = findCatalogEntry(id);
    if (!comp) return json(res, { ok: false, error: 'Setting not found' }, 400);
    if (comp.status === 'managed-only' || comp.status === 'global') {
      return json(res, { ok: false, error: 'This setting cannot be applied from ECC Manager.' }, 400);
    }
    const state = loadState();
    if (!state.projects[projName]) return json(res, { ok: false, error: 'Project not found' }, 404);
    const s = readSettings(projName);
    const vPath = comp.valuePath || comp.settingKey;
    setNestedPath(s, vPath, value);
    writeSettings(projName, s);
    state.projects[projName].components[id] = { installed: true, installedAt: new Date().toISOString(), value };
    saveState(state);
    log('info', `setting [${projName}] ${vPath} = ${value}`);
    return json(res, { ok: true });
  }

  // GET /api/diagnostics — local-only counter snapshot for support + product metrics.
  // No PII, no network egress; surfaces what /api/* events have fired this session.
  if (p === '/api/diagnostics' && req.method === 'GET') {
    return json(res, {
      ok: true,
      bootedAt: _diagBootedAt,
      uptime: process.uptime(),
      counters: { ..._diagCounters },
      stateDir: stateStore.stateDir(),
      indexPath: stateStore.indexStatePath(),
    });
  }

  // GET /api/migration-status — one-shot signal so the UI can show a banner
  // after a legacy → sharded migration. ?ack=1 clears the flag.
  if (p === '/api/migration-status' && req.method === 'GET') {
    if (url.searchParams.get('ack') === '1') {
      const cleared = _lastMigration;
      _lastMigration = null;
      return json(res, { ok: true, migrated: false, cleared });
    }
    if (!_lastMigration) return json(res, { ok: true, migrated: false });
    return json(res, { ok: true, migrated: true, ..._lastMigration });
  }

  if (p === '/health' && req.method === 'GET') {
    return json(res, { ok: true, uptime: process.uptime() });
  }

  json(res, { error: 'Not found' }, 404);
});

if (require.main === module) {
  ensureDir(PROJECTS_DIR);
  ensureDir(VERSIONS_DIR);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Error: port ${PORT} is already in use.`);
      console.error(`  Kill the other process or change PORT in server.js.\n`);
      process.exit(1);
    }
    throw err;
  });

  const shutdown = () => {
    const t = setTimeout(() => process.exit(1), 5000);
    t.unref();
    server.close(() => { clearTimeout(t); process.exit(0); });
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (reason) => {
    log('error', `Unhandled rejection: ${reason}`);
  });

  server.listen(PORT, () => {
    console.log(`\n  ECC Manager  http://localhost:${PORT}`);
    console.log(`  Versions     ${VERSIONS_DIR}`);
    console.log(`  Projects     ${PROJECTS_DIR}`);
    console.log(`  ~/.claude/   NOT TOUCHED\n`);
  });
}

module.exports = {
  // settings
  safeName,
  getNestedPath,
  setNestedPath,
  deleteNestedPath,
  readSettings,
  writeSettings,
  loadSettingsCatalog,
  saveSettingsCatalogMeta,
  findCatalogEntry,
  _resetCatalogCache: () => { _settingsCatalog = null; },
  _resetVersionCatalogCache: () => { Object.keys(_catalogCache).forEach(k => delete _catalogCache[k]); },
  // state
  loadState,
  saveState,
  saveProjectShard,
  _resetStateCache: () => { _stateCache = null; _shardCacheByName = {}; },
  // expose state-store helpers needed by routes / tests
  stateStore,
  // file utils
  ensureDir,
  copyRecursive,
  removeTarget,
  copyEccRootFiles,
  getEccDefaultClaudeMd,
  getClaudeMdStatus,
  backupProjectClaudeMd,
  listProjectClaudeMdBackups,
  // managed docs (CLAUDE.md / AGENTS.md)
  MANAGED_DOCS,
  MANAGED_DOC_KEYS,
  getManagedDocConfig,
  getProjectManagedDocPath,
  getEccDefaultManagedDoc,
  getManagedDocStatus,
  backupProjectManagedDoc,
  listProjectManagedDocBackups,
  readProjectManagedDocMeta,
  writeProjectManagedDocMeta,
  backupNamePattern,
  // shared library
  SHARED_DOC_KEYS,
  SHARED_DOC_KIND_DIRS,
  CUSTOM_COMPONENT_KINDS,
  MARKDOWN_COMPONENT_KINDS,
  JSON_COMPONENT_KINDS,
  sharedDir,
  sharedDocDir,
  _resetLegacySkillTemplatesFlag: () => { _legacySkillTemplatesMigrated = false; },
  sharedComponentKindDir,
  sharedComponentEntryDir,
  safeSharedFileName,
  safeSharedSlug,
  safeSharedSlugPattern,
  assertPathInside,
  listSharedDocs,
  readSharedDoc,
  writeSharedDoc,
  updateSharedDoc,
  deleteSharedDoc,
  customComponentId,
  defaultTargetForCustom,
  listCustomComponents,
  readCustomComponent,
  writeCustomComponent,
  updateCustomComponent,
  deleteCustomComponent,
  validateCustomComponentContent,
  resolveApplyTargetPath,
  isProjectRootDeployTarget,
  PROJECT_ROOT_DEPLOY_DIRS,
  detectApplyCollision,
  backupDeployTargets,
  classifyBackupName,
  listAllProjectBackups,
  applyMarkdownComponent,
  applyJsonComponent,
  canonicalJson,
  hashHookEntry,
  mergeHooksPayload,
  mergeMcpPayload,
  // catalog scan
  readFrontmatter,
  scanCatalog,
  scanCatalogV2,
  walkMarkdownLeaves,
  relPathToLeafSlug,
  migrateV2ModuleInstallsToLeaves,
  getCatalog,
  clientComp,
  resolveVersion,
  kindPriority,
  getVersionId,
  nodeFetch,
  // install / remove
  installComponent,
  removeComponent,
  projectSummary,
  // http utils
  parseBody,
  // path helpers
  projectDir,
  versionDir,
  // constants
  PROJECTS_DIR,
  VERSIONS_DIR,
  STATE_FILE,           // legacy single-file location (pre-shard)
  SETTINGS_CATALOG_FILE,
  // Resolved at call time so env-var overrides take effect for tests.
  get INDEX_STATE_FILE() { return stateStore.indexStatePath(); },
  get STATE_DIR()        { return stateStore.stateDir(); },
  // The HTTP server is exported so integration tests can listen on an
  // ephemeral port via server.listen(0) without binding to PORT.
  server,
};
