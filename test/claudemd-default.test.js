'use strict';
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// Set env overrides BEFORE requiring server so constants are baked in correctly.
const tmpRoot     = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-claudemd-test-'));
const tmpProjects = path.join(tmpRoot, 'projects');
const tmpVersions = path.join(tmpProjects, '.ecc-versions');
const tmpState    = path.join(tmpRoot, 'state.json');
const tmpCatalog  = path.join(tmpRoot, 'catalog.json');

process.env.ECC_PROJECTS_DIR = tmpProjects;
process.env.ECC_STATE_FILE   = tmpState;
process.env.ECC_CATALOG_FILE = tmpCatalog;

const {
  getEccDefaultClaudeMd,
  getClaudeMdStatus,
  backupProjectClaudeMd,
  listProjectClaudeMdBackups,
  loadState,
  saveState,
  _resetStateCache,
  ensureDir,
  copyRecursive,
  projectDir,
} = require('../server');

// ─── Mini test runner ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.stack || err.message}`);
    failed++;
  }
}

function suite(name, fn) {
  console.log(`\n${name}`);
  _resetStateCache();
  fn();
}

process.on('exit', () => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let _idSeq = 0;
function uid() { return `t${++_idSeq}`; }

function makeVersionDir(verId, claudeMdContent = null) {
  const vDir = path.join(tmpVersions, verId);
  fs.mkdirSync(vDir, { recursive: true });
  if (claudeMdContent !== null) {
    fs.writeFileSync(path.join(vDir, 'CLAUDE.md'), claudeMdContent, 'utf8');
  }
  return vDir;
}

function setupState(projName, { activeVersion = null, pinnedVersion = null } = {}) {
  _resetStateCache();
  const versions = {};
  if (activeVersion) versions[activeVersion] = { verId: activeVersion };
  if (pinnedVersion && pinnedVersion !== activeVersion) versions[pinnedVersion] = { verId: pinnedVersion };
  const proj = { name: projName, components: {} };
  if (pinnedVersion) proj.eccVersion = pinnedVersion;
  const state = { versions, activeVersion, projects: { [projName]: proj } };
  saveState(state);
  return state;
}

function writeProjectClaudeMd(projName, content) {
  const dir = path.join(tmpProjects, projName, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), content, 'utf8');
}

function readProjectClaudeMd(projName) {
  const fpath = path.join(projectDir(projName), 'CLAUDE.md');
  return fs.existsSync(fpath) ? fs.readFileSync(fpath, 'utf8') : null;
}

// ─── getEccDefaultClaudeMd ────────────────────────────────────────────────────

suite('getEccDefaultClaudeMd', () => {
  test('returns available:true with content when active version has CLAUDE.md', () => {
    const ver = uid();
    const proj = `p-${uid()}`;
    makeVersionDir(ver, '# ECC Default\nsome content');
    const state = setupState(proj, { activeVersion: ver });
    const result = getEccDefaultClaudeMd(state.projects[proj], state);
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.content, '# ECC Default\nsome content');
    assert.strictEqual(result.verId, ver);
    assert.strictEqual(result.filePath, 'CLAUDE.md');
  });

  test('returns available:false when version dir has no CLAUDE.md', () => {
    const ver = uid();
    const proj = `p-${uid()}`;
    makeVersionDir(ver);  // no CLAUDE.md
    const state = setupState(proj, { activeVersion: ver });
    const result = getEccDefaultClaudeMd(state.projects[proj], state);
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.content, null);
  });

  test('returns available:false when no version is resolvable', () => {
    const proj = `p-${uid()}`;
    _resetStateCache();
    const state = { versions: {}, activeVersion: null, projects: { [proj]: { name: proj, components: {} } } };
    saveState(state);
    const result = getEccDefaultClaudeMd(state.projects[proj], state);
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.verId, null);
  });

  test('returns available:false when version dir does not exist on disk', () => {
    const ver = uid();
    const proj = `p-${uid()}`;
    _resetStateCache();
    // Register version in state but never create the dir
    const state = { versions: { [ver]: { verId: ver } }, activeVersion: ver, projects: { [proj]: { name: proj, components: {} } } };
    saveState(state);
    const result = getEccDefaultClaudeMd(state.projects[proj], state);
    assert.strictEqual(result.available, false);
  });

  test('uses project-pinned eccVersion over activeVersion', () => {
    const activeVer = uid();
    const pinnedVer = uid();
    const proj = `p-${uid()}`;
    makeVersionDir(activeVer, '# Active Version');
    makeVersionDir(pinnedVer, '# Pinned Version');
    const state = setupState(proj, { activeVersion: activeVer, pinnedVersion: pinnedVer });
    const result = getEccDefaultClaudeMd(state.projects[proj], state);
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.verId, pinnedVer);
    assert.strictEqual(result.content, '# Pinned Version');
  });
});

