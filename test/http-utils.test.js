'use strict';
const assert  = require('assert');
const fs      = require('fs');
const http    = require('http');
const path    = require('path');
const os      = require('os');
const { EventEmitter } = require('events');

// Set env overrides BEFORE requiring server so constants are baked in correctly.
const tmpRoot     = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-httputils-test-'));
const tmpProjects = path.join(tmpRoot, 'projects');
const tmpState    = path.join(tmpRoot, 'state.json');
const tmpCatalog  = path.join(tmpRoot, 'catalog.json');

process.env.ECC_PROJECTS_DIR = tmpProjects;
process.env.ECC_STATE_FILE   = tmpState;
process.env.ECC_CATALOG_FILE = tmpCatalog;

const { parseBody, nodeFetch } = require('../server');

// ─── Async mini test runner ───────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function suite(name, fn) {
  console.log(`\n${name}`);
  fn();
}

async function runAll() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.stack || err.message}`);
      failed++;
    }
  }
  console.log(`\n${'─'.repeat(50)}`);
  const total = passed + failed;
  console.log(`${total} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Simulate an HTTP request readable stream using EventEmitter.
 * Emits chunks synchronously then fires 'end'.
 */
function makeReq(chunks = [], { destroyable = true } = {}) {
  const req = new EventEmitter();
  req.destroy = () => { req.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })); };
  process.nextTick(() => {
    for (const chunk of chunks) req.emit('data', chunk);
    req.emit('end');
  });
  return req;
}

/**
 * Make a request that fires data events exceeding MAX_BODY (1 MB).
 */
function makeOversizedReq() {
  const req = new EventEmitter();
  req.destroy = () => {
    req.emit('error', Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' }));
  };
  // Emit a single chunk larger than 1 MB
  process.nextTick(() => {
    req.emit('data', 'x'.repeat(1 * 1024 * 1024 + 1));
  });
  return req;
}

// ─── parseBody ────────────────────────────────────────────────────────────────

suite('parseBody', () => {
  test('parses a valid JSON body', async () => {
    const payload = JSON.stringify({ hello: 'world', num: 42 });
    const req = makeReq([payload]);
    const result = await parseBody(req);
    assert.strictEqual(result.hello, 'world');
    assert.strictEqual(result.num, 42);
  });

  test('returns {} for an empty body', async () => {
    const req = makeReq([]);
    const result = await parseBody(req);
    assert.deepStrictEqual(result, {});
  });

  test('returns {} for invalid JSON', async () => {
    const req = makeReq(['{ not valid json ]]']);
    const result = await parseBody(req);
    assert.deepStrictEqual(result, {});
  });

  test('handles body split across multiple chunks', async () => {
    const payload = JSON.stringify({ a: 1, b: 2 });
    const half = Math.floor(payload.length / 2);
    const req = makeReq([payload.slice(0, half), payload.slice(half)]);
    const result = await parseBody(req);
    assert.strictEqual(result.a, 1);
    assert.strictEqual(result.b, 2);
  });

  test('rejects with BODY_TOO_LARGE when body exceeds 1 MB', async () => {
    const req = makeOversizedReq();
    let threw = false;
    try {
      await parseBody(req);
    } catch (err) {
      threw = true;
      assert.strictEqual(err.code, 'BODY_TOO_LARGE');
    }
    assert.ok(threw, 'expected parseBody to reject for oversized body');
  });

  test('rejects when request emits an error event', async () => {
    const req = new EventEmitter();
    req.destroy = () => {};
    process.nextTick(() => req.emit('error', new Error('network failure')));
    let threw = false;
    try {
      await parseBody(req);
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('network failure'));
    }
    assert.ok(threw, 'expected parseBody to reject on req error');
  });
});

// ─── nodeFetch ────────────────────────────────────────────────────────────────

suite('nodeFetch', () => {
  let server;
  let baseUrl;

  async function withServer(handler) {
    return new Promise((resolve, reject) => {
      const s = http.createServer(handler);
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address();
        resolve({ server: s, url: `http://127.0.0.1:${port}` });
      });
      s.on('error', reject);
    });
  }

  test('resolves with status and body for a 200 response', async () => {
    const { server: s, url } = await withServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      const result = await nodeFetch(url);
      assert.strictEqual(result.status, 200);
      assert.strictEqual(JSON.parse(result.body).ok, true);
    } finally {
      s.close();
    }
  });

  test('resolves with non-200 status without throwing', async () => {
    const { server: s, url } = await withServer((req, res) => {
      res.writeHead(404);
      res.end('Not Found');
    });
    try {
      const result = await nodeFetch(url);
      assert.strictEqual(result.status, 404);
    } finally {
      s.close();
    }
  });

  test('sends POST body and method correctly', async () => {
    let received = '';
    const { server: s, url } = await withServer((req, res) => {
      req.on('data', d => { received += d; });
      req.on('end', () => {
        res.writeHead(200);
        res.end(req.method);
      });
    });
    try {
      const payload = JSON.stringify({ msg: 'hello' });
      const result = await nodeFetch(url, { method: 'POST', body: payload });
      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.body, 'POST');
      assert.strictEqual(received, payload);
    } finally {
      s.close();
    }
  });

  test('rejects with timeout error when server does not respond', async () => {
    const { server: s, url } = await withServer(() => { /* never respond */ });
    let threw = false;
    try {
      await nodeFetch(url, { timeout: 50 });
    } catch (err) {
      threw = true;
      assert.ok(err.message === 'timeout' || err.code === 'ECONNRESET', `unexpected error: ${err.message}`);
    } finally {
      s.close();
    }
    assert.ok(threw, 'expected nodeFetch to reject on timeout');
  });

  test('rejects with connection error for an unreachable host', async () => {
    let threw = false;
    try {
      await nodeFetch('http://127.0.0.1:1');
    } catch (err) {
      threw = true;
      assert.ok(err.code === 'ECONNREFUSED' || err.message, `unexpected error: ${err.message}`);
    }
    assert.ok(threw, 'expected nodeFetch to reject for unreachable host');
  });
});

// ─── Run ──────────────────────────────────────────────────────────────────────

process.on('exit', () => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

runAll().catch(err => {
  console.error('Unexpected runner error:', err);
  process.exit(1);
});
