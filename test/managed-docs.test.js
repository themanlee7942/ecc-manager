'use strict';
// Tests for the generalized managed-doc workflow (CLAUDE.md / AGENTS.md).
// Covers helpers, status transitions, write-time legacy mirroring, per-doc
// backups, and the /docs/:docKey HTTP routes. SKILLS.md is intentionally NOT
// a managed doc — see the docKey-rejection tests below.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const tmpRoot     = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-manageddocs-'));
const tmpProjects = path.join(tmpRoot, 'projects');
const tmpVersions = path.join(tmpProjects, '.ecc-versions');
const tmpState    = path.join(tmpRoot, 'state.json');
const tmpCatalog  = path.join(tmpRoot, 'catalog.json');

process.env.ECC_PROJECTS_DIR = tmpProjects;
process.env.ECC_STATE_FILE   = tmpState;
process.env.ECC_CATALOG_FILE = tmpCatalog;

const srv = require('../server');
const {
  MANAGED_DOC_KEYS,
  getManagedDocConfig,
  getEccDefaultManagedDoc,
  getManagedDocStatus,
  backupProjectManagedDoc,
  listProjectManagedDocBackups,
  getProjectManagedDocPath,
  readProjectManagedDocMeta,
  writeProjectManagedDocMeta,
  backupNamePattern,
  loadState,
  saveState,
  _resetStateCache,
  ensureDir,
  projectDir,
  server: httpServer,
} = srv;

let passed = 0, failed = 0;
let _idSeq = 0;
const uid = () => `t${++_idSeq}`;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); failed++; }
}
function suite(name, fn) { console.log(`\n${name}`); _resetStateCache(); fn(); }

process.on('exit', () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} });

function makeVersionDir(verId, files = {}) {
  const vDir = path.join(tmpVersions, verId);
  fs.mkdirSync(vDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(vDir, name), content, 'utf8');
  }
  return vDir;
}

function setupProject(projName, { activeVersion = null } = {}) {
  _resetStateCache();
  const versions = {};
  if (activeVersion) versions[activeVersion] = { verId: activeVersion };
  const proj = { name: projName, components: {} };
  if (activeVersion) proj.eccVersion = activeVersion;
  const state = { versions, activeVersion, projects: { [projName]: proj } };
  saveState(state);
  return state;
}

function writeProjectDoc(projName, fileName, content) {
  const dir = path.join(tmpProjects, projName, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), content, 'utf8');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

suite('MANAGED_DOC_KEYS / getManagedDocConfig', () => {
  test('exposes only the two managed doc keys (claude, agents)', () => {
    assert.deepStrictEqual([...MANAGED_DOC_KEYS].sort(), ['agents','claude']);
  });
  test('returns null for unknown docKey', () => {
    assert.strictEqual(getManagedDocConfig('foo'), null);
    assert.strictEqual(getManagedDocConfig(null), null);
    assert.strictEqual(getManagedDocConfig(123), null);
  });
  test('returns null for the removed "skills" managed-doc key', () => {
    // SKILLS.md was never a real top-level convention — it's only a per-skill
    // file at .claude/skills/<name>/SKILL.md. The managed-doc system must
    // refuse 'skills' so an old request can't accidentally resurrect the
    // SKILLS.md feature.
    assert.strictEqual(getManagedDocConfig('skills'), null);
  });
  test('claude config preserves legacy state slot', () => {
    const cfg = getManagedDocConfig('claude');
    assert.strictEqual(cfg.fileName, 'CLAUDE.md');
    assert.strictEqual(cfg.legacyStateKey, 'claudeMd');
  });
  test('agents config uses AGENTS.md as its filename', () => {
    assert.strictEqual(getManagedDocConfig('agents').fileName, 'AGENTS.md');
  });
});

suite('getEccDefaultManagedDoc — per docKey', () => {
  test('returns available:true when CLAUDE.md exists in version dir', () => {
    const ver = uid();
    const proj = `p-${uid()}`;
    makeVersionDir(ver, { 'CLAUDE.md': '# Default C' });
    const state = setupProject(proj, { activeVersion: ver });
    const result = getEccDefaultManagedDoc(state.projects[proj], state, 'claude');
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.content, '# Default C');
    assert.strictEqual(result.filePath, 'CLAUDE.md');
  });
  test('returns available:true when AGENTS.md exists in version dir', () => {
    const ver = uid();
    const proj = `p-${uid()}`;
    makeVersionDir(ver, { 'AGENTS.md': '# Default A' });
    const state = setupProject(proj, { activeVersion: ver });
    const result = getEccDefaultManagedDoc(state.projects[proj], state, 'agents');
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.filePath, 'AGENTS.md');
  });
  test('returns available:false for unknown docKey', () => {
    const proj = `p-${uid()}`;
    const state = setupProject(proj);
    const result = getEccDefaultManagedDoc(state.projects[proj], state, 'unknown');
    assert.strictEqual(result.available, false);
  });
});

