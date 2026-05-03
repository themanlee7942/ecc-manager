'use strict';
/**
 * ECC Manager state store — sharded persistence
 *
 * Layout:
 *   state/state.json                       — small global index
 *   state/<verId>-<projectName>.json       — per-project per-version shard
 *   state/backups/                         — corruption + legacy backups
 *
 * Public surface intentionally narrow; server.js holds all HTTP/route logic.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const INDEX_SCHEMA_VERSION = 2;
const SHARD_SCHEMA_VERSION = 1;

// ─── Schema migrations ───────────────────────────────────────────────────────
//
// Migrations are pure functions that take an index/shard at version N and
// return one at version N+1. They compose, are idempotent, and are tested.
// To add one: append { fromVersion, toVersion, kind, migrate } and bump the
// corresponding *_SCHEMA_VERSION constant.

const _indexMigrations = []; // [{ from, to, migrate(doc) }]
const _shardMigrations = []; // [{ from, to, migrate(doc) }]

function _runMigrations(doc, kind, target) {
  const list = kind === 'index' ? _indexMigrations : _shardMigrations;
  let working = doc;
  let cur = (working && typeof working.schemaVersion === 'number') ? working.schemaVersion : 1;
  while (cur < target) {
    const step = list.find(m => m.from === cur);
    if (!step) break; // gap in chain — stop, leave at current version
    working = step.migrate(working);
    cur = step.to;
    working.schemaVersion = cur;
  }
  return working;
}

function migrateIndex(doc)  { return _runMigrations(doc, 'index',  INDEX_SCHEMA_VERSION); }
function migrateShard(doc)  { return _runMigrations(doc, 'shard',  SHARD_SCHEMA_VERSION); }
function _registerIndexMigration(step) { _indexMigrations.push(step); }
function _registerShardMigration(step) { _shardMigrations.push(step); }

// ─── Path helpers ─────────────────────────────────────────────────────────────

function rootDir() {
  return process.env.ECC_PROJECT_ROOT || path.dirname(__filename);
}

function stateDir() {
  if (process.env.ECC_STATE_DIR) return process.env.ECC_STATE_DIR;
  if (process.env.ECC_STATE_FILE) return path.dirname(process.env.ECC_STATE_FILE);
  return path.join(rootDir(), 'state');
}

function indexStatePath() {
  if (process.env.ECC_STATE_FILE && !process.env.ECC_STATE_DIR) {
    // Test override: keep the exact filename so existing tests continue to point at it.
    return process.env.ECC_STATE_FILE;
  }
  return path.join(stateDir(), 'state.json');
}

function backupsDir() {
  return path.join(stateDir(), 'backups');
}

function legacyStatePath() {
  // The old single-file location.
  if (process.env.ECC_STATE_FILE) return process.env.ECC_STATE_FILE;
  // If the caller explicitly redirected the state dir without specifying a
  // legacy file, do NOT fall back to the project root — tests would otherwise
  // accidentally migrate the developer's real state.json into their tmp dir.
  if (process.env.ECC_STATE_DIR) return null;
  return path.join(rootDir(), 'state.json');
}

// ─── Sanitization ─────────────────────────────────────────────────────────────

function safeStateFilePart(value) {
  return String(value == null ? '' : value)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function projectStateFileName(eccVersion, projectName) {
  const v = safeStateFilePart(eccVersion || 'unversioned') || 'unversioned';
  const n = safeStateFilePart(projectName) || 'project';
  return `${v}-${n}.json`;
}

function projectStatePath(eccVersion, projectName) {
  return path.join(stateDir(), projectStateFileName(eccVersion, projectName));
}

// ─── Filesystem primitives ────────────────────────────────────────────────────

function ensureDirSync(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function atomicWriteJson(file, data) {
  ensureDirSync(path.dirname(file));
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function tsStamp() {
  return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
}

function backupCorruptFile(file, label) {
  ensureDirSync(backupsDir());
  const base = path.basename(file);
  const dest = path.join(backupsDir(), `${base}.${label || 'corrupt'}.${tsStamp()}.bak`);
  try { fs.copyFileSync(file, dest); } catch {}
  pruneBackups();
  return dest;
}

// Keep at most MAX_STATE_BACKUPS files in state/backups/, oldest first.
const MAX_STATE_BACKUPS = 50;
function pruneBackups() {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return;
  let entries;
  try {
    entries = fs.readdirSync(dir).map(name => {
      const full = path.join(dir, name);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch {}
      return { name, full, mtime };
    });
  } catch { return; }
  if (entries.length <= MAX_STATE_BACKUPS) return;
  entries.sort((a, b) => a.mtime - b.mtime);
  const toRemove = entries.slice(0, entries.length - MAX_STATE_BACKUPS);
  for (const e of toRemove) {
    try { fs.unlinkSync(e.full); } catch {}
  }
}

function readJsonOrBackup(file) {
  if (!fs.existsSync(file)) return { ok: true, data: null };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { ok: false, error: e.message, data: null };
  }
  try { return { ok: true, data: JSON.parse(raw) }; } catch (e) {
    const backup = backupCorruptFile(file);
    return { ok: false, error: e.message, data: null, backup };
  }
}

// ─── Hash + normalize helpers (for analysis cache identity) ───────────────────

function normalizeAnalysisDesc(desc) {
  if (typeof desc !== 'string') return '';
  return desc.replace(/\r\n/g, '\n').trim();
}

function hashAnalysisDesc(desc) {
  const h = crypto.createHash('sha256');
  h.update(normalizeAnalysisDesc(desc));
  return 'sha256:' + h.digest('hex');
}

function hashCatalogForVersion(verId, candidates) {
  // Hash the sorted identity list of candidate files. Identity = type+name+relPath+contentHash.
  // Caller passes already-collected candidate list (matches /api/lmstudio/files output shape).
  const parts = (candidates || [])
    .map(c => {
      const ch = crypto.createHash('sha256');
      ch.update(String(c.content || ''));
      const contentHash = ch.digest('hex');
      return `${verId}|${c.type}|${c.name}|${c.relPath}|${contentHash}`;
    })
    .sort();
  const h = crypto.createHash('sha256');
  parts.forEach(p => h.update(p + '\n'));
  return 'sha256:' + h.digest('hex');
}

// ─── Index load / save ────────────────────────────────────────────────────────

function emptyIndex() {
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    activeVersion: null,
    versions: {},
    projects: {},
  };
}

function loadIndexRaw() {
  const file = indexStatePath();
  const r = readJsonOrBackup(file);
  if (!r.ok) {
    // Corrupted index — reset only the index, preserve shards on disk.
    const fresh = emptyIndex();
    atomicWriteJson(file, fresh);
    return { index: fresh, corrupted: true, backup: r.backup || null };
  }
  if (r.data == null) return { index: null, corrupted: false };
  return { index: r.data, corrupted: false };
}

function saveIndexRaw(index) {
  atomicWriteJson(indexStatePath(), index);
}

// ─── Shard load / save ────────────────────────────────────────────────────────

function emptyShard(projectName, eccVersion) {
  return {
    schemaVersion: SHARD_SCHEMA_VERSION,
    project: {
      name: projectName,
      description: '',
      deployPath: '',
      createdAt: new Date().toISOString(),
      eccVersion: eccVersion || null,
      pathLocked: false,
    },
    analysis: {
      description: '',
      descriptionHash: null,
      eccVersion: eccVersion || null,
      catalogHash: null,
      thresholdAtRun: null,
      status: 'not_run',
      totalItems: 0,
      completedItems: 0,
      failedItems: 0,
      startedAt: null,
      updatedAt: null,
      completedAt: null,
      lmStudio: null,
    },
    components: {},
  };
}

function loadShardRaw(projectName, eccVersion, expectedFileName) {
  const fileName = expectedFileName || projectStateFileName(eccVersion, projectName);
  const file = path.join(stateDir(), fileName);
  const r = readJsonOrBackup(file);
  if (!r.ok) {
    // Corrupted shard — reset just this shard, keep going.
    const fresh = emptyShard(projectName, eccVersion);
    atomicWriteJson(file, fresh);
    return { shard: fresh, file, corrupted: true, backup: r.backup || null };
  }
  if (r.data == null) return { shard: null, file, corrupted: false };
  // Run schema migrations forward to current target. Idempotent if already current.
  const migrated = migrateShard(r.data);
  if (migrated !== r.data) atomicWriteJson(file, migrated);
  return { shard: migrated, file, corrupted: false };
}

function saveShardRaw(shard, projectName, eccVersion, expectedFileName) {
  const fileName = expectedFileName || projectStateFileName(eccVersion || shard?.project?.eccVersion, projectName || shard?.project?.name);
  const file = path.join(stateDir(), fileName);
  atomicWriteJson(file, shard);
  return file;
}

function deleteShardFile(fileName) {
  const file = path.join(stateDir(), fileName);
  if (fs.existsSync(file)) {
    try { fs.unlinkSync(file); return true; } catch { return false; }
  }
  return false;
}

// ─── Compose / decompose ─────────────────────────────────────────────────────
//
// In-memory project shape (legacy, what server.js routes still use):
//   {
//     name, description, deployPath, createdAt, eccVersion, pathLocked,
//     analysisDesc?, claudeMd?,
//     components: { [id]: { installed, installedAt, value?, matchingPerc?,
//                           reasoning?, analysisHash?, catalogHash?,
//                           lmFilePath?, lmFileType?, analyzedAt?, analysisStatus? } },
//     _analysis?: { ...shard.analysis },   // exposed for new endpoints
//     _stateFile?: string,                  // shard filename for save-back
//   }
//
// `_analysis` and `_stateFile` are private hints; they are not serialized back
// to the legacy state.json shape, but they let routes round-trip through
// saveState() without re-deriving everything.

function composeProject(shard, indexEntry) {
  if (!shard) return null;
  const proj = {
    name: shard.project.name,
    description: shard.project.description || '',
    deployPath: shard.project.deployPath || '',
    createdAt: shard.project.createdAt || null,
    eccVersion: shard.project.eccVersion || (indexEntry && indexEntry.eccVersion) || null,
    pathLocked: !!shard.project.pathLocked,
    analysisDesc: (shard.analysis && shard.analysis.description) || '',
    components: shard.components || {},
  };
  if (shard.project.claudeMd) proj.claudeMd = shard.project.claudeMd;
  if (shard.project.managedDocs) proj.managedDocs = shard.project.managedDocs;
  if (shard.project.customComponents) proj.customComponents = shard.project.customComponents;
  proj._analysis = { ...(shard.analysis || {}) };
  proj._stateFile = (indexEntry && indexEntry.stateFile) || projectStateFileName(proj.eccVersion, proj.name);
  return proj;
}

function decomposeProject(proj, opts = {}) {
  const verId = proj.eccVersion || opts.fallbackVersion || null;
  const existing = opts.existingShard || null;
  const baseAnalysis = proj._analysis || (existing && existing.analysis) || emptyShard(proj.name, verId).analysis;
  const shard = {
    schemaVersion: SHARD_SCHEMA_VERSION,
    project: {
      name: proj.name,
      description: proj.description || '',
      deployPath: proj.deployPath || '',
      createdAt: proj.createdAt || (existing && existing.project && existing.project.createdAt) || new Date().toISOString(),
      eccVersion: verId,
      pathLocked: !!proj.pathLocked,
      ...(proj.claudeMd ? { claudeMd: proj.claudeMd } : {}),
      ...(proj.managedDocs ? { managedDocs: proj.managedDocs } : {}),
      ...(proj.customComponents ? { customComponents: proj.customComponents } : {}),
    },
    analysis: {
      ...baseAnalysis,
      description: proj.analysisDesc || '',
      eccVersion: verId,
    },
    components: proj.components || {},
  };
  return shard;
}

// ─── Legacy detection + migration ────────────────────────────────────────────

function looksLegacyIndex(obj) {
  if (!obj || typeof obj !== 'object') return false;
  // Legacy state had projects[name].components inline.
  const projects = obj.projects;
  if (!projects || typeof projects !== 'object') return false;
  return Object.values(projects).some(p => p && typeof p === 'object' && Object.prototype.hasOwnProperty.call(p, 'components'));
}

function buildIndexFromLegacy(legacy) {
  const index = emptyIndex();
  index.activeVersion = legacy.activeVersion || null;
  index.versions      = legacy.versions || {};
  if (legacy.lmStudio) index.lmStudio = legacy.lmStudio;
  for (const [name, proj] of Object.entries(legacy.projects || {})) {
    const verId = proj.eccVersion || index.activeVersion || null;
    index.projects[name] = {
      name,
      eccVersion: verId,
      stateFile: projectStateFileName(verId, name),
      createdAt: proj.createdAt || null,
      deployPath: proj.deployPath || '',
    };
  }
  return index;
}

function legacyProjectToShard(name, legacyProj, fallbackVerId) {
  const verId = legacyProj.eccVersion || fallbackVerId || null;
  return {
    schemaVersion: SHARD_SCHEMA_VERSION,
    project: {
      name,
      description: legacyProj.description || '',
      deployPath: legacyProj.deployPath || '',
      createdAt: legacyProj.createdAt || new Date().toISOString(),
      eccVersion: verId,
      pathLocked: !!legacyProj.pathLocked,
      ...(legacyProj.claudeMd ? { claudeMd: legacyProj.claudeMd } : {}),
      ...(legacyProj.managedDocs ? { managedDocs: legacyProj.managedDocs } : {}),
      ...(legacyProj.customComponents ? { customComponents: legacyProj.customComponents } : {}),
    },
    analysis: {
      description: legacyProj.analysisDesc || '',
      descriptionHash: null,
      eccVersion: verId,
      catalogHash: null,
      thresholdAtRun: null,
      status: 'not_run',
      totalItems: 0,
      completedItems: 0,
      failedItems: 0,
      startedAt: null,
      updatedAt: null,
      completedAt: null,
      lmStudio: null,
    },
    components: normalizeLegacyComponents(legacyProj.components || {}),
  };
}

function normalizeLegacyComponents(components) {
  const out = {};
  for (const [id, entry] of Object.entries(components)) {
    if (!entry || typeof entry !== 'object') { out[id] = entry; continue; }
    const fixed = { ...entry };
    // Migrate accidental typo from older versions: `reasoniing` → `reasoning`.
    if (fixed.reasoniing != null && fixed.reasoning == null) {
      fixed.reasoning = fixed.reasoniing;
      delete fixed.reasoniing;
    }
    out[id] = fixed;
  }
  return out;
}

function migrateLegacyToShards(legacy, opts = {}) {
  const { writeBackup = true, source = null } = opts;
  ensureDirSync(stateDir());
  ensureDirSync(backupsDir());
  let backupPath = null;
  if (writeBackup && source && fs.existsSync(source)) {
    const dest = path.join(backupsDir(), `legacy-state.json.bak.${tsStamp()}`);
    try { fs.copyFileSync(source, dest); backupPath = dest; } catch {}
  }
  const index = buildIndexFromLegacy(legacy);
  // Phase 1: write all shards before we touch the index. If any shard write
  // throws, abort before committing the new index — the legacy data on disk
  // is still authoritative and our backup at backupPath remains intact.
  const shardsWritten = [];
  try {
    for (const [name, proj] of Object.entries(legacy.projects || {})) {
      const fallback = index.projects[name] && index.projects[name].eccVersion;
      const shard = legacyProjectToShard(name, proj, fallback);
      const file = saveShardRaw(shard, name, shard.project.eccVersion, index.projects[name].stateFile);
      shardsWritten.push(file);
    }
    saveIndexRaw(index);
  } catch (err) {
    // Best-effort rollback: remove any shards we wrote so the next boot can
    // retry cleanly from the legacy file (which is still on disk).
    for (const f of shardsWritten) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
    throw err;
  }
  return { index, backupPath };
}

// Returns null if no migration ran, otherwise an object describing the
// migration so callers (e.g. the UI) can surface it as a one-time notice.
//   { backupPath: string, migratedAt: string, projectsMigrated: number }
function migrateIfNeeded() {
  const newIndex = indexStatePath();
  // If the new index already exists AND looks new-shape, no migration.
  if (fs.existsSync(newIndex)) {
    const r = readJsonOrBackup(newIndex);
    if (r.ok && r.data && !looksLegacyIndex(r.data)) return null;
    if (r.ok && r.data && looksLegacyIndex(r.data)) {
      const before = r.data;
      const result = migrateLegacyToShards(before, { writeBackup: true, source: newIndex });
      return {
        backupPath: result.backupPath,
        migratedAt: new Date().toISOString(),
        projectsMigrated: Object.keys(before.projects || {}).length,
        source: 'in-place',
      };
    }
    return null;
  }
  // New index doesn't exist. Check legacy location.
  const legacy = legacyStatePath();
  if (!legacy) return null;
  if (legacy === newIndex) return null;
  if (!fs.existsSync(legacy)) return null;
  const r = readJsonOrBackup(legacy);
  if (!r.ok || !r.data) return null;
  const result = migrateLegacyToShards(r.data, { writeBackup: true, source: legacy });
  return {
    backupPath: result.backupPath,
    migratedAt: new Date().toISOString(),
    projectsMigrated: Object.keys(r.data.projects || {}).length,
    source: 'legacy-file',
  };
}

// ─── LM analysis cache helpers ───────────────────────────────────────────────

const LM_RESULT_FIELDS = [
  'matchingPerc',
  'reasoning',
  'analysisHash',
  'catalogHash',
  'lmFilePath',
  'lmFileType',
  'analyzedAt',
  'analysisStatus',
];

function clearLmAnalysisFields(shard) {
  const components = shard.components || {};
  for (const id of Object.keys(components)) {
    const entry = components[id];
    if (!entry || typeof entry !== 'object') continue;
    let touched = false;
    for (const field of LM_RESULT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(entry, field)) {
        delete entry[field];
        touched = true;
      }
    }
    if (touched) components[id] = entry;
  }
  shard.analysis = {
    ...(shard.analysis || {}),
    descriptionHash: null,
    catalogHash: null,
    status: 'not_run',
    totalItems: 0,
    completedItems: 0,
    failedItems: 0,
    startedAt: null,
    updatedAt: null,
    completedAt: null,
  };
  return shard;
}

function applyLmAnalysisResult(shard, result) {
  // result: { componentId, relPath, type, name, matchingPerc, reasoning, status, analysisHash, catalogHash }
  if (!result || !result.componentId) return { ok: false, error: 'missing componentId' };
  shard.components = shard.components || {};
  const existing = shard.components[result.componentId] || {};
  const status = result.status || 'complete';
  const next = {
    ...existing,
    matchingPerc: typeof result.matchingPerc === 'number' ? result.matchingPerc : existing.matchingPerc ?? 0,
    reasoning: typeof result.reasoning === 'string' ? result.reasoning : existing.reasoning || '',
    analysisHash: result.analysisHash || existing.analysisHash || null,
    catalogHash: result.catalogHash || existing.catalogHash || null,
    lmFilePath: result.relPath || existing.lmFilePath || null,
    lmFileType: result.type || existing.lmFileType || null,
    analyzedAt: result.analyzedAt || new Date().toISOString(),
    analysisStatus: status,
  };
  shard.components[result.componentId] = next;
  // Recount progress from components.
  recountAnalysisProgress(shard);
  shard.analysis.updatedAt = new Date().toISOString();
  return { ok: true, component: next };
}

function recountAnalysisProgress(shard) {
  let completed = 0;
  let failed = 0;
  let scored = 0;
  for (const entry of Object.values(shard.components || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.analysisStatus === 'complete') completed++;
    else if (entry.analysisStatus === 'failed') failed++;
    if (entry.analysisStatus) scored++;
  }
  shard.analysis = shard.analysis || {};
  shard.analysis.completedItems = completed;
  shard.analysis.failedItems = failed;
  // totalItems is set authoritatively at run-start. If the recorded total is
  // smaller than the number of components actually scored (e.g. catalog grew
  // mid-run), bump it so progress percentages stay sane.
  if (typeof shard.analysis.totalItems !== 'number' || shard.analysis.totalItems < scored) {
    shard.analysis.totalItems = scored;
  }
}

function isAnalysisCacheFresh(shard, descriptionHash, catalogHash) {
  if (!shard || !shard.analysis) return false;
  if (!descriptionHash || !catalogHash) return false;
  if (shard.analysis.descriptionHash !== descriptionHash) return false;
  // catalogHash mismatch invalidates only if we have a recorded catalogHash that differs.
  if (shard.analysis.catalogHash && shard.analysis.catalogHash !== catalogHash) return false;
  return true;
}

// ─── Module exports ──────────────────────────────────────────────────────────

module.exports = {
  // path helpers
  rootDir,
  stateDir,
  indexStatePath,
  backupsDir,
  legacyStatePath,                      // returns null when ECC_STATE_DIR is set without ECC_STATE_FILE
  projectStatePath,
  projectStateFileName,
  safeStateFilePart,
  // primitives
  ensureDirSync,
  atomicWriteJson,
  readJsonOrBackup,
  backupCorruptFile,
  // hashing
  normalizeAnalysisDesc,
  hashAnalysisDesc,
  hashCatalogForVersion,
  // index/shard
  emptyIndex,
  emptyShard,
  loadIndexRaw,
  saveIndexRaw,
  loadShardRaw,
  saveShardRaw,
  deleteShardFile,
  composeProject,
  decomposeProject,
  // migration
  looksLegacyIndex,
  migrateLegacyToShards,
  migrateIfNeeded,
  legacyProjectToShard,
  buildIndexFromLegacy,
  // lm cache
  LM_RESULT_FIELDS,
  clearLmAnalysisFields,
  applyLmAnalysisResult,
  recountAnalysisProgress,
  isAnalysisCacheFresh,
  // schema migrations
  migrateIndex,
  migrateShard,
  _registerIndexMigration,
  _registerShardMigration,
  // backups
  pruneBackups,
  MAX_STATE_BACKUPS,
  // constants
  INDEX_SCHEMA_VERSION,
  SHARD_SCHEMA_VERSION,
};
