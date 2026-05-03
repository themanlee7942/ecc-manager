'use strict';
// Integration tests: bind the real HTTP server to an ephemeral port and hit
// it with actual fetch requests. These cover the route layer (parsing, status
// codes, content negotiation) which unit tests against helpers cannot see.

const assert = require('assert');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-int-lm-'));
process.env.ECC_PROJECTS_DIR = path.join(tmpRoot, 'projects');
process.env.ECC_STATE_DIR    = path.join(tmpRoot, 'state');
process.env.ECC_CATALOG_FILE = path.join(tmpRoot, 'catalog.json');
delete process.env.ECC_STATE_FILE;

const srv = require('../server');
const httpServer = srv.server;

let port;
let passed = 0, failed = 0;
const queue = [];

function test(name, fn) {
  queue.push(async () => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); failed++; }
  });
}
function suite(name, fn) {
  queue.push(() => console.log(`\n${name}`));
  fn();
}

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {};
    const r = http.request({ hostname: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(buf || '{}'); } catch { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

process.on('exit', () => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ─── Suites ──────────────────────────────────────────────────────────────────

suite('integration: cache endpoint route layer', () => {
  test('GET /api/projects/:name/lmstudio/cache returns 404 for unknown project', async () => {
    const r = await req('GET', '/api/projects/does-not-exist/lmstudio/cache?version=1.0.0');
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.ok, false);
  });

  test('GET cache rejects invalid project-name format with 400', async () => {
    const r = await req('GET', '/api/projects/..%2Fbad/lmstudio/cache');
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.ok, false);
  });

  test('GET cache rejects invalid version format with 400', async () => {
    // Set up a project so we get past the safeName check.
    await req('POST', '/api/projects', { name: 'intproj', description: '' });
    const r = await req('GET', '/api/projects/intproj/lmstudio/cache?version=..%2F..%2Fetc');
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.ok, false);
    assert.match(r.body.error || '', /version/i);
  });

  test('GET cache returns ok with empty results for a fresh project (no version on disk)', async () => {
    const r = await req('GET', '/api/projects/intproj/lmstudio/cache?version=1.0.0');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.deepStrictEqual(r.body.results, []);
    assert.strictEqual(r.body.cacheHit, false);
  });
});