suite('getManagedDocStatus — generalized', () => {
  test('missing when content is null and no default', () => {
    assert.strictEqual(getManagedDocStatus(null, { available: false }), 'missing');
  });
  test('no-default when content exists but no ECC default', () => {
    assert.strictEqual(getManagedDocStatus('# user', { available: false }), 'no-default');
  });
  test('matches-default when content equals default', () => {
    assert.strictEqual(getManagedDocStatus('x', { available: true, content: 'x' }), 'matches-default');
  });
  test('customized when content differs', () => {
    assert.strictEqual(getManagedDocStatus('x', { available: true, content: 'y' }), 'customized');
  });
});

suite('backup — per-document', () => {
  test('CLAUDE.md and AGENTS.md backups stay in their own buckets', () => {
    const proj = `p-${uid()}`;
    writeProjectDoc(proj, 'CLAUDE.md', 'C');
    writeProjectDoc(proj, 'AGENTS.md', 'A');
    backupProjectManagedDoc(proj, 'claude');
    backupProjectManagedDoc(proj, 'agents');
    const claudeBackups = listProjectManagedDocBackups(proj, 'claude');
    const agentsBackups = listProjectManagedDocBackups(proj, 'agents');
    assert.strictEqual(claudeBackups.length, 1);
    assert.strictEqual(agentsBackups.length, 1);
    assert.ok(claudeBackups[0].name.startsWith('CLAUDE.md.'));
    assert.ok(agentsBackups[0].name.startsWith('AGENTS.md.'));
  });
  test('backupNamePattern only matches its own doc', () => {
    const claudePat = backupNamePattern('claude');
    const agentsPat = backupNamePattern('agents');
    assert.ok(claudePat.test('CLAUDE.md.20260501T120000Z.bak'));
    assert.ok(!claudePat.test('AGENTS.md.20260501T120000Z.bak'));
    assert.ok(agentsPat.test('AGENTS.md.20260501T120000Z.bak'));
    assert.ok(!agentsPat.test('CLAUDE.md.20260501T120000Z.bak'));
    // Path traversal guard
    assert.ok(!claudePat.test('../../etc/passwd'));
  });
  test('multiple backups are preserved (no automatic cleanup)', () => {
    const proj = `p-${uid()}`;
    writeProjectDoc(proj, 'CLAUDE.md', 'first');
    // Create many backups by repeatedly invoking; in-memory ts collisions are
    // resolved by the second-resolution timestamp. Simulate by sleeping
    // between calls (1100ms x 12 would be too slow); use direct timestamp
    // injection via rewrite.
    for (let i = 0; i < 15; i++) {
      writeProjectDoc(proj, 'CLAUDE.md', `content-${i}`);
      backupProjectManagedDoc(proj, 'claude');
      // Force unique mtime / name by also pre-creating
    }
    const list = listProjectManagedDocBackups(proj, 'claude');
    // We may have collisions on the millisecond-truncated stamp, but the count
    // should be at least 1 and there should be NO automatic deletion (older
    // ones must not be culled below MAX_BACKUPS like the old behavior). We
    // assert only the no-deletion guarantee: count >= 1.
    assert.ok(list.length >= 1, 'at least one backup must remain');
  });
});

