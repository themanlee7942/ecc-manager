'use strict';
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// Set env overrides BEFORE requiring server so constants are baked in correctly.
const tmpRoot     = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-components-test-'));
const tmpProjects = path.join(tmpRoot, 'projects');
const tmpVersions = path.join(tmpProjects, '.ecc-versions');
const tmpState    = path.join(tmpRoot, 'state.json');
const tmpCatalog  = path.join(tmpRoot, 'catalog.json');

process.env.ECC_PROJECTS_DIR = tmpProjects;
process.env.ECC_STATE_FILE   = tmpState;
process.env.ECC_CATALOG_FILE = tmpCatalog;

const {
  installComponent,
  removeComponent,
  projectSummary,
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProj(name, extra = {}) {
  return { name, components: {}, ...extra };
}

function makeState(projName, proj) {
  return { versions: {}, activeVersion: null, projects: { [projName]: proj } };
}

function settingsPath(projName) {
  return path.join(tmpProjects, projName, '.claude', 'settings.json');
}

function readSettingsFile(projName) {
  const f = settingsPath(projName);
  if (!fs.existsSync(f)) return {};
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

// ─── installComponent — setting ───────────────────────────────────────────────

suite('installComponent (setting)', () => {
  test('writes setting to settings.json and marks component installed', () => {
    const proj  = makeProj('proj-s1');
    const state = makeState('proj-s1', proj);
    const comp  = { id: 'setting-model', type: 'setting', settingKey: 'model', defaultValue: 'sonnet' };
    const result = installComponent(comp, 'proj-s1', state);
    assert.strictEqual(result.ok, true);
    const s = readSettingsFile('proj-s1');
    assert.strictEqual(s.model, 'sonnet');
    assert.strictEqual(proj.components['setting-model'].installed, true);
    assert.strictEqual(proj.components['setting-model'].value, 'sonnet');
  });

  test('writes nested setting via valuePath', () => {
    const proj  = makeProj('proj-s2');
    const state = makeState('proj-s2', proj);
    const comp  = { id: 'setting-thinking', type: 'setting', settingKey: 'env.MAX_THINKING_TOKENS', defaultValue: '10000' };
    installComponent(comp, 'proj-s2', state);
    const s = readSettingsFile('proj-s2');
    assert.strictEqual(s.env.MAX_THINKING_TOKENS, '10000');
    assert.strictEqual(proj.components['setting-thinking'].installed, true);
  });

  test('does not error if settings.json does not yet exist', () => {
    const proj  = makeProj('proj-s3-fresh');
    const state = makeState('proj-s3-fresh', proj);
    const comp  = { id: 'setting-model', type: 'setting', settingKey: 'model', defaultValue: 'opus' };
    const result = installComponent(comp, 'proj-s3-fresh', state);
    assert.strictEqual(result.ok, true);
  });
});

// ─── installComponent — hook ──────────────────────────────────────────────────

suite('installComponent (hook)', () => {
  test('returns error for quarantined hook', () => {
    const proj   = makeProj('proj-h1');
    const state  = makeState('proj-h1', proj);
    const comp   = { id: 'hook-quarantined', type: 'hook', quarantined: true, quarantineReason: 'Manual setup required' };
    const result = installComponent(comp, 'proj-h1', state);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('Manual setup required'));
  });

  test('returns error when no ECC version available', () => {
    const proj  = makeProj('proj-h2');
    const state = makeState('proj-h2', proj);
    const comp  = { id: 'hook-fmt', type: 'hook', quarantined: false, hookEvent: 'PostToolUse', hookId: 'format-on-save' };
    const result = installComponent(comp, 'proj-h2', state);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('No ECC version'));
  });

  test('merges hook entry from hooks.json into project settings.json', () => {
    const verId  = 'hook-install-ver';
    const hDir   = path.join(tmpVersions, verId, 'hooks');
    fs.mkdirSync(hDir, { recursive: true });
    fs.writeFileSync(path.join(hDir, 'hooks.json'), JSON.stringify({
      hooks: {
        PostToolUse: [{ id: 'format-on-save', command: 'prettier --write "$FILE_PATH"' }],
      },
    }));
    const proj  = makeProj('proj-h3', { eccVersion: verId });
    const state = makeState('proj-h3', proj);
    state.activeVersion = verId;
    const comp  = { id: 'hook-fmt', type: 'hook', quarantined: false, hookEvent: 'PostToolUse', hookId: 'format-on-save' };
    const result = installComponent(comp, 'proj-h3', state);
    assert.strictEqual(result.ok, true);
    const s = readSettingsFile('proj-h3');
    assert.ok(Array.isArray(s.hooks.PostToolUse));
    assert.ok(s.hooks.PostToolUse.some(h => h.id === 'format-on-save'));
    assert.strictEqual(proj.components['hook-fmt'].installed, true);
  });

  test('returns error when hookId is not found in hooks.json', () => {
    const verId  = 'hook-missing-ver';
    const hDir   = path.join(tmpVersions, verId, 'hooks');
    fs.mkdirSync(hDir, { recursive: true });
    fs.writeFileSync(path.join(hDir, 'hooks.json'), JSON.stringify({
      hooks: { PostToolUse: [{ id: 'other-hook', command: 'echo' }] },
    }));
    const proj  = makeProj('proj-h4', { eccVersion: verId });
    const state = makeState('proj-h4', proj);
    state.activeVersion = verId;
    const comp  = { id: 'hook-no-exist', type: 'hook', quarantined: false, hookEvent: 'PostToolUse', hookId: 'no-such-hook' };
    const result = installComponent(comp, 'proj-h4', state);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('not found'));
  });
});