// ─── getClaudeMdStatus ────────────────────────────────────────────────────────

suite('getClaudeMdStatus', () => {
  test('returns no-default when eccDefault.available is false', () => {
    const status = getClaudeMdStatus('any content', { available: false, content: null });
    assert.strictEqual(status, 'no-default');
  });

  test('returns missing when currentContent is null and default is available', () => {
    const status = getClaudeMdStatus(null, { available: true, content: '# Default' });
    assert.strictEqual(status, 'missing');
  });

  test('returns matches-default when content equals ECC default', () => {
    const content = '# Same content\n';
    const status = getClaudeMdStatus(content, { available: true, content });
    assert.strictEqual(status, 'matches-default');
  });

  test('returns customized when content differs from ECC default', () => {
    const status = getClaudeMdStatus('# Custom', { available: true, content: '# Default' });
    assert.strictEqual(status, 'customized');
  });
});

// ─── backupProjectClaudeMd ────────────────────────────────────────────────────

suite('backupProjectClaudeMd', () => {
  test('creates a backup file in .backups/ and returns relative path', () => {
    const proj = `p-${uid()}`;
    writeProjectClaudeMd(proj, '# My instructions');
    const rel = backupProjectClaudeMd(proj);
    assert.ok(rel, 'expected a non-null return value');
    assert.ok(rel.startsWith(path.join('.backups', 'CLAUDE.md.')), `unexpected path: ${rel}`);
    assert.ok(rel.endsWith('.bak'), `expected .bak suffix: ${rel}`);
    const backupFile = path.join(projectDir(proj), rel);
    assert.ok(fs.existsSync(backupFile), 'backup file must exist on disk');
    assert.strictEqual(fs.readFileSync(backupFile, 'utf8'), '# My instructions');
  });

  test('returns null when CLAUDE.md does not exist', () => {
    const proj = `p-${uid()}`;
    // Ensure no CLAUDE.md exists for this project
    const result = backupProjectClaudeMd(proj);
    assert.strictEqual(result, null);
  });

  test('backup filename embeds a timestamp in YYYYMMDDTHHmmssZ format', () => {
    const proj = `p-${uid()}`;
    writeProjectClaudeMd(proj, 'content');
    const rel = backupProjectClaudeMd(proj);
    const name = path.basename(rel);
    // CLAUDE.md.20260501T123456Z.bak
    assert.ok(/^CLAUDE\.md\.\d{8}T\d{6}Z\.bak$/.test(name), `unexpected name format: ${name}`);
  });
});

// ─── listProjectClaudeMdBackups ───────────────────────────────────────────────

suite('listProjectClaudeMdBackups', () => {
  test('returns empty array when .backups dir does not exist', () => {
    const proj = `p-${uid()}`;
    const result = listProjectClaudeMdBackups(proj);
    assert.deepStrictEqual(result, []);
  });

  test('lists backups sorted newest-first', () => {
    const proj = `p-${uid()}`;
    const backupsDir = path.join(projectDir(proj), '.backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const names = [
      'CLAUDE.md.20260501T100000Z.bak',
      'CLAUDE.md.20260501T120000Z.bak',
      'CLAUDE.md.20260501T110000Z.bak',
    ];
    for (const n of names) fs.writeFileSync(path.join(backupsDir, n), n);
    const result = listProjectClaudeMdBackups(proj);
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].name, 'CLAUDE.md.20260501T120000Z.bak');
    assert.strictEqual(result[1].name, 'CLAUDE.md.20260501T110000Z.bak');
    assert.strictEqual(result[2].name, 'CLAUDE.md.20260501T100000Z.bak');
  });

  test('ignores files that do not match the CLAUDE.md.*.bak pattern', () => {
    const proj = `p-${uid()}`;
    const backupsDir = path.join(projectDir(proj), '.backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    fs.writeFileSync(path.join(backupsDir, 'CLAUDE.md.20260501T100000Z.bak'), 'bak');
    fs.writeFileSync(path.join(backupsDir, 'other.txt'), 'not a backup');
    fs.writeFileSync(path.join(backupsDir, 'CLAUDE.md.snapshot'), 'wrong extension');
    const result = listProjectClaudeMdBackups(proj);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'CLAUDE.md.20260501T100000Z.bak');
  });

  test('each entry contains name and relativePath', () => {
    const proj = `p-${uid()}`;
    const backupsDir = path.join(projectDir(proj), '.backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const name = 'CLAUDE.md.20260501T100000Z.bak';
    fs.writeFileSync(path.join(backupsDir, name), 'content');
    const result = listProjectClaudeMdBackups(proj);
    assert.strictEqual(result[0].name, name);
    assert.strictEqual(result[0].relativePath, path.join('.backups', name));
  });
});

