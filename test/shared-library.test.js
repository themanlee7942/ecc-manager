'use strict';
// Tests for the global shared library: state/shared/<DOC>.md/ markdown
// templates and state/shared/custom-components/<kind>/<slug>/ components.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const tmpRoot     = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-shared-'));
const tmpProjects = path.join(tmpRoot, 'projects');
const tmpStateDir = path.join(tmpRoot, 'state');
const tmpCatalog  = path.join(tmpRoot, 'catalog.json');

process.env.ECC_PROJECTS_DIR = tmpProjects;
process.env.ECC_STATE_DIR    = tmpStateDir;
process.env.ECC_CATALOG_FILE = tmpCatalog;
delete process.env.ECC_STATE_FILE;

const srv = require('../server');
const {
  // shared library
  safeSharedFileName,
  safeSharedSlug,
  safeSharedSlugPattern,
  assertPathInside,
  listSharedDocs,
  readSharedDoc,
  writeSharedDoc,
  deleteSharedDoc,
  sharedDocDir,
  // custom components
  customComponentId,
  defaultTargetForCustom,
  listCustomComponents,
  readCustomComponent,
  writeCustomComponent,
  updateCustomComponent,
  deleteCustomComponent,
  validateCustomComponentContent,
  // apply
  resolveApplyTargetPath,
  detectApplyCollision,
  applyMarkdownComponent,
  applyJsonComponent,
  // hooks/mcp merge
  canonicalJson,
  hashHookEntry,
  mergeHooksPayload,
  mergeMcpPayload,
  // misc
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

function setupProject(name) {
  _resetStateCache();
  const state = { versions: {}, activeVersion: null, projects: { [name]: { name, components: {}, customComponents: {} } } };
  saveState(state);
  return state;
}

// ─── Sanitization ─────────────────────────────────────────────────────────────

suite('safeSharedSlug / safeSharedFileName / safeSharedSlugPattern', () => {
  test('safeSharedSlug deterministically slugs names', () => {
    assert.strictEqual(safeSharedSlug('My Great Prompt'), 'my-great-prompt');
    assert.strictEqual(safeSharedSlug('  Spaces  '), 'spaces');
    assert.strictEqual(safeSharedSlug('FOO__BAR'), 'foo-bar');
    assert.strictEqual(safeSharedSlug('a..b'), 'a-b');
  });
  test('safeSharedSlug rejects empties', () => {
    assert.strictEqual(safeSharedSlug(''), null);
    assert.strictEqual(safeSharedSlug('   '), null);
    assert.strictEqual(safeSharedSlug('---'), null);
    assert.strictEqual(safeSharedSlug(null), null);
  });
  test('safeSharedSlug rejects path traversal artifacts', () => {
    // Slugs may not contain "..". Internally, '..' becomes '-'.
    const slug = safeSharedSlug('..');
    assert.strictEqual(slug, null);
  });
  test('safeSharedSlugPattern is strict', () => {
    assert.ok(safeSharedSlugPattern('my-slug'));
    assert.ok(safeSharedSlugPattern('a1'));
    assert.ok(!safeSharedSlugPattern('-leading'));
    assert.ok(!safeSharedSlugPattern('UPPER'));
    assert.ok(!safeSharedSlugPattern('with.dot'));
    assert.ok(!safeSharedSlugPattern('a/b'));
    assert.ok(!safeSharedSlugPattern('..'));
  });
  test('safeSharedFileName produces a .md extension', () => {
    assert.strictEqual(safeSharedFileName('My File'), 'my-file.md');
    assert.strictEqual(safeSharedFileName('strict-typescript.md'), 'strict-typescript.md');
    assert.strictEqual(safeSharedFileName('  Trim  '), 'trim.md');
  });
  test('safeSharedFileName rejects empties', () => {
    assert.strictEqual(safeSharedFileName(''), null);
    assert.strictEqual(safeSharedFileName('---'), null);
    assert.strictEqual(safeSharedFileName(null), null);
  });
  test('assertPathInside rejects escapes', () => {
    const base = path.join(tmpRoot, 'base');
    fs.mkdirSync(base, { recursive: true });
    assertPathInside(base, path.join(base, 'a/b'));
    assert.throws(() => assertPathInside(base, path.join(base, '..', 'evil')));
  });
});

// ─── Shared docs CRUD ─────────────────────────────────────────────────────────

suite('Shared markdown docs CRUD', () => {
  test('listSharedDocs returns empty array when directory does not exist', () => {
    assert.deepStrictEqual(listSharedDocs('claude'), []);
  });
  test('writeSharedDoc creates an id-keyed entry with metadata', () => {
    const r = writeSharedDoc('claude', { name: 'Strict TypeScript', description: 'tighten ts', content: '# CLAUDE.md\nrules' });
    assert.strictEqual(r.ok, true);
    assert.match(r.id, /^[a-f0-9]{8}$/);
    const meta = JSON.parse(fs.readFileSync(path.join(sharedDocDir('claude'), r.id, 'meta.json'), 'utf8'));
    assert.strictEqual(meta.name, 'Strict TypeScript');
    assert.strictEqual(meta.description, 'tighten ts');
    const onDisk = fs.readFileSync(path.join(sharedDocDir('claude'), r.id, 'content.md'), 'utf8');
    assert.strictEqual(onDisk, '# CLAUDE.md\nrules');
  });
  test('listSharedDocs returns id + name + description for each entry', () => {
    const items = listSharedDocs('claude');
    assert.ok(items.length >= 1);
    const found = items.find(it => it.name === 'Strict TypeScript');
    assert.ok(found);
    assert.match(found.id, /^[a-f0-9]{8}$/);
    assert.strictEqual(found.description, 'tighten ts');
  });
  test('readSharedDoc returns content addressed by id', () => {
    const items = listSharedDocs('claude');
    const id = items.find(it => it.name === 'Strict TypeScript').id;
    const r = readSharedDoc('claude', id);
    assert.ok(r);
    assert.match(r.content, /CLAUDE/);
    assert.strictEqual(r.name, 'Strict TypeScript');
  });
  test('two entries with the same name coexist (different ids)', () => {
    const a = writeSharedDoc('claude', { name: 'design', description: 'v1 strict', content: 'v1' });
    const b = writeSharedDoc('claude', { name: 'design', description: 'v2 with auth', content: 'v2' });
    assert.ok(a.ok && b.ok);
    assert.notStrictEqual(a.id, b.id);
    const items = listSharedDocs('claude').filter(it => it.name === 'design');
    assert.strictEqual(items.length, 2, 'both same-name entries surface');
    const descs = items.map(it => it.description).sort();
    assert.deepStrictEqual(descs, ['v1 strict', 'v2 with auth']);
  });
  test('deleteSharedDoc removes by id', () => {
    const created = writeSharedDoc('agents', { name: 'Cursor Context', content: 'agent context' });
    assert.ok(readSharedDoc('agents', created.id));
    const removed = deleteSharedDoc('agents', created.id);
    assert.strictEqual(removed, true);
    assert.strictEqual(readSharedDoc('agents', created.id), null);
  });
  test('shared docs are isolated by docKey', () => {
    writeSharedDoc('agents', { name: 'Deploy Checklist', content: '# agents' });
    const agentItems = listSharedDocs('agents');
    const claudeItems = listSharedDocs('claude');
    assert.ok(agentItems.find(it => it.name === 'Deploy Checklist'));
    assert.ok(!claudeItems.find(it => it.name === 'Deploy Checklist'));
  });
  test('claude/agents/settings-local/other are the valid shared-doc kinds', () => {
    // Reusable SKILL.md templates are now custom components (kind: 'skills'),
    // not a separate shared-doc kind. The legacy `skill` and `skills` keys
    // are both rejected at the shared-doc layer. `other` is the free-form
    // markdown template library; `settings-local` holds reusable
    // settings.local.json templates that users copy/paste into a project.
    assert.strictEqual(srv.sharedDocDir('skill'), null);
    assert.strictEqual(srv.sharedDocDir('skills'), null);
    assert.ok(srv.sharedDocDir('claude'),         'claude docKey resolves to a real dir');
    assert.ok(srv.sharedDocDir('agents'),         'agents docKey resolves to a real dir');
    assert.ok(srv.sharedDocDir('settings-local'), 'settings-local docKey resolves to a real dir');
    assert.ok(srv.sharedDocDir('other'),          'other docKey resolves to a real dir');
  });
  test('shared "other" docKey persists arbitrary markdown templates', () => {
    writeSharedDoc('other', { name: 'design.md',       content: '# Design' });
    writeSharedDoc('other', { name: 'architecture.md', content: '# Architecture' });
    const items = listSharedDocs('other');
    assert.ok(items.find(it => it.name === 'design.md'),       'design.md persisted');
    assert.ok(items.find(it => it.name === 'architecture.md'), 'architecture.md persisted');
    // Isolation: claude / agents must not see "other" docs and vice versa.
    const claudeItems = listSharedDocs('claude');
    assert.ok(!claudeItems.find(it => it.name === 'design.md'), 'design.md does not bleed into claude');
  });
  test('updateSharedDoc renames + reassigns description without changing the id', () => {
    const created = writeSharedDoc('other', { name: 'roadmap', description: 'q1', content: '# r1' });
    const r = srv.updateSharedDoc('other', created.id, { name: 'roadmap', description: 'q2', content: '# r2' });
    assert.strictEqual(r.ok, true);
    const after = readSharedDoc('other', created.id);
    assert.strictEqual(after.id, created.id);
    assert.strictEqual(after.description, 'q2');
    assert.match(after.content, /r2/);
  });
  test('migrates legacy <slug>.md flat files into id-keyed dirs on first list', () => {
    // Drop a legacy-shaped file directly under the docKey dir so the next
    // listSharedDocs call has to migrate it. Verifies the on-disk shape is
    // converted: file disappears, an <id>/ dir with meta.json + content.md
    // takes its place, and the surfaced item carries the original filename
    // (sans .md) as its `name`.
    const dir = sharedDocDir('claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'legacy-doc.md'), '# legacy body', 'utf8');
    const items = listSharedDocs('claude');
    assert.ok(items.find(it => it.name === 'legacy-doc'), 'legacy doc surfaces under new layout');
    assert.ok(!fs.existsSync(path.join(dir, 'legacy-doc.md')), 'legacy flat file removed');
    const migratedId = items.find(it => it.name === 'legacy-doc').id;
    assert.ok(fs.existsSync(path.join(dir, migratedId, 'meta.json')), 'meta.json created');
    assert.ok(fs.existsSync(path.join(dir, migratedId, 'content.md')), 'content.md created');
  });
  test('legacy state/shared/SKILL.md/*.md content migrates into custom skills', () => {
    // Simulate a pre-merge install: a legacy SKILL.md library file on disk
    // and no matching custom skill yet. Reading the skills kind dir should
    // run the one-shot migration and surface the file as a Custom Skill.
    const legacyDir = path.join(srv.sharedDir(), 'SKILL.md');
    const skillsDir = path.join(srv.sharedDir(), 'custom-components', 'skills');
    try { fs.rmSync(legacyDir, { recursive: true, force: true }); } catch {}
    // Wipe any pre-existing migrated entry from earlier test runs in this
    // process. listCustomComponents below would otherwise see a stale hit.
    try { fs.rmSync(path.join(skillsDir, 'legacy-deploy'), { recursive: true, force: true }); } catch {}
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'legacy-deploy.md'), '# legacy skill\n', 'utf8');
    // The migration runs on the first sharedComponentKindDir('skills') call
    // *of the process lifetime*. It's already fired in earlier suites, but
    // the side effects (files on disk) persist regardless of the one-shot
    // flag, so we trigger it manually here for repeatability.
    if (typeof srv._resetLegacySkillTemplatesFlag === 'function') srv._resetLegacySkillTemplatesFlag();
    listCustomComponents('skills'); // forces migration
    const items = listCustomComponents('skills');
    assert.ok(items.find(it => it.slug === 'legacy-deploy'), 'legacy SKILL.md file appears as a Custom Skill');
    const it = items.find(x => x.slug === 'legacy-deploy');
    assert.match(it.content, /legacy skill/, 'migrated content matches');
  });
});