// ─── installComponent — mcp ───────────────────────────────────────────────────

suite('installComponent (mcp)', () => {
  test('writes mcpConfig to mcpServers in settings.json', () => {
    const proj  = makeProj('proj-m1');
    const state = makeState('proj-m1', proj);
    const comp  = {
      id: 'mcp-github', type: 'mcp', mcpKey: 'github',
      mcpConfig: { command: 'npx', args: ['-y', '@github/mcp'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' } },
      requiresKey: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    };
    const result = installComponent(comp, 'proj-m1', state);
    assert.strictEqual(result.ok, true);
    const s = readSettingsFile('proj-m1');
    assert.ok(s.mcpServers && s.mcpServers.github);
    assert.deepStrictEqual(s.mcpServers.github, comp.mcpConfig);
    assert.ok(result.note.includes('GITHUB_PERSONAL_ACCESS_TOKEN'));
  });

  test('marks mcp installed even when mcpConfig is absent', () => {
    const proj  = makeProj('proj-m2');
    const state = makeState('proj-m2', proj);
    const comp  = { id: 'mcp-context7', type: 'mcp', mcpKey: 'context7' };
    const result = installComponent(comp, 'proj-m2', state);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(proj.components['mcp-context7'].installed, true);
  });

  test('note excludes env-var reminder when requiresKey is absent', () => {
    const proj  = makeProj('proj-m3');
    const state = makeState('proj-m3', proj);
    const comp  = { id: 'mcp-ctx', type: 'mcp', mcpKey: 'context7', mcpConfig: { command: 'npx' } };
    const result = installComponent(comp, 'proj-m3', state);
    assert.strictEqual(result.ok, true);
    assert.ok(!result.note.includes('Set env vars'));
  });
});

// ─── installComponent — file type ─────────────────────────────────────────────

suite('installComponent (file type)', () => {
  test('returns error when source file is absent even if a version dir exists', () => {
    // Ensure at least one version dir exists so auto-assign can pick it up,
    // then verify that a missing sourcePath still returns ok:false.
    const verId = 'file-nopath-ver';
    fs.mkdirSync(path.join(tmpVersions, verId), { recursive: true });
    const proj  = makeProj('proj-f1', { eccVersion: verId });
    const state = makeState('proj-f1', proj);
    state.activeVersion = verId;
    const comp  = { id: 'agent-ghost', type: 'agent', sourcePath: 'agents/ghost.md', paths: [] };
    const result = installComponent(comp, 'proj-f1', state);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('Not found'));
  });

  test('copies file from versionDir to projectDir and marks installed', () => {
    const verId   = 'file-install-ver';
    const vDir    = path.join(tmpVersions, verId);
    const agentsDir = path.join(vDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'planner.md'), '# Planner Agent');
    const proj  = makeProj('proj-f2', { eccVersion: verId });
    const state = makeState('proj-f2', proj);
    state.activeVersion = verId;
    const comp  = { id: 'agent-planner', type: 'agent', sourcePath: 'agents/planner.md', paths: [] };
    const result = installComponent(comp, 'proj-f2', state);
    assert.strictEqual(result.ok, true);
    const dest = path.join(tmpProjects, 'proj-f2', '.claude', 'agents', 'planner.md');
    assert.ok(fs.existsSync(dest));
    assert.strictEqual(proj.components['agent-planner'].installed, true);
  });

  test('returns error when source path is missing in versionDir', () => {
    const verId = 'file-missing-ver';
    fs.mkdirSync(path.join(tmpVersions, verId), { recursive: true });
    const proj  = makeProj('proj-f3', { eccVersion: verId });
    const state = makeState('proj-f3', proj);
    state.activeVersion = verId;
    const comp  = { id: 'rule-x', type: 'rule', sourcePath: 'rules/common/no-such-rule.md', paths: [] };
    const result = installComponent(comp, 'proj-f3', state);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('Not found'));
  });
});

// ─── removeComponent ──────────────────────────────────────────────────────────