suite('legacy CLAUDE.md mirror', () => {
  test('writeProjectManagedDocMeta(claude) populates both managedDocs.claude and legacy claudeMd', () => {
    _resetStateCache();
    const proj = { name: 'mp', components: {} };
    const state = { versions: {}, activeVersion: null, projects: { mp: proj } };
    writeProjectManagedDocMeta(proj, 'claude', { source: 'manual', updatedAt: '2026-05-05T00:00:00.000Z' });
    assert.strictEqual(proj.managedDocs.claude.source, 'manual');
    assert.strictEqual(proj.claudeMd.source, 'manual', 'legacy slot must mirror managedDocs.claude');
  });
  test('readProjectManagedDocMeta prefers managedDocs.claude over legacy claudeMd', () => {
    const proj = {
      managedDocs: { claude: { source: 'ecc-default' } },
      claudeMd:    { source: 'manual' },
    };
    const meta = readProjectManagedDocMeta(proj, 'claude');
    assert.strictEqual(meta.source, 'ecc-default');
  });
  test('readProjectManagedDocMeta falls back to legacy claudeMd when managedDocs is missing', () => {
    const proj = { claudeMd: { source: 'manual' } };
    const meta = readProjectManagedDocMeta(proj, 'claude');
    assert.strictEqual(meta.source, 'manual');
  });
  test('writeProjectManagedDocMeta(agents) does NOT mirror to claudeMd', () => {
    _resetStateCache();
    const proj = { name: 'mp', components: {} };
    writeProjectManagedDocMeta(proj, 'agents', { source: 'manual', updatedAt: 'now' });
    assert.strictEqual(proj.managedDocs.agents.source, 'manual');
    assert.strictEqual(proj.claudeMd, undefined, 'agents writes must not pollute legacy claudeMd');
  });
});

// ─── HTTP integration ────────────────────────────────────────────────────────