suite('integration: result endpoint route layer', () => {
  test('POST /lmstudio/result rejects body without componentId', async () => {
    const r = await req('POST', '/api/projects/intproj/lmstudio/result', {
      matchingPerc: 80, reasoning: 'r',
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.ok, false);
    assert.match(r.body.error || '', /componentId/i);
  });

  test('POST result accepts a single result and round-trips via cache GET', async () => {
    const post = await req('POST', '/api/projects/intproj/lmstudio/result', {
      componentId: 'agent-foo',
      relPath: 'agents/foo.md', type: 'agent', name: 'foo.md',
      matchingPerc: 90, reasoning: 'matches well', status: 'complete',
    });
    assert.strictEqual(post.status, 200);
    assert.strictEqual(post.body.ok, true);
    assert.strictEqual(post.body.component.matchingPerc, 90);

    const get = await req('GET', '/api/projects/intproj/lmstudio/cache?version=1.0.0');
    assert.strictEqual(get.status, 200);
    assert.strictEqual(get.body.ok, true);
    const found = get.body.results.find(r => r.componentId === 'agent-foo');
    assert.ok(found, 'expected agent-foo in cache results');
    assert.strictEqual(found.matchingPerc, 90);
    assert.strictEqual(found.reasoning, 'matches well');
  });
});

suite('integration: soft-stale on description change', () => {
  test('PATCH /api/projects/:name with new analysisDesc preserves LM cache fields', async () => {
    // intproj already has agent-foo from the previous suite. Change description
    // and then verify the cache GET still returns the score (marked stale).
    const patch = await req('PATCH', '/api/projects/intproj', { analysisDesc: 'totally new description' });
    assert.strictEqual(patch.status, 200);
    assert.strictEqual(patch.body.ok, true);

    const cache = await req('GET', '/api/projects/intproj/lmstudio/cache?version=1.0.0');
    assert.strictEqual(cache.status, 200);
    const found = cache.body.results.find(r => r.componentId === 'agent-foo');
    assert.ok(found, 'cached score preserved after description change');
    assert.strictEqual(found.matchingPerc, 90);
  });

  test('POST /lmstudio/clear-cache wipes scoring fields explicitly', async () => {
    const r = await req('POST', '/api/projects/intproj/lmstudio/clear-cache', {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    const cache = await req('GET', '/api/projects/intproj/lmstudio/cache?version=1.0.0');
    assert.deepStrictEqual(cache.body.results, []);
  });
});

suite('integration: diagnostics endpoint', () => {
  test('GET /api/diagnostics returns counter snapshot with bootedAt + stateDir', async () => {
    const r = await req('GET', '/api/diagnostics');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(r.body.bootedAt, 'expected bootedAt');
    assert.ok(typeof r.body.uptime === 'number');
    assert.ok(r.body.counters, 'expected counters object');
    // We exercised lm.result.saved + lm.cache.clear in the prior suites.
    assert.ok(r.body.counters['lm.result.saved'] >= 1, 'lm.result.saved should be incremented');
    assert.ok(r.body.counters['lm.cache.clear'] >= 1, 'lm.cache.clear should be incremented');
    assert.ok(r.body.stateDir.includes(path.basename(tmpRoot)), 'stateDir reflects ECC_STATE_DIR override');
  });
});

suite('integration: resumeRun preserves cache (Analyze Missing/Failed)', () => {
  test('resumeRun:true does NOT wipe existing component scores', async () => {
    // Set up a project with two scored components.
    await req('POST', '/api/projects', { name: 'resumeproj', description: '' });
    await req('PATCH', '/api/projects/resumeproj', { analysisDesc: 'a project' });
    await req('POST', '/api/projects/resumeproj/lmstudio/result', {
      componentId: 'agent-keep', relPath: 'agents/keep.md', type: 'agent', name: 'keep.md',
      matchingPerc: 87, reasoning: 'should survive resume', status: 'complete',
    });
    await req('POST', '/api/projects/resumeproj/lmstudio/result', {
      componentId: 'agent-fail', relPath: 'agents/fail.md', type: 'agent', name: 'fail.md',
      matchingPerc: 0, reasoning: 'analysis failed', status: 'failed',
    });

    // Simulate the Analyze Missing/Failed kickoff: resumeRun:true (NOT startRun).
    const r = await req('POST', '/api/projects/resumeproj/lmstudio/analysis-description', {
      description: 'a project', version: '1.0.0', threshold: 80,
      resumeRun: true,
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.analysis.status, 'in_progress', 'run marked in_progress');

    // Both scores must still be on disk.
    const cache = await req('GET', '/api/projects/resumeproj/lmstudio/cache?version=1.0.0');
    const keep = cache.body.results.find(x => x.componentId === 'agent-keep');
    const fail = cache.body.results.find(x => x.componentId === 'agent-fail');
    assert.ok(keep, 'completed result must survive resumeRun');
    assert.strictEqual(keep.matchingPerc, 87);
    assert.ok(fail, 'failed result must survive resumeRun');
    assert.strictEqual(fail.analysisStatus, 'failed');
  });

  test('startRun:true STILL wipes scores (existing semantics preserved)', async () => {
    const r = await req('POST', '/api/projects/resumeproj/lmstudio/analysis-description', {
      description: 'a project', version: '1.0.0', threshold: 80,
      startRun: true,
    });
    assert.strictEqual(r.status, 200);
    const cache = await req('GET', '/api/projects/resumeproj/lmstudio/cache?version=1.0.0');
    assert.deepStrictEqual(cache.body.results, [], 'startRun must wipe (Re-analyze flow depends on this)');
  });

  test('startRun + resumeRun together returns 400', async () => {
    const r = await req('POST', '/api/projects/resumeproj/lmstudio/analysis-description', {
      description: 'x', version: '1.0.0', startRun: true, resumeRun: true,
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error || '', /mutually exclusive/i);
  });

  test('resumeRun with a CHANGED description returns 409 DESC_CHANGED_DURING_RESUME', async () => {
    // Set up: project with one scored result tied to original description.
    await req('POST', '/api/projects', { name: 'resumeguard', description: '' });
    await req('POST', '/api/projects/resumeguard/lmstudio/analysis-description', {
      description: 'original description', version: '1.0.0', threshold: 80,
      startRun: true,
    });
    await req('POST', '/api/projects/resumeguard/lmstudio/result', {
      componentId: 'agent-x', relPath: 'agents/x.md', type: 'agent', name: 'x.md',
      matchingPerc: 75, reasoning: 'scored against the original description',
      status: 'complete',
    });

    // Mid-edit race: user changes description, then immediately clicks Analyze
    // Missing/Failed before the soft-stale save lands.
    const r = await req('POST', '/api/projects/resumeguard/lmstudio/analysis-description', {
      description: 'completely different description',
      version: '1.0.0', threshold: 80, resumeRun: true,
    });
    assert.strictEqual(r.status, 409, 'must reject with 409 Conflict');
    assert.strictEqual(r.body.ok, false);
    assert.strictEqual(r.body.code, 'DESC_CHANGED_DURING_RESUME');
    assert.ok(r.body.scoredDescriptionHash, 'response includes scoredDescriptionHash');
    assert.ok(r.body.currentDescriptionHash, 'response includes currentDescriptionHash');
    assert.notStrictEqual(r.body.scoredDescriptionHash, r.body.currentDescriptionHash);

    // Crucially, the rejection must NOT have mutated state. The cache should
    // still report the original description, the original score, and the
    // original scored hash.
    const cache = await req('GET', '/api/projects/resumeguard/lmstudio/cache?version=1.0.0');
    assert.strictEqual(cache.body.analysis.description, 'original description', 'description not overwritten');
    assert.strictEqual(cache.body.analysis.descriptionHash, r.body.scoredDescriptionHash);
    const found = cache.body.results.find(x => x.componentId === 'agent-x');
    assert.ok(found, 'cached score still present after rejected resume');
    assert.strictEqual(found.matchingPerc, 75);
  });

  test('resumeRun is allowed when description hash is unchanged (whitespace-normalized)', async () => {
    // Hash normalization strips leading/trailing whitespace and CRLF, so a
    // user who only added a trailing newline must still be able to resume.
    const r = await req('POST', '/api/projects/resumeguard/lmstudio/analysis-description', {
      description: '  original description\r\n', // same after normalization
      version: '1.0.0', threshold: 80, resumeRun: true,
    });
    assert.strictEqual(r.status, 200, `expected 200 but got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.analysis.status, 'in_progress');
  });
});

suite('integration: manual CLAUDE.md save updates metadata', () => {
  test('POST /claudemd flips source to "manual" so stale ecc-default metadata clears', async () => {
    await req('POST', '/api/projects', { name: 'claudemdproj', description: '' });
    // Pretend a prior replace-with-default happened by recording metadata via
    // the existing path. Easiest: PATCH won't write claudeMd, so we just check
    // the manual path reports source: "manual" after a save.
    const post = await req('POST', '/api/projects/claudemdproj/claudemd', { content: '# manually edited' });
    assert.strictEqual(post.status, 200);

    const get = await req('GET', '/api/projects/claudemdproj');
    assert.strictEqual(get.status, 200);
    // proj.claudeMd is private to the server, but the GET /api/projects/:name
    // route returns the raw project (minus underscore-prefixed fields).
    assert.ok(get.body.project.claudeMd, 'claudeMd metadata recorded');
    assert.strictEqual(get.body.project.claudeMd.source, 'manual');
    assert.ok(get.body.project.claudeMd.updatedAt, 'updatedAt timestamp present');
  });

  test('POST /claudemd with invalid project name returns 400', async () => {
    const r = await req('POST', '/api/projects/..%2Fbad/claudemd', { content: 'x' });
    assert.strictEqual(r.status, 400);
  });

  test('POST /claudemd to unknown project returns 404', async () => {
    const r = await req('POST', '/api/projects/no-such-project/claudemd', { content: 'x' });
    assert.strictEqual(r.status, 404);
  });
});

// ─── ECC v2 candidate-mapping regression ─────────────────────────────────────
//
// Reproduces the bug where v2 manifest-based catalogs (multi-path modules,
// directory-rooted skills) silently dropped 90%+ of LM Studio scoring results
// because file→component mapping was attempted client-side against an
// incomplete catalog. The fix: collectLmCandidates is now catalog-driven and
// stamps each candidate with componentId server-side.

suite('integration: ECC v2 candidate mapping (regression for dropped results)', () => {
  const fakeVersionId = 'v2-fake-1.0.0';
  const fakeVersionDir = path.join(tmpRoot, 'projects', '.ecc-versions', fakeVersionId);

  test('synthesizes a minimal v2 manifest fixture on disk', async () => {
    fs.mkdirSync(fakeVersionDir, { recursive: true });
    fs.writeFileSync(path.join(fakeVersionDir, 'package.json'), JSON.stringify({ version: fakeVersionId }));
    // Manifest with: agent (single-path), rule module (multi-path), skill,
    // command, hooks module (quarantined).
    fs.mkdirSync(path.join(fakeVersionDir, 'manifests'), { recursive: true });
    fs.mkdirSync(path.join(fakeVersionDir, 'agents'),    { recursive: true });
    fs.mkdirSync(path.join(fakeVersionDir, 'commands'),  { recursive: true });
    fs.mkdirSync(path.join(fakeVersionDir, 'rules', 'python'), { recursive: true });
    fs.mkdirSync(path.join(fakeVersionDir, 'skills', 'demo-SKILL'), { recursive: true });
    fs.writeFileSync(path.join(fakeVersionDir, 'agents', 'doc-updater.md'), '# doc-updater agent');
    fs.writeFileSync(path.join(fakeVersionDir, 'commands', 'plan.md'), '# plan command');
    fs.writeFileSync(path.join(fakeVersionDir, 'rules', 'python', 'coding-style.md'), '# python style');
    fs.writeFileSync(path.join(fakeVersionDir, 'rules', 'python', 'hooks.md'), '# python hooks');
    fs.writeFileSync(path.join(fakeVersionDir, 'rules', 'python', 'patterns.md'), '# python patterns');
    fs.writeFileSync(path.join(fakeVersionDir, 'skills', 'demo-SKILL', 'SKILL.md'), '# demo skill');
    fs.writeFileSync(path.join(fakeVersionDir, 'manifests', 'install-modules.json'), JSON.stringify({
      modules: [
        { id: 'doc-updater',   kind: 'agents',   description: 'doc updater', paths: ['agents/doc-updater.md'] },
        { id: 'plan',          kind: 'commands', description: 'plan cmd',    paths: ['commands/plan.md'] },
        { id: 'rule-python',   kind: 'rules',    description: 'python rules',
          paths: ['rules/python/coding-style.md', 'rules/python/hooks.md', 'rules/python/patterns.md'] },
        { id: 'demo-SKILL',    kind: 'skills',   description: 'demo skill',  paths: ['skills/demo-SKILL'] },
      ],
    }));
    // Force a catalog-cache reset so collectLmCandidates picks up the fixture.
    srv._resetVersionCatalogCache();
  });

  test('GET /api/lmstudio/files emits one candidate per .md leaf, each with componentId', async () => {
    const r = await req('GET', `/api/lmstudio/files?version=${encodeURIComponent(fakeVersionId)}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    const files = r.body.files;
    // Every candidate must carry a non-null componentId.
    const missing = files.filter(f => !f.componentId);
    assert.deepStrictEqual(missing, [], `every candidate must have a componentId; missing: ${JSON.stringify(missing)}`);
    const ids = files.map(f => f.componentId).sort();
    // v2 conventional-prefix stripping makes leaf IDs match v1 exactly.
    assert.ok(ids.includes('agent-doc-updater'), 'agent leaf candidate present');
    assert.ok(ids.includes('command-plan'),      'command leaf candidate present');
    assert.ok(ids.includes('skill-demo-SKILL'),  'skill candidate present');
    // Multi-path rule module expands into ONE candidate per .md path (not collapsed).
    assert.ok(ids.includes('rule-python-coding-style'), 'rule leaf #1 present');
    assert.ok(ids.includes('rule-python-hooks'),        'rule leaf #2 present');
    assert.ok(ids.includes('rule-python-patterns'),     'rule leaf #3 present');
    // Module-level entry must NOT appear post-leaf-fix.
    assert.ok(!ids.includes('module-rule-python'), 'module-rule-python must not exist post-leaf-fix');
    // Each rule leaf's content is the body of its own .md file.
    const styleLeaf = files.find(f => f.componentId === 'rule-python-coding-style');
    assert.strictEqual(styleLeaf.relPath, 'rules/python/coding-style.md');
    assert.match(styleLeaf.content, /python style/, 'leaf content is its file body');
    // Skill candidate reads SKILL.md inside the directory, not the directory itself.
    const skillHit = files.find(f => f.componentId === 'skill-demo-SKILL');
    assert.strictEqual(skillHit.relPath, 'skills/demo-SKILL/SKILL.md');
    assert.match(skillHit.content, /demo skill/, 'skill content is the SKILL.md body');
  });

  test('directory-path modules (real ECC v2 shape) emit per-file leaf candidates', async () => {
    // The actual v2.0.0-rc.1 manifest declares modules with paths: ["rules"],
    // paths: ["commands"], paths: [".agents","agents","AGENTS.md"], etc. After
    // the per-leaf catalog change, each .md file under those paths becomes its
    // own selectable component (matching v1's per-file granularity).
    const realShapeDir = path.join(tmpRoot, 'projects', '.ecc-versions', 'v2-realshape-1.0.0');
    fs.mkdirSync(realShapeDir, { recursive: true });
    fs.writeFileSync(path.join(realShapeDir, 'package.json'), JSON.stringify({ version: 'v2-realshape-1.0.0' }));
    fs.mkdirSync(path.join(realShapeDir, 'manifests'), { recursive: true });
    fs.mkdirSync(path.join(realShapeDir, 'rules', 'typescript'), { recursive: true });
    fs.mkdirSync(path.join(realShapeDir, 'rules', 'python'),     { recursive: true });
    fs.mkdirSync(path.join(realShapeDir, 'commands'),            { recursive: true });
    fs.mkdirSync(path.join(realShapeDir, 'agents'),              { recursive: true });
    fs.writeFileSync(path.join(realShapeDir, 'rules', 'typescript', 'coding-style.md'), '# TS coding style');
    fs.writeFileSync(path.join(realShapeDir, 'rules', 'typescript', 'hooks.md'),        '# TS hooks');
    fs.writeFileSync(path.join(realShapeDir, 'rules', 'python', 'patterns.md'),         '# python patterns');
    fs.writeFileSync(path.join(realShapeDir, 'commands', 'tdd.md'),                     '# /tdd command');
    fs.writeFileSync(path.join(realShapeDir, 'commands', 'plan.md'),                    '# /plan command');
    fs.writeFileSync(path.join(realShapeDir, 'agents', 'planner.md'),                   '# planner agent');
    fs.writeFileSync(path.join(realShapeDir, 'AGENTS.md'),                              '# AGENTS top-level guidance');
    fs.writeFileSync(path.join(realShapeDir, 'manifests', 'install-modules.json'), JSON.stringify({
      modules: [
        { id: 'rules-core',    kind: 'rules',    description: 'Shared and language rules.', paths: ['rules'] },
        { id: 'commands-core', kind: 'commands', description: 'Core slash-command library.',  paths: ['commands'] },
        { id: 'agents-core',   kind: 'agents',   description: 'Agent definitions.',           paths: ['.agents', 'agents', 'AGENTS.md'] },
      ],
    }));
    srv._resetVersionCatalogCache();

    const r = await req('GET', `/api/lmstudio/files?version=${encodeURIComponent('v2-realshape-1.0.0')}`);
    assert.strictEqual(r.status, 200);
    const files = r.body.files;
    const ids = files.map(f => f.componentId);

    // Module-level entries must NOT exist anymore
    assert.ok(!ids.includes('module-rules-core'),    'module-rules-core should not exist post-leaf-fix');
    assert.ok(!ids.includes('module-agents-core'),   'module-agents-core should not exist post-leaf-fix');
    assert.ok(!ids.includes('module-commands-core'), 'module-commands-core should not exist post-leaf-fix');

    // rules-core: 3 leaves (TS coding-style, TS hooks, python patterns)
    const ruleLeaves = files.filter(f => f.type === 'rule');
    const rulePaths = ruleLeaves.map(f => f.relPath).sort();
    assert.deepStrictEqual(rulePaths, [
      'rules/python/patterns.md',
      'rules/typescript/coding-style.md',
      'rules/typescript/hooks.md',
    ]);
    // Each rule leaf carries the .md file body as its scoring content
    const tsHooks = files.find(f => f.relPath === 'rules/typescript/hooks.md');
    assert.match(tsHooks.content, /TS hooks/);

    // commands-core: 2 leaves
    const cmdPaths = files.filter(f => f.type === 'command').map(f => f.relPath).sort();
    assert.deepStrictEqual(cmdPaths, ['commands/plan.md', 'commands/tdd.md']);

    // agents-core: 2 leaves (agents/planner.md + AGENTS.md). `.agents` dir is empty, ignored.
    const agentPaths = files.filter(f => f.type === 'agent').map(f => f.relPath).sort();
    assert.deepStrictEqual(agentPaths, ['AGENTS.md', 'agents/planner.md']);

    // LM excludes settings (config values, not relevance-rankable) and
    // platform (toolchain choice the user knows themselves). Verify both
    // are absent from the candidate set even when present in the catalog.
    assert.strictEqual(files.find(f => f.type === 'setting'),  undefined, 'setting candidates must be excluded');
    assert.strictEqual(files.find(f => f.type === 'platform'), undefined, 'platform candidates must be excluded');
  });

  test('LM candidates exclude settings and platform types but include hooks + mcp', async () => {
    // Build a fixture that exercises every catalog type. The LM candidate
    // set must include analyzable types (rule, agent, skill, command, hook,
    // mcp) and skip non-analyzable ones (setting, platform).
    const vDir = path.join(tmpRoot, 'projects', '.ecc-versions', 'v2-types-1.0.0');
    fs.mkdirSync(vDir, { recursive: true });
    fs.writeFileSync(path.join(vDir, 'package.json'), JSON.stringify({ version: 'v2-types-1.0.0' }));
    fs.mkdirSync(path.join(vDir, 'manifests'), { recursive: true });
    fs.mkdirSync(path.join(vDir, 'mcp-configs'), { recursive: true });
    fs.mkdirSync(path.join(vDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(vDir, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(vDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(vDir, 'agents', 'reviewer.md'), '# reviewer');
    fs.writeFileSync(path.join(vDir, 'mcp-configs', 'mcp-servers.json'), JSON.stringify({
      mcpServers: { github: { description: 'GitHub MCP' } },
    }));
    fs.writeFileSync(path.join(vDir, 'hooks', 'hooks.json'), JSON.stringify({
      hooks: { PreToolUse: [{ id: 'pre:bash:check', description: 'Check Bash', hooks: [{ type: 'command', command: 'echo' }] }] },
    }));
    fs.writeFileSync(path.join(vDir, 'manifests', 'install-modules.json'), JSON.stringify({
      modules: [
        { id: 'agents-core',     kind: 'agents',   description: '', paths: ['agents'] },
        { id: 'hooks-runtime',   kind: 'hooks',    description: '', paths: ['hooks'] },
        { id: 'platform-configs', kind: 'platform', description: '', paths: ['.claude-plugin'] },
      ],
    }));
    srv._resetVersionCatalogCache();

    const r = await req('GET', `/api/lmstudio/files?version=${encodeURIComponent('v2-types-1.0.0')}`);
    assert.strictEqual(r.status, 200);
    const types = new Set(r.body.files.map(f => f.type));

    // Included
    assert.ok(types.has('agent'), 'agents must be LM-scored');
    assert.ok(types.has('hook'),  'hooks must be LM-scored');
    assert.ok(types.has('mcp'),   'mcps must be LM-scored');
    // Excluded
    assert.ok(!types.has('setting'),  'settings must NOT be LM-scored');
    assert.ok(!types.has('platform'), 'platforms must NOT be LM-scored');
  });

  test('POST result for a v2 leaf id round-trips through the cache', async () => {
    await req('POST', '/api/projects', { name: 'v2proj', description: '', eccVersion: fakeVersionId });
    await req('POST', '/api/projects/v2proj/lmstudio/result', {
      componentId: 'rule-python-coding-style',
      relPath: 'rules/python/coding-style.md', type: 'rule', name: 'coding-style.md',
      matchingPerc: 92, reasoning: 'fits a Python project', status: 'complete',
    });
    const cache = await req('GET', `/api/projects/v2proj/lmstudio/cache?version=${encodeURIComponent(fakeVersionId)}`);
    assert.strictEqual(cache.status, 200);
    const found = cache.body.results.find(x => x.componentId === 'rule-python-coding-style');
    assert.ok(found, 'leaf-level rule score must persist under its leaf id');
    assert.strictEqual(found.matchingPerc, 92);
  });
});

suite('integration: deploy relocates platform deployRoot=project paths to project root (P1.2)', () => {
  const verId  = 'v2-deploy-root-1.0.0';
  const projName = 'deployroot';
  const deployRoot = path.join(tmpRoot, 'deploy-target');

  test('install + deploy a hidden platform path lands at <deployPath>/.cursor, not .claude/.cursor', async () => {
    // Synthesize a v2 fixture with a .cursor platform leaf
    const vDir = path.join(tmpRoot, 'projects', '.ecc-versions', verId);
    fs.mkdirSync(vDir, { recursive: true });
    fs.writeFileSync(path.join(vDir, 'package.json'), JSON.stringify({ version: verId }));
    fs.mkdirSync(path.join(vDir, 'manifests'), { recursive: true });
    fs.mkdirSync(path.join(vDir, '.cursor', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(vDir, '.cursor', 'rules', 'main.mdc'), '# cursor rules');
    fs.mkdirSync(path.join(vDir, 'mcp-configs'), { recursive: true });
    fs.writeFileSync(path.join(vDir, 'mcp-configs', 'mcp-servers.json'), JSON.stringify({ mcpServers: {} }));
    fs.writeFileSync(path.join(vDir, 'manifests', 'install-modules.json'), JSON.stringify({
      modules: [{ id: 'platform-configs', kind: 'platform', description: '', paths: ['.cursor'] }],
    }));
    srv._resetVersionCatalogCache();

    // Create project with deploy path
    fs.mkdirSync(deployRoot, { recursive: true });
    await req('POST', '/api/projects', { name: projName, description: '', deployPath: deployRoot, eccVersion: verId });

    // Install the .cursor platform leaf
    const installRes = await req('POST', '/api/install', { project: projName, ids: ['platform-cursor'] });
    assert.strictEqual(installRes.status, 200);
    assert.strictEqual(installRes.body.results['platform-cursor'].ok, true);

    // Deploy
    const deployRes = await req('POST', '/api/deploy', { project: projName });
    assert.strictEqual(deployRes.status, 200);

    // .cursor must be at the project ROOT, not inside .claude/
    const atRoot      = path.join(deployRoot, '.cursor', 'rules', 'main.mdc');
    const insideClaude = path.join(deployRoot, '.claude', '.cursor');
    assert.ok(fs.existsSync(atRoot), `expected .cursor at project root: ${atRoot}`);
    assert.ok(!fs.existsSync(insideClaude), `must NOT exist at ${insideClaude}`);
    // And the file content actually arrived
    assert.match(fs.readFileSync(atRoot, 'utf8'), /cursor rules/);
  });
});

suite('integration: clientProj strips private fields', () => {
  test('GET /api/projects does not leak _analysis or _stateFile', async () => {
    const r = await req('GET', '/api/projects');
    assert.strictEqual(r.status, 200);
    const proj = r.body.projects.find(p => p.name === 'intproj');
    assert.ok(proj, 'intproj present');
    assert.strictEqual(proj._analysis,  undefined, '_analysis must not leak');
    assert.strictEqual(proj._stateFile, undefined, '_stateFile must not leak');
  });

  test('GET /api/projects/:name does not leak _analysis or _stateFile', async () => {
    const r = await req('GET', '/api/projects/intproj');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.project._analysis,  undefined);
    assert.strictEqual(r.body.project._stateFile, undefined);
  });
});

// ─── Run ─────────────────────────────────────────────────────────────────────

(async () => {
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => { port = httpServer.address().port; resolve(); });
  });
  try {
    for (const fn of queue) await fn();
  } finally {
    await new Promise(r => httpServer.close(r));
  }
  console.log(`\n${'─'.repeat(50)}`);
  const total = passed + failed;
  console.log(`${total} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
