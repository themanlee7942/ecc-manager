'use strict';
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const tmpRoot     = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-lmcache-test-'));
const tmpProjects = path.join(tmpRoot, 'projects');
const tmpStateDir = path.join(tmpRoot, 'state');
const tmpCatalog  = path.join(tmpRoot, 'catalog.json');

process.env.ECC_PROJECTS_DIR = tmpProjects;
process.env.ECC_STATE_DIR    = tmpStateDir;
process.env.ECC_CATALOG_FILE = tmpCatalog;
delete process.env.ECC_STATE_FILE;

const {
  loadState, saveState, saveProjectShard, _resetStateCache, stateStore,
} = require('../server');

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
function clean() {
  _resetStateCache();
  if (fs.existsSync(tmpStateDir)) fs.rmSync(tmpStateDir, { recursive: true, force: true });
}
process.on('exit', () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} });

// ─── Helpers exercising shard logic directly through stateStore ──────────────

function seedProject(name, opts = {}) {
  clean();
  saveState({
    versions: { '1.0': { verId: '1.0', pulledAt: 't' } },
    activeVersion: '1.0',
    projects: {
      [name]: {
        name, eccVersion: '1.0', createdAt: 't', deployPath: '/x',
        analysisDesc: opts.desc || '',
        components: opts.components || {},
      },
    },
  });
  return loadState();
}

// ─── applyLmAnalysisResult ──────────────────────────────────────────────────

suite('applyLmAnalysisResult', () => {
  test('saves matchingPerc and reasoning to the right component', () => {
    const shard = stateStore.emptyShard('myproj', '1.0');
    stateStore.applyLmAnalysisResult(shard, {
      componentId: 'agent-foo', relPath: 'agents/foo.md', type: 'agent', name: 'foo.md',
      matchingPerc: 85, reasoning: 'matches the project',
      analysisHash: 'sha256:abc', catalogHash: 'sha256:cat',
    });
    const c = shard.components['agent-foo'];
    assert.strictEqual(c.matchingPerc, 85);
    assert.strictEqual(c.reasoning, 'matches the project');
    assert.strictEqual(c.lmFilePath, 'agents/foo.md');
    assert.strictEqual(c.lmFileType, 'agent');
    assert.strictEqual(c.analysisStatus, 'complete');
    assert.ok(c.analyzedAt);
  });

  test('progress counters update from completed/failed components', () => {
    const shard = stateStore.emptyShard('myproj', '1.0');
    stateStore.applyLmAnalysisResult(shard, { componentId: 'a', matchingPerc: 70, reasoning: 'r', status: 'complete' });
    stateStore.applyLmAnalysisResult(shard, { componentId: 'b', matchingPerc: 0,  reasoning: 'fail', status: 'failed' });
    stateStore.applyLmAnalysisResult(shard, { componentId: 'c', matchingPerc: 95, reasoning: 'r', status: 'complete' });
    assert.strictEqual(shard.analysis.completedItems, 2);
    assert.strictEqual(shard.analysis.failedItems, 1);
  });

  test('preserves install state when overwriting LM scoring', () => {
    const shard = stateStore.emptyShard('myproj', '1.0');
    shard.components['agent-foo'] = { installed: true, installedAt: 't', value: null, matchingPerc: 50, reasoning: 'old' };
    stateStore.applyLmAnalysisResult(shard, { componentId: 'agent-foo', matchingPerc: 90, reasoning: 'new', status: 'complete' });
    assert.strictEqual(shard.components['agent-foo'].installed, true, 'install state preserved');
    assert.strictEqual(shard.components['agent-foo'].installedAt, 't');
    assert.strictEqual(shard.components['agent-foo'].matchingPerc, 90);
    assert.strictEqual(shard.components['agent-foo'].reasoning, 'new');
  });
});

// ─── clearLmAnalysisFields ──────────────────────────────────────────────────

