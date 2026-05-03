# Architecture Notes

A small living document for invariants that aren't visible from the code alone.
Skim before adding concurrency, parallelism, or new top-level state.

---

## Process model

ECC Manager is a single-process Node.js HTTP server. **All shared mutable state
lives in the main thread.** This is load-bearing across the codebase. If you
introduce `worker_threads`, `child_process`, or any second runtime that touches
the state files or the in-process caches, you will silently break invariants.

Concretely, do not parallelize or background:

- `_stateCache` (server.js) — single composed in-memory state
- `_shardCacheByName` — projectName → last-written shard
- `_shardWriteQueue` — per-project write serializer
- `_lmCatalogHashCache` — memoized catalog hash per ECC version
- `_catalogCache` — memoized component catalog per ECC version
- `state-store.js` private state (none today, but assume it grows)

`spawnSync('git', …)` for ECC pulls is fine — it doesn't touch state files.
A future "parallel pull" feature would need to coordinate writes to
`state.versions` through the main thread, not from workers.

## State storage layout

```
state/
  state.json                          # global index — schemaVersion 2
  <eccVersion>-<projectName>.json     # one shard per project per ECC version
  backups/                            # corruption + legacy snapshots
  shared/                             # global, NOT tied to project or version
    CLAUDE.md/<id>/                   # one dir per Custom CLAUDE.md template
      meta.json                       #   { id, name, description, createdAt, updatedAt }
      content.md                      #   the markdown body
    AGENTS.md/<id>/                   # same shape — Custom AGENTS.md templates
    other/<id>/                       # same shape — "Other md files" library
    custom-components/<kind>/<slug>/  # rules / hooks / mcp / agents / skills / commands
      component.json
      content.md  (markdown kinds)
      content.json (hooks, mcp)
```

**Identity rules differ between shared docs and custom components:**

- Shared docs (`CLAUDE.md` / `AGENTS.md` / `other`) are keyed by an opaque
  8-hex `<id>`. Names don't have to be unique — two `design.md` entries
  with different descriptions can coexist. Renames are pure metadata edits;
  the on-disk dir name is stable across renames so external references
  (e.g. URL bookmarks of `/api/shared/docs/<docKey>/<id>`) keep working.
- Custom components are keyed by `<slug>` because each slug maps to a
  single apply-target path inside the project's `.claude/` (e.g.
  `rules/custom/<slug>.md`). Two custom rules with the same slug would
  collide on apply, so the slug is forced unique.

Index holds list / search / navigation metadata only. Shards hold install
state, settings, managed-doc metadata (`managedDocs.{claude,agents}`),
applied custom-component metadata (`customComponents`), and LM Studio
analysis cache. The legacy `claudeMd` slot is mirrored on every CLAUDE.md
write so older shards keep working.

`state/shared/` is global. Projects do not own anything inside it. Applying
a custom component to a project writes a copy into the project's `.claude/`
directory and records `proj.customComponents[id]` in the project shard;
deleting the shared component does not remove the project copy.

**Two on-disk migrations run lazily on first access:**

1. `migrateLegacySharedDocs(docKey)` — pre-id `state/shared/<docKey>/<slug>.md`
   flat files get rewritten as `<id>/{meta.json, content.md}`. The slug
   becomes the new `name`, description starts empty.
2. `migrateLegacySkillTemplates()` — files under the legacy
   `state/shared/SKILL.md/` library (which no longer has a sidebar entry)
   migrate to `custom-components/skills/<slug>/`. Triggered on first read of
   any `skills` custom-component listing.

Both migrations are idempotent and short-circuit when there's nothing on
disk to convert. Keep them in place even after they look "done" — fresh
clones of older state directories on a teammate's machine still need them.

## Managed agent docs

Two top-level managed docs live in each project's `.claude/`:

```
projects/<name>/.claude/CLAUDE.md
projects/<name>/.claude/AGENTS.md
```

Each is exposed at `/api/projects/:name/docs/:docKey` (`docKey` ∈
`{claude, agents}`). Backups land at `.claude/.backups/<FILE>.<timestamp>.bak`
and are NEVER deployed.

