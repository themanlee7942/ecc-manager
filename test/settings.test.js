'use strict';
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// ─── Test environment ─────────────────────────────────────────────────────────
// Set env overrides BEFORE requiring server so constants are baked in correctly.

const tmpRoot    = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-test-'));
const tmpProjects = path.join(tmpRoot, 'projects');
const tmpCatalog = path.join(tmpRoot, 'catalog.json');
const tmpState   = path.join(tmpRoot, 'state.json');

process.env.ECC_PROJECTS_DIR = tmpProjects;
process.env.ECC_CATALOG_FILE = tmpCatalog;
process.env.ECC_STATE_FILE   = tmpState;

const {
  safeName,
  getNestedPath,
  setNestedPath,
  deleteNestedPath,
  readSettings,
  writeSettings,
  loadSettingsCatalog,
  saveSettingsCatalogMeta,
  findCatalogEntry,
  _resetCatalogCache,
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
  fn();
}

process.on('exit', () => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ─── safeName ────────────────────────────────────────────────────────────────

suite('safeName', () => {
  test('accepts lowercase letters', () => assert.strictEqual(safeName('abc'), true));
  test('accepts uppercase letters', () => assert.strictEqual(safeName('ABC'), true));
  test('accepts numbers', () => assert.strictEqual(safeName('abc123'), true));
  test('accepts hyphens', () => assert.strictEqual(safeName('my-project'), true));
  test('accepts underscores', () => assert.strictEqual(safeName('my_project'), true));
  test('accepts mixed valid chars', () => assert.strictEqual(safeName('My_Project-123'), true));
  test('rejects forward slash', () => assert.strictEqual(safeName('a/b'), false));
  test('rejects dot', () => assert.strictEqual(safeName('a.b'), false));
  test('rejects space', () => assert.strictEqual(safeName('a b'), false));
  test('rejects empty string', () => assert.strictEqual(safeName(''), false));
  test('rejects path traversal', () => assert.strictEqual(safeName('../evil'), false));
  test('rejects null byte', () => assert.strictEqual(safeName('a\0b'), false));
  test('rejects at-sign', () => assert.strictEqual(safeName('@scope'), false));
});

// ─── getNestedPath ────────────────────────────────────────────────────────────

suite('getNestedPath', () => {
  test('reads shallow key', () => assert.strictEqual(getNestedPath({ a: 1 }, 'a'), 1));
  test('reads two-level key', () => assert.strictEqual(getNestedPath({ a: { b: 2 } }, 'a.b'), 2));
  test('reads three-level key', () => assert.strictEqual(getNestedPath({ a: { b: { c: 3 } } }, 'a.b.c'), 3));
  test('returns undefined for missing shallow key', () => assert.strictEqual(getNestedPath({ a: 1 }, 'z'), undefined));
  test('returns undefined for missing deep key', () => assert.strictEqual(getNestedPath({ a: {} }, 'a.z'), undefined));
  test('returns undefined when intermediate is null', () => assert.strictEqual(getNestedPath({ a: null }, 'a.b'), undefined));
  test('returns undefined when intermediate is undefined', () => assert.strictEqual(getNestedPath({}, 'a.b.c'), undefined));
  test('reads falsy value 0', () => assert.strictEqual(getNestedPath({ a: 0 }, 'a'), 0));
  test('reads falsy value false', () => assert.strictEqual(getNestedPath({ a: false }, 'a'), false));
  test('reads falsy value empty string', () => assert.strictEqual(getNestedPath({ a: '' }, 'a'), ''));
});

// ─── setNestedPath ────────────────────────────────────────────────────────────

suite('setNestedPath', () => {
  test('sets shallow key', () => {
    const obj = {};
    setNestedPath(obj, 'a', 1);
    assert.strictEqual(obj.a, 1);
  });

  test('sets two-level key, creates intermediate', () => {
    const obj = {};
    setNestedPath(obj, 'a.b', 2);
    assert.deepStrictEqual(obj, { a: { b: 2 } });
  });

  test('sets three-level key, creates full chain', () => {
    const obj = {};
    setNestedPath(obj, 'a.b.c', 3);
    assert.deepStrictEqual(obj, { a: { b: { c: 3 } } });
  });

  test('overwrites existing value', () => {
    const obj = { a: { b: 1 } };
    setNestedPath(obj, 'a.b', 99);
    assert.strictEqual(obj.a.b, 99);
  });

  test('replaces non-object intermediate with object', () => {
    const obj = { a: 'string' };
    setNestedPath(obj, 'a.b', 1);
    assert.deepStrictEqual(obj, { a: { b: 1 } });
  });

  test('replaces null intermediate with object', () => {
    const obj = { a: null };
    setNestedPath(obj, 'a.b', 42);
    assert.deepStrictEqual(obj, { a: { b: 42 } });
  });

  test('does not disturb sibling keys', () => {
    const obj = { a: { b: 1, c: 2 } };
    setNestedPath(obj, 'a.b', 99);
    assert.strictEqual(obj.a.c, 2);
  });

  test('sets falsy value 0', () => {
    const obj = {};
    setNestedPath(obj, 'a', 0);
    assert.strictEqual(obj.a, 0);
  });
});

// ─── deleteNestedPath ─────────────────────────────────────────────────────────

suite('deleteNestedPath', () => {
  test('deletes shallow key', () => {
    const obj = { a: 1, b: 2 };
    deleteNestedPath(obj, 'a');
    assert.deepStrictEqual(obj, { b: 2 });
  });

  test('deletes deep key and prunes empty parent', () => {
    const obj = { a: { b: 1 } };
    deleteNestedPath(obj, 'a.b');
    assert.deepStrictEqual(obj, {});
  });

  test('prunes chain of empty parents recursively', () => {
    const obj = { a: { b: { c: 1 } } };
    deleteNestedPath(obj, 'a.b.c');
    assert.deepStrictEqual(obj, {});
  });

  test('does not prune parent that still has siblings', () => {
    const obj = { a: { b: 1, c: 2 } };
    deleteNestedPath(obj, 'a.b');
    assert.deepStrictEqual(obj, { a: { c: 2 } });
  });

  test('no-op when shallow key does not exist', () => {
    const obj = { a: 1 };
    deleteNestedPath(obj, 'z');
    assert.deepStrictEqual(obj, { a: 1 });
  });

  test('no-op when intermediate key does not exist', () => {
    const obj = { a: 1 };
    deleteNestedPath(obj, 'z.b');
    assert.deepStrictEqual(obj, { a: 1 });
  });

  test('no-op when intermediate is null', () => {
    const obj = { a: null };
    deleteNestedPath(obj, 'a.b');
    assert.deepStrictEqual(obj, { a: null });
  });

  test('preserves unrelated top-level keys after deep delete', () => {
    const obj = { a: { b: 1 }, x: 99 };
    deleteNestedPath(obj, 'a.b');
    assert.strictEqual(obj.x, 99);
  });
});

// ─── readSettings / writeSettings ─────────────────────────────────────────────

suite('readSettings / writeSettings', () => {
  const proj = 'test-proj';

  test('read missing project returns {}', () => {
    const s = readSettings('nonexistent-project-xyz');
    assert.deepStrictEqual(s, {});
  });

  test('write then read round-trips data', () => {
    const payload = { model: 'sonnet', env: { MAX_THINKING_TOKENS: '10000' } };
    writeSettings(proj, payload);
    const s = readSettings(proj);
    assert.strictEqual(s.model, 'sonnet');
    assert.strictEqual(s.env.MAX_THINKING_TOKENS, '10000');
  });

  test('write auto-injects $schema when absent', () => {
    writeSettings(proj, { model: 'opus' });
    const s = readSettings(proj);
    assert.strictEqual(s.$schema, 'https://json.schemastore.org/claude-code-settings.json');
  });

  test('write preserves explicit $schema', () => {
    const customSchema = 'https://custom.example.com/schema.json';
    writeSettings(proj, { $schema: customSchema, model: 'haiku' });
    const s = readSettings(proj);
    assert.strictEqual(s.$schema, customSchema);
  });

  test('write creates parent directory if missing', () => {
    const newProj = 'brand-new-project';
    writeSettings(newProj, { model: 'haiku' });
    const s = readSettings(newProj);
    assert.strictEqual(s.model, 'haiku');
  });

  test('read malformed JSON returns {}', () => {
    const badProj = 'bad-json-proj';
    const projDir = path.join(tmpProjects, badProj, '.claude');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'settings.json'), '{ not valid json ]');
    const s = readSettings(badProj);
    assert.deepStrictEqual(s, {});
  });

  test('write persists nested path structure correctly', () => {
    const nestedProj = 'nested-proj';
    const payload = { env: { A: '1', B: '2' }, hooks: { PostToolUse: [] } };
    writeSettings(nestedProj, payload);
    const s = readSettings(nestedProj);
    assert.strictEqual(s.env.A, '1');
    assert.strictEqual(s.env.B, '2');
    assert.ok(Array.isArray(s.hooks.PostToolUse));
  });
});

