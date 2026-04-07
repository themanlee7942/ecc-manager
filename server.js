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
const { execSync } = require('child_process');

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
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const PORT         = 7700;
const ROOT         = __dirname;
const PROJECTS_DIR = path.join(ROOT, 'projects');
const VERSIONS_DIR = path.join(PROJECTS_DIR, '.ecc-versions');
const STATE_FILE   = path.join(ROOT, 'state.json');
const HTML_FILE    = path.join(ROOT, 'index.html');

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
    const hash = execSync(`git -C "${dir}" rev-parse --short HEAD`, { timeout: 5000 }).toString().trim();
    return `${new Date().toISOString().split('T')[0]}-${hash}`;
  } catch {}
  return `pull-${Date.now()}`;
}

const _catalogCache = {};

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
    } catch {}
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
    } catch {}
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

  // Skills: skills/*/* — individual files within each skill directory
  const skillsDir = path.join(vDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    fs.readdirSync(skillsDir).sort().forEach(skill => {
      const skillDir = path.join(skillsDir, skill);
      try { if (!fs.statSync(skillDir).isDirectory()) return; } catch { return; }
      const skillFm = readFrontmatter(path.join(skillDir, 'SKILL.md'));
      fs.readdirSync(skillDir).sort().forEach(f => {
        const filePath = path.join(skillDir, f);
        try { if (fs.statSync(filePath).isDirectory()) return; } catch { return; }
        const fileFm = f === 'SKILL.md' ? skillFm : readFrontmatter(filePath);
        items.push({
          id: `skill-${skill}-${f.replace(/\.[^.]+$/, '')}`,
          type: 'skill', priority: 6,
          name: f,
          description: fileFm.description || skillFm.description || `${skill}/${f}`,
          sourcePath: `skills/${skill}/${f}`,
          targetPath: `skills/${skill}/${f}`,
        });
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

function getCatalog(vDir, verId) {
  if (!_catalogCache[verId]) _catalogCache[verId] = scanCatalog(vDir);
  return _catalogCache[verId];
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

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(level, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const lvl = level.toUpperCase().padEnd(5);
  console.log(`[${ts}] [${lvl}] ${msg}`);
}

// ─── Version Utilities ────────────────────────────────────────────────────────


function versionDir(verId) {
  return path.join(VERSIONS_DIR, verId);
}

// ─── State ────────────────────────────────────────────────────────────────────

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    const s = { versions: {}, activeVersion: null, projects: {} };
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
    return s;
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    const backup = STATE_FILE + '.bak.' + Date.now();
    fs.copyFileSync(STATE_FILE, backup);
    console.error(`[warn] state.json corrupted — reset to empty. Backup saved: ${backup}`);
    const s = { versions: {}, activeVersion: null, projects: {} };
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
    return s;
  }
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function projectDir(name) {
  return path.join(PROJECTS_DIR, name, '.claude');
}

function initProjectComponents() { return {}; }

// ─── File Utils ───────────────────────────────────────────────────────────────

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// Copy root ECC files (AGENTS.md, agent.yaml) into a .claude/ dir, skip if already present
const ECC_ROOT_FILES = ['AGENTS.md', 'agent.yaml'];
function copyEccRootFiles(vDir, claudeDir) {
  ECC_ROOT_FILES.forEach(f => {
    const src  = path.join(vDir, f);
    const dest = path.join(claudeDir, f);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      ensureDir(claudeDir);
      fs.copyFileSync(src, dest);
      log('info', `copied ${f} → ${dest}`);
    }
  });
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

function readSettings(projName) {
  const f = path.join(projectDir(projName), 'settings.json');
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; }
}

function writeSettings(projName, s) {
  ensureDir(projectDir(projName));
  fs.writeFileSync(path.join(projectDir(projName), 'settings.json'), JSON.stringify(s, null, 2));
}

// ─── Install / Remove ─────────────────────────────────────────────────────────

function installComponent(comp, projName, state) {
  const now  = new Date().toISOString();
  const proj = state.projects[projName];

  if (comp.type === 'setting') {
    const s = readSettings(projName);
    const parts = comp.settingKey.split('.');
    if (parts.length === 1) s[parts[0]] = comp.defaultValue;
    else { if (!s[parts[0]]) s[parts[0]] = {}; s[parts[0]][parts[1]] = comp.defaultValue; }
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

  const src = path.join(versionDir(verId), comp.sourcePath);
  const dst = path.join(projectDir(projName), comp.targetPath);
  if (!copyRecursive(src, dst)) {
    return { ok: false, error: `Not found in version ${verId}: ${comp.sourcePath}` };
  }

  proj.components[comp.id] = { installed: true, installedAt: now };
  return { ok: true };
}

function removeComponent(comp, projName, state) {
  const proj = state.projects[projName];

  if (comp.type === 'setting') {
    const s = readSettings(projName);
    const parts = comp.settingKey.split('.');
    if (parts.length === 1) delete s[parts[0]];
    else if (s[parts[0]]) delete s[parts[0]][parts[1]];
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
    } catch {}
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
    } catch {}
    proj.components[comp.id] = { installed: false, installedAt: null };
    return { ok: true };
  }

  removeTarget(path.join(projectDir(projName), comp.targetPath));
  proj.components[comp.id] = { installed: false, installedAt: null };
  return { ok: true };
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function safeName(n) { return /^[a-zA-Z0-9_-]+$/.test(n); }

function projectSummary(proj) {
  const installedCount = Object.values(proj.components || {}).filter(v => v.installed).length;
  return { installedCount };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p   = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*',
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
    const components = hasEcc ? getCatalog(vDir, qv) : [...STATIC_SETTINGS];
    return json(res, { components, needsEcc: !hasEcc });
  }

  // GET /api/versions
  if (p === '/api/versions' && req.method === 'GET') {
    const state = loadState();
    return json(res, { versions: state.versions || {}, activeVersion: state.activeVersion });
  }

  // POST /api/pull-version — clone/pull into new versioned folder
  if (p === '/api/pull-version' && req.method === 'POST') {
    const tmpDir = path.join(VERSIONS_DIR, '_tmp_pull');
    log('info', 'pull-version: cloning ECC repo…');
    try {
      ensureDir(VERSIONS_DIR);
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      execSync(`git clone https://github.com/affaan-m/everything-claude-code.git "${tmpDir}"`, { timeout: 180000, stdio: 'pipe' });
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
      ...pr,
      ...projectSummary(pr),
    }));
    return json(res, { projects, versions: state.versions || {}, activeVersion: state.activeVersion, projectsDir: PROJECTS_DIR });
  }

  // POST /api/projects
  if (p === '/api/projects' && req.method === 'POST') {
    const body = await parseBody(req);
    const { name, description = '', deployPath = '', eccVersion } = body;
    if (!name || !safeName(name)) return json(res, { ok: false, error: 'Invalid name. Use letters, numbers, hyphens, underscores.' }, 400);
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
    return json(res, { ok: true, project: state.projects[name] });
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
    if (body.description  !== undefined) state.projects[name].description  = body.description;
    if (body.deployPath   !== undefined) state.projects[name].deployPath   = body.deployPath;
    if (body.eccVersion   !== undefined) state.projects[name].eccVersion   = body.eccVersion;
    if (body.analysisDesc !== undefined) state.projects[name].analysisDesc = body.analysisDesc;
    if (body.pathLocked   !== undefined) state.projects[name].pathLocked   = body.pathLocked;
    saveState(state);
    return json(res, { ok: true });
  }

  // GET/POST /api/projects/:name/claudemd
  const claudeMdMatch = p.match(/^\/api\/projects\/([^/]+)\/claudemd$/);
  if (claudeMdMatch && req.method === 'GET') {
    const name  = claudeMdMatch[1];
    const fpath = path.join(projectDir(name), 'CLAUDE.md');
    const content = fs.existsSync(fpath) ? fs.readFileSync(fpath, 'utf8') : null;
    return json(res, { ok: true, content });
  }
  if (claudeMdMatch && req.method === 'POST') {
    const name  = claudeMdMatch[1];
    const body  = await parseBody(req);
    const fpath = path.join(projectDir(name), 'CLAUDE.md');
    ensureDir(projectDir(name));
    fs.writeFileSync(fpath, body.content || '', 'utf8');
    log('info', `CLAUDE.md saved for [${name}]`);
    return json(res, { ok: true });
  }

  // GET /api/projects/:name
  if (projMatch && req.method === 'GET') {
    const name = projMatch[1];
    const state = loadState();
    if (!state.projects[name]) return json(res, { ok: false, error: 'Not found' }, 404);
    const proj  = state.projects[name];
    const cat   = getCatalogForProject(proj, state);
    const components = cat.map(c => ({
      ...c,
      installed:   proj.components[c.id]?.installed   || false,
      installedAt: proj.components[c.id]?.installedAt || null,
      value:       proj.components[c.id]?.value       || null,
    }));
    return json(res, { project: proj, components, summary: projectSummary(proj) });
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
      const { vDir: iVDir } = resolveVersion(state.projects[projName], state);
      if (iVDir) copyEccRootFiles(iVDir, projectDir(projName));
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
    const state = loadState();
    state.lmStudio = { serverUrl: body.serverUrl || '', lmApiToken: body.lmApiToken || '', threshold: Number(body.threshold) || 80 };
    saveState(state);
    return json(res, { ok: true });
  }

  // GET /api/lmstudio/status — server-side health probe via v1 API (no CORS issue)
  if (p === '/api/lmstudio/status' && req.method === 'GET') {
    const state = loadState();
    const base  = (state.lmStudio?.serverUrl || 'http://localhost:1234/v1/chat/completions').replace(/\/v1\/.*$/, '');
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
    const vDir  = versionDir(verId);
    if (!fs.existsSync(vDir)) return json(res, { ok: false, error: 'Version not found' }, 404);

    const files = [];

    function readFile(relPath) {
      try { return fs.readFileSync(path.join(vDir, relPath), 'utf8'); } catch { return ''; }
    }

    // Agents
    const agentsDir = path.join(vDir, 'agents');
    if (fs.existsSync(agentsDir)) {
      fs.readdirSync(agentsDir).sort().filter(f => f.endsWith('.md')).forEach(f => {
        files.push({ type: 'agent', name: f, relPath: `agents/${f}`, content: readFile(`agents/${f}`) });
      });
    }

    // Skills: individual files within each skill directory
    const skillsDir = path.join(vDir, 'skills');
    if (fs.existsSync(skillsDir)) {
      fs.readdirSync(skillsDir).sort().forEach(skill => {
        const skillDir = path.join(skillsDir, skill);
        try { if (!fs.statSync(skillDir).isDirectory()) return; } catch { return; }
        fs.readdirSync(skillDir).sort().forEach(f => {
          const fp = path.join(skillDir, f);
          try { if (fs.statSync(fp).isDirectory()) return; } catch { return; }
          files.push({ type: 'skill', name: f, relPath: `skills/${skill}/${f}`, content: fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '' });
        });
      });
    }

    // Commands
    const commandsDir = path.join(vDir, 'commands');
    if (fs.existsSync(commandsDir)) {
      fs.readdirSync(commandsDir).sort().filter(f => f.endsWith('.md')).forEach(f => {
        files.push({ type: 'command', name: f, relPath: `commands/${f}`, content: readFile(`commands/${f}`) });
      });
    }

    // Rules: individual .md files within each rules/ subdirectory
    const rulesDir = path.join(vDir, 'rules');
    if (fs.existsSync(rulesDir)) {
      fs.readdirSync(rulesDir).sort().forEach(lang => {
        const langDir = path.join(rulesDir, lang);
        try { if (!fs.statSync(langDir).isDirectory()) return; } catch { return; }
        fs.readdirSync(langDir).sort().filter(f => f.endsWith('.md')).forEach(f => {
          const fp = path.join(langDir, f);
          files.push({ type: 'rule', name: f, relPath: `rules/${lang}/${f}`, content: fs.readFileSync(fp, 'utf8') });
        });
      });
    }

    // Hooks (one entry per hook from hooks.json)
    const hooksFile = path.join(vDir, 'hooks', 'hooks.json');
    if (fs.existsSync(hooksFile)) {
      try {
        const hd = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
        Object.entries(hd.hooks || {}).forEach(([event, entries]) => {
          (entries || []).forEach(entry => {
            files.push({ type: 'hook', name: entry.id || event, relPath: 'hooks/hooks.json', content: `[${event}] ${entry.description || entry.id}` });
          });
        });
      } catch {}
    }

    // MCP servers
    const mcpFile = path.join(vDir, 'mcp-configs', 'mcp-servers.json');
    if (fs.existsSync(mcpFile)) {
      try {
        const md = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
        Object.entries(md.mcpServers || {}).forEach(([key, cfg]) => {
          files.push({ type: 'mcp', name: key, relPath: `mcp-configs/mcp-servers.json#${key}`, content: `MCP Server: ${key}\n${cfg.description || ''}\nEnv: ${Object.keys(cfg.env || {}).join(', ')}` });
        });
      } catch {}
    }

    return json(res, { ok: true, files });
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
    const cmd = process.platform === 'win32' ? `explorer "${target}"` : process.platform === 'darwin' ? `open "${target}"` : `xdg-open "${target}"`;
    try { execSync(cmd, { timeout: 5000 }); } catch {}
    return json(res, { ok: true });
  }

  // GET /api/pick-folder — show native folder picker dialog (macOS only)
  if (p === '/api/pick-folder' && req.method === 'GET') {
    if (process.platform !== 'darwin') return json(res, { ok: false, error: 'Folder picker only supported on macOS' }, 400);
    try {
      const chosen = execSync(
        `osascript -e 'POSIX path of (choose folder with prompt "Select deployment folder:")'`,
        { timeout: 60000 }
      ).toString().trim();
      return json(res, { ok: true, path: chosen });
    } catch (e) {
      // User cancelled the dialog (exit code 1)
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
    const { vDir: dVDir } = resolveVersion(proj, loadState());
    if (dVDir) copyEccRootFiles(dVDir, dest);
    // Lock the path after first successful deploy
    if (!proj.pathLocked) {
      proj.pathLocked = true;
      saveState(state);
    }
    log('info', `deploy [${body.project}] → ${dest}`);
    return json(res, { ok: true, deployedTo: dest, pathLocked: true });
  }

  // POST /api/settings
  if (p === '/api/settings' && req.method === 'POST') {
    const body = await parseBody(req);
    const { project: projName, id, value } = body;
    const comp = STATIC_SETTINGS.find(c => c.id === id);
    if (!comp) return json(res, { ok: false, error: 'Setting not found' }, 400);
    const state = loadState();
    if (!state.projects[projName]) return json(res, { ok: false, error: 'Project not found' }, 404);
    const s = readSettings(projName);
    const parts = comp.settingKey.split('.');
    if (parts.length === 1) s[parts[0]] = value;
    else { if (!s[parts[0]]) s[parts[0]] = {}; s[parts[0]][parts[1]] = value; }
    writeSettings(projName, s);
    state.projects[projName].components[id] = { installed: true, installedAt: new Date().toISOString(), value };
    saveState(state);
    log('info', `setting [${projName}] ${comp.settingKey} = ${value}`);
    return json(res, { ok: true });
  }

  json(res, { error: 'Not found' }, 404);
});

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

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`\n  ECC Manager  http://localhost:${PORT}`);
  console.log(`  Versions     ${VERSIONS_DIR}`);
  console.log(`  Projects     ${PROJECTS_DIR}`);
  console.log(`  ~/.claude/   NOT TOUCHED\n`);
});