// ─── Custom components CRUD ───────────────────────────────────────────────────

suite('Custom components CRUD', () => {
  test('writeCustomComponent rejects empty name', () => {
    const r = writeCustomComponent('rules', '   ', { content: '' });
    assert.strictEqual(r.ok, false);
  });
  test('writeCustomComponent creates a markdown component', () => {
    const r = writeCustomComponent('rules', 'Strict TypeScript', { content: '# strict\n', description: 'tighten ts' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.slug, 'strict-typescript');
    assert.strictEqual(r.id, 'custom-rules-strict-typescript');
  });
  test('writeCustomComponent rejects duplicate slug', () => {
    const r = writeCustomComponent('rules', 'Strict TypeScript', { content: 'dup' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error || '', /already exists/i);
  });
  test('readCustomComponent returns the persisted entry', () => {
    const it = readCustomComponent('rules', 'strict-typescript');
    assert.ok(it);
    assert.strictEqual(it.kind, 'rules');
    assert.match(it.content, /strict/);
    assert.strictEqual(it.contentFile, 'content.md');
  });
  test('writeCustomComponent rejects invalid JSON for hooks', () => {
    const r = writeCustomComponent('hooks', 'My Hook', { content: 'not json' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error || '', /JSON/i);
  });
  test('writeCustomComponent persists JSON content for hooks', () => {
    const r = writeCustomComponent('hooks', 'Notify On Stop', {
      content: JSON.stringify({ event: 'Stop', entry: { command: 'echo done', id: 'notify-stop' } }),
    });
    assert.strictEqual(r.ok, true);
    const it = readCustomComponent('hooks', 'notify-on-stop');
    assert.strictEqual(it.contentFile, 'content.json');
    const parsed = JSON.parse(it.content);
    assert.strictEqual(parsed.event, 'Stop');
  });
  test('updateCustomComponent rewrites content + metadata', () => {
    const r = updateCustomComponent('rules', 'strict-typescript', { content: '# updated', description: 'tighter' });
    assert.strictEqual(r.ok, true);
    const it = readCustomComponent('rules', 'strict-typescript');
    assert.strictEqual(it.content, '# updated');
    assert.strictEqual(it.description, 'tighter');
  });
  test('deleteCustomComponent removes the entry', () => {
    writeCustomComponent('commands', 'Throwaway', { content: '# tmp' });
    const r = deleteCustomComponent('commands', 'throwaway');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(readCustomComponent('commands', 'throwaway'), null);
  });
  test('listCustomComponents returns all entries for a kind', () => {
    writeCustomComponent('agents', 'Senior Reviewer', { content: '# agent', description: 'rev' });
    const items = listCustomComponents('agents');
    assert.ok(items.find(it => it.slug === 'senior-reviewer'));
  });
  test('writeCustomComponent substitutes <slug> in defaultFileName at save time', () => {
    // Frontend seeds the file input with `<slug>.md` before the user has
    // typed a name. If they save without editing the file field, the literal
    // placeholder must NOT be persisted — it should resolve to the slug now.
    const r = writeCustomComponent('rules', 'Slug Sub Test', {
      content: '# r',
      defaultTargetFolder: 'rules/custom',
      defaultFileName: '<slug>.md',
    });
    assert.strictEqual(r.ok, true);
    const it = readCustomComponent('rules', 'slug-sub-test');
    assert.strictEqual(it.defaultFileName, 'slug-sub-test.md', 'file resolved');
    assert.strictEqual(it.defaultTargetFolder, 'rules/custom');
  });
  test('writeCustomComponent substitutes <slug> in defaultTargetFolder for skills', () => {
    const r = writeCustomComponent('skills', 'Folder Slug Test', {
      content: '# s',
      defaultTargetFolder: 'skills/<slug>',
      defaultFileName: 'SKILL.md',
    });
    assert.strictEqual(r.ok, true);
    const it = readCustomComponent('skills', 'folder-slug-test');
    assert.strictEqual(it.defaultTargetFolder, 'skills/folder-slug-test');
    assert.strictEqual(it.defaultFileName, 'SKILL.md');
  });
  test('updateCustomComponent substitutes <slug> when client sends a placeholder', () => {
    writeCustomComponent('commands', 'Update Slug', { content: '# c' });
    const r = updateCustomComponent('commands', 'update-slug', {
      defaultTargetFolder: 'commands',
      defaultFileName: '<slug>.md',
    });
    assert.strictEqual(r.ok, true);
    const it = readCustomComponent('commands', 'update-slug');
    assert.strictEqual(it.defaultFileName, 'update-slug.md');
  });
  test('readCustomComponent resolves <slug> in legacy on-disk metadata', () => {
    // Simulate a pre-fix entry: hand-write component.json with a literal
    // `<slug>.md` so the read path has to clean it up for older data that
    // already escaped to disk before the write-time normalization landed.
    const legacyDir = srv.sharedComponentEntryDir('rules', 'legacy-slug');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'component.json'), JSON.stringify({
      id: 'custom-rules-legacy-slug',
      kind: 'rules',
      name: 'Legacy Slug',
      description: '',
      defaultTargetFolder: 'rules/custom',
      defaultFileName: '<slug>.md',
      contentFile: 'content.md',
    }), 'utf8');
    fs.writeFileSync(path.join(legacyDir, 'content.md'), '# legacy', 'utf8');
    const it = readCustomComponent('rules', 'legacy-slug');
    assert.strictEqual(it.defaultFileName, 'legacy-slug.md', 'placeholder resolved on read');
  });
  test('resolveApplyTargetPath substitutes <slug> in user-supplied overrides', () => {
    // Defensive: even if the persisted entry escaped normalization, applying
    // it must still produce a real on-disk path, never `<slug>.md`.
    const p = resolveApplyTargetPath('rules', 'apply-slug', {
      targetFolder: 'rules/custom',
      fileName: '<slug>.md',
    });
    assert.strictEqual(p, path.join('rules', 'custom', 'apply-slug.md'));
  });
});

// ─── Apply ────────────────────────────────────────────────────────────────────

suite('resolveApplyTargetPath / defaults', () => {
  test('rules default to rules/custom/<slug>.md', () => {
    const p = resolveApplyTargetPath('rules', 'foo');
    assert.strictEqual(p, path.join('rules', 'custom', 'foo.md'));
  });
  test('skills default to skills/<slug>/SKILL.md', () => {
    const p = resolveApplyTargetPath('skills', 'foo');
    assert.strictEqual(p, path.join('skills', 'foo', 'SKILL.md'));
  });
  test('overrides take effect when valid', () => {
    const p = resolveApplyTargetPath('rules', 'foo', { targetFolder: 'rules/custom-2', fileName: 'bar.md' });
    assert.strictEqual(p, path.join('rules', 'custom-2', 'bar.md'));
  });
  test('rejects path traversal in target folder', () => {
    const p = resolveApplyTargetPath('rules', 'foo', { targetFolder: '../evil', fileName: 'bar.md' });
    assert.strictEqual(p, null);
  });
  test('rejects absolute paths', () => {
    const p = resolveApplyTargetPath('rules', 'foo', { targetFolder: '/etc', fileName: 'bar.md' });
    assert.strictEqual(p, null);
  });
  test('rejects file with slashes', () => {
    const p = resolveApplyTargetPath('rules', 'foo', { targetFolder: '', fileName: 'a/b.md' });
    assert.strictEqual(p, null);
  });
});

suite('applyMarkdownComponent', () => {
  test('writes component content to project .claude/<targetPath>', () => {
    writeCustomComponent('rules', 'TestApply', { content: '# applied content' });
    const proj = `pa-${uid()}`;
    setupProject(proj);
    const r = applyMarkdownComponent(proj, 'rules', 'testapply', {});
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.targetPath, path.join('rules', 'custom', 'testapply.md'));
    const onDisk = fs.readFileSync(path.join(projectDir(proj), r.targetPath), 'utf8');
    assert.strictEqual(onDisk, '# applied content');
  });
  test('returns collision when target already exists', () => {
    writeCustomComponent('rules', 'CollideTest', { content: '# x' });
    const proj = `pa-${uid()}`;
    setupProject(proj);
    // First apply
    applyMarkdownComponent(proj, 'rules', 'collidetest', {});
    // Second apply without overwrite must report collision
    const r = applyMarkdownComponent(proj, 'rules', 'collidetest', {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.collision, true);
  });
  test('overwrite:true backs up existing target before replacing', () => {
    writeCustomComponent('rules', 'BackupTest', { content: '# new' });
    const proj = `pa-${uid()}`;
    setupProject(proj);
    const dest = path.join(projectDir(proj), 'rules', 'custom', 'backuptest.md');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, '# original', 'utf8');
    const r = applyMarkdownComponent(proj, 'rules', 'backuptest', { overwrite: true });
    assert.strictEqual(r.ok, true);
    assert.ok(r.backupPath, 'backup should be created');
    const backupAbs = path.join(projectDir(proj), r.backupPath);
    assert.strictEqual(fs.readFileSync(backupAbs, 'utf8'), '# original');
    // file replaced
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), '# new');
  });
  test('records applied metadata in proj.customComponents', () => {
    writeCustomComponent('rules', 'MetaTest', { content: '# meta' });
    const proj = `pa-${uid()}`;
    setupProject(proj);
    const r = applyMarkdownComponent(proj, 'rules', 'metatest', {});
    assert.strictEqual(r.ok, true);
    _resetStateCache();
    const state = loadState();
    const meta = state.projects[proj].customComponents['custom-rules-metatest'];
    assert.ok(meta);
    assert.strictEqual(meta.kind, 'rules');
    assert.strictEqual(meta.targetPath, path.join('rules', 'custom', 'metatest.md'));
    assert.ok(meta.appliedAt);
  });
  test('deleting shared component does NOT remove project copy', () => {
    writeCustomComponent('rules', 'DelTest', { content: '# x' });
    const proj = `pa-${uid()}`;
    setupProject(proj);
    applyMarkdownComponent(proj, 'rules', 'deltest', {});
    deleteCustomComponent('rules', 'deltest');
    const dest = path.join(projectDir(proj), 'rules', 'custom', 'deltest.md');
    assert.ok(fs.existsSync(dest), 'project copy must remain after shared component deletion');
  });
});

