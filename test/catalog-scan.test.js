'use strict';
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// Set env overrides BEFORE requiring server so constants are baked in correctly.
const tmpRoot      = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-catalog-test-'));
const tmpProjects  = path.join(tmpRoot, 'projects');
const tmpVersions  = path.join(tmpProjects, '.ecc-versions');
const tmpState     = path.join(tmpRoot, 'state.json');
const tmpCatalog   = path.join(tmpRoot, 'catalog.json');

process.env.ECC_PROJECTS_DIR = tmpProjects;
process.env.ECC_STATE_FILE   = tmpState;
process.env.ECC_CATALOG_FILE = tmpCatalog;

const {
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
  _resetVersionCatalogCache,
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

// ─── readFrontmatter ──────────────────────────────────────────────────────────

suite('readFrontmatter', () => {
  test('parses valid frontmatter key/value pairs', () => {
    const f = path.join(tmpRoot, 'valid-fm.md');
    fs.writeFileSync(f, '---\nname: my-agent\ndescription: Does things\n---\n# Content');
    const fm = readFrontmatter(f);
    assert.strictEqual(fm.name, 'my-agent');
    assert.strictEqual(fm.description, 'Does things');
  });

  test('returns {} for a file that does not exist', () => {
    const fm = readFrontmatter(path.join(tmpRoot, 'no-such-file.md'));
    assert.deepStrictEqual(fm, {});
  });

  test('returns {} when file has no frontmatter block', () => {
    const f = path.join(tmpRoot, 'no-fm.md');
    fs.writeFileSync(f, '# Just a heading\nNo frontmatter block here.');
    const fm = readFrontmatter(f);
    assert.deepStrictEqual(fm, {});
  });

  test('strips wrapping single quotes from values', () => {
    const f = path.join(tmpRoot, 'single-quoted.md');
    fs.writeFileSync(f, "---\nkey: 'quoted value'\n---\ncontent");
    const fm = readFrontmatter(f);
    assert.strictEqual(fm.key, 'quoted value');
  });

  test('strips wrapping double quotes from values', () => {
    const f = path.join(tmpRoot, 'double-quoted.md');
    fs.writeFileSync(f, '---\nkey: "double quoted"\n---\ncontent');
    const fm = readFrontmatter(f);
    assert.strictEqual(fm.key, 'double quoted');
  });

  test('parses frontmatter with CRLF line endings', () => {
    const f = path.join(tmpRoot, 'crlf-fm.md');
    fs.writeFileSync(f, '---\r\nname: crlf-agent\r\ndescription: CRLF test\r\n---\r\ncontent');
    const fm = readFrontmatter(f);
    assert.strictEqual(fm.name, 'crlf-agent');
    assert.strictEqual(fm.description, 'CRLF test');
  });
});

// ─── scanCatalog ──────────────────────────────────────────────────────────────

suite('scanCatalog', () => {
  test('always includes static settings regardless of vDir contents', () => {
    const vDir = path.join(tmpRoot, 'vscan-empty');
    fs.mkdirSync(vDir, { recursive: true });
    const items = scanCatalog(vDir);
    const ids = items.map(i => i.id);
    assert.ok(ids.includes('setting-model'));
    assert.ok(ids.includes('setting-thinking-tokens'));
    assert.ok(ids.includes('setting-autocompact'));
  });

  test('uses fallback MCP entries when mcp-configs/mcp-servers.json is absent', () => {
    const vDir = path.join(tmpRoot, 'vscan-no-mcp');
    fs.mkdirSync(vDir, { recursive: true });
    const items = scanCatalog(vDir);
    const mcpItems = items.filter(i => i.type === 'mcp');
    assert.ok(mcpItems.length > 0);
    assert.ok(mcpItems.some(m => m.id === 'mcp-github'));
    assert.ok(mcpItems.some(m => m.id === 'mcp-context7'));
  });

  test('reads rules from rules/<lang>/*.md and assigns correct id', () => {
    const vDir = path.join(tmpRoot, 'vscan-rules');
    const rulesDir = path.join(vDir, 'rules', 'common');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'testing.md'), '---\ndescription: Testing rules\n---\ncontent');
    const items = scanCatalog(vDir);
    const rule = items.find(i => i.id === 'rule-common-testing');
    assert.ok(rule, 'expected rule-common-testing in catalog');
    assert.strictEqual(rule.type, 'rule');
    assert.strictEqual(rule.sourcePath, 'rules/common/testing.md');
  });

  test('reads agents from agents/*.md and assigns correct id', () => {
    const vDir = path.join(tmpRoot, 'vscan-agents');
    const agentsDir = path.join(vDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'planner.md'), '---\ndescription: Planning agent\n---\ncontent');
    const items = scanCatalog(vDir);
    const agent = items.find(i => i.id === 'agent-planner');
    assert.ok(agent, 'expected agent-planner in catalog');
    assert.strictEqual(agent.type, 'agent');
    assert.strictEqual(agent.sourcePath, 'agents/planner.md');
  });

  test('reads MCP servers from mcp-configs/mcp-servers.json when present', () => {
    const vDir = path.join(tmpRoot, 'vscan-mcp');
    const mcpDir = path.join(vDir, 'mcp-configs');
    fs.mkdirSync(mcpDir, { recursive: true });
    fs.writeFileSync(path.join(mcpDir, 'mcp-servers.json'), JSON.stringify({
      mcpServers: {
        'my-server': { description: 'Custom MCP', env: { MY_API_KEY: '' } },
      },
    }));
    const items = scanCatalog(vDir);
    const mcp = items.find(i => i.id === 'mcp-my-server');
    assert.ok(mcp, 'expected mcp-my-server in catalog');
    assert.strictEqual(mcp.name, 'my-server');
    assert.strictEqual(mcp.requiresKey, 'MY_API_KEY');
  });

  test('reads hooks from hooks/hooks.json and assigns correct id', () => {
    const vDir = path.join(tmpRoot, 'vscan-hooks');
    const hooksDir = path.join(vDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify({
      hooks: {
        PostToolUse: [{ id: 'format-on-save', description: 'Run prettier after edits' }],
      },
    }));
    const items = scanCatalog(vDir);
    const hook = items.find(i => i.id === 'hook-format-on-save');
    assert.ok(hook, 'expected hook-format-on-save in catalog');
    assert.strictEqual(hook.type, 'hook');
    assert.strictEqual(hook.hookEvent, 'PostToolUse');
  });

  test('silently skips malformed mcp-servers.json and falls back to static entries', () => {
    const vDir = path.join(tmpRoot, 'vscan-bad-mcp');
    const mcpDir = path.join(vDir, 'mcp-configs');
    fs.mkdirSync(mcpDir, { recursive: true });
    fs.writeFileSync(path.join(mcpDir, 'mcp-servers.json'), '{ not valid json }}');
    const items = scanCatalog(vDir);
    assert.ok(Array.isArray(items));
    assert.ok(items.some(i => i.id === 'setting-model'), 'static settings should still appear');
  });
});

