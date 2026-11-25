'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { ANCHOR, FIX, applyBackport, isApplied } = require('./patch-wwebjs-auth-ready');

function fixture(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-auth-ready-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'));
  const file = path.join(dir, 'src', 'Client.js');
  fs.writeFileSync(file, content);
  return { dir, file };
}

test('patch applies once, preserves CRLF and refuses ambiguous or unknown sources without writing', t => {
  const { dir, file } = fixture(t, `async function inject() {\n${ANCHOR}\n}`.replace(/\n/g, '\r\n'));
  assert.equal(isApplied(dir), false);
  assert.equal(applyBackport(dir).skipped, false);
  assert.equal(isApplied(dir), true);
  const patched = fs.readFileSync(file, 'utf8');
  assert.ok(patched.includes(FIX.replace(/\n/g, '\r\n')));
  assert.equal(applyBackport(dir).skipped, true);
  assert.equal(fs.readFileSync(file, 'utf8'), patched);
  for (const source of ['class Client {}', `${ANCHOR}\n${ANCHOR}`, `${ANCHOR}\n${FIX}`]) {
    fs.writeFileSync(file, source);
    assert.equal(isApplied(dir), false);
    assert.throws(() => applyBackport(dir), /unsupported Client.js shape/);
    assert.equal(fs.readFileSync(file, 'utf8'), source);
  }
});

async function simulate(states, options = {}) {
  const context = vm.createContext({ window: {}, ExposeAuthStore() {} });
  const observed = [];
  let exposed = false;
  let disposed = false;
  const client = {
    options: { authTimeoutMs: 45000 },
    pupPage: {
      async waitForFunction(predicate, settings) {
        assert.equal(settings.timeout, 45000);
        assert.equal(settings.polling, 200);
        for (const state of states) {
          assert.equal(exposed, false, 'AuthStore must not access Socket before readiness');
          context.window.require = state === undefined ? undefined : () => {
            if (state === 'LOADER_ERROR') throw new Error('module not registered');
            return state === null ? null : state === 'NO_SOCKET' ? {} : { Socket: { state } };
          };
          const value = predicate();
          observed.push(value);
          if (value) return {
            async jsonValue() {
              if (options.valueError) throw options.valueError;
              return value;
            },
            async dispose() { disposed = true; },
          };
        }
        const error = options.error || Object.assign(new Error('waiting'), { name: 'TimeoutError' });
        throw error;
      },
      async evaluate(fn) {
        assert.equal(fn, context.ExposeAuthStore);
        assert.equal(disposed, true);
        exposed = true;
      },
    },
  };
  const execute = vm.runInContext(`(async function () { ${FIX}\nreturn needAuthentication; })`, context);
  try {
    return { needsAuth: await execute.call(client), observed, exposed, disposed };
  } catch (error) {
    error.disposed = disposed;
    error.exposed = exposed;
    throw error;
  }
}

for (const state of ['UNPAIRED', 'UNPAIRED_IDLE', 'CONNECTED']) {
  test(`waits through missing modules and transitional states before ${state}`, async () => {
    const result = await simulate([undefined, null, 'NO_SOCKET', 'LOADER_ERROR', 'OPENING', 'UNLAUNCHED', 'PAIRING', state]);
    assert.equal(result.needsAuth, state !== 'CONNECTED');
    assert.deepEqual(result.observed.slice(0, -1), [false, false, false, false, false, false, false]);
    assert.equal(result.exposed, true);
    assert.equal(result.disposed, true);
  });
}

test('missing socket times out with a diagnostic instead of a null dereference or an unbounded listener', async () => {
  await assert.rejects(simulate([null, 'OPENING']), error => {
    assert.match(error.message, /socket initialization timed out/);
    assert.equal(error.exposed, false);
    return true;
  });
});

test('page-close failures propagate and a handle is released even if its value cannot be read', async () => {
  const error = new Error('Target closed');
  await assert.rejects(simulate([null], { error }), result => result === error);
  await assert.rejects(simulate(['CONNECTED'], { valueError: error }), result => {
    assert.equal(result, error);
    assert.equal(result.disposed, true);
    assert.equal(result.exposed, false);
    return true;
  });
});

test('CLI refuses drift in a Docker build; best-effort local installs warn', t => {
  const { dir } = fixture(t, 'class Client {}');
  const scripts = path.join(dir, 'scripts');
  const dependency = path.join(dir, 'node_modules', 'whatsapp-web.js', 'src');
  fs.mkdirSync(scripts);
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(path.join(dependency, 'Client.js'), 'class Client {}');
  const script = path.join(scripts, 'patch-wwebjs-auth-ready.js');
  fs.copyFileSync(path.join(__dirname, 'patch-wwebjs-auth-ready.js'), script);
  const strict = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /unsupported Client.js shape/);
  const relaxed = spawnSync(process.execPath, [script, '--best-effort'], { encoding: 'utf8' });
  assert.equal(relaxed.status, 0);
  assert.match(relaxed.stderr, /skipped/);
});