// ─── Hooks/MCP merging ────────────────────────────────────────────────────────

suite('canonicalJson / hashHookEntry', () => {
  test('canonicalJson sorts object keys', () => {
    const a = canonicalJson({ b: 1, a: 2 });
    const b = canonicalJson({ a: 2, b: 1 });
    assert.strictEqual(a, b);
  });
  test('canonicalJson normalizes CRLF to LF in strings', () => {
    const a = canonicalJson({ x: 'a\r\nb' });
    const b = canonicalJson({ x: 'a\nb' });
    assert.strictEqual(a, b);
  });
  test('hashHookEntry is deterministic across key order', () => {
    const h1 = hashHookEntry({ command: 'echo', id: 'h1', priority: 5 });
    const h2 = hashHookEntry({ priority: 5, id: 'h1', command: 'echo' });
    assert.strictEqual(h1, h2);
  });
  test('hashHookEntry differs for meaningful content changes', () => {
    const h1 = hashHookEntry({ command: 'echo a', id: 'h1' });
    const h2 = hashHookEntry({ command: 'echo b', id: 'h1' });
    assert.notStrictEqual(h1, h2);
  });
});

suite('mergeHooksPayload', () => {
  test('appends new hook entries when event is new', () => {
    const r = mergeHooksPayload({}, { event: 'Stop', entry: { id: 'a', command: 'x' } });
    assert.strictEqual(r.merged.hooks.Stop.length, 1);
    assert.strictEqual(r.appended, 1);
  });
  test('skips identical hook entry by id', () => {
    const existing = { hooks: { Stop: [{ id: 'a', command: 'x' }] } };
    const r = mergeHooksPayload(existing, { event: 'Stop', entry: { id: 'a', command: 'x' } });
    assert.strictEqual(r.merged.hooks.Stop.length, 1);
    assert.strictEqual(r.skipped, 1);
    assert.strictEqual(r.appended, 0);
  });
  test('reports conflicts when same id has different content (detect)', () => {
    const existing = { hooks: { Stop: [{ id: 'a', command: 'x' }] } };
    const r = mergeHooksPayload(existing, { event: 'Stop', entry: { id: 'a', command: 'y' } });
    assert.strictEqual(r.conflicts.length, 1);
    // Detect mode must NOT mutate the existing entry.
    assert.strictEqual(r.merged.hooks.Stop[0].command, 'x');
  });
  test('replace mode actually overwrites the conflicting entry', () => {
    const existing = { hooks: { Stop: [{ id: 'a', command: 'x' }] } };
    const r = mergeHooksPayload(existing, { event: 'Stop', entry: { id: 'a', command: 'y' } }, 'replace');
    assert.strictEqual(r.replaced, 1);
    assert.strictEqual(r.merged.hooks.Stop.length, 1);
    assert.strictEqual(r.merged.hooks.Stop[0].command, 'y');
    assert.strictEqual(r.conflicts.length, 0);
  });
  test('append-as-new keeps existing entry and appends a derived id', () => {
    const existing = { hooks: { Stop: [{ id: 'a', command: 'x' }] } };
    const r = mergeHooksPayload(existing, { event: 'Stop', entry: { id: 'a', command: 'y' } }, 'append-as-new');
    assert.strictEqual(r.appended, 1);
    assert.strictEqual(r.merged.hooks.Stop.length, 2);
    assert.strictEqual(r.merged.hooks.Stop[0].id, 'a');
    assert.strictEqual(r.merged.hooks.Stop[1].id, 'a-2');
    assert.strictEqual(r.merged.hooks.Stop[1].command, 'y');
  });
  test('falls back to content hash when no id present', () => {
    const existing = { hooks: { Stop: [{ command: 'x' }] } };
    const r = mergeHooksPayload(existing, { event: 'Stop', entry: { command: 'x' } });
    assert.strictEqual(r.skipped, 1);
  });
});

suite('mergeMcpPayload', () => {
  test('adds new server when name does not exist', () => {
    const r = mergeMcpPayload({}, { mcpServers: { github: { command: 'g' } } });
    assert.strictEqual(r.added, 1);
    assert.deepStrictEqual(r.merged.mcpServers.github, { command: 'g' });
  });
  test('skips identical server config', () => {
    const existing = { mcpServers: { github: { command: 'g' } } };
    const r = mergeMcpPayload(existing, { mcpServers: { github: { command: 'g' } } });
    assert.strictEqual(r.skipped, 1);
  });
  test('reports conflict for differing config under same name (detect)', () => {
    const existing = { mcpServers: { github: { command: 'g' } } };
    const r = mergeMcpPayload(existing, { mcpServers: { github: { command: 'changed' } } });
    assert.strictEqual(r.conflicts.length, 1);
    // Detect mode must NOT mutate the existing config.
    assert.strictEqual(r.merged.mcpServers.github.command, 'g');
  });
  test('replace mode overwrites the conflicting server', () => {
    const existing = { mcpServers: { github: { command: 'g' } } };
    const r = mergeMcpPayload(existing, { mcpServers: { github: { command: 'changed' } } }, 'replace');
    assert.strictEqual(r.replaced, 1);
    assert.strictEqual(r.merged.mcpServers.github.command, 'changed');
  });
  test('append-as-new keeps existing server and adds a derived key', () => {
    const existing = { mcpServers: { github: { command: 'g' } } };
    const r = mergeMcpPayload(existing, { mcpServers: { github: { command: 'changed' } } }, 'append-as-new');
    assert.strictEqual(r.added, 1);
    assert.strictEqual(r.merged.mcpServers.github.command, 'g');
    assert.strictEqual(r.merged.mcpServers['github-2'].command, 'changed');
  });
  test('accepts the alternate { mcp: { servers: {} } } payload shape', () => {
    const r = mergeMcpPayload({}, { mcp: { servers: { foo: { command: 'f' } } } });
    assert.strictEqual(r.added, 1);
  });
});