// ─── clientComp ───────────────────────────────────────────────────────────────

suite('clientComp', () => {
  test('strips paths, moduleId, and multiPath from component', () => {
    const comp = {
      id: 'rule-x', type: 'rule', name: 'x.md',
      paths: ['rules/common/x.md'], moduleId: 'mod-rules', multiPath: true,
      sourcePath: 'rules/common/x.md',
    };
    const safe = clientComp(comp);
    assert.ok(!('paths' in safe));
    assert.ok(!('moduleId' in safe));
    assert.ok(!('multiPath' in safe));
  });

  test('keeps all other fields intact', () => {
    const comp = { id: 'agent-planner', type: 'agent', name: 'planner.md', sourcePath: 'agents/planner.md', paths: [] };
    const safe = clientComp(comp);
    assert.strictEqual(safe.id, 'agent-planner');
    assert.strictEqual(safe.type, 'agent');
    assert.strictEqual(safe.sourcePath, 'agents/planner.md');
  });

  test('does not mutate the original component object', () => {
    const comp = { id: 'x', paths: ['a', 'b'], moduleId: 'y', multiPath: true };
    clientComp(comp);
    assert.ok('paths' in comp);
    assert.ok('moduleId' in comp);
    assert.ok('multiPath' in comp);
  });
});

// ─── resolveVersion ───────────────────────────────────────────────────────────

suite('resolveVersion', () => {
  test('returns {verId: null, vDir: null} when proj and state have no version', () => {
    const proj  = { name: 'p', components: {} };
    const state = { activeVersion: null, projects: { p: proj } };
    const { verId, vDir } = resolveVersion(proj, state);
    assert.strictEqual(verId, null);
    assert.strictEqual(vDir, null);
  });

  test('returns {verId: null, vDir: null} when version directory does not exist on disk', () => {
    const proj  = { name: 'p', eccVersion: 'v99.99.99', components: {} };
    const state = { activeVersion: 'v99.99.99', projects: { p: proj } };
    const { verId, vDir } = resolveVersion(proj, state);
    assert.strictEqual(verId, null);
    assert.strictEqual(vDir, null);
  });

  test('returns verId and vDir when version directory exists', () => {
    const verId   = 'test-resolve-v1';
    const realVDir = path.join(tmpVersions, verId);
    fs.mkdirSync(realVDir, { recursive: true });
    const proj  = { name: 'p', eccVersion: verId, components: {} };
    const state = { activeVersion: verId, projects: { p: proj } };
    const result = resolveVersion(proj, state);
    assert.strictEqual(result.verId, verId);
    assert.ok(result.vDir.endsWith(verId));
  });
});

// ─── getCatalog ───────────────────────────────────────────────────────────────

suite('getCatalog', () => {
  test('returns an array of catalog items for a valid vDir', () => {
    const verId = 'gc-ver-1';
    const vDir  = path.join(tmpVersions, verId);
    fs.mkdirSync(vDir, { recursive: true });
    const items = getCatalog(vDir, verId);
    assert.ok(Array.isArray(items));
    assert.ok(items.length >= 4, 'expected at least the 4 static settings');
  });

  test('caches result — second call returns same array reference', () => {
    const verId = 'gc-ver-2';
    const vDir  = path.join(tmpVersions, verId);
    fs.mkdirSync(vDir, { recursive: true });
    const a = getCatalog(vDir, verId);
    const b = getCatalog(vDir, verId);
    assert.strictEqual(a, b);
  });
});