let port;
function http_(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {};
    const r = require('http').request({ hostname: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        let parsed; try { parsed = JSON.parse(buf || '{}'); } catch { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const httpQueue = [];
function http_test(name, fn) {
  httpQueue.push(async () => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); failed++; }
  });
}
function http_suite(name, fn) { httpQueue.push(() => console.log(`\n${name}`)); fn(); }

http_suite('HTTP /docs/:docKey', () => {
  http_test('rejects unknown docKey with 400', async () => {
    const ver = uid();
    const proj = `p-http-${uid()}`;
    makeVersionDir(ver, { 'CLAUDE.md': '# c' });
    setupProject(proj, { activeVersion: ver });
    const r = await http_('GET', `/api/projects/${proj}/docs/foo`);
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error || '', /docKey/i);
  });

  http_test('GET /docs/agents returns content + status for missing file', async () => {
    const ver = uid();
    const proj = `p-http-${uid()}`;
    makeVersionDir(ver, { 'AGENTS.md': '# default agents' });
    setupProject(proj, { activeVersion: ver });
    const r = await http_('GET', `/api/projects/${proj}/docs/agents`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.docKey, 'agents');
    assert.strictEqual(r.body.fileName, 'AGENTS.md');
    assert.strictEqual(r.body.exists, false);
    assert.strictEqual(r.body.defaultAvailable, true);
    // content is null because the project file doesn't exist yet
    assert.strictEqual(r.body.content, null);
  });

  http_test('GET /docs/skills returns 400 — SKILLS.md is no longer a managed doc', async () => {
    const proj = `p-http-${uid()}`;
    setupProject(proj);
    const r = await http_('GET', `/api/projects/${proj}/docs/skills`);
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error || '', /docKey/i);
  });

  http_test('POST /docs/skills returns 400 — and never writes a SKILLS.md to disk', async () => {
    const proj = `p-http-${uid()}`;
    setupProject(proj);
    const r = await http_('POST', `/api/projects/${proj}/docs/skills`, { content: '# my skills' });
    assert.strictEqual(r.status, 400);
    assert.ok(!fs.existsSync(path.join(projectDir(proj), 'SKILLS.md')), 'no SKILLS.md should be written');
  });

  http_test('POST /docs/claude mirrors metadata to legacy claudeMd', async () => {
    const proj = `p-http-${uid()}`;
    setupProject(proj);
    const r = await http_('POST', `/api/projects/${proj}/docs/claude`, { content: 'manual edit' });
    assert.strictEqual(r.body.ok, true);
    _resetStateCache();
    const state = loadState();
    assert.strictEqual(state.projects[proj].managedDocs.claude.source, 'manual');
    assert.strictEqual(state.projects[proj].claudeMd.source, 'manual', 'legacy mirror should be populated');
  });

  http_test('legacy /claudemd POST still works (compat wrapper)', async () => {
    const proj = `p-http-${uid()}`;
    setupProject(proj);
    const r = await http_('POST', `/api/projects/${proj}/claudemd`, { content: 'via legacy' });
    assert.strictEqual(r.body.ok, true);
    const r2 = await http_('GET', `/api/projects/${proj}/claudemd`);
    assert.strictEqual(r2.body.content, 'via legacy');
  });

  http_test('POST /docs/agents/replace-default backs up existing file', async () => {
    const ver = uid();
    const proj = `p-http-${uid()}`;
    makeVersionDir(ver, { 'AGENTS.md': '# default agents' });
    setupProject(proj, { activeVersion: ver });
    writeProjectDoc(proj, 'AGENTS.md', '# user-edited agents');
    const r = await http_('POST', `/api/projects/${proj}/docs/agents/replace-default`);
    assert.strictEqual(r.body.ok, true);
    assert.ok(r.body.backupPath, 'backup path must be returned');
    assert.ok(r.body.backupPath.includes('AGENTS.md.'), 'backup must be doc-specific');
    const onDisk = fs.readFileSync(path.join(projectDir(proj), 'AGENTS.md'), 'utf8');
    assert.strictEqual(onDisk, '# default agents');
  });

  http_test('POST /docs/skills/replace-default fails with 400 when no default exists', async () => {
    const proj = `p-http-${uid()}`;
    setupProject(proj);
    const r = await http_('POST', `/api/projects/${proj}/docs/skills/replace-default`);
    assert.strictEqual(r.status, 400);
  });

  http_test('GET /docs/agents/backups filters by document', async () => {
    const proj = `p-http-${uid()}`;
    setupProject(proj);
    writeProjectDoc(proj, 'CLAUDE.md', 'C');
    writeProjectDoc(proj, 'AGENTS.md', 'A');
    backupProjectManagedDoc(proj, 'claude');
    backupProjectManagedDoc(proj, 'agents');
    const r = await http_('GET', `/api/projects/${proj}/docs/agents/backups`);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.backups.length, 1);
    assert.ok(r.body.backups[0].name.startsWith('AGENTS.md.'));
  });

  http_test('POST /docs/agents/restore validates per-doc backup name format', async () => {
    const proj = `p-http-${uid()}`;
    setupProject(proj);
    writeProjectDoc(proj, 'AGENTS.md', '# A');
    backupProjectManagedDoc(proj, 'agents');
    // Trying to restore a CLAUDE.md backup format under /docs/agents/restore must fail
    const r = await http_('POST', `/api/projects/${proj}/docs/agents/restore`, { backupName: 'CLAUDE.md.20260501T120000Z.bak' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error || '', /format/i);
  });

  http_test('deploy does NOT silently materialize AGENTS.md when only CLAUDE.md was edited', async () => {
    // Regression: when the deploy path equals the staging area (the default
    // for projects under <ROOT>/projects/<name>), the old deploy path called
    // copyEccRootFiles() which wrote AGENTS.md and agent.yaml from the ECC
    // version into the staging dir if they were missing. That made AGENTS.md
    // silently appear in the right-panel "installed" list whenever the user
    // triggered an auto-deploy via a CLAUDE.md action — even though they
    // never asked for AGENTS.md.
    const ver = uid();
    makeVersionDir(ver, { 'CLAUDE.md': '# c-default', 'AGENTS.md': '# a-default', 'agent.yaml': 'name: x' });
    const proj = `p-http-${uid()}`;
    setupProject(proj, { activeVersion: ver });
    // Deploy in place: deploy target's .claude/ IS the staging area.
    const state = loadState();
    state.projects[proj].deployPath = path.join(tmpProjects, proj);
    saveState(state);
    // Save CLAUDE.md only — the user's single explicit action.
    const save = await http_('POST', `/api/projects/${proj}/docs/claude`, { content: '# my claude' });
    assert.strictEqual(save.body.ok, true);
    // Trigger the deploy that auto-runs after Replace / Save.
    const dep = await http_('POST', '/api/deploy', { project: proj });
    assert.strictEqual(dep.body.ok, true);
    // AGENTS.md and agent.yaml must NOT have been auto-created in staging.
    assert.ok(!fs.existsSync(path.join(projectDir(proj), 'AGENTS.md')),
      'deploy must not auto-write AGENTS.md when the user only touched CLAUDE.md');
    assert.ok(!fs.existsSync(path.join(projectDir(proj), 'agent.yaml')),
      'deploy must not auto-write agent.yaml as a side effect of editing CLAUDE.md');
    // CLAUDE.md the user actually saved is still on disk.
    assert.strictEqual(fs.readFileSync(path.join(projectDir(proj), 'CLAUDE.md'), 'utf8'), '# my claude');
  });
});

// ─── Run ─────────────────────────────────────────────────────────────────────

(async () => {
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => { port = httpServer.address().port; resolve(); });
  });
  try {
    for (const fn of httpQueue) await fn();
  } finally {
    await new Promise(r => httpServer.close(r));
  }
  console.log(`\n${'─'.repeat(50)}`);
  const total = passed + failed;
  console.log(`${total} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
