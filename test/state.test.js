'use strict';
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// Set env overrides BEFORE requiring server so constants are baked in correctly.
const tmpRoot    = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-state-test-'));
const tmpProjects = path.join(tmpRoot, 'projects');
const tmpState   = path.join(tmpRoot, 'state.json');
const tmpCatalog = path.join(tmpRoot, 'catalog.json');

process.env.ECC_PROJECTS_DIR = tmpProjects;
process.env.ECC_STATE_FILE   = tmpState;
process.env.ECC_CATALOG_FILE = tmpCatalog;

const { loadState, saveState, _resetStateCache } = require('../server');

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
  fn();
}

process.on('exit', () => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ─── loadState ────────────────────────────────────────────────────────────────

suite('loadState', () => {
  test('creates default state when file is missing', () => {
    _resetStateCache();
    if (fs.existsSync(tmpState)) fs.unlinkSync(tmpState);
    const s = loadState();
    assert.deepStrictEqual(s, { versions: {}, activeVersion: null, projects: {} });
  });

  test('writes default state to disk when file is missing', () => {
    _resetStateCache();
    if (fs.existsSync(tmpState)) fs.unlinkSync(tmpState);
    loadState();
    assert.ok(fs.existsSync(tmpState));
    const raw = JSON.parse(fs.readFileSync(tmpState, 'utf8'));
    // Index now carries schemaVersion alongside the legacy-shape fields
    assert.strictEqual(raw.activeVersion, null);
    assert.deepStrictEqual(raw.versions, {});
    assert.deepStrictEqual(raw.projects, {});
    assert.strictEqual(raw.schemaVersion, 2);
  });

  test('reads and parses existing state file', () => {
    _resetStateCache();
    const fixture = {
      versions: { 'v1.0.0': { verId: 'v1.0.0', pulledAt: '2026-01-01' } },
      activeVersion: 'v1.0.0',
      projects: { myproj: { name: 'myproj', components: {} } },
    };
    fs.writeFileSync(tmpState, JSON.stringify(fixture));
    const s = loadState();
    assert.strictEqual(s.activeVersion, 'v1.0.0');
    assert.ok(s.projects.myproj);
    assert.ok(s.versions['v1.0.0']);
  });

  test('caches result — second call returns same object reference', () => {
    _resetStateCache();
    fs.writeFileSync(tmpState, JSON.stringify({ versions: {}, activeVersion: null, projects: {} }));
    const a = loadState();
    const b = loadState();
    assert.strictEqual(a, b);
  });

  test('corrupted JSON resets to default and creates backup file', () => {
    _resetStateCache();
    fs.writeFileSync(tmpState, '{ bad json ]]');
    const s = loadState();
    assert.deepStrictEqual(s, { versions: {}, activeVersion: null, projects: {} });
    // Backups now live under <stateDir>/backups/
    const backupsDir = path.join(tmpRoot, 'backups');
    assert.ok(fs.existsSync(backupsDir), 'expected backups directory');
    const backups = fs.readdirSync(backupsDir).filter(f => f.startsWith('state.json.') && f.endsWith('.bak'));
    assert.ok(backups.length >= 1, 'expected at least one backup file');
  });
});

// ─── saveState ────────────────────────────────────────────────────────────────

suite('saveState', () => {
  test('writes state object to disk', () => {
    _resetStateCache();
    const newState = { versions: {}, activeVersion: 'v2.0.0', projects: {} };
    saveState(newState);
    const raw = JSON.parse(fs.readFileSync(tmpState, 'utf8'));
    assert.strictEqual(raw.activeVersion, 'v2.0.0');
  });

  test('updates cache so subsequent loadState returns saved state', () => {
    _resetStateCache();
    const newState = { versions: {}, activeVersion: 'cached-ver', projects: {} };
    saveState(newState);
    const s = loadState();
    assert.strictEqual(s.activeVersion, 'cached-ver');
  });

  test('persists deeply nested structures to disk', () => {
    _resetStateCache();
    const newState = {
      versions: { '1.0.0': { verId: '1.0.0', pulledAt: '2026-01-01' } },
      activeVersion: '1.0.0',
      projects: { foo: { name: 'foo', components: { 'setting-model': { installed: true, value: 'sonnet' } } } },
    };
    saveState(newState);
    _resetStateCache();
    const s = loadState();
    assert.strictEqual(s.projects.foo.components['setting-model'].installed, true);
    assert.strictEqual(s.projects.foo.components['setting-model'].value, 'sonnet');
  });
});

// ─── Report ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
const total = passed + failed;
console.log(`${total} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