Backup retention is intentionally manual: we do not auto-prune. If usage
patterns make the directory grow noticeably, add a user-initiated cleanup
endpoint rather than reintroducing automatic deletion.

There is intentionally no top-level `SKILLS.md` managed doc and no
`/api/shared/docs/skill` endpoint. Skills are per-skill artifacts at
`.claude/skills/<name>/SKILL.md`; reusable per-skill templates live as
`skills` custom components (`state/shared/custom-components/skills/<slug>/`)
which apply to `skills/<slug>/SKILL.md` inside the project. The
`migrateLegacySkillTemplates()` migration above handles any leftover
`state/shared/SKILL.md/<file>.md` from earlier versions.

### Write ordering invariant

`saveState` writes shards FIRST, then the index, then deletes orphan shards.
The index is the **single commit point**. A crash between phases leaves
orphan shards but never references-without-shards.

If you change this, document it — it's not a free reordering.

### Atomic writes

All shard / index writes go through `atomicWriteJson`: write to a temp file,
fsync-ish (we rely on Node's default), then `rename`. POSIX `rename` is
atomic; on Windows, behavior is documented but less battle-tested. If we
ever ship Windows support, add a Windows-specific test for crash recovery.

### Corruption isolation

`readJsonOrBackup` quarantines a corrupt file into `state/backups/` with a
labeled timestamp, then resets only that file. A corrupt single shard never
takes down the whole app. Don't change this behavior without a similar
fallback path.

## Concurrency

`saveProjectShard(projName)` is per-project serialized via
`_enqueueShardWrite`. Two callers writing the same project are guaranteed
sequential disk writes; two callers writing different projects can run in
parallel.

Node's HTTP server processes handlers in the main event loop, so request-scoped
mutations of `_stateCache` are race-free *between requests*. Do not assume
this if you ever introduce `await`-after-mutation patterns where another
handler could observe partial state — explicit locking would be needed.

## Schema versioning

`state-store.js` exposes:

```js
INDEX_SCHEMA_VERSION
SHARD_SCHEMA_VERSION
_registerIndexMigration({ from, to, migrate })
_registerShardMigration({ from, to, migrate })
```

Migrations run automatically inside `loadShardRaw` (one-shot, idempotent,
forward-only). To bump a schema:

1. Implement the migration as a pure function `(doc) → doc'`.
2. Register it with `_registerShardMigration({ from: N, to: N+1, migrate })`.
3. Bump `SHARD_SCHEMA_VERSION` to N+1.
4. Add a test that runs your migration over a fixture and asserts the result.

Never mutate input docs in a migration — return a new shape.

## LM Studio cache identity

Cache freshness is determined by:

```
descriptionHash(scoring) === descriptionHash(current)
   AND
catalogHash(scoring) === catalogHash(current)
```

`descriptionHash` is set ONLY at run-start (POST `…/analysis-description` with
`startRun: true`). Editing the description does NOT update it — the mismatch
is what marks the cache "stale" without destroying data. Re-analyze is the
only path that wipes cache.

`catalogHash` is the SHA-256 of the sorted identity list of every analyzed
candidate (type, name, relPath, content hash). Memoized per ECC version;
invalidated on `pull-version` and `delete-version`.

## Observability

- `log(level, msg, ctx?)` — human-readable by default; emit
  `ECC_LOG_FORMAT=json` env var for one-line JSON logs.
- `diag(event)` — increment a local counter. Surface via `/api/diagnostics`.
- `/api/migration-status` — one-shot signal for a UI banner after legacy migration.

Counters are in-memory only (no persistence, no network egress). They reset
on server restart. This is intentional — we don't want a hidden log file.

## Test layout

- `test/<area>.test.js` — unit tests against helper functions, no HTTP.
- Each file is a standalone Node script; run via `npm test`.
- Tests share env-var conventions: `ECC_STATE_DIR` (preferred) or
  `ECC_STATE_FILE` (legacy compat).
- The home-grown runner in each file uses an async queue + counters. If we
  ever reach > 12 test files, migrate to `node --test` (Node 20+).

Integration tests live in `test/integration-*.test.js` and boot a real HTTP
server on a non-default port. They are the only tests that exercise the
route layer.