// ─── loadSettingsCatalog ──────────────────────────────────────────────────────

suite('loadSettingsCatalog', () => {
  test('returns default when catalog file is missing', () => {
    _resetCatalogCache();
    if (fs.existsSync(tmpCatalog)) fs.unlinkSync(tmpCatalog);
    const cat = loadSettingsCatalog();
    assert.deepStrictEqual(cat, {
      sourceUrl: '',
      lastSyncedAt: '',
      catalogVersion: 1,
      recommendedSettingIds: [],
      settings: [],
    });
  });

  test('loads and parses catalog from file', () => {
    _resetCatalogCache();
    const fixture = {
      sourceUrl: 'https://example.com',
      lastSyncedAt: '2026-01-01T00:00:00Z',
      catalogVersion: 7,
      recommendedSettingIds: ['entry-a'],
      settings: [{ id: 'entry-a', key: 'model', label: 'Model' }],
    };
    fs.writeFileSync(tmpCatalog, JSON.stringify(fixture));
    const cat = loadSettingsCatalog();
    assert.strictEqual(cat.catalogVersion, 7);
    assert.strictEqual(cat.settings.length, 1);
    assert.strictEqual(cat.settings[0].id, 'entry-a');
  });

  test('caches result — second call returns same object reference', () => {
    _resetCatalogCache();
    fs.writeFileSync(tmpCatalog, JSON.stringify({
      sourceUrl: '', lastSyncedAt: '', catalogVersion: 3,
      recommendedSettingIds: [], settings: [],
    }));
    const a = loadSettingsCatalog();
    const b = loadSettingsCatalog();
    assert.strictEqual(a, b);
  });

  test('returns default for malformed catalog JSON', () => {
    _resetCatalogCache();
    fs.writeFileSync(tmpCatalog, '{ bad json ]]');
    const cat = loadSettingsCatalog();
    assert.deepStrictEqual(cat, {
      sourceUrl: '',
      lastSyncedAt: '',
      catalogVersion: 1,
      recommendedSettingIds: [],
      settings: [],
    });
  });
});