suite('applyJsonComponent — hooks/mcp', () => {
  test('apply hooks merges into settings.json', () => {
    writeCustomComponent('hooks', 'NewHook', { content: JSON.stringify({ event: 'Stop', entry: { id: 'h', command: 'echo' } }) });
    const proj = `pj-${uid()}`;
    setupProject(proj);
    const r = applyJsonComponent(proj, 'hooks', 'newhook', {});
    assert.strictEqual(r.ok, true);
    const settings = JSON.parse(fs.readFileSync(path.join(projectDir(proj), 'settings.json'), 'utf8'));
    assert.ok(settings.hooks.Stop);
    assert.strictEqual(settings.hooks.Stop[0].command, 'echo');
  });
  test('apply mcp merges into settings.mcpServers', () => {
    writeCustomComponent('mcp', 'GitHub MCP', { content: JSON.stringify({ mcpServers: { github: { command: 'gh' } } }) });
    const proj = `pj-${uid()}`;
    setupProject(proj);
    const r = applyJsonComponent(proj, 'mcp', 'github-mcp', {});
    assert.strictEqual(r.ok, true);
    const settings = JSON.parse(fs.readFileSync(path.join(projectDir(proj), 'settings.json'), 'utf8'));
    assert.ok(settings.mcpServers.github);
  });
  test('apply hooks reports requiresConflictResolution on id collision', () => {
    writeCustomComponent('hooks', 'ConflictHook', { content: JSON.stringify({ event: 'Stop', entry: { id: 'cid', command: 'a' } }) });
    const proj = `pj-${uid()}`;
    setupProject(proj);
    fs.mkdirSync(projectDir(proj), { recursive: true });
    fs.writeFileSync(path.join(projectDir(proj), 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ id: 'cid', command: 'b' }] } }), 'utf8');
    const r = applyJsonComponent(proj, 'hooks', 'conflicthook', {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.requiresConflictResolution, true);
    // settings.json must be untouched on conflict-detect.
    const before = JSON.parse(fs.readFileSync(path.join(projectDir(proj), 'settings.json'), 'utf8'));
    assert.strictEqual(before.hooks.Stop[0].command, 'b');
  });

  test('apply hooks with conflictMode:replace overwrites the existing entry', () => {
    writeCustomComponent('hooks', 'ReplaceHook', { content: JSON.stringify({ event: 'Stop', entry: { id: 'rid', command: 'new' } }) });
    const proj = `pj-${uid()}`;
    setupProject(proj);
    fs.mkdirSync(projectDir(proj), { recursive: true });
    fs.writeFileSync(path.join(projectDir(proj), 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ id: 'rid', command: 'old' }] } }), 'utf8');
    const r = applyJsonComponent(proj, 'hooks', 'replacehook', { conflictMode: 'replace' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.merge.replaced, 1);
    const after = JSON.parse(fs.readFileSync(path.join(projectDir(proj), 'settings.json'), 'utf8'));
    assert.strictEqual(after.hooks.Stop.length, 1);
    assert.strictEqual(after.hooks.Stop[0].command, 'new', 'replace mode must rewrite the conflicting entry');
  });

  test('apply hooks with conflictMode:append-as-new adds a new entry alongside', () => {
    writeCustomComponent('hooks', 'AppendHook', { content: JSON.stringify({ event: 'Stop', entry: { id: 'aid', command: 'new' } }) });
    const proj = `pj-${uid()}`;
    setupProject(proj);
    fs.mkdirSync(projectDir(proj), { recursive: true });
    fs.writeFileSync(path.join(projectDir(proj), 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ id: 'aid', command: 'old' }] } }), 'utf8');
    const r = applyJsonComponent(proj, 'hooks', 'appendhook', { conflictMode: 'append-as-new' });
    assert.strictEqual(r.ok, true);
    const after = JSON.parse(fs.readFileSync(path.join(projectDir(proj), 'settings.json'), 'utf8'));
    assert.strictEqual(after.hooks.Stop.length, 2);
    assert.strictEqual(after.hooks.Stop[0].id, 'aid');
    assert.strictEqual(after.hooks.Stop[1].id, 'aid-2');
  });

  test('apply mcp with conflictMode:replace overwrites the conflicting server', () => {
    writeCustomComponent('mcp', 'ReplaceMcp', { content: JSON.stringify({ mcpServers: { svc: { command: 'new' } } }) });
    const proj = `pj-${uid()}`;
    setupProject(proj);
    fs.mkdirSync(projectDir(proj), { recursive: true });
    fs.writeFileSync(path.join(projectDir(proj), 'settings.json'),
      JSON.stringify({ mcpServers: { svc: { command: 'old' } } }), 'utf8');
    const r = applyJsonComponent(proj, 'mcp', 'replacemcp', { conflictMode: 'replace' });
    assert.strictEqual(r.ok, true);
    const after = JSON.parse(fs.readFileSync(path.join(projectDir(proj), 'settings.json'), 'utf8'));
    assert.strictEqual(after.mcpServers.svc.command, 'new');
  });
});

suite('Project-root deploy targets', () => {
  test('isProjectRootDeployTarget allows known agent/tool config roots', () => {
    assert.strictEqual(srv.isProjectRootDeployTarget('.cursor/rules/foo.md'), true);
    assert.strictEqual(srv.isProjectRootDeployTarget('.agents/skills/foo/SKILL.md'), true);
    assert.strictEqual(srv.isProjectRootDeployTarget('.codex/agents.md'), true);
    assert.strictEqual(srv.isProjectRootDeployTarget('.gemini/foo.toml'), true);
    assert.strictEqual(srv.isProjectRootDeployTarget('.opencode/foo.md'), true);
  });
  test('isProjectRootDeployTarget rejects normal .claude paths', () => {
    assert.strictEqual(srv.isProjectRootDeployTarget('rules/custom/foo.md'), false);
    assert.strictEqual(srv.isProjectRootDeployTarget('skills/foo/SKILL.md'), false);
  });
  test('isProjectRootDeployTarget never treats .backups as deploy-root', () => {
    assert.strictEqual(srv.isProjectRootDeployTarget('.backups/whatever.bak'), false);
  });
  test('isProjectRootDeployTarget rejects sensitive hidden directories (security)', () => {
    // The allowlist must NOT include these — relocating writes into them
    // would push files into the user's git config, ssh keys, secrets, etc.
    for (const evil of ['.git/hooks/post-commit', '.ssh/id_rsa', '.env', '.envrc',
                        '.docker/config.json', '.aws/credentials', '.npm/foo',
                        '.idea/workspace.xml', '.vscode/settings.json',
                        '.foo-not-on-allowlist/x.md']) {
      assert.strictEqual(srv.isProjectRootDeployTarget(evil), false, `must reject ${evil}`);
    }
  });
  test('applyMarkdownComponent records deployRoot:project for hidden first-segment targets', () => {
    writeCustomComponent('agents', 'CursorAgent', { content: '# cursor agent' });
    const proj = `pr-${uid()}`;
    setupProject(proj);
    const r = applyMarkdownComponent(proj, 'agents', 'cursoragent', { targetFolder: '.cursor/agents', fileName: 'cursor-agent.md' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.deployRoot, 'project');
    _resetStateCache();
    const state = loadState();
    const meta = state.projects[proj].customComponents['custom-agents-cursoragent'];
    assert.strictEqual(meta.deployRoot, 'project');
    assert.strictEqual(meta.targetPath, path.join('.cursor', 'agents', 'cursor-agent.md'));
  });
  test('applyMarkdownComponent records deployRoot:claude for ordinary targets', () => {
    writeCustomComponent('rules', 'NormalRule', { content: '# r' });
    const proj = `pr-${uid()}`;
    setupProject(proj);
    const r = applyMarkdownComponent(proj, 'rules', 'normalrule', {});
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.deployRoot, 'claude');
  });
  test('applyMarkdownComponent rejects directory targets with a clean error', () => {
    writeCustomComponent('rules', 'DirGuard', { content: '# x' });
    const proj = `pr-${uid()}`;
    setupProject(proj);
    // Pre-create a directory at the would-be target file path
    const dir = path.join(projectDir(proj), 'rules', 'custom', 'dirguard.md');
    fs.mkdirSync(dir, { recursive: true });
    const r = applyMarkdownComponent(proj, 'rules', 'dirguard', { overwrite: true });
    assert.strictEqual(r.ok, false);
    assert.match(r.error || '', /directory/i);
  });
});