// ─── kindPriority ─────────────────────────────────────────────────────────────

suite('kindPriority', () => {
  test('returns 1 for platform', () => assert.strictEqual(kindPriority('platform'), 1));
  test('returns 2 for rules',    () => assert.strictEqual(kindPriority('rules'), 2));
  test('returns 3 for hooks',    () => assert.strictEqual(kindPriority('hooks'), 3));
  test('returns 4 for mcp',      () => assert.strictEqual(kindPriority('mcp'), 4));
  test('returns 5 for agents',   () => assert.strictEqual(kindPriority('agents'), 5));
  test('returns 6 for skills',   () => assert.strictEqual(kindPriority('skills'), 6));
  test('returns 6 for orchestration', () => assert.strictEqual(kindPriority('orchestration'), 6));
  test('returns 7 for commands', () => assert.strictEqual(kindPriority('commands'), 7));
  test('returns 8 for unknown kind', () => assert.strictEqual(kindPriority('unknown-kind'), 8));
});

// ─── getVersionId ─────────────────────────────────────────────────────────────

suite('getVersionId', () => {
  test('returns version from package.json when present', () => {
    const dir = path.join(tmpRoot, 'gv-pkg');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '2.5.1' }));
    assert.strictEqual(getVersionId(dir), '2.5.1');
  });

  test('falls back to pull-<timestamp> when no package.json and no git', () => {
    const dir = path.join(tmpRoot, 'gv-fallback');
    fs.mkdirSync(dir, { recursive: true });
    const id = getVersionId(dir);
    assert.ok(id.startsWith('pull-'), `expected pull- prefix, got: ${id}`);
    assert.ok(/^\d+$/.test(id.slice('pull-'.length)), 'expected numeric timestamp suffix');
  });
});

// ─── scanCatalogV2 ────────────────────────────────────────────────────────────

