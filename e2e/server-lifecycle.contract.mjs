import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve('@playwright/test/package.json')), 'cli.js')
const playwright = import.meta.resolve('@playwright/test')
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`

async function freePort() {
  const server = createServer()
  await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done))
  const port = server.address().port
  await new Promise((done) => server.close(done))
  return port
}

async function until(check, message) {
  const deadline = Date.now() + 15_000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(message)
    await delay(25)
  }
}

function events(trace) {
  return existsSync(trace)
    ? readFileSync(trace, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
}

async function launch({ mode = 'pass', provided = false, config = 'playwright.config.ts' } = {}) {
  const port = await freePort()
  const scratch = mkdtempSync(join(tmpdir(), 'plein-lifecycle-contract-'))
  const trace = join(scratch, 'events.jsonl')
  const backend = join(scratch, 'server.mjs')
  const descendant = join(scratch, 'grandchild.mjs')
  writeFileSync(
    descendant,
    `import { appendFileSync } from 'node:fs';
const log = (event) => appendFileSync(process.env.E2E_CONTRACT_TRACE, JSON.stringify({ event, pid: process.pid }) + '\\n');
process.on('SIGTERM', () => log('grandchild-term'));
setInterval(() => {}, 1000);
log('grandchild');
process.send('ready');
`,
  )
  writeFileSync(
    backend,
    `import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
const directory = process.env.PLEIN_DATA_DIR;
mkdirSync(directory, { recursive: true });
const log = (event) => appendFileSync(process.env.E2E_CONTRACT_TRACE, JSON.stringify({ event,
  directory, exists: existsSync(directory), pid: process.pid, auth: process.env.PLEIN_AUTH,
  mock: process.env.PLEIN_MOCK_PROVIDER, agent: process.env.PLEIN_AGENT,
  custom: process.env.E2E_CONTRACT_CUSTOM }) + '\\n');
writeFileSync(directory + '/server-open', 'open');
log('started');
if (process.env.E2E_CONTRACT_MODE === 'start-failure') process.exit(7);
const server = createServer((request, response) => { response.writeHead(200); response.end('ok'); });
if (process.env.E2E_CONTRACT_MODE === 'force') {
  const child = spawn(process.execPath, [process.env.E2E_CONTRACT_CHILD], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  child.once('message', () => server.listen(Number(process.env.PLEIN_PORT), '127.0.0.1'));
} else if (process.env.E2E_CONTRACT_MODE !== 'start-timeout') server.listen(Number(process.env.PLEIN_PORT), '127.0.0.1');
else setInterval(() => {}, 1000);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  log('stopping');
  if (process.env.E2E_CONTRACT_MODE === 'force') return;
  server.close(() => {});
  setTimeout(() => { log('stopped'); process.exit(0); }, 100);
});
`,
  )
  const configFile = join(scratch, 'playwright.config.mjs')
  const base = join(root, 'e2e', config)
  writeFileSync(
    configFile,
    `import base from ${JSON.stringify(base)};
import { mkdirSync, writeFileSync } from 'node:fs';
const backend = Array.isArray(base.webServer) ? base.webServer[0] : base.webServer;
console.log('RESERVED=' + backend.env.PLEIN_DATA_DIR);
if (process.env.E2E_CONTRACT_MODE === 'collision') {
  mkdirSync(backend.env.PLEIN_DATA_DIR);
  writeFileSync(backend.env.PLEIN_DATA_DIR + '/not-owned', 'preserve');
}
export default { ...base, testDir: ${JSON.stringify(scratch)}, testMatch: '*.spec.mjs',
  outputDir: ${JSON.stringify(join(scratch, 'results'))}, reporter: 'line', retries: 0,
  webServer: { ...backend, timeout: 2500 } };
`,
  )
  writeFileSync(
    join(scratch, 'lifecycle.spec.mjs'),
    `import { test, expect } from ${JSON.stringify(playwright)};
import { appendFileSync } from 'node:fs';
test('lifecycle', async ({ request }) => {
  expect((await request.get('/api/health')).ok()).toBe(true);
  appendFileSync(process.env.E2E_CONTRACT_TRACE, JSON.stringify({ event: 'test', directory: process.env.PLEIN_E2E_DATA }) + '\\n');
  if (process.env.E2E_CONTRACT_MODE === 'test-failure') expect(false).toBe(true);
  if (process.env.E2E_CONTRACT_MODE === 'hold') await new Promise((done) => setTimeout(done, 30_000));
});
`,
  )
  const env = {
    ...process.env,
    TMPDIR: scratch,
    PLEIN_E2E_SERVER: `${quote(process.execPath)} ${quote(backend)}`,
    PLEIN_E2E_PORT: String(port),
    E2E_CONTRACT_TRACE: trace,
    E2E_CONTRACT_MODE: mode,
    E2E_CONTRACT_CHILD: descendant,
    E2E_CONTRACT_CUSTOM: 'forwarded',
  }
  delete env.PLEIN_E2E_DATA
  delete env.PLEIN_E2E_OWN_DATA
  if (provided) {
    env.PLEIN_E2E_DATA = join(scratch, 'caller-data')
    mkdirSync(env.PLEIN_E2E_DATA)
    writeFileSync(join(env.PLEIN_E2E_DATA, 'caller-marker'), 'preserve')
  }
  const args = [cli, 'test', '-c', configFile]
  if (mode === 'list') args.push('--list')
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const exited = new Promise((done, fail) => {
    child.once('error', fail)
    child.once('close', (code, signal) => done({ code, signal }))
  })
  return {
    child,
    exited,
    trace,
    url: `http://127.0.0.1:${port}/api/health`,
    output: () => output,
    directory: () => /RESERVED=([^\r\n]+)/.exec(output)?.[1],
    async cleanup() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await exited
      const directory = /RESERVED=([^\r\n]+)/.exec(output)?.[1]
      if (!provided && mode !== 'collision' && directory)
        await until(() => !existsSync(directory), `自动目录仍存在：${directory}\n${output}`)
      rmSync(scratch, { recursive: true, force: true })
    },
  }
}