suite('backupDeployTargets — type conflicts', () => {
  test('reports failure when src is a file but dest is a directory', () => {
    const proj = `tc-${uid()}`;
    setupProject(proj);
    const srcDir = path.join(tmpRoot, `tc-src-${uid()}`);
    const destDir = path.join(tmpRoot, `tc-dest-${uid()}`);
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(destDir, { recursive: true });
    // src/foo.md is a file
    fs.writeFileSync(path.join(srcDir, 'foo.md'), 'incoming', 'utf8');
    // dest/foo.md is a DIRECTORY — fs.copyFileSync would throw EISDIR
    fs.mkdirSync(path.join(destDir, 'foo.md'), { recursive: true });
    const stagingBackups = path.join(tmpRoot, `tc-backups-${uid()}`);
    const result = srv.backupDeployTargets(srcDir, destDir, stagingBackups, '.cursor/agents');
    assert.strictEqual(result.created.length, 0);
    assert.ok(result.failed.length >= 1);
    assert.match(result.failed[0].error || '', /type conflict/i);
    assert.match(result.failed[0].error || '', /file.*directory/i);
  });

  test('reports failure when src is a directory but dest is a file', () => {
    const srcDir = path.join(tmpRoot, `tc2-src-${uid()}`);
    const destBase = path.join(tmpRoot, `tc2-dest-${uid()}`);
    fs.mkdirSync(path.join(srcDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'agents', 'foo.md'), 'inner', 'utf8');
    fs.mkdirSync(destBase, { recursive: true });
    // dest/agents is a FILE — copyRecursive would later mkdir on top of it.
    fs.writeFileSync(path.join(destBase, 'agents'), 'I am a file in the way', 'utf8');
    const stagingBackups = path.join(tmpRoot, `tc2-backups-${uid()}`);
    const result = srv.backupDeployTargets(srcDir, destBase, stagingBackups, '.cursor');
    assert.strictEqual(result.created.length, 0);
    assert.ok(result.failed.length >= 1);
    assert.match(result.failed[0].error || '', /type conflict/i);
    assert.match(result.failed[0].error || '', /directory.*file/i);
  });

  test('reports failure when an ANCESTOR of dest is a file (single-file rel case)', () => {
    // Custom apply produces a single-file rel like ".cursor/agents/foo.md".
    // The walk doesn't recurse, so my dir-vs-non-dir guard wouldn't fire —
    // only the upfront ancestor preflight catches "<dest>/.cursor/agents" as
    // a file blocking the path to "<dest>/.cursor/agents/foo.md".
    const stagingDir = path.join(tmpRoot, `tcA-staging-${uid()}`);
    const deployDir  = path.join(tmpRoot, `tcA-deploy-${uid()}`);
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.mkdirSync(deployDir, { recursive: true });
    // src is a single file
    fs.writeFileSync(path.join(stagingDir, 'foo.md'), 'incoming', 'utf8');
    // dest path: deployDir/.cursor/agents/foo.md, but .cursor/agents is a FILE
    fs.mkdirSync(path.join(deployDir, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(deployDir, '.cursor', 'agents'), 'in the way', 'utf8');
    const stagingBackups = path.join(tmpRoot, `tcA-backups-${uid()}`);
    const result = srv.backupDeployTargets(
      path.join(stagingDir, 'foo.md'),
      path.join(deployDir, '.cursor', 'agents', 'foo.md'),
      stagingBackups,
      '.cursor/agents/foo.md'
    );
    assert.strictEqual(result.created.length, 0);
    assert.ok(result.failed.length >= 1);
    assert.match(result.failed[0].error || '', /type conflict/i);
    assert.match(result.failed[0].error || '', /ancestor/i);
    // The blocking file must still be there untouched.
    assert.strictEqual(fs.readFileSync(path.join(deployDir, '.cursor', 'agents'), 'utf8'), 'in the way');
  });

  test('does NOT report an ancestor failure when the chain is all directories', () => {
    const stagingDir = path.join(tmpRoot, `tcA2-staging-${uid()}`);
    const deployDir  = path.join(tmpRoot, `tcA2-deploy-${uid()}`);
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, 'foo.md'), 'incoming', 'utf8');
    fs.mkdirSync(path.join(deployDir, '.cursor', 'agents'), { recursive: true });
    const stagingBackups = path.join(tmpRoot, `tcA2-backups-${uid()}`);
    const result = srv.backupDeployTargets(
      path.join(stagingDir, 'foo.md'),
      path.join(deployDir, '.cursor', 'agents', 'foo.md'),
      stagingBackups,
      '.cursor/agents/foo.md'
    );
    assert.strictEqual(result.failed.length, 0);
  });

  test('does NOT report a failure when both sides are matching directories', () => {
    const srcDir = path.join(tmpRoot, `tc3-src-${uid()}`);
    const destBase = path.join(tmpRoot, `tc3-dest-${uid()}`);
    fs.mkdirSync(path.join(srcDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'agents', 'foo.md'), 'inner', 'utf8');
    fs.mkdirSync(path.join(destBase, 'agents'), { recursive: true });
    // No file at dest/agents/foo.md — nothing to back up, no conflict.
    const stagingBackups = path.join(tmpRoot, `tc3-backups-${uid()}`);
    const result = srv.backupDeployTargets(srcDir, destBase, stagingBackups, '.cursor');
    assert.strictEqual(result.failed.length, 0);
    assert.strictEqual(result.created.length, 0);
  });
});

suite('backupDeployTargets — failure surfacing', () => {
  test('reports failures via the `failed` array (no silent swallow)', () => {
    // Set up a src/dest pair where the dest is a real file, then point
    // backupsDir at a path that *cannot* be created — by rooting it at an
    // existing FILE so mkdir would fail. Confirms backupDeployTargets emits
    // a `failed` entry instead of just logging a warning.
    const proj = `bf-${uid()}`;
    setupProject(proj);
    const stagingFile = path.join(tmpRoot, `bf-blocking-${uid()}.txt`);
    fs.writeFileSync(stagingFile, 'I am a file, not a directory', 'utf8');
    // Backups dir under that file → mkdir EEXIST/ENOTDIR.
    const blockedBackupsDir = path.join(stagingFile, '.backups');

    const srcDir = path.join(tmpRoot, `bf-src-${uid()}`);
    const destDir = path.join(tmpRoot, `bf-dest-${uid()}`);
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'foo.md'), 'incoming', 'utf8');
    fs.writeFileSync(path.join(destDir, 'foo.md'), 'pre-existing', 'utf8');

    const result = srv.backupDeployTargets(srcDir, destDir, blockedBackupsDir, '.cursor/rules');
    assert.strictEqual(result.created.length, 0);
    assert.ok(result.failed.length >= 1, 'must surface at least one failure');
  });
});

suite('classifyBackupName / listAllProjectBackups', () => {
  test('classifies managed-doc backups by docKey', () => {
    assert.deepStrictEqual(srv.classifyBackupName('CLAUDE.md.20260505T120000Z.bak'), { kind: 'managed-doc', docKey: 'claude' });
    assert.deepStrictEqual(srv.classifyBackupName('AGENTS.md.20260505T120000Z-2.bak'), { kind: 'managed-doc', docKey: 'agents' });
    // SKILLS.md is no longer a managed doc, so its filename pattern must NOT
    // be classified as managed-doc anymore — falls through to apply-or-deploy
    // (since it still ends in `.md.<ts>.bak`) which is correct: any leftover
    // SKILLS.md backup from older versions is recoverable from the filesystem,
    // just not via the managed-doc UI.
    assert.strictEqual(srv.classifyBackupName('SKILLS.md.20260505T120000Z.bak').kind, 'apply-or-deploy');
  });
  test('classifies settings.json backups', () => {
    assert.strictEqual(srv.classifyBackupName('settings.json.20260505T120000Z.bak').kind, 'settings-json');
  });
  test('classifies deploy-time and apply-time snapshots as apply-or-deploy', () => {
    assert.strictEqual(srv.classifyBackupName('.cursor__agents__foo.md.20260505T120000Z.bak').kind, 'apply-or-deploy');
    assert.strictEqual(srv.classifyBackupName('foo.md.20260505T120000Z.bak').kind, 'apply-or-deploy');
  });
  test('listAllProjectBackups returns mixed-category entries with metadata', () => {
    const proj = `lb-${uid()}`;
    setupProject(proj);
    const backupsDir = path.join(projectDir(proj), '.backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    fs.writeFileSync(path.join(backupsDir, 'CLAUDE.md.20260505T100000Z.bak'), 'c', 'utf8');
    fs.writeFileSync(path.join(backupsDir, 'settings.json.20260505T110000Z.bak'), 's', 'utf8');
    fs.writeFileSync(path.join(backupsDir, '.cursor__agents__foo.md.20260505T120000Z.bak'), 'r', 'utf8');
    const all = srv.listAllProjectBackups(proj);
    assert.strictEqual(all.length, 3);
    const kinds = all.map(b => b.kind).sort();
    assert.deepStrictEqual(kinds, ['apply-or-deploy', 'managed-doc', 'settings-json']);
    assert.ok(all.every(b => typeof b.size === 'number'));
    assert.ok(all.every(b => typeof b.relativePath === 'string'));
  });
});

suite('Backup uniqueness — same-second collisions', () => {
  test('two backups within the same second must both exist', () => {
    const proj = `bu-${uid()}`;
    setupProject(proj);
    const dir = projectDir(proj);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'v1', 'utf8');
    const b1 = srv.backupProjectManagedDoc(proj, 'claude');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'v2', 'utf8');
    const b2 = srv.backupProjectManagedDoc(proj, 'claude');
    assert.notStrictEqual(b1, b2, 'second backup must produce a different filename');
    const all = srv.listProjectManagedDocBackups(proj, 'claude');
    assert.ok(all.length >= 2, 'both backups must remain on disk');
    // The collision suffix variant must still match the validator regex so
    // restore can use it as a backupName.
    const pat = srv.backupNamePattern('claude');
    assert.ok(all.every(b => pat.test(b.name)), 'every backup name must match the pattern');
  });
});