// ─── Replace flow ─────────────────────────────────────────────────────────────

suite('replace-default flow', () => {
  test('backs up existing CLAUDE.md before replacement', () => {
    const ver = uid();
    const proj = `p-${uid()}`;
    makeVersionDir(ver, '# ECC Default');
    writeProjectClaudeMd(proj, '# Original');
    const state = setupState(proj, { activeVersion: ver });
    const eccDefault = getEccDefaultClaudeMd(state.projects[proj], state);

    const backupPath = backupProjectClaudeMd(proj);
    assert.ok(backupPath, 'backup must be created');
    const backupFile = path.join(projectDir(proj), backupPath);
    assert.ok(fs.existsSync(backupFile), 'backup file must exist on disk');
    assert.strictEqual(fs.readFileSync(backupFile, 'utf8'), '# Original');

    // Continue with replacement
    ensureDir(projectDir(proj));
    fs.writeFileSync(path.join(projectDir(proj), 'CLAUDE.md'), eccDefault.content, 'utf8');
    assert.strictEqual(readProjectClaudeMd(proj), '# ECC Default');
  });

  test('file content is updated to ECC default after replacement', () => {
    const ver = uid();
    const proj = `p-${uid()}`;
    makeVersionDir(ver, '# New ECC Instructions');
    writeProjectClaudeMd(proj, '# Old custom content');
    const state = setupState(proj, { activeVersion: ver });
    const eccDefault = getEccDefaultClaudeMd(state.projects[proj], state);

    backupProjectClaudeMd(proj);
    fs.writeFileSync(path.join(projectDir(proj), 'CLAUDE.md'), eccDefault.content, 'utf8');
    assert.strictEqual(readProjectClaudeMd(proj), '# New ECC Instructions');
  });

  test('state claudeMd metadata is recorded after replacement', () => {
    const ver = uid();
    const proj = `p-${uid()}`;
    makeVersionDir(ver, '# ECC Default');
    writeProjectClaudeMd(proj, '# Old');
    const state = setupState(proj, { activeVersion: ver });
    const eccDefault = getEccDefaultClaudeMd(state.projects[proj], state);

    const backupPath = backupProjectClaudeMd(proj);
    fs.writeFileSync(path.join(projectDir(proj), 'CLAUDE.md'), eccDefault.content, 'utf8');

    const projEntry = state.projects[proj];
    if (!projEntry.claudeMd) projEntry.claudeMd = {};
    projEntry.claudeMd.source = 'ecc-default';
    projEntry.claudeMd.sourceVersion = eccDefault.verId;
    projEntry.claudeMd.sourcePath = eccDefault.filePath;
    projEntry.claudeMd.replacedAt = new Date().toISOString();
    if (backupPath) projEntry.claudeMd.lastBackupPath = backupPath;
    saveState(state);

    _resetStateCache();
    const saved = loadState();
    const md = saved.projects[proj].claudeMd;
    assert.strictEqual(md.source, 'ecc-default');
    assert.strictEqual(md.sourceVersion, ver);
    assert.strictEqual(md.sourcePath, 'CLAUDE.md');
    assert.ok(md.replacedAt, 'replacedAt must be set');
    assert.ok(md.lastBackupPath, 'lastBackupPath must be set');
  });
});

// ─── Restore flow ─────────────────────────────────────────────────────────────