suite('clearLmAnalysisFields', () => {
  test('removes only LM scoring fields, preserves install state', () => {
    const shard = stateStore.emptyShard('myproj', '1.0');
    shard.components['agent-foo'] = {
      installed: true, installedAt: 't', value: 'sonnet',
      matchingPerc: 80, reasoning: 'r',
      analysisHash: 'sha256:x', catalogHash: 'sha256:y',
      lmFilePath: 'p', lmFileType: 'agent', analyzedAt: 't', analysisStatus: 'complete',
    };
    stateStore.clearLmAnalysisFields(shard);
    const c = shard.components['agent-foo'];
    assert.strictEqual(c.installed, true);
    assert.strictEqual(c.installedAt, 't');
    assert.strictEqual(c.value, 'sonnet');
    assert.strictEqual(c.matchingPerc, undefined);
    assert.strictEqual(c.reasoning, undefined);
    assert.strictEqual(c.analysisHash, undefined);
    assert.strictEqual(c.catalogHash, undefined);
    assert.strictEqual(c.lmFilePath, undefined);
    assert.strictEqual(c.lmFileType, undefined);
    assert.strictEqual(c.analyzedAt, undefined);
    assert.strictEqual(c.analysisStatus, undefined);
    assert.strictEqual(shard.analysis.status, 'not_run');
    assert.strictEqual(shard.analysis.completedItems, 0);
  });
});

// ─── isAnalysisCacheFresh ───────────────────────────────────────────────────

suite('isAnalysisCacheFresh', () => {
  test('returns false when descriptionHash mismatches', () => {
    const shard = stateStore.emptyShard('p', '1.0');
    shard.analysis.descriptionHash = 'sha256:A';
    shard.analysis.catalogHash     = 'sha256:cat';
    assert.strictEqual(stateStore.isAnalysisCacheFresh(shard, 'sha256:B', 'sha256:cat'), false);
  });
  test('returns false when catalogHash mismatches', () => {
    const shard = stateStore.emptyShard('p', '1.0');
    shard.analysis.descriptionHash = 'sha256:A';
    shard.analysis.catalogHash     = 'sha256:cat1';
    assert.strictEqual(stateStore.isAnalysisCacheFresh(shard, 'sha256:A', 'sha256:cat2'), false);
  });
  test('returns true when both match', () => {
    const shard = stateStore.emptyShard('p', '1.0');
    shard.analysis.descriptionHash = 'sha256:A';
    shard.analysis.catalogHash     = 'sha256:cat';
    assert.strictEqual(stateStore.isAnalysisCacheFresh(shard, 'sha256:A', 'sha256:cat'), true);
  });
});

// ─── End-to-end through composed state + saveProjectShard ───────────────────