suite('scanCatalogV2', () => {
  test('always includes static settings', () => {
    const vDir = path.join(tmpRoot, 'v2-empty');
    fs.mkdirSync(vDir, { recursive: true });
    fs.mkdirSync(path.join(vDir, 'manifests'), { recursive: true });
    fs.writeFileSync(path.join(vDir, 'manifests', 'install-modules.json'), JSON.stringify({ modules: [] }));
    const items = scanCatalogV2(vDir);
    assert.ok(Array.isArray(items));
    assert.ok(items.some(i => i.id === 'setting-model'), 'static settings should be present');
  });

  test('falls back to FALLBACK_MCP when mcp-configs/mcp-servers.json is absent', () => {
    const vDir = path.join(tmpRoot, 'v2-no-mcp');
    fs.mkdirSync(vDir, { recursive: true });
    fs.mkdirSync(path.join(vDir, 'manifests'), { recursive: true });
    fs.writeFileSync(path.join(vDir, 'manifests', 'install-modules.json'), JSON.stringify({ modules: [] }));
    const items = scanCatalogV2(vDir);
    assert.ok(items.some(i => i.type === 'mcp'), 'fallback MCP entries should be present');
  });

  test('emits one rule entry per .md leaf (single-file path)', () => {
    const vDir = path.join(tmpRoot, 'v2-rules');
    fs.mkdirSync(path.join(vDir, 'manifests'), { recursive: true });
    fs.mkdirSync(path.join(vDir, 'rules', 'common'), { recursive: true });
    fs.writeFileSync(path.join(vDir, 'rules', 'common', 'testing.md'), '# Testing rule');
    fs.writeFileSync(path.join(vDir, 'manifests', 'install-modules.json'), JSON.stringify({
      modules: [
        { id: 'common-rules', kind: 'rules', description: 'Common rules', paths: ['rules/common/testing.md'] },
      ],
    }));
    const items = scanCatalogV2(vDir);
    // No module-level entry for rules — only leaves
    assert.strictEqual(items.find(i => i.id === 'module-common-rules'), undefined, 'should NOT emit module-level rules entry');
    const leaf = items.find(i => i.type === 'rule' && i.sourcePath === 'rules/common/testing.md');
    assert.ok(leaf, 'expected per-file leaf entry for rules/common/testing.md');
    assert.strictEqual(leaf.priority, 2);
    assert.strictEqual(leaf.moduleId, 'common-rules');
    assert.match(leaf.id, /^rule-/);
  });

  test('expands directory-path rules module into one entry per .md file recursively', () => {
    const vDir = path.join(tmpRoot, 'v2-rules-dir');
    fs.mkdirSync(path.join(vDir, 'manifests'), { recursive: true });
    fs.mkdirSync(path.join(vDir, 'rules', 'common'), { recursive: true });
    fs.mkdirSync(path.join(vDir, 'rules', 'typescript'), { recursive: true });
    fs.writeFileSync(path.join(vDir, 'rules', 'common', 'testing.md'), 'a');
    fs.writeFileSync(path.join(vDir, 'rules', 'common', 'security.md'), 'b');
    fs.writeFileSync(path.join(vDir, 'rules', 'typescript', 'patterns.md'), 'c');
    fs.writeFileSync(path.join(vDir, 'rules', 'common', 'README.txt'), 'not markdown'); // ignored
    fs.writeFileSync(path.join(vDir, 'manifests', 'install-modules.json'), JSON.stringify({
      modules: [{ id: 'rules-core', kind: 'rules', description: 'All rules', paths: ['rules'] }],
    }));
    const items = scanCatalogV2(vDir);
    const ruleLeaves = items.filter(i => i.type === 'rule' && i.moduleId === 'rules-core');
    const paths = ruleLeaves.map(l => l.sourcePath).sort();
    assert.deepStrictEqual(paths, [
      'rules/common/security.md',
      'rules/common/testing.md',
      'rules/typescript/patterns.md',
    ]);
    // IDs are unique and slug-safe
    const ids = ruleLeaves.map(l => l.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'leaf IDs must be unique');
  });

  test('hidden directory under agents kind is treated as ONE bundle, not flattened (P1.1)', () => {
    // Real ECC v2 case: .agents/skills/dmux-workflows/ contains SKILL.md plus
    // sibling YAML/JSON files. Flattening it into per-.md leaves silently
    // drops the siblings on install. Hidden dirs must emit ONE bundle entry.
    const vDir = path.join(tmpRoot, 'v2-agents-hidden');
    fs.mkdirSync(path.join(vDir, 'manifests'), { recursive: true });
    fs.mkdirSync(path.join(vDir, '.agents', 'skills', 'dmux-workflows', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(vDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(vDir, '.agents', 'skills', 'dmux-workflows', 'SKILL.md'), '# dmux');
    fs.writeFileSync(path.join(vDir, '.agents', 'skills', 'dmux-workflows', 'agents', 'openai.yaml'), 'name: x');
    fs.writeFileSync(path.join(vDir, 'agents', 'reviewer.md'), '# reviewer');
    fs.writeFileSync(path.join(vDir, 'manifests', 'install-modules.json'), JSON.stringify({
      modules: [{ id: 'agents-core', kind: 'agents', description: 'Agents', paths: ['.agents', 'agents'] }],
    }));
    const items = scanCatalogV2(vDir);
    const agents = items.filter(i => i.type === 'agent' && i.moduleId === 'agents-core');
    // Two leaves: ONE bundle for .agents (not flattened deep into SKILL.md)
    // PLUS the conventional agents/reviewer.md leaf.
    assert.strictEqual(agents.length, 2, `expected 2 leaves; got ${JSON.stringify(agents.map(a => a.id))}`);
    const bundle = agents.find(a => a.sourcePath === '.agents');
    assert.ok(bundle, '.agents bundle entry expected');
    assert.strictEqual(bundle.targetPath, '.agents');
    // Critically: NO entry that points at SKILL.md inside .agents
    const flattened = agents.find(a => a.sourcePath && a.sourcePath.includes('.agents/skills'));
    assert.strictEqual(flattened, undefined, 'must NOT flatten .agents/.../SKILL.md into a separate leaf');
    // Conventional path still produces leaves
    assert.ok(agents.find(a => a.sourcePath === 'agents/reviewer.md'), 'agents/reviewer.md leaf expected');
  });

  test('agents module with mixed dir + file paths: hidden dir → bundle, conventional dir → leaves, top-level .md → leaf', () => {
    const vDir = path.join(tmpRoot, 'v2-agents-mixed');
    fs.mkdirSync(path.join(vDir, 'manifests'), { recursive: true });
    fs.mkdirSync(path.join(vDir, '.agents'), { recursive: true });
    fs.mkdirSync(path.join(vDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(vDir, '.agents', 'reviewer.md'), 'a'); // inside hidden bundle
    fs.writeFileSync(path.join(vDir, 'agents', 'reviewer.md'), 'b'); // conventional leaf
    fs.writeFileSync(path.join(vDir, 'AGENTS.md'), 'c');
    fs.writeFileSync(path.join(vDir, 'manifests', 'install-modules.json'), JSON.stringify({
      modules: [{ id: 'agents-core', kind: 'agents', description: 'Agents', paths: ['.agents', 'agents', 'AGENTS.md'] }],
    }));
    const items = scanCatalogV2(vDir);
    const leaves = items.filter(i => i.type === 'agent' && i.moduleId === 'agents-core');
    // 3 leaves: ONE bundle for .agents (P1.1), ONE leaf for agents/reviewer.md, ONE leaf for AGENTS.md
    assert.strictEqual(leaves.length, 3, `expected 3 agent leaves; got ${JSON.stringify(leaves.map(l => l.id))}`);
    const ids = leaves.map(l => l.id).sort();
    assert.strictEqual(new Set(ids).size, ids.length, 'leaf IDs must be unique');
    // .agents/ → bundle entry with sourcePath == '.agents'
    const bundle = leaves.find(l => l.sourcePath === '.agents');
    assert.ok(bundle, 'bundle for .agents expected');
    // agents/reviewer.md → v1-style leaf
    assert.ok(ids.includes('agent-reviewer'));
    // AGENTS.md → top-level leaf
    assert.ok(ids.includes('agent-agents'));
    // The bundle MUST NOT collide with the conventional-folder leaf
    assert.notStrictEqual(bundle.id, 'agent-reviewer');
    // No module-level entry leaks through
    assert.strictEqual(items.find(i => i.id === 'module-agents-core'), undefined);
  });

  test('commands module with directory path emits per-file commands', () => {
    const vDir = path.join(tmpRoot, 'v2-commands');
    fs.mkdirSync(path.join(vDir, 'manifests'), { recursive: true });
    fs.mkdirSync(path.join(vDir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(vDir, 'commands', 'tdd.md'), 'tdd');
    fs.writeFileSync(path.join(vDir, 'commands', 'plan.md'), 'plan');
    fs.writeFileSync(path.join(vDir, 'manifests', 'install-modules.json'), JSON.stringify({
      modules: [{ id: 'commands-core', kind: 'commands', description: 'Cmds', paths: ['commands'] }],
    }));
    const items = scanCatalogV2(vDir);
    const cmds = items.filter(i => i.type === 'command' && i.moduleId === 'commands-core');
    assert.strictEqual(cmds.length, 2);
    assert.ok(cmds.every(c => c.priority === 7), 'commands priority should be 7');
  });

  test('platform module emits one leaf per top-level path with friendly metadata', () => {
    const vDir = path.join(tmpRoot, 'v2-platform');
    fs.mkdirSync(path.join(vDir, 'manifests'), { recursive: true });
    fs.mkdirSync(path.join(vDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(vDir, '.cursor'),        { recursive: true });
    fs.mkdirSync(path.join(vDir, 'mcp-configs'),    { recursive: true });
    fs.mkdirSync(path.join(vDir, 'scripts'),        { recursive: true });
    fs.writeFileSync(path.join(vDir, 'scripts', 'auto-update.js'), '// auto');
    fs.writeFileSync(path.join(vDir, 'scripts', 'setup-package-manager.js'), '// pm');
    // Include a missing path to confirm we silently skip non-existent ones.
    fs.writeFileSync(path.join(vDir, 'manifests', 'install-modules.json'), JSON.stringify({
      modules: [{
        id: 'platform-configs',
        kind: 'platform',
        description: 'Baseline platform configs',
        paths: ['.claude-plugin', '.cursor', '.codex', 'mcp-configs', 'scripts/auto-update.js', 'scripts/setup-package-manager.js'],
      }],
    }));
    const items = scanCatalogV2(vDir);
    const leaves = items.filter(i => i.type === 'platform' && i.moduleId === 'platform-configs');
    const ids = leaves.map(l => l.id).sort();

    // Five paths exist on disk (.codex was intentionally not created → skipped)
    assert.deepStrictEqual(ids, [
      'platform-claude-plugin',
      'platform-cursor',
      'platform-mcp-configs',
      'platform-scripts-auto-update',
      'platform-scripts-setup-package-manager',
    ]);

    // No module-level entry leaks through
    assert.strictEqual(items.find(i => i.id === 'module-platform-configs'), undefined);

    // Friendly name + description from the lookup table (not raw paths)
    const claudePlugin = leaves.find(l => l.id === 'platform-claude-plugin');
    assert.match(claudePlugin.name, /Claude Code plugin/i);
    assert.match(claudePlugin.description, /Plugin manifest/i);

    // sourcePath / targetPath round-trip the original manifest path
    assert.strictEqual(claudePlugin.sourcePath, '.claude-plugin');
    assert.strictEqual(claudePlugin.targetPath, '.claude-plugin');

    // Script paths drop the .js extension in their slug
    const autoUpdate = leaves.find(l => l.id === 'platform-scripts-auto-update');
    assert.strictEqual(autoUpdate.sourcePath, 'scripts/auto-update.js');
  });

  test('hidden platform paths get deployRoot=project; non-hidden ones do not (P1.2)', () => {
    const vDir = path.join(tmpRoot, 'v2-platform-deploy');
    fs.mkdirSync(path.join(vDir, 'manifests'), { recursive: true });
    fs.mkdirSync(path.join(vDir, '.cursor'),     { recursive: true });
    fs.mkdirSync(path.join(vDir, '.codex'),      { recursive: true });
    fs.mkdirSync(path.join(vDir, 'mcp-configs'), { recursive: true });
    fs.mkdirSync(path.join(vDir, 'scripts'),     { recursive: true });
    fs.writeFileSync(path.join(vDir, 'scripts', 'auto-update.js'), '// auto');
    fs.writeFileSync(path.join(vDir, 'manifests', 'install-modules.json'), JSON.stringify({
      modules: [{
        id: 'platform-configs', kind: 'platform', description: '',
        paths: ['.cursor', '.codex', 'mcp-configs', 'scripts/auto-update.js'],
      }],
    }));
    const items = scanCatalogV2(vDir);
    const cursor   = items.find(i => i.id === 'platform-cursor');
    const codex    = items.find(i => i.id === 'platform-codex');
    const mcp      = items.find(i => i.id === 'platform-mcp-configs');
    const script   = items.find(i => i.id === 'platform-scripts-auto-update');
    // Hidden top-level dirs deploy to project root
    assert.strictEqual(cursor.deployRoot, 'project');
    assert.strictEqual(codex.deployRoot,  'project');
    // Non-hidden paths stay under .claude/
    assert.strictEqual(mcp.deployRoot,    undefined);
    assert.strictEqual(script.deployRoot, undefined);
  });

  test('v2 hook descriptions surface the global-plugin runtime requirement (P2)', () => {
    const vDir = path.join(tmpRoot, 'v2-hooks-runtime-note');
    fs.mkdirSync(path.join(vDir, 'manifests'), { recursive: true });
    fs.mkdirSync(path.join(vDir, 'hooks'), { recursive: true });
    // Hooks file using $CLAUDE_PLUGIN_ROOT bootstrap (real v2 shape).
    fs.writeFileSync(path.join(vDir, 'hooks', 'hooks.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{
          id: 'pre:bash:check',
          description: 'Check Bash before run',
          matcher: 'Bash',
          hooks: [{
            type: 'command',
            command: 'node -e "process.env.CLAUDE_PLUGIN_ROOT; require(\'scripts/hooks/plugin-hook-bootstrap.js\')"',
          }],
        }],
      },
    }));
    fs.writeFileSync(path.join(vDir, 'manifests', 'install-modules.json'), JSON.stringify({
      modules: [{ id: 'hooks-runtime', kind: 'hooks', description: 'Hooks', paths: ['hooks'] }],
    }));
    const items = scanCatalogV2(vDir);
    const hook = items.find(i => i.id === 'hook-pre-bash-check');
    assert.ok(hook, 'hook leaf expected');
    assert.match(hook.description, /Requires.*ECC plugin.*\.claude\/plugins/i,
      'description must surface the runtime requirement');
    assert.strictEqual(hook.requiresRuntime, 'ecc-plugin');
  });

  test('hooks WITHOUT global-plugin bootstrap do NOT get the runtime note', () => {
    const vDir = path.join(tmpRoot, 'v2-hooks-self-contained');
    fs.mkdirSync(path.join(vDir, 'manifests'), { recursive: true });
    fs.mkdirSync(path.join(vDir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(vDir, 'hooks', 'hooks.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{
          id: 'pre:simple', description: 'Self-contained hook',
          hooks: [{ type: 'command', command: 'echo hello' }],
        }],
      },
    }));
    fs.writeFileSync(path.join(vDir, 'manifests', 'install-modules.json'), JSON.stringify({
      modules: [{ id: 'hooks-runtime', kind: 'hooks', description: 'Hooks', paths: ['hooks'] }],
    }));
    const items = scanCatalogV2(vDir);
    const hook = items.find(i => i.id === 'hook-pre-simple');
    assert.ok(hook);
    assert.doesNotMatch(hook.description, /Requires.*ECC plugin/i);
    assert.strictEqual(hook.requiresRuntime, undefined);
  });

  test('platform leaves use generic fallback description for unknown paths', () => {
    const vDir = path.join(tmpRoot, 'v2-platform-unknown');
    fs.mkdirSync(path.join(vDir, 'manifests'), { recursive: true });
    fs.mkdirSync(path.join(vDir, '.something-new'), { recursive: true });
    fs.writeFileSync(path.join(vDir, 'manifests', 'install-modules.json'), JSON.stringify({
      modules: [{ id: 'platform-configs', kind: 'platform', description: '', paths: ['.something-new'] }],
    }));
    const items = scanCatalogV2(vDir);
    const leaf = items.find(i => i.id === 'platform-something-new');
    assert.ok(leaf, 'unknown platform path should still emit a leaf');
    assert.strictEqual(leaf.name, '.something-new');
    assert.match(leaf.description, /Platform config: \.something-new/);
  });

  test('emits one hook entry per hooks.json hook (matches v1 granularity)', () => {
    const vDir = path.join(tmpRoot, 'v2-hooks');
    fs.mkdirSync(path.join(vDir, 'manifests'), { recursive: true });
    fs.mkdirSync(path.join(vDir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(vDir, 'hooks', 'hooks.json'), JSON.stringify({
      hooks: {
        PreToolUse: [
          { id: 'pre:bash:check', description: 'Check Bash before run', matcher: 'Bash', hooks: [{ type: 'command', command: 'echo a' }] },
          { id: 'pre:write:warn',  description: 'Warn on Write',         matcher: 'Write', hooks: [{ type: 'command', command: 'echo b' }] },
        ],
        Stop: [
          { id: 'stop:summary',    description: 'Print summary',         hooks: [{ type: 'command', command: 'echo c' }] },
        ],
      },
    }));
    fs.writeFileSync(path.join(vDir, 'manifests', 'install-modules.json'), JSON.stringify({
      modules: [
        { id: 'hooks-runtime', kind: 'hooks', description: 'Hook bundle', paths: ['hooks', 'scripts/hooks', 'scripts/lib'] },
      ],
    }));
    const items = scanCatalogV2(vDir);
    const hooks = items.filter(i => i.type === 'hook');
    assert.strictEqual(hooks.length, 3, 'expected 3 individual hook entries');
    const ids = hooks.map(h => h.id).sort();
    assert.deepStrictEqual(ids, ['hook-pre-bash-check', 'hook-pre-write-warn', 'hook-stop-summary']);
    // Module-level quarantined entry should NOT appear when hooks.json has hooks
    assert.strictEqual(items.find(i => i.id === 'module-hooks-runtime'), undefined);
    // Each leaf carries hookId/hookEvent so install can locate the entry
    const preBash = hooks.find(h => h.id === 'hook-pre-bash-check');
    assert.strictEqual(preBash.hookId, 'pre:bash:check');
    assert.strictEqual(preBash.hookEvent, 'PreToolUse');
    assert.strictEqual(preBash.moduleId, 'hooks-runtime');
    assert.strictEqual(preBash.quarantined, undefined, 'individual hooks must not be quarantined');
  });

  test('falls back to quarantined module entry when hooks.json is missing', () => {
    const vDir = path.join(tmpRoot, 'v2-hooks-empty');
    fs.mkdirSync(path.join(vDir, 'manifests'), { recursive: true });
    fs.writeFileSync(path.join(vDir, 'manifests', 'install-modules.json'), JSON.stringify({
      modules: [
        { id: 'hooks-runtime', kind: 'hooks', description: 'Hook bundle', paths: ['hooks'] },
      ],
    }));
    const items = scanCatalogV2(vDir);
    const fallback = items.find(i => i.id === 'module-hooks-runtime');
    assert.ok(fallback, 'fallback module entry expected when hooks.json absent');
    assert.strictEqual(fallback.quarantined, true);
  });

  test('returns early with static items when install-modules.json is missing', () => {
    const vDir = path.join(tmpRoot, 'v2-no-manifest');
    fs.mkdirSync(vDir, { recursive: true });
    const items = scanCatalogV2(vDir);
    assert.ok(Array.isArray(items));
    assert.ok(items.some(i => i.id === 'setting-model'), 'static settings should still be present');
  });

  test('getCatalog uses v2 scanner when install-modules.json is present', () => {
    _resetVersionCatalogCache();
    const verId = 'gc-v2-detect';
    const vDir  = path.join(tmpVersions, verId);
    fs.mkdirSync(path.join(vDir, 'manifests'), { recursive: true });
    fs.writeFileSync(path.join(vDir, 'manifests', 'install-modules.json'), JSON.stringify({ modules: [] }));
    const items = getCatalog(vDir, verId);
    assert.ok(Array.isArray(items));
  });
});