// ─── saveSettingsCatalogMeta ──────────────────────────────────────────────────

suite('saveSettingsCatalogMeta', () => {
  test('updates metadata fields in memory and on disk', () => {
    _resetCatalogCache();
    fs.writeFileSync(tmpCatalog, JSON.stringify({
      sourceUrl: '', lastSyncedAt: '', catalogVersion: 1,
      recommendedSettingIds: [], settings: [],
    }));
    saveSettingsCatalogMeta({ sourceUrl: 'https://updated.example.com', catalogVersion: 9 });
    _resetCatalogCache();
    const cat = loadSettingsCatalog();
    assert.strictEqual(cat.sourceUrl, 'https://updated.example.com');
    assert.strictEqual(cat.catalogVersion, 9);
  });

  test('preserves existing fields not present in updates', () => {
    _resetCatalogCache();
    fs.writeFileSync(tmpCatalog, JSON.stringify({
      sourceUrl: 'original', lastSyncedAt: '', catalogVersion: 1,
      recommendedSettingIds: ['keep-me'], settings: [{ id: 'x' }],
    }));
    saveSettingsCatalogMeta({ sourceUrl: 'new' });
    _resetCatalogCache();
    const cat = loadSettingsCatalog();
    assert.deepStrictEqual(cat.recommendedSettingIds, ['keep-me']);
    assert.strictEqual(cat.settings.length, 1);
  });

  test('persists to disk — changes survive cache reset', () => {
    _resetCatalogCache();
    fs.writeFileSync(tmpCatalog, JSON.stringify({
      sourceUrl: '', lastSyncedAt: '', catalogVersion: 1,
      recommendedSettingIds: [], settings: [],
    }));
    saveSettingsCatalogMeta({ lastSyncedAt: '2026-05-01T12:00:00Z' });
    _resetCatalogCache();
    const raw = JSON.parse(fs.readFileSync(tmpCatalog, 'utf8'));
    assert.strictEqual(raw.lastSyncedAt, '2026-05-01T12:00:00Z');
  });
});