suite('end-to-end LM cache via saveProjectShard', () => {
  test('writes one LM result and persists it across reload', async () => {
    seedProject('myproj', { desc: 'TypeScript backend' });
    const s = loadState();
    const proj = s.projects.myproj;
    proj._analysis = proj._analysis || {};
    proj._analysis.descriptionHash = stateStore.hashAnalysisDesc(proj.analysisDesc);
    proj._analysis.catalogHash = 'sha256:cat';
    const shardLike = { analysis: proj._analysis, components: proj.components };
    stateStore.applyLmAnalysisResult(shardLike, {
      componentId: 'agent-typescript-reviewer',
      relPath: 'agents/typescript-reviewer.md',
      type: 'agent',
      name: 'typescript-reviewer.md',
      matchingPerc: 95,
      reasoning: 'TS-specific reviewer fits a TS project',
      status: 'complete',
      analysisHash: proj._analysis.descriptionHash,
      catalogHash: proj._analysis.catalogHash,
    });
    proj.components = shardLike.components;
    proj._analysis = shardLike.analysis;
    await saveProjectShard('myproj');

    _resetStateCache();
    const reloaded = loadState();
    const c = reloaded.projects.myproj.components['agent-typescript-reviewer'];
    assert.strictEqual(c.matchingPerc, 95);
    assert.strictEqual(c.reasoning, 'TS-specific reviewer fits a TS project');
    assert.strictEqual(c.analysisStatus, 'complete');
  });

  test('description change clears LM scoring but preserves installs', async () => {
    seedProject('myproj', {
      desc: 'first description',
      components: { 'agent-foo': { installed: true, installedAt: 't', matchingPerc: 80, reasoning: 'r' } },
    });
    const s = loadState();
    const proj = s.projects.myproj;
    // Simulate the PATCH endpoint logic
    const oldHash = stateStore.hashAnalysisDesc(proj.analysisDesc);
    const newHash = stateStore.hashAnalysisDesc('totally different description');
    proj.analysisDesc = 'totally different description';
    if (oldHash !== newHash) {
      const cleared = stateStore.clearLmAnalysisFields({
        analysis: proj._analysis || {}, components: proj.components,
      });
      proj._analysis = cleared.analysis;
      proj.components = cleared.components;
    }
    await saveProjectShard('myproj');
    _resetStateCache();
    const reloaded = loadState();
    const c = reloaded.projects.myproj.components['agent-foo'];
    assert.strictEqual(c.installed, true, 'install state preserved');
    assert.strictEqual(c.matchingPerc, undefined, 'match score cleared');
    assert.strictEqual(c.reasoning, undefined, 'reasoning cleared');
  });

  test('partial analysis preserves completed results', async () => {
    seedProject('myproj', { desc: 'desc' });
    const s = loadState();
    const proj = s.projects.myproj;
    proj._analysis = { ...proj._analysis, descriptionHash: 'h', catalogHash: 'c', status: 'in_progress', totalItems: 3 };
    const shardLike = { analysis: proj._analysis, components: proj.components };
    stateStore.applyLmAnalysisResult(shardLike, { componentId: 'a', matchingPerc: 70, reasoning: 'r', status: 'complete' });
    stateStore.applyLmAnalysisResult(shardLike, { componentId: 'b', matchingPerc: 0,  reasoning: 'err', status: 'failed' });
    proj._analysis = shardLike.analysis;
    proj.components = shardLike.components;
    proj._analysis.status = 'partial';
    await saveProjectShard('myproj');
    _resetStateCache();
    const reloaded = loadState();
    assert.strictEqual(reloaded.projects.myproj.components.a.matchingPerc, 70);
    assert.strictEqual(reloaded.projects.myproj.components.b.analysisStatus, 'failed');
    assert.strictEqual(reloaded.projects.myproj._analysis.status, 'partial');
    assert.strictEqual(reloaded.projects.myproj._analysis.completedItems, 1);
    assert.strictEqual(reloaded.projects.myproj._analysis.failedItems, 1);
  });

  test('failed result can be retried (overwritten with success)', () => {
    seedProject('myproj', { desc: 'desc' });
    const s = loadState();
    const proj = s.projects.myproj;
    const sl = { analysis: proj._analysis || {}, components: proj.components };
    stateStore.applyLmAnalysisResult(sl, { componentId: 'a', matchingPerc: 0, reasoning: 'fail', status: 'failed' });
    stateStore.applyLmAnalysisResult(sl, { componentId: 'a', matchingPerc: 80, reasoning: 'works now', status: 'complete' });
    assert.strictEqual(sl.components.a.matchingPerc, 80);
    assert.strictEqual(sl.components.a.analysisStatus, 'complete');
    assert.strictEqual(sl.analysis.failedItems, 0);
    assert.strictEqual(sl.analysis.completedItems, 1);
  });

  test('different ECC version uses a different shard, no LM result reuse', () => {
    clean();
    saveState({
      versions: { '1.0': { verId: '1.0', pulledAt: 't' }, '2.0': { verId: '2.0', pulledAt: 't' } },
      activeVersion: '2.0',
      projects: {
        myproj: { name: 'myproj', eccVersion: '1.0', components: { 'agent-foo': { matchingPerc: 90, reasoning: 'old', analysisStatus: 'complete' } } },
      },
    });
    // Switch project to 2.0 — components reset (this matches existing PATCH eccVersion behavior).
    const s = loadState();
    s.projects.myproj.eccVersion = '2.0';
    s.projects.myproj.components = {};
    saveState(s);
    // Original 1.0 shard still on disk; new 2.0 shard is the active one.
    assert.ok(fs.existsSync(path.join(tmpStateDir, '1.0-myproj.json')));
    assert.ok(fs.existsSync(path.join(tmpStateDir, '2.0-myproj.json')));
    const shard1 = JSON.parse(fs.readFileSync(path.join(tmpStateDir, '1.0-myproj.json'), 'utf8'));
    const shard2 = JSON.parse(fs.readFileSync(path.join(tmpStateDir, '2.0-myproj.json'), 'utf8'));
    assert.strictEqual(shard1.components['agent-foo'].matchingPerc, 90);
    assert.deepStrictEqual(shard2.components, {});
  });

  test('threshold change does not invalidate cache (only descriptionHash + catalogHash do)', () => {
    const shard = stateStore.emptyShard('p', '1.0');
    shard.analysis.descriptionHash = 'sha256:A';
    shard.analysis.catalogHash = 'sha256:cat';
    shard.analysis.thresholdAtRun = 90;
    // Threshold changes from 90 → 50; cache identity is unchanged.
    assert.strictEqual(stateStore.isAnalysisCacheFresh(shard, 'sha256:A', 'sha256:cat'), true);
  });

  test('catalogHash change invalidates the cache', () => {
    const shard = stateStore.emptyShard('p', '1.0');
    shard.analysis.descriptionHash = 'sha256:A';
    shard.analysis.catalogHash = 'sha256:cat-old';
    assert.strictEqual(stateStore.isAnalysisCacheFresh(shard, 'sha256:A', 'sha256:cat-new'), false);
  });

  // Soft-stale guarantee: a description edit must NOT wipe LM scores.
  // Cache freshness is computed at read-time via hash comparison; only an
  // explicit clear-cache or startRun:true should destroy data.
  test('soft-stale: description edit preserves LM scoring fields on disk', async () => {
    seedProject('myproj', { desc: 'first description' });
    const s = loadState();
    const proj = s.projects.myproj;
    proj._analysis = proj._analysis || {};
    // Simulate a completed run.
    proj._analysis.descriptionHash = stateStore.hashAnalysisDesc('first description');
    proj._analysis.catalogHash = 'sha256:cat';
    proj._analysis.status = 'complete';
    const sl = { analysis: proj._analysis, components: proj.components };
    stateStore.applyLmAnalysisResult(sl, {
      componentId: 'agent-foo', matchingPerc: 88, reasoning: 'good fit',
      status: 'complete', analysisHash: proj._analysis.descriptionHash,
      catalogHash: proj._analysis.catalogHash,
    });
    proj.components = sl.components;
    proj._analysis = sl.analysis;
    await saveProjectShard('myproj');

    // User edits description (simulate PATCH soft-stale path: just change
    // analysisDesc, leave _analysis.descriptionHash alone).
    proj.analysisDesc = 'edited description';
    await saveProjectShard('myproj');

    _resetStateCache();
    const reloaded = loadState();
    const c = reloaded.projects.myproj.components['agent-foo'];
    // Score must still be on disk
    assert.strictEqual(c.matchingPerc, 88);
    assert.strictEqual(c.reasoning, 'good fit');
    assert.strictEqual(c.analysisStatus, 'complete');
    // Staleness signal: descriptionHash on analysis is still the OLD hash,
    // which now mismatches hash(current description).
    const currentHash = stateStore.hashAnalysisDesc('edited description');
    assert.notStrictEqual(reloaded.projects.myproj._analysis.descriptionHash, currentHash);
    // isAnalysisCacheFresh agrees the cache is stale against the new hash.
    const shardLike = {
      analysis: reloaded.projects.myproj._analysis,
      components: reloaded.projects.myproj.components,
    };
    assert.strictEqual(
      stateStore.isAnalysisCacheFresh(shardLike, currentHash, 'sha256:cat'),
      false,
      'cache must report stale when descriptionHash mismatches',
    );
  });
});

// ─── Run queue ────────────────────────────────────────────────────────────────

(async () => {
  for (const fn of queue) await fn();
  console.log(`\n${'─'.repeat(50)}`);
  const total = passed + failed;
  console.log(`${total} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