suite('removeComponent (setting)', () => {
  test('removes setting key from settings.json', () => {
    const proj  = makeProj('proj-rs1');
    const state = makeState('proj-rs1', proj);
    // Install first so settings.json has the key
    installComponent(
      { id: 'setting-model', type: 'setting', settingKey: 'model', defaultValue: 'sonnet' },
      'proj-rs1', state,
    );
    const comp   = { id: 'setting-model', type: 'setting', settingKey: 'model' };
    const result = removeComponent(comp, 'proj-rs1', state);
    assert.strictEqual(result.ok, true);
    const s = readSettingsFile('proj-rs1');
    assert.strictEqual(s.model, undefined);
    assert.strictEqual(proj.components['setting-model'].installed, false);
  });

  test('removes nested setting key and prunes empty parent', () => {
    const proj  = makeProj('proj-rs2');
    const state = makeState('proj-rs2', proj);
    installComponent(
      { id: 'setting-thinking', type: 'setting', settingKey: 'env.MAX_THINKING_TOKENS', defaultValue: '10000' },
      'proj-rs2', state,
    );
    removeComponent(
      { id: 'setting-thinking', type: 'setting', settingKey: 'env.MAX_THINKING_TOKENS' },
      'proj-rs2', state,
    );
    const s = readSettingsFile('proj-rs2');
    assert.strictEqual(s.env, undefined);
  });
});

suite('removeComponent (hook)', () => {
  test('removes hook entry from settings.hooks', () => {
    const verId = 'remove-hook-ver';
    const hDir  = path.join(tmpVersions, verId, 'hooks');
    fs.mkdirSync(hDir, { recursive: true });
    fs.writeFileSync(path.join(hDir, 'hooks.json'), JSON.stringify({
      hooks: { PostToolUse: [{ id: 'fmt', command: 'prettier' }] },
    }));
    const proj  = makeProj('proj-rh1', { eccVersion: verId });
    const state = makeState('proj-rh1', proj);
    state.activeVersion = verId;
    installComponent(
      { id: 'hook-fmt', type: 'hook', quarantined: false, hookEvent: 'PostToolUse', hookId: 'fmt' },
      'proj-rh1', state,
    );
    const result = removeComponent(
      { id: 'hook-fmt', type: 'hook', hookEvent: 'PostToolUse', hookId: 'fmt' },
      'proj-rh1', state,
    );
    assert.strictEqual(result.ok, true);
    const s = readSettingsFile('proj-rh1');
    assert.strictEqual(s.hooks, undefined);
    assert.strictEqual(proj.components['hook-fmt'].installed, false);
  });
});

suite('removeComponent (mcp)', () => {
  test('removes mcpKey from mcpServers in settings.json', () => {
    const proj  = makeProj('proj-rm1');
    const state = makeState('proj-rm1', proj);
    installComponent(
      { id: 'mcp-github', type: 'mcp', mcpKey: 'github', mcpConfig: { command: 'npx' } },
      'proj-rm1', state,
    );
    const result = removeComponent(
      { id: 'mcp-github', type: 'mcp', mcpKey: 'github' },
      'proj-rm1', state,
    );
    assert.strictEqual(result.ok, true);
    const s = readSettingsFile('proj-rm1');
    assert.strictEqual(s.mcpServers, undefined);
    assert.strictEqual(proj.components['mcp-github'].installed, false);
  });
});

suite('removeComponent (file type)', () => {
  test('removes copied file from project directory', () => {
    const verId   = 'remove-file-ver';
    const agentsDir = path.join(tmpVersions, verId, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'planner.md'), '# Planner');
    const proj  = makeProj('proj-rf1', { eccVersion: verId });
    const state = makeState('proj-rf1', proj);
    state.activeVersion = verId;
    installComponent(
      { id: 'agent-planner', type: 'agent', sourcePath: 'agents/planner.md', paths: [] },
      'proj-rf1', state,
    );
    const dest = path.join(tmpProjects, 'proj-rf1', '.claude', 'agents', 'planner.md');
    assert.ok(fs.existsSync(dest), 'file should be present after install');
    const result = removeComponent(
      { id: 'agent-planner', type: 'agent', targetPath: 'agents/planner.md', paths: [] },
      'proj-rf1', state,
    );
    assert.strictEqual(result.ok, true);
    assert.ok(!fs.existsSync(dest));
    assert.strictEqual(proj.components['agent-planner'].installed, false);
  });
});

// ─── projectSummary ───────────────────────────────────────────────────────────

suite('projectSummary', () => {
  test('returns installedCount 0 when no components are installed', () => {
    const proj = { name: 'p', components: {} };
    const { installedCount } = projectSummary(proj);
    assert.strictEqual(installedCount, 0);
  });

  test('returns correct count for partially installed components', () => {
    const proj = {
      name: 'p',
      components: {
        'setting-model':    { installed: true },
        'setting-thinking': { installed: false },
        'mcp-github':       { installed: true },
        'agent-planner':    { installed: false },
        'mcp-context7':     { installed: true },
      },
    };
    const { installedCount } = projectSummary(proj);
    assert.strictEqual(installedCount, 3);
  });

  test('returns 0 when components is undefined', () => {
    const proj = { name: 'p' };
    const { installedCount } = projectSummary(proj);
    assert.strictEqual(installedCount, 0);
  });
});

// ─── Report ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
const total = passed + failed;
console.log(`${total} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