// ─── findCatalogEntry ─────────────────────────────────────────────────────────

suite('findCatalogEntry', () => {
  test('finds entry in catalog settings array', () => {
    _resetCatalogCache();
    fs.writeFileSync(tmpCatalog, JSON.stringify({
      sourceUrl: '', lastSyncedAt: '', catalogVersion: 1,
      recommendedSettingIds: [],
      settings: [{ id: 'catalog-entry-1', key: 'some.key', label: 'Test Entry' }],
    }));
    const entry = findCatalogEntry('catalog-entry-1');
    assert.ok(entry !== null);
    assert.strictEqual(entry.id, 'catalog-entry-1');
  });

  test('finds entry in STATIC_SETTINGS (setting-model)', () => {
    _resetCatalogCache();
    fs.writeFileSync(tmpCatalog, JSON.stringify({
      sourceUrl: '', lastSyncedAt: '', catalogVersion: 1,
      recommendedSettingIds: [], settings: [],
    }));
    const entry = findCatalogEntry('setting-model');
    assert.ok(entry !== null);
    assert.strictEqual(entry.id, 'setting-model');
    assert.strictEqual(entry.inputType, 'select');
  });

  test('finds entry in STATIC_SETTINGS (setting-thinking-tokens)', () => {
    _resetCatalogCache();
    fs.writeFileSync(tmpCatalog, JSON.stringify({
      sourceUrl: '', lastSyncedAt: '', catalogVersion: 1,
      recommendedSettingIds: [], settings: [],
    }));
    const entry = findCatalogEntry('setting-thinking-tokens');
    assert.ok(entry !== null);
    assert.strictEqual(entry.inputType, 'number');
  });

  test('catalog entry takes precedence over nothing (catalog is checked first)', () => {
    _resetCatalogCache();
    // Put a custom entry with same id as a static setting — catalog wins
    fs.writeFileSync(tmpCatalog, JSON.stringify({
      sourceUrl: '', lastSyncedAt: '', catalogVersion: 1,
      recommendedSettingIds: [],
      settings: [{ id: 'setting-model', key: 'model', label: 'Overridden', inputType: 'text' }],
    }));
    const entry = findCatalogEntry('setting-model');
    assert.strictEqual(entry.label, 'Overridden');
  });

  test('returns null for unknown id', () => {
    _resetCatalogCache();
    fs.writeFileSync(tmpCatalog, JSON.stringify({
      sourceUrl: '', lastSyncedAt: '', catalogVersion: 1,
      recommendedSettingIds: [], settings: [],
    }));
    const entry = findCatalogEntry('does-not-exist-xyz');
    assert.strictEqual(entry, null);
  });
});

// ─── Report ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
const total = passed + failed;
console.log(`${total} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