// ─── Collision detection ──────────────────────────────────────────────────────

suite('detectApplyCollision', () => {
  test('detects existing manual file at target', () => {
    const proj = `pcol-${uid()}`;
    setupProject(proj);
    const dest = path.join(projectDir(proj), 'rules', 'foo.md');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, '# manual', 'utf8');
    const r = detectApplyCollision(proj, path.join('rules', 'foo.md'), { components: {}, customComponents: {} });
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.source, 'manual');
  });
  test('detects ECC component owning the same path', () => {
    const proj = `pcol-${uid()}`;
    setupProject(proj);
    const proj_obj = {
      components: { 'rule-strict-ts': { installed: true, sourcePath: path.join('rules', 'strict.md') } },
      customComponents: {},
    };
    const r = detectApplyCollision(proj, path.join('rules', 'strict.md'), proj_obj);
    assert.strictEqual(r.exists, true);
    assert.match(r.source, /^ecc:/);
  });
  test('detects another custom component with the same target path', () => {
    const proj = `pcol-${uid()}`;
    setupProject(proj);
    const proj_obj = {
      components: {},
      customComponents: { 'custom-rules-other': { kind: 'rules', targetPath: path.join('rules', 'shared.md') } },
    };
    const r = detectApplyCollision(proj, path.join('rules', 'shared.md'), proj_obj);
    assert.strictEqual(r.exists, true);
    assert.match(r.source, /^custom:/);
  });

  test('detects a pre-existing file at the FINAL deploy destination for project-root targets', () => {
    const proj = `pcol-deploy-${uid()}`;
    setupProject(proj);
    const deployPath = path.join(tmpRoot, `pcol-deploy-target-${uid()}`);
    fs.mkdirSync(path.join(deployPath, '.cursor', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(deployPath, '.cursor', 'agents', 'foo.md'), '# already here', 'utf8');
    const proj_obj = { components: {}, customComponents: {}, deployPath };
    const r = detectApplyCollision(proj, path.join('.cursor', 'agents', 'foo.md'), proj_obj);
    assert.strictEqual(r.exists, true);
    assert.match(r.source, /^project-root-file:/);
  });

  test('does NOT check deploy destination for non-project-root targets', () => {
    const proj = `pcol-noproj-${uid()}`;
    setupProject(proj);
    const deployPath = path.join(tmpRoot, `pcol-noproj-target-${uid()}`);
    fs.mkdirSync(path.join(deployPath, 'rules', 'custom'), { recursive: true });
    fs.writeFileSync(path.join(deployPath, 'rules', 'custom', 'whatever.md'), '# pretend', 'utf8');
    const proj_obj = { components: {}, customComponents: {}, deployPath };
    // Normal .claude/<rel> targets aren't relocated, so the deploy-target
    // check must not fire (otherwise every project with deployPath set would
    // false-positive on harmless re-applies).
    const r = detectApplyCollision(proj, path.join('rules', 'custom', 'whatever.md'), proj_obj);
    assert.strictEqual(r.exists, false);
  });

  test('does NOT check deploy destination when deployPath is unset', () => {
    const proj = `pcol-nodp-${uid()}`;
    setupProject(proj);
    const proj_obj = { components: {}, customComponents: {}, deployPath: '' };
    const r = detectApplyCollision(proj, path.join('.cursor', 'agents', 'foo.md'), proj_obj);
    assert.strictEqual(r.exists, false);
  });
});

// ─── HTTP integration ─────────────────────────────────────────────────────────

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

