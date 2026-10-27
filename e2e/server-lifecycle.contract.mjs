import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

/**
 * 服务监护的合同：只回收本轮独占创建的数据，先停后端再删目录。
 *
 * 覆盖的是 `e2e/server-lifecycle.ts` 的监护语义（独占创建、成功/失败/中断后回收、
 * 忽略 SIGTERM 时升级 SIGKILL）。并行跑时后端由 `e2e/worker-server.ts` 按 worker 起，
 * 这里直接驱动同一个监护入口，验的是同一份实现。
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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
  if (!existsSync(trace)) return []
  return readFileSync(trace, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

/** 假后端：记录启动/停止事件，按模式模拟启动失败、拒绝退出等情形 */
function writeBackend(scratch) {
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
  return { backend, descendant }
}

/**
 * 直接起一份被监护的后端（和 `e2e/worker-server.ts` 走同一条路径）。
 * 返回句柄，调用方负责收尾。
 */
async function startGuarded({
  mode = 'pass',
  port,
  dataDir,
  scratch,
  backend,
  descendant,
  ownData = true,
  extraEnv = {},
}) {
  const trace = join(scratch, 'events.jsonl')
  const child = spawn(process.execPath, [join(root, 'e2e', 'worker-server.ts'), '--serve'], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      PLEIN_E2E_SERVER_COMMAND: `${quote(process.execPath)} ${quote(backend)}`,
      // 独占标记：调用方自己的目录不带这个标记，监护进程就不回收它
      PLEIN_E2E_OWN_DATA: ownData ? dataDir : '',
      PLEIN_E2E_RUNNER_PID: String(process.pid),
      PLEIN_PORT: String(port),
      PLEIN_DATA_DIR: dataDir,
      PLEIN_MOCK_PROVIDER: '1',
      PLEIN_AGENT: '0',
      E2E_CONTRACT_TRACE: trace,
      E2E_CONTRACT_MODE: mode,
      E2E_CONTRACT_CHILD: descendant,
      E2E_CONTRACT_CUSTOM: 'forwarded',
      ...extraEnv,
    },
  })
  const exited = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })))
  return { child, exited, trace }
}

async function stop(child, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((done) => child.once('exit', done))
  child.send?.({ stop: signal })
  await exited
}

void test('后端正常退出时先停后端再回收自动目录', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'plein-lifecycle-contract-'))
  const { backend, descendant } = writeBackend(scratch)
  const dataDir = join(scratch, 'worker-data')
  const port = await freePort()
  const run = await startGuarded({ port, dataDir, scratch, backend, descendant })
  try {
    await until(() => events(run.trace).some((entry) => entry.event === 'started'), '后端没起来')
    const started = events(run.trace).find((entry) => entry.event === 'started')
    assert.equal(started.exists, true)
    assert.equal(started.mock, '1')
    assert.equal(started.agent, '0')
    assert.equal(started.custom, 'forwarded')
    // 目录由监护进程独占创建
    assert.equal(existsSync(dataDir), true)
    await stop(run.child)
    await until(() => !existsSync(dataDir), '自动目录仍存在')
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }),
    )
  } finally {
    await stop(run.child).catch(() => {})
    rmSync(scratch, { recursive: true, force: true })
  }
})

void test('调用方指定的数据目录不由监护进程回收', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'plein-lifecycle-contract-'))
  const { backend, descendant } = writeBackend(scratch)
  // 调用方自己的目录：监护进程不独占创建，也就不负责回收
  const dataDir = join(scratch, 'caller-data')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'caller-marker'), 'preserve')
  const port = await freePort()
  const run = await startGuarded({ port, dataDir, scratch, backend, descendant, ownData: false })
  try {
    await until(() => events(run.trace).some((entry) => entry.event === 'started'), '后端没起来')
    const started = events(run.trace).find((entry) => entry.event === 'started')
    assert.equal(started.directory, dataDir)
    await stop(run.child)
    // 目录和里面的内容都要留着
    assert.equal(existsSync(dataDir), true)
    assert.equal(readFileSync(join(dataDir, 'caller-marker'), 'utf8'), 'preserve')
  } finally {
    await stop(run.child).catch(() => {})
    rmSync(scratch, { recursive: true, force: true })
  }
})