// ─── walkMarkdownLeaves ──────────────────────────────────────────────────────

suite('walkMarkdownLeaves', () => {
  test('returns single-file leaf when path is a .md file', () => {
    const vDir = path.join(tmpRoot, 'walk-file');
    fs.mkdirSync(vDir, { recursive: true });
    fs.writeFileSync(path.join(vDir, 'AGENTS.md'), 'a');
    const leaves = walkMarkdownLeaves(vDir, 'AGENTS.md');
    assert.deepStrictEqual(leaves, [{ relPath: 'AGENTS.md' }]);
  });

  test('returns empty when path is missing', () => {
    const vDir = path.join(tmpRoot, 'walk-missing');
    fs.mkdirSync(vDir, { recursive: true });
    assert.deepStrictEqual(walkMarkdownLeaves(vDir, 'nope'), []);
  });

  test('returns empty when path is a non-.md file', () => {
    const vDir = path.join(tmpRoot, 'walk-nonmd');
    fs.mkdirSync(vDir, { recursive: true });
    fs.writeFileSync(path.join(vDir, 'config.json'), '{}');
    assert.deepStrictEqual(walkMarkdownLeaves(vDir, 'config.json'), []);
  });

  test('walks directories recursively, ignoring non-markdown files', () => {
    const vDir = path.join(tmpRoot, 'walk-recursive');
    fs.mkdirSync(path.join(vDir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(vDir, 'a', 'top.md'), '1');
    fs.writeFileSync(path.join(vDir, 'a', 'b', 'deep.md'), '2');
    fs.writeFileSync(path.join(vDir, 'a', 'b', 'note.txt'), 'skip');
    const paths = walkMarkdownLeaves(vDir, 'a').map(l => l.relPath).sort();
    assert.deepStrictEqual(paths, ['a/b/deep.md', 'a/top.md']);
  });
});

// ─── relPathToLeafSlug ───────────────────────────────────────────────────────

suite('relPathToLeafSlug', () => {
  test('converts a normal nested path to a hyphenated slug', () => {
    assert.strictEqual(relPathToLeafSlug('rules/common/coding-style.md'), 'rules-common-coding-style');
  });

  test('handles leading-dot paths without colliding with non-dot variant', () => {
    const a = relPathToLeafSlug('.agents/code-reviewer.md');
    const b = relPathToLeafSlug('agents/code-reviewer.md');
    assert.notStrictEqual(a, b, 'leading-dot path must produce a distinct slug');
    assert.match(a, /^dot-/);
  });

  test('lowercases and trims', () => {
    assert.strictEqual(relPathToLeafSlug('AGENTS.md'), 'agents');
  });
});

// ─── migrateV2ModuleInstallsToLeaves ────────────────────────────────────────

suite('migrateV2ModuleInstallsToLeaves', () => {
  test('expands module-agents-core install flag to per-leaf flags', () => {
    const proj = {
      components: {
        'module-agents-core': { installed: true, installedAt: '2026-01-01T00:00:00Z' },
      },
    };
    const catalog = [
      { id: 'agent-foo', type: 'agent', moduleId: 'agents-core' },
      { id: 'agent-bar', type: 'agent', moduleId: 'agents-core' },
      { id: 'agent-other', type: 'agent', moduleId: 'something-else' },
    ];
    const n = migrateV2ModuleInstallsToLeaves(proj, catalog);
    assert.strictEqual(n, 2);
    assert.strictEqual(proj.components['agent-foo'].installed, true);
    assert.strictEqual(proj.components['agent-foo'].installedAt, '2026-01-01T00:00:00Z');
    assert.strictEqual(proj.components['agent-bar'].installed, true);
    assert.strictEqual(proj.components['agent-other'], undefined);
    assert.strictEqual(proj.components['module-agents-core'], undefined, 'legacy flag must be deleted');
  });

  test('is idempotent — second call is a no-op', () => {
    const proj = {
      components: {
        'module-rules-core': { installed: true, installedAt: '2026-01-01T00:00:00Z' },
      },
    };
    const catalog = [{ id: 'rule-x', type: 'rule', moduleId: 'rules-core' }];
    assert.strictEqual(migrateV2ModuleInstallsToLeaves(proj, catalog), 1);
    assert.strictEqual(migrateV2ModuleInstallsToLeaves(proj, catalog), 0);
  });

  test('does not overwrite an existing leaf install record', () => {
    const proj = {
      components: {
        'module-agents-core': { installed: true, installedAt: '2026-01-01T00:00:00Z' },
        'agent-foo': { installed: true, installedAt: '2025-12-31T00:00:00Z' },
      },
    };
    const catalog = [{ id: 'agent-foo', type: 'agent', moduleId: 'agents-core' }];
    migrateV2ModuleInstallsToLeaves(proj, catalog);
    assert.strictEqual(proj.components['agent-foo'].installedAt, '2025-12-31T00:00:00Z', 'preexisting timestamp must be preserved');
  });

  test('skips migration when catalog has no matching leaves (version not pulled yet)', () => {
    const proj = {
      components: {
        'module-rules-core': { installed: true, installedAt: 'x' },
      },
    };
    const n = migrateV2ModuleInstallsToLeaves(proj, []);
    assert.strictEqual(n, 0);
    assert.strictEqual(proj.components['module-rules-core'].installed, true, 'legacy flag preserved when no catalog leaves');
  });

  test('does not migrate when legacy module flag was never installed', () => {
    const proj = {
      components: {
        'module-agents-core': { installed: false, installedAt: null },
      },
    };
    const catalog = [{ id: 'agent-foo', type: 'agent', moduleId: 'agents-core' }];
    assert.strictEqual(migrateV2ModuleInstallsToLeaves(proj, catalog), 0);
    assert.strictEqual(proj.components['agent-foo'], undefined);
  });

  test('migrates legacy module-platform-configs to per-platform leaves', () => {
    const proj = {
      components: {
        'module-platform-configs': { installed: true, installedAt: '2026-04-01T00:00:00Z' },
      },
    };
    const catalog = [
      { id: 'platform-claude-plugin',  type: 'platform', moduleId: 'platform-configs' },
      { id: 'platform-cursor',         type: 'platform', moduleId: 'platform-configs' },
      { id: 'platform-mcp-configs',    type: 'platform', moduleId: 'platform-configs' },
    ];
    const n = migrateV2ModuleInstallsToLeaves(proj, catalog);
    assert.strictEqual(n, 3);
    assert.strictEqual(proj.components['platform-claude-plugin'].installed, true);
    assert.strictEqual(proj.components['platform-cursor'].installed, true);
    assert.strictEqual(proj.components['platform-mcp-configs'].installedAt, '2026-04-01T00:00:00Z');
    assert.strictEqual(proj.components['module-platform-configs'], undefined);
  });

  test('migrates legacy module-hooks-runtime to per-hook leaves when hooks.json had hooks', () => {
    const proj = {
      components: {
        'module-hooks-runtime': { installed: true, installedAt: '2026-04-01T00:00:00Z' },
      },
    };
    const catalog = [
      { id: 'hook-pre-bash-check', type: 'hook', moduleId: 'hooks-runtime', hookId: 'pre:bash:check', hookEvent: 'PreToolUse' },
      { id: 'hook-stop-summary',   type: 'hook', moduleId: 'hooks-runtime', hookId: 'stop:summary',   hookEvent: 'Stop' },
    ];
    const n = migrateV2ModuleInstallsToLeaves(proj, catalog);
    assert.strictEqual(n, 2);
    assert.strictEqual(proj.components['hook-pre-bash-check'].installed, true);
    assert.strictEqual(proj.components['hook-stop-summary'].installed, true);
    assert.strictEqual(proj.components['module-hooks-runtime'], undefined);
  });

  test('leaves quarantined hooks module alone when no hook leaves exist (hooks.json missing)', () => {
    const proj = {
      components: {
        'module-hooks-runtime': { installed: true, installedAt: '2026-04-01T00:00:00Z' },
      },
    };
    // Fallback case — hooks.json was missing in this version, so the catalog
    // only has the quarantined module entry itself. No hook leaves to migrate
    // to, so the legacy install flag must survive.
    const catalog = [
      { id: 'module-hooks-runtime', type: 'hook', moduleId: 'hooks-runtime', quarantined: true },
    ];
    assert.strictEqual(migrateV2ModuleInstallsToLeaves(proj, catalog), 0);
    assert.strictEqual(proj.components['module-hooks-runtime'].installed, true);
  });
});

// ─── Report ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
const total = passed + failed;
console.log(`${total} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