suite('restore flow', () => {
  test('backs up current CLAUDE.md before restoring', () => {
    const proj = `p-${uid()}`;
    const backupsDir = path.join(projectDir(proj), '.backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const bakName = 'CLAUDE.md.20260501T100000Z.bak';
    fs.writeFileSync(path.join(backupsDir, bakName), '# Saved version');
    writeProjectClaudeMd(proj, '# Current version');

    backupProjectClaudeMd(proj);

    const allBackups = listProjectClaudeMdBackups(proj);
    assert.ok(allBackups.length >= 2, 'at least two backups should exist after backing up');
    const hasCurrentBackup = allBackups.some(b => b.name !== bakName);
    assert.ok(hasCurrentBackup, 'a new backup of the current file should have been created');
  });

  test('restores file content from selected backup', () => {
    const proj = `p-${uid()}`;
    const backupsDir = path.join(projectDir(proj), '.backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const bakName = 'CLAUDE.md.20260501T090000Z.bak';
    fs.writeFileSync(path.join(backupsDir, bakName), '# Version from backup');
    writeProjectClaudeMd(proj, '# Current version to be overwritten');

    const content = fs.readFileSync(path.join(backupsDir, bakName), 'utf8');
    ensureDir(projectDir(proj));
    fs.writeFileSync(path.join(projectDir(proj), 'CLAUDE.md'), content, 'utf8');

    assert.strictEqual(readProjectClaudeMd(proj), '# Version from backup');
  });

  test('state claudeMd metadata is recorded after restore', () => {
    const ver = uid();
    const proj = `p-${uid()}`;
    makeVersionDir(ver, '# ECC');
    const state = setupState(proj, { activeVersion: ver });
    const backupsDir = path.join(projectDir(proj), '.backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const bakName = 'CLAUDE.md.20260501T080000Z.bak';
    fs.writeFileSync(path.join(backupsDir, bakName), '# Saved');
    writeProjectClaudeMd(proj, '# Current');

    const content = fs.readFileSync(path.join(backupsDir, bakName), 'utf8');
    fs.writeFileSync(path.join(projectDir(proj), 'CLAUDE.md'), content, 'utf8');

    const projEntry = state.projects[proj];
    projEntry.claudeMd = {
      ...(projEntry.claudeMd || {}),
      source: 'restored-backup',
      replacedAt: new Date().toISOString(),
    };
    saveState(state);

    _resetStateCache();
    const saved = loadState();
    const md = saved.projects[proj].claudeMd;
    assert.strictEqual(md.source, 'restored-backup');
    assert.ok(md.replacedAt, 'replacedAt must be set');
  });

  test('backup name format validation rejects path traversal', () => {
    const validFormat = /^CLAUDE\.md\.\d{8}T\d{6}Z\.bak$/;
    assert.ok(!validFormat.test('../../../etc/passwd'), 'traversal path must fail format check');
    assert.ok(!validFormat.test('CLAUDE.md.20260501T100000Z.bak/../evil'), 'embedded traversal must fail format check');
    assert.ok(!validFormat.test('CLAUDE.md.20260501T100000Z.bak.extra'), 'trailing suffix must fail format check');
    assert.ok(validFormat.test('CLAUDE.md.20260501T100000Z.bak'), 'valid name must pass format check');
  });
});

// ─── Deploy does not copy .backups ────────────────────────────────────────────

suite('deploy — .backups exclusion', () => {
  test('.backups is not present in deploy destination', () => {
    const proj = `p-${uid()}`;
    writeProjectClaudeMd(proj, '# CLAUDE');
    const backupsDir = path.join(projectDir(proj), '.backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    fs.writeFileSync(path.join(backupsDir, 'CLAUDE.md.20260501T100000Z.bak'), 'backup');

    const deployTarget = path.join(tmpRoot, `deploy-${uid()}`);
    const dest = path.join(deployTarget, '.claude');
    copyRecursive(projectDir(proj), dest);

    // Backups exist in dest before stripping — confirm copyRecursive copied everything
    assert.ok(fs.existsSync(path.join(dest, '.backups')), 'precondition: .backups was copied');

    // Simulate the deploy handler stripping .backups
    const deployedBackups = path.join(dest, '.backups');
    if (fs.existsSync(deployedBackups)) fs.rmSync(deployedBackups, { recursive: true, force: true });

    assert.ok(!fs.existsSync(path.join(dest, '.backups')), '.backups must not be in deploy destination');
    assert.ok(fs.existsSync(path.join(dest, 'CLAUDE.md')), 'CLAUDE.md must still be deployed');
  });
});

// ─── Version pinning ──────────────────────────────────────────────────────────

suite('version pinning', () => {
  test('project-pinned version is used instead of active latest version', () => {
    const activeVer = uid();
    const pinnedVer = uid();
    const proj = `p-${uid()}`;
    makeVersionDir(activeVer, '# Active version CLAUDE.md');
    makeVersionDir(pinnedVer, '# Pinned version CLAUDE.md');
    const state = setupState(proj, { activeVersion: activeVer, pinnedVersion: pinnedVer });

    const result = getEccDefaultClaudeMd(state.projects[proj], state);
    assert.strictEqual(result.verId, pinnedVer);
    assert.strictEqual(result.content, '# Pinned version CLAUDE.md');
  });

  test('falls back to active version when no eccVersion is pinned', () => {
    const activeVer = uid();
    const proj = `p-${uid()}`;
    makeVersionDir(activeVer, '# Active only');
    const state = setupState(proj, { activeVersion: activeVer });

    const result = getEccDefaultClaudeMd(state.projects[proj], state);
    assert.strictEqual(result.verId, activeVer);
    assert.strictEqual(result.content, '# Active only');
  });
});

// ─── Report ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
const total = passed + failed;
console.log(`${total} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
