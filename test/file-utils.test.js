'use strict';
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// Set env overrides BEFORE requiring server so constants are baked in correctly.
const tmpRoot     = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-fileutils-test-'));
const tmpProjects = path.join(tmpRoot, 'projects');
const tmpState    = path.join(tmpRoot, 'state.json');
const tmpCatalog  = path.join(tmpRoot, 'catalog.json');

process.env.ECC_PROJECTS_DIR = tmpProjects;
process.env.ECC_STATE_FILE   = tmpState;
process.env.ECC_CATALOG_FILE = tmpCatalog;

const { ensureDir, copyRecursive, removeTarget, copyEccRootFiles } = require('../server');

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

// ─── ensureDir ────────────────────────────────────────────────────────────────

suite('ensureDir', () => {
  test('creates a directory that does not exist', () => {
    const d = path.join(tmpRoot, `newdir-${Date.now()}`);
    assert.ok(!fs.existsSync(d));
    ensureDir(d);
    assert.ok(fs.existsSync(d));
    assert.ok(fs.statSync(d).isDirectory());
  });

  test('no-op when directory already exists', () => {
    const d = path.join(tmpRoot, 'existing-dir');
    fs.mkdirSync(d, { recursive: true });
    assert.doesNotThrow(() => ensureDir(d));
    assert.ok(fs.existsSync(d));
  });

  test('creates nested directories recursively', () => {
    const d = path.join(tmpRoot, 'deep', 'nested', 'dir');
    ensureDir(d);
    assert.ok(fs.statSync(d).isDirectory());
  });
});

// ─── copyRecursive ────────────────────────────────────────────────────────────

suite('copyRecursive', () => {
  test('copies a single file to destination', () => {
    const src  = path.join(tmpRoot, 'src-single.txt');
    const dest = path.join(tmpRoot, 'dest-single.txt');
    fs.writeFileSync(src, 'hello world');
    copyRecursive(src, dest);
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'hello world');
  });

  test('returns true on successful copy', () => {
    const src  = path.join(tmpRoot, 'src-ret.txt');
    const dest = path.join(tmpRoot, 'dest-ret.txt');
    fs.writeFileSync(src, 'data');
    const result = copyRecursive(src, dest);
    assert.strictEqual(result, true);
  });

  test('returns false when source does not exist', () => {
    const result = copyRecursive(
      path.join(tmpRoot, 'no-such-file.txt'),
      path.join(tmpRoot, 'nowhere.txt'),
    );
    assert.strictEqual(result, false);
  });

  test('copies a directory tree recursively', () => {
    const srcDir  = path.join(tmpRoot, 'tree-src');
    const destDir = path.join(tmpRoot, 'tree-dest');
    fs.mkdirSync(path.join(srcDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'a.txt'), 'aaa');
    fs.writeFileSync(path.join(srcDir, 'sub', 'b.txt'), 'bbb');
    copyRecursive(srcDir, destDir);
    assert.strictEqual(fs.readFileSync(path.join(destDir, 'a.txt'), 'utf8'), 'aaa');
    assert.strictEqual(fs.readFileSync(path.join(destDir, 'sub', 'b.txt'), 'utf8'), 'bbb');
  });

  test('creates parent directories for nested destination file', () => {
    const src  = path.join(tmpRoot, 'flat-src.txt');
    const dest = path.join(tmpRoot, 'parent-a', 'parent-b', 'flat-dest.txt');
    fs.writeFileSync(src, 'content');
    copyRecursive(src, dest);
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'content');
  });
});

// ─── removeTarget ─────────────────────────────────────────────────────────────

suite('removeTarget', () => {
  test('removes a file', () => {
    const f = path.join(tmpRoot, 'remove-me.txt');
    fs.writeFileSync(f, 'bye');
    removeTarget(f);
    assert.ok(!fs.existsSync(f));
  });

  test('removes a directory and all its contents recursively', () => {
    const d = path.join(tmpRoot, 'remove-dir');
    fs.mkdirSync(path.join(d, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(d, 'file.txt'), 'x');
    fs.writeFileSync(path.join(d, 'sub', 'deep.txt'), 'y');
    removeTarget(d);
    assert.ok(!fs.existsSync(d));
  });

  test('no-op when path does not exist', () => {
    assert.doesNotThrow(() => removeTarget(path.join(tmpRoot, 'ghost-does-not-exist.txt')));
  });
});

// ─── copyEccRootFiles ─────────────────────────────────────────────────────────

suite('copyEccRootFiles', () => {
  test('copies AGENTS.md when it exists in vDir and not in dest', () => {
    const vDir     = path.join(tmpRoot, 'vdir-copy-1');
    const claudeDir = path.join(tmpRoot, 'claude-copy-1');
    fs.mkdirSync(vDir, { recursive: true });
    fs.writeFileSync(path.join(vDir, 'AGENTS.md'), '# Agents');
    copyEccRootFiles(vDir, claudeDir);
    assert.ok(fs.existsSync(path.join(claudeDir, 'AGENTS.md')));
    assert.strictEqual(fs.readFileSync(path.join(claudeDir, 'AGENTS.md'), 'utf8'), '# Agents');
  });

  test('does not overwrite dest file that already exists', () => {
    const vDir      = path.join(tmpRoot, 'vdir-copy-2');
    const claudeDir = path.join(tmpRoot, 'claude-copy-2');
    fs.mkdirSync(vDir, { recursive: true });
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(vDir, 'AGENTS.md'), '# New Version');
    fs.writeFileSync(path.join(claudeDir, 'AGENTS.md'), '# Existing');
    copyEccRootFiles(vDir, claudeDir);
    assert.strictEqual(fs.readFileSync(path.join(claudeDir, 'AGENTS.md'), 'utf8'), '# Existing');
  });

  test('no-op when source file does not exist in vDir', () => {
    const vDir      = path.join(tmpRoot, 'vdir-copy-3');
    const claudeDir = path.join(tmpRoot, 'claude-copy-3');
    fs.mkdirSync(vDir, { recursive: true });
    copyEccRootFiles(vDir, claudeDir);
    assert.ok(!fs.existsSync(path.join(claudeDir, 'AGENTS.md')));
  });
});

// ─── Report ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
const total = passed + failed;
console.log(`${total} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