for (const mode of ['pass', 'test-failure', 'start-failure', 'start-timeout']) {
  void test(`${mode}：先停服务再回收自动目录，保留原退出结果`, async () => {
    const run = await launch({ mode })
    try {
      const result = await run.exited
      assert.equal(result.code === 0, mode === 'pass', run.output())
      const entries = events(run.trace)
      const started = entries.find((entry) => entry.event === 'started')
      assert.ok(started, run.output())
      await until(() => !existsSync(started.directory), run.output())
      await assert.rejects(fetch(run.url, { signal: AbortSignal.timeout(1000) }))
      if (mode !== 'start-failure') {
        assert.equal(entries.find((entry) => entry.event === 'stopped')?.exists, true, run.output())
      }
      if (mode === 'pass' || mode === 'test-failure') {
        assert.equal(entries.find((entry) => entry.event === 'test')?.directory, started.directory)
        assert.equal(started.mock, '1')
        assert.equal(started.agent, '0')
        assert.equal(started.custom, 'forwarded')
      }
    } finally {
      await run.cleanup()
    }
  })
}

void test('--list 不启动服务，也不创建预留目录', async () => {
  const run = await launch({ mode: 'list' })
  try {
    assert.equal((await run.exited).code, 0, run.output())
    assert.ok(run.directory(), run.output())
    assert.equal(existsSync(run.directory()), false)
    assert.deepEqual(events(run.trace), [])
  } finally {
    await run.cleanup()
  }
})

void test('显式 PLEIN_E2E_DATA 及 auth env 保留，worker 使用同一路径', async () => {
  const run = await launch({ provided: true, config: 'playwright.auth.config.ts' })
  try {
    assert.equal((await run.exited).code, 0, run.output())
    const entries = events(run.trace)
    const started = entries.find((entry) => entry.event === 'started')
    assert.equal(started.auth, 'password')
    assert.equal(entries.find((entry) => entry.event === 'test')?.directory, started.directory)
    assert.equal(existsSync(started.directory), true)
    assert.equal(readFileSync(join(started.directory, 'caller-marker'), 'utf8'), 'preserve')
    assert.equal(readFileSync(join(started.directory, 'server-open'), 'utf8'), 'open')
    await assert.rejects(fetch(run.url, { signal: AbortSignal.timeout(1000) }))
  } finally {
    await run.cleanup()
  }
})

void test('自动目录独占创建遇到既存路径时不启动服务或删除既存内容', async () => {
  const run = await launch({ mode: 'collision' })
  try {
    assert.notEqual((await run.exited).code, 0, run.output())
    assert.deepEqual(events(run.trace), [])
    assert.equal(readFileSync(join(run.directory(), 'not-owned'), 'utf8'), 'preserve')
  } finally {
    await run.cleanup()
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  void test(`Playwright CLI 收到 ${signal} 后仍停服务并回收自动目录`, async () => {
    const run = await launch({ mode: 'hold' })
    try {
      await until(() => events(run.trace).some((entry) => entry.event === 'test'), run.output())
      run.child.kill(signal)
      await run.exited
      const entries = events(run.trace)
      const started = entries.find((entry) => entry.event === 'started')
      await until(() => !existsSync(started.directory), run.output())
      assert.equal(events(run.trace).find((entry) => entry.event === 'stopped')?.exists, true)
      await assert.rejects(fetch(run.url, { signal: AbortSignal.timeout(1000) }))
    } finally {
      await run.cleanup()
    }
  })
}

void test('后端及孙进程忽略 SIGTERM 时升级 SIGKILL，整组停止后才回收目录', async () => {
  const run = await launch({ mode: 'force' })
  try {
    assert.equal((await run.exited).code, 0, run.output())
    const entries = events(run.trace)
    const started = entries.find((entry) => entry.event === 'started')
    const descendant = entries.find((entry) => entry.event === 'grandchild')
    assert.ok(descendant, run.output())
    assert.equal(entries.find((entry) => entry.event === 'stopping')?.exists, true)
    assert.ok(
      entries.find((entry) => entry.event === 'grandchild-term'),
      run.output(),
    )
    await until(() => !existsSync(started.directory), run.output())
    await assert.rejects(fetch(run.url, { signal: AbortSignal.timeout(1000) }))
    let states = ''
    try {
      states = execFileSync('ps', ['-p', String(descendant.pid), '-o', 'stat='], {
        encoding: 'utf8',
      })
    } catch (error) {
      if (error.status !== 1) throw error
    }
    assert.ok(states.trim() === '' || states.trim().startsWith('Z'), states)
  } finally {
    await run.cleanup()
  }
})