http_suite('HTTP /api/shared/docs', () => {
  http_test('POST returns an id; GET returns name + description + content', async () => {
    const r = await http_('POST', '/api/shared/docs/claude', { name: 'API Test Doc', description: 'http test', content: 'hello' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.match(r.body.id, /^[a-f0-9]{8}$/);
    const list = await http_('GET', '/api/shared/docs/claude');
    assert.ok(list.body.items.find(it => it.id === r.body.id && it.name === 'API Test Doc'));
    const get = await http_('GET', `/api/shared/docs/claude/${r.body.id}`);
    assert.strictEqual(get.body.content, 'hello');
    assert.strictEqual(get.body.description, 'http test');
  });
  http_test('POST rejects unknown docKey', async () => {
    const r = await http_('POST', '/api/shared/docs/foo', { name: 'x', content: 'y' });
    assert.strictEqual(r.status, 400);
  });
  http_test('PUT updates existing content + description', async () => {
    const create = await http_('POST', '/api/shared/docs/agents', { name: 'API Agents Doc', description: 'v1', content: 'v1 body' });
    const id = create.body.id;
    const r = await http_('PUT', `/api/shared/docs/agents/${id}`, { content: 'v2 body', description: 'v2' });
    assert.strictEqual(r.status, 200);
    const get = await http_('GET', `/api/shared/docs/agents/${id}`);
    assert.strictEqual(get.body.content, 'v2 body');
    assert.strictEqual(get.body.description, 'v2');
  });
  http_test('DELETE removes the entry by id', async () => {
    const create = await http_('POST', '/api/shared/docs/agents', { name: 'API Agents Doc Two', content: 'z' });
    const id = create.body.id;
    const r = await http_('DELETE', `/api/shared/docs/agents/${id}`);
    assert.strictEqual(r.body.ok, true);
    const get = await http_('GET', `/api/shared/docs/agents/${id}`);
    assert.strictEqual(get.status, 404);
  });
  http_test('two POSTs with the same name produce distinct ids', async () => {
    const a = await http_('POST', '/api/shared/docs/other', { name: 'design', description: 'v1', content: 'a' });
    const b = await http_('POST', '/api/shared/docs/other', { name: 'design', description: 'v2', content: 'b' });
    assert.notStrictEqual(a.body.id, b.body.id);
    const list = await http_('GET', '/api/shared/docs/other');
    const designs = list.body.items.filter(it => it.name === 'design');
    assert.ok(designs.length >= 2, 'both versions surface in the list');
  });
  http_test('legacy /api/shared/docs/skill and /skills both return 400', async () => {
    // SKILL.md is no longer a shared-doc kind — those templates moved to
    // custom components (kind: 'skills'). Both legacy keys must be rejected.
    const skillRes  = await http_('POST', '/api/shared/docs/skill',  { name: 'Old', content: 'x' });
    const skillsRes = await http_('POST', '/api/shared/docs/skills', { name: 'Old', content: 'x' });
    assert.strictEqual(skillRes.status, 400);
    assert.strictEqual(skillsRes.status, 400);
  });
});

http_suite('HTTP /api/shared/components', () => {
  http_test('POST creates a component then GET returns it', async () => {
    const r = await http_('POST', '/api/shared/components/rules', {
      name: 'API Rule', description: 'apirule', content: '# rule',
    });
    assert.strictEqual(r.body.ok, true);
    const get = await http_('GET', '/api/shared/components/rules/api-rule');
    assert.strictEqual(get.body.item.slug, 'api-rule');
    assert.strictEqual(get.body.item.kind, 'rules');
  });
  http_test('GET /api/shared/components (no kind) returns every kind grouped', async () => {
    // Seed at least one entry across two kinds so the grouping is meaningful.
    await http_('POST', '/api/shared/components/skills', {
      name: 'Aggregate Skill', description: '', content: '# skill body',
    });
    await http_('POST', '/api/shared/components/commands', {
      name: 'Aggregate Cmd', description: '', content: '# cmd body',
    });
    const r = await http_('GET', '/api/shared/components');
    assert.strictEqual(r.body.ok, true);
    assert.ok(r.body.byKind, 'response includes byKind map');
    // Every supported kind is keyed even when empty so the frontend doesn't
    // have to special-case missing keys when iterating.
    for (const kind of ['rules', 'hooks', 'mcp', 'agents', 'skills', 'commands']) {
      assert.ok(Array.isArray(r.body.byKind[kind]), `byKind.${kind} is an array`);
    }
    assert.ok(r.body.byKind.skills.find(it => it.slug === 'aggregate-skill'));
    assert.ok(r.body.byKind.commands.find(it => it.slug === 'aggregate-cmd'));
  });
  http_test('GET /api/shared/components includes sharedDocCounts for sidebar', async () => {
    // Seed a couple of CLAUDE.md library entries so the sidebar count is
    // non-zero. Names are uniquified to survive previous suite state.
    await http_('POST', '/api/shared/docs/claude', { name: 'Sidebar Count Doc One', content: '1' });
    await http_('POST', '/api/shared/docs/claude', { name: 'Sidebar Count Doc Two', content: '2' });
    const r = await http_('GET', '/api/shared/components');
    assert.strictEqual(r.body.ok, true);
    assert.ok(r.body.sharedDocCounts, 'response carries sharedDocCounts');
    assert.strictEqual(typeof r.body.sharedDocCounts.claude, 'number');
    assert.strictEqual(typeof r.body.sharedDocCounts.agents, 'number');
    assert.ok(r.body.sharedDocCounts.claude >= 2, 'claude count reflects newly-seeded docs');
  });
  http_test('GET /api/projects/:name includes customApplied for applied custom components', async () => {
    await http_('POST', '/api/shared/components/rules', { name: 'Tracked Apply Rule', content: '# r' });
    const proj = `tracked-${uid()}`;
    await http_('POST', '/api/projects', { name: proj, description: '', deployPath: '' });
    // Before apply: customApplied is empty.
    const before = await http_('GET', `/api/projects/${proj}`);
    assert.deepStrictEqual(before.body.customApplied, {});
    // Apply, then re-fetch.
    const ar = await http_('POST', '/api/shared/components/rules/tracked-apply-rule/apply', { project: proj });
    assert.strictEqual(ar.body.ok, true);
    const after = await http_('GET', `/api/projects/${proj}`);
    const id = 'custom-rules-tracked-apply-rule';
    const entry = after.body.customApplied[id];
    assert.ok(entry, 'customApplied has entry for the applied component');
    assert.strictEqual(entry.kind, 'rules');
    assert.ok(entry.targetPath, 'customApplied entry exposes targetPath');
    assert.ok(entry.appliedAt, 'customApplied entry exposes appliedAt');
  });
  http_test('apply requires project', async () => {
    await http_('POST', '/api/shared/components/rules', { name: 'NoProj Rule', content: '# r' });
    const r = await http_('POST', '/api/shared/components/rules/noproj-rule/apply', {});
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error || '', /project/i);
  });
  http_test('apply writes to project .claude/', async () => {
    await http_('POST', '/api/shared/components/rules', { name: 'HTTP Apply Rule', content: '# applied' });
    const proj = `httpapply-${uid()}`;
    await http_('POST', '/api/projects', { name: proj, description: '', deployPath: '' });
    const r = await http_('POST', '/api/shared/components/rules/http-apply-rule/apply', { project: proj });
    assert.strictEqual(r.body.ok, true);
    const dest = path.join(projectDir(proj), 'rules', 'custom', 'http-apply-rule.md');
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), '# applied');
  });
  http_test('DELETE removes shared component but leaves project copies', async () => {
    await http_('POST', '/api/shared/components/rules', { name: 'PreserveTest', content: '# p' });
    const proj = `preserve-${uid()}`;
    await http_('POST', '/api/projects', { name: proj, description: '', deployPath: '' });
    await http_('POST', '/api/shared/components/rules/preservetest/apply', { project: proj });
    await http_('DELETE', '/api/shared/components/rules/preservetest');
    const dest = path.join(projectDir(proj), 'rules', 'custom', 'preservetest.md');
    assert.ok(fs.existsSync(dest), 'applied copy must remain');
  });

  http_test('apply with conflictMode:skip on every-entry-conflict returns noop and does NOT record metadata', async () => {
    await http_('POST', '/api/shared/components/hooks', {
      name: 'SkipHook',
      content: JSON.stringify({ event: 'Stop', entry: { id: 'sid', command: 'incoming' } }),
    });
    const proj = `skip-${uid()}`;
    await http_('POST', '/api/projects', { name: proj, description: '', deployPath: '' });
    fs.mkdirSync(projectDir(proj), { recursive: true });
    const original = JSON.stringify({ hooks: { Stop: [{ id: 'sid', command: 'pre-existing' }] } });
    fs.writeFileSync(path.join(projectDir(proj), 'settings.json'), original, 'utf8');
    const originalMtime = fs.statSync(path.join(projectDir(proj), 'settings.json')).mtimeMs;
    const r = await http_('POST', '/api/shared/components/hooks/skiphook/apply', { project: proj, conflictMode: 'skip' });
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.noop, true, 'skip-only result must be flagged noop');
    assert.strictEqual(r.body.backupPath, null, 'no backup should be created on noop');
    // settings.json must be byte-identical, not even rewritten with re-serialized JSON
    const afterRaw = fs.readFileSync(path.join(projectDir(proj), 'settings.json'), 'utf8');
    assert.strictEqual(afterRaw, original);
    // No customComponents metadata recorded
    const projGet = await http_('GET', `/api/projects/${proj}`);
    const customCC = projGet.body.project.customComponents || {};
    assert.ok(!customCC['custom-hooks-skiphook'], 'metadata must not be recorded for noop apply');
  });

  http_test('apply with conflictMode:skip but with non-conflicting new entries DOES record metadata', async () => {
    // Two entries: one matches existing (will skip), one is new (will append).
    // Net effect is a real change, so the apply is real.
    await http_('POST', '/api/shared/components/hooks', {
      name: 'PartialSkip',
      content: JSON.stringify({
        hooks: {
          Stop: [
            { id: 'existing-id', command: 'this-conflicts' },   // conflict → skip
            { id: 'brand-new',   command: 'fresh' },             // appended
          ],
        },
      }),
    });
    const proj = `partial-${uid()}`;
    await http_('POST', '/api/projects', { name: proj, description: '', deployPath: '' });
    fs.mkdirSync(projectDir(proj), { recursive: true });
    fs.writeFileSync(path.join(projectDir(proj), 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ id: 'existing-id', command: 'pre-existing' }] } }), 'utf8');
    const r = await http_('POST', '/api/shared/components/hooks/partialskip/apply', { project: proj, conflictMode: 'skip' });
    assert.strictEqual(r.body.ok, true);
    assert.ok(!r.body.noop, 'partial apply must NOT be flagged as noop');
    const after = JSON.parse(fs.readFileSync(path.join(projectDir(proj), 'settings.json'), 'utf8'));
    // Conflicting entry preserved, new entry appended
    assert.strictEqual(after.hooks.Stop.length, 2);
    assert.ok(after.hooks.Stop.find(h => h.id === 'existing-id' && h.command === 'pre-existing'));
    assert.ok(after.hooks.Stop.find(h => h.id === 'brand-new'));
    // Metadata recorded
    const projGet = await http_('GET', `/api/projects/${proj}`);
    assert.ok((projGet.body.project.customComponents || {})['custom-hooks-partialskip']);
  });

  http_test('GET /api/shared/config returns the project-root allowlist for the frontend', async () => {
    const r = await http_('GET', '/api/shared/config');
    assert.strictEqual(r.body.ok, true);
    assert.ok(Array.isArray(r.body.projectRootDeployDirs));
    // Spot-check a few known entries
    assert.ok(r.body.projectRootDeployDirs.includes('.cursor'));
    assert.ok(r.body.projectRootDeployDirs.includes('.codex'));
    // And confirm sensitive dirs are NOT advertised to the UI
    assert.ok(!r.body.projectRootDeployDirs.includes('.git'));
    assert.ok(!r.body.projectRootDeployDirs.includes('.ssh'));
    assert.ok(!r.body.projectRootDeployDirs.includes('.env'));
  });

  http_test('apply blocks when a real file already lives at the final deploy destination', async () => {
    await http_('POST', '/api/shared/components/agents', { name: 'BlockOverwrite', content: '# new' });
    const proj = `block-${uid()}`;
    const deployPath = path.join(tmpRoot, `block-target-${uid()}`);
    await http_('POST', '/api/projects', { name: proj, description: '', deployPath });
    // User wrote a file at the deploy target outside ECC Manager
    fs.mkdirSync(path.join(deployPath, '.cursor', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(deployPath, '.cursor', 'agents', 'block-overwrite.md'), '# user-edited', 'utf8');
    const r = await http_('POST', '/api/shared/components/agents/blockoverwrite/apply', {
      project: proj,
      targetFolder: '.cursor/agents',
      fileName: 'block-overwrite.md',
    });
    assert.strictEqual(r.body.ok, false);
    assert.strictEqual(r.body.collision, true);
    assert.match(r.body.conflictSource, /^project-root-file:/);
  });

  http_test('GET /api/projects/:name/backups lists every backup category', async () => {
    const proj = `lb-http-${uid()}`;
    await http_('POST', '/api/projects', { name: proj, description: '', deployPath: '' });
    const backupsDir = path.join(projectDir(proj), '.backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    fs.writeFileSync(path.join(backupsDir, 'CLAUDE.md.20260505T100000Z.bak'), 'c', 'utf8');
    fs.writeFileSync(path.join(backupsDir, '.cursor__agents__foo.md.20260505T120000Z.bak'), 'r', 'utf8');
    const r = await http_('GET', `/api/projects/${proj}/backups`);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.backups.length, 2);
    const byKind = Object.fromEntries(r.body.backups.map(b => [b.kind, b]));
    assert.ok(byKind['managed-doc']);
    assert.ok(byKind['apply-or-deploy']);
    assert.strictEqual(byKind['managed-doc'].docKey, 'claude');
  });

  http_test('deploy aborts cleanly when an ANCESTOR of the target path is a file at the deploy path', async () => {
    // Custom component target: .cursor/agents/ancestorconflict.md (single file).
    // At the deploy path, .cursor/agents is a FILE — so writing a file under
    // it would crash mid-relocation in pass 2 without the upfront ancestor
    // check.
    await http_('POST', '/api/shared/components/agents', { name: 'AncestorConflict', content: '# x' });
    const proj = `anc-${uid()}`;
    const deployPath = path.join(tmpRoot, `anc-target-${uid()}`);
    await http_('POST', '/api/projects', { name: proj, description: '', deployPath });
    const apply = await http_('POST', '/api/shared/components/agents/ancestorconflict/apply', {
      project: proj,
      targetFolder: '.cursor/agents',
      fileName: 'ancestorconflict.md',
    });
    assert.strictEqual(apply.body.ok, true);
    // Sabotage: at deploy path, .cursor/agents is a FILE.
    fs.mkdirSync(path.join(deployPath, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(deployPath, '.cursor', 'agents'), 'precious file content', 'utf8');
    const dep = await http_('POST', '/api/deploy', { project: proj });
    assert.strictEqual(dep.status, 500);
    assert.strictEqual(dep.body.ok, false);
    assert.match(dep.body.error || '', /preflight/i);
    assert.match(dep.body.backupFailures[0].error || '', /type conflict.*ancestor/i);
    // The blocking file is untouched.
    assert.strictEqual(fs.readFileSync(path.join(deployPath, '.cursor', 'agents'), 'utf8'), 'precious file content');
  });

  http_test('deploy aborts cleanly when a project-root target type-conflicts with the deploy path', async () => {
    // Custom component is a file (.cursor/agents/foo.md) but the user's
    // project has a *directory* at the same path. Without the preflight,
    // pass 2 would throw mid-loop.
    await http_('POST', '/api/shared/components/agents', { name: 'TypeConflictAgent', content: '# new' });
    const proj = `typec-${uid()}`;
    const deployPath = path.join(tmpRoot, `typec-target-${uid()}`);
    await http_('POST', '/api/projects', { name: proj, description: '', deployPath });
    const apply = await http_('POST', '/api/shared/components/agents/typeconflictagent/apply', {
      project: proj,
      targetFolder: '.cursor/agents',
      fileName: 'typeconflict.md',
    });
    assert.strictEqual(apply.body.ok, true);
    // Sabotage: at the deploy path, put a directory where our file would go.
    fs.mkdirSync(path.join(deployPath, '.cursor', 'agents', 'typeconflict.md'), { recursive: true });
    fs.writeFileSync(path.join(deployPath, '.cursor', 'agents', 'typeconflict.md', 'inner.txt'), 'precious', 'utf8');
    const dep = await http_('POST', '/api/deploy', { project: proj });
    assert.strictEqual(dep.status, 500);
    assert.strictEqual(dep.body.ok, false);
    assert.match(dep.body.error || '', /preflight/i);
    assert.ok(dep.body.backupFailures && dep.body.backupFailures.length >= 1);
    assert.match(dep.body.backupFailures[0].error || '', /type conflict/i);
    // The directory (and its inner file) survived untouched.
    const innerStill = fs.readFileSync(path.join(deployPath, '.cursor', 'agents', 'typeconflict.md', 'inner.txt'), 'utf8');
    assert.strictEqual(innerStill, 'precious');
  });

  http_test('deploy aborts before any overwrite if a pre-existing root file cannot be backed up', async () => {
    await http_('POST', '/api/shared/components/agents', { name: 'AbortGuard', content: '# new' });
    const proj = `abort-${uid()}`;
    const deployPath = path.join(tmpRoot, `abort-target-${uid()}`);
    await http_('POST', '/api/projects', { name: proj, description: '', deployPath });
    // Apply first so the staging side has the file.
    await http_('POST', '/api/shared/components/agents/abortguard/apply', {
      project: proj,
      targetFolder: '.cursor/agents',
      fileName: 'abortguard.md',
    });
    // Seed a conflicting real file at the deploy path.
    fs.mkdirSync(path.join(deployPath, '.cursor', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(deployPath, '.cursor', 'agents', 'abortguard.md'), '# IMPORTANT user content', 'utf8');
    // Sabotage the staging .backups path so backup creation cannot succeed.
    // Deleting the directory then dropping a *file* with the same name
    // forces ensureDir to fail with ENOTDIR.
    const stagingClaude = projectDir(proj);
    const stagingBackupsDir = path.join(stagingClaude, '.backups');
    if (fs.existsSync(stagingBackupsDir)) fs.rmSync(stagingBackupsDir, { recursive: true, force: true });
    fs.writeFileSync(stagingBackupsDir, 'NOT A DIRECTORY', 'utf8');
    const dep = await http_('POST', '/api/deploy', { project: proj });
    assert.strictEqual(dep.status, 500);
    assert.strictEqual(dep.body.ok, false);
    assert.match(dep.body.error || '', /aborted|preflight/i);
    assert.ok(dep.body.backupFailures && dep.body.backupFailures.length >= 1);
    // Critical guarantee: the user's original file was not overwritten.
    const stillThere = fs.readFileSync(path.join(deployPath, '.cursor', 'agents', 'abortguard.md'), 'utf8');
    assert.strictEqual(stillThere, '# IMPORTANT user content', 'real project-root file must be untouched on abort');
    // Cleanup so subsequent tests aren't affected by the sabotaged path.
    try { fs.unlinkSync(stagingBackupsDir); } catch {}
  });

  http_test('deploy backs up a pre-existing root file before relocating a custom component over it', async () => {
    await http_('POST', '/api/shared/components/agents', { name: 'DeploySafety', content: '# new content' });
    const proj = `dsafe-${uid()}`;
    const deployPath = path.join(tmpRoot, `dsafe-target-${uid()}`);
    await http_('POST', '/api/projects', { name: proj, description: '', deployPath });
    // Apply BEFORE the user adds a real file at the deploy target — this
    // simulates a deferred deploy where the user hand-edited between steps.
    const apply = await http_('POST', '/api/shared/components/agents/deploysafety/apply', {
      project: proj,
      targetFolder: '.cursor/agents',
      fileName: 'deploy-safety.md',
    });
    assert.strictEqual(apply.body.ok, true);
    // Now seed a conflicting real file at the deploy path (simulating the
    // user editing it directly after apply but before deploy).
    fs.mkdirSync(path.join(deployPath, '.cursor', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(deployPath, '.cursor', 'agents', 'deploy-safety.md'), '# user-hand-edited', 'utf8');
    const dep = await http_('POST', '/api/deploy', { project: proj });
    assert.strictEqual(dep.body.ok, true);
    // Final file is the new content (overwrite happened, as designed) ...
    const finalFile = fs.readFileSync(path.join(deployPath, '.cursor', 'agents', 'deploy-safety.md'), 'utf8');
    assert.strictEqual(finalFile, '# new content');
    // ... AND the user's hand-edit was backed up before being overwritten.
    const stagingBackups = fs.readdirSync(path.join(projectDir(proj), '.backups'));
    const matchedBackup = stagingBackups.find(name => {
      const content = fs.readFileSync(path.join(projectDir(proj), '.backups', name), 'utf8');
      return content === '# user-hand-edited';
    });
    assert.ok(matchedBackup, 'deploy must snapshot the pre-existing file before overwriting');
  });

  http_test('deploy relocates custom project-root components to <deployPath>/<rel>', async () => {
    await http_('POST', '/api/shared/components/agents', { name: 'CursorDeploy', content: '# da' });
    const proj = `dr-${uid()}`;
    const deployTarget = path.join(tmpRoot, `dr-target-${uid()}`);
    await http_('POST', '/api/projects', { name: proj, description: '', deployPath: deployTarget });
    const apply = await http_('POST', '/api/shared/components/agents/cursordeploy/apply', {
      project: proj,
      targetFolder: '.cursor/agents',
      fileName: 'cursor-deploy.md',
    });
    assert.strictEqual(apply.body.ok, true);
    assert.strictEqual(apply.body.deployRoot, 'project');
    const dep = await http_('POST', '/api/deploy', { project: proj });
    assert.strictEqual(dep.body.ok, true);
    const atRoot       = path.join(deployTarget, '.cursor', 'agents', 'cursor-deploy.md');
    const insideClaude = path.join(deployTarget, '.claude', '.cursor', 'agents', 'cursor-deploy.md');
    assert.ok(fs.existsSync(atRoot),       'project-root deploy target must live at <deployPath>/.cursor/...');
    assert.ok(!fs.existsSync(insideClaude),'project-root deploy target must NOT remain under .claude/');
  });
});

// ─── Run ──────────────────────────────────────────────────────────────────────

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