void test('后端启动失败时保留后端的退出码，不当成别的错误', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'plein-lifecycle-contract-'))
  const { backend, descendant } = writeBackend(scratch)
  const dataDir = join(scratch, 'worker-data')
  const port = await freePort()
  const run = await startGuarded({
    mode: 'start-failure',
    port,
    dataDir,
    scratch,
    backend,
    descendant,
  })
  try {
    const result = await run.exited
    // 后端自己退出码是 7，监护进程原样带出来
    assert.equal(result.code, 7)
    // 后端没起来，不该有「已停止」事件
    assert.deepEqual(
      events(run.trace).filter((e) => e.event === 'stopped'),
      [],
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

void test('自动目录已存在时不启动服务，也不删除既存内容', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'plein-lifecycle-contract-'))
  const { backend, descendant } = writeBackend(scratch)
  const dataDir = join(scratch, 'worker-data')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'not-owned'), 'preserve')
  const port = await freePort()
  const run = await startGuarded({ port, dataDir, scratch, backend, descendant })
  try {
    const result = await run.exited
    assert.notEqual(result.code, 0)
    assert.deepEqual(events(run.trace), [])
    assert.equal(readFileSync(join(dataDir, 'not-owned'), 'utf8'), 'preserve')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  void test(`监护进程收到 ${signal} 后仍停服务并回收自动目录`, async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'plein-lifecycle-contract-'))
    const { backend, descendant } = writeBackend(scratch)
    const dataDir = join(scratch, 'worker-data')
    const port = await freePort()
    const run = await startGuarded({ port, dataDir, scratch, backend, descendant })
    try {
      await until(() => events(run.trace).some((entry) => entry.event === 'started'), '后端没起来')
      run.child.kill(signal)
      await run.exited
      await until(() => !existsSync(dataDir), '自动目录仍存在')
      assert.equal(events(run.trace).find((entry) => entry.event === 'stopped')?.exists, true)
      await assert.rejects(
        fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }),
      )
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
}

void test('调用方退出时监护进程自己收尾并回收目录', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'plein-lifecycle-contract-'))
  const { backend } = writeBackend(scratch)
  const dataDir = join(scratch, 'worker-data')
  const port = await freePort()
  // 监护进程盯的是调用方 PID；这里用一个马上退出的子进程当调用方
  const caller = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const trace = join(scratch, 'events.jsonl')
  const child = spawn(process.execPath, [join(root, 'e2e', 'worker-server.ts'), '--serve'], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      PLEIN_E2E_SERVER_COMMAND: `${quote(process.execPath)} ${quote(backend)}`,
      PLEIN_E2E_OWN_DATA: dataDir,
      PLEIN_E2E_RUNNER_PID: String(caller.pid),
      PLEIN_PORT: String(port),
      PLEIN_DATA_DIR: dataDir,
      PLEIN_MOCK_PROVIDER: '1',
      PLEIN_AGENT: '0',
      E2E_CONTRACT_TRACE: trace,
      E2E_CONTRACT_MODE: 'pass',
      E2E_CONTRACT_CUSTOM: 'forwarded',
    },
  })
  try {
    await until(() => events(trace).some((entry) => entry.event === 'started'), '后端没起来')
    await until(() => !existsSync(dataDir), '自动目录仍存在')
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }),
    )
  } finally {
    child.kill('SIGKILL')
    rmSync(scratch, { recursive: true, force: true })
  }
})

void test('后端及孙进程忽略 SIGTERM 时升级 SIGKILL，整组停止后才回收目录', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'plein-lifecycle-contract-'))
  const { backend, descendant } = writeBackend(scratch)
  const dataDir = join(scratch, 'worker-data')
  const port = await freePort()
  const run = await startGuarded({ mode: 'force', port, dataDir, scratch, backend, descendant })
  try {
    await until(() => events(run.trace).some((entry) => entry.event === 'started'), '后端没起来')
    const started = events(run.trace).find((entry) => entry.event === 'started')
    // 孙进程要自己起来并记一笔，才能验证整组停止
    await until(
      () => events(run.trace).some((entry) => entry.event === 'grandchild'),
      '孙进程没起来',
    )
    const grandchild = events(run.trace).find((entry) => entry.event === 'grandchild')
    await stop(run.child)
    await until(() => !existsSync(dataDir), '自动目录仍存在')
    assert.equal(events(run.trace).find((entry) => entry.event === 'stopping')?.exists, true)
    assert.ok(
      events(run.trace).find((entry) => entry.event === 'grandchild-term'),
      '孙进程应先收到 SIGTERM',
    )
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }),
    )
    let states = ''
    try {
      states = execFileSync('ps', ['-p', String(grandchild.pid), '-o', 'stat='], {
        encoding: 'utf8',
      })
    } catch (error) {
      if (error.status !== 1) throw error
    }
    assert.ok(states.trim() === '' || states.trim().startsWith('Z'), states)
    assert.ok(started)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
