/** 显式零付费真实素材合成中断验收；仅操作新建的独立数据目录和自身子进程组。 */
import assert from 'node:assert/strict'
import { fork, execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const packagePath = process.env.PLEIN_ACCEPTANCE_PACKAGE
const outputPath = process.env.PLEIN_ACCEPTANCE_OUT
const freezeId = process.env.PLEIN_ACCEPTANCE_FREEZE_ID
assert(packagePath && outputPath && freezeId, '必须指定项目包、新输出目录及冻结 ID')
assert(process.platform !== 'win32', '本验收使用 POSIX 独立进程组')
const out = resolve(outputPath)
await mkdir(out, { recursive: false, mode: 0o700 })
const report: Record<string, unknown> = {
  scope: 'existing-real-media-render-crash-no-new-paid-generation',
  freezeId,
  startedAt: new Date().toISOString(),
  status: 'running',
}
const persist = () => writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
await persist()
const exec = promisify(execFile)
let activeGroup: number | undefined
const readJson = async (name: string) => JSON.parse(await readFile(join(out, name), 'utf8'))

async function child(mode: 'interrupt' | 'recover') {
  const proc = fork(
    fileURLToPath(new URL('./stable-production-render-crash.child.ts', import.meta.url)),
    [mode, out],
    {
      detached: true,
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, PLEIN_ACCEPTANCE_PACKAGE: resolve(packagePath!) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  )
  assert(proc.pid)
  activeGroup = proc.pid
  const stdout = createWriteStream(join(out, `${mode}.stdout.log`))
  const stderr = createWriteStream(join(out, `${mode}.stderr.log`))
  proc.stdout!.pipe(stdout)
  proc.stderr!.pipe(stderr)
  let killed = false
  let handlerError: unknown
  const timer = setTimeout(() => {
    handlerError = new Error(`${mode} 子进程超过 20 分钟`)
    process.kill(-proc.pid!, 'SIGKILL')
  }, 20 * 60_000)
  try {
    proc.on('message', (message: unknown) => {
      if (mode !== 'interrupt') return
      try {
        assert(message && typeof message === 'object' && 'type' in message)
        const evidence = message as {
          type: string
          pid: number
          processGroup: number
          bytes: number
        }
        assert.equal(evidence.type, 'render-started')
        assert.equal(evidence.pid, proc.pid)
        assert.equal(evidence.processGroup, proc.pid)
        assert(evidence.bytes > 4096, '真实 FFmpeg 输出必须超过容器头，已写入媒体数据')
        report.interruption = evidence
        process.kill(-proc.pid!, 'SIGKILL')
        killed = true
      } catch (error) {
        handlerError = error
        process.kill(-proc.pid!, 'SIGKILL')
      }
    })
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        proc.once('error', reject)
        proc.once('exit', (code, signal) => resolve({ code, signal }))
      },
    )
    if (handlerError) throw handlerError
    if (mode === 'interrupt') {
      assert(killed, '未收到可检查的渲染开始证据，不能算通过')
      assert.equal(result.signal, 'SIGKILL')
      // 独立组可能短暂保留被杀死的僵尸；不得存在仍执行的 FFmpeg 或服务。
      const goneBy = Date.now() + 10_000
      let survivors: string[]
      do {
        const { stdout: table } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,args='])
        survivors = table.split('\n').filter((line) => {
          const fields = line.trim().split(/\s+/)
          return Number(fields[2]) === proc.pid && !fields[3]?.startsWith('Z')
        })
        if (!survivors.length) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      } while (Date.now() < goneBy)
      assert.deepEqual(survivors, [], '强杀后验收进程组不得残留执行中的进程')
      report.killedProcessGroup = proc.pid
    } else {
      assert.equal(result.code, 0, `恢复子进程失败，见 ${out}/recover.stderr.log`)
      assert.equal(result.signal, null)
    }
    activeGroup = undefined
  } finally {
    clearTimeout(timer)
    stdout.end()
    stderr.end()
  }
}

try {
  await child('interrupt')
  report.before = await readJson('before.json')
  await persist()
  await child('recover')
  report.recovery = await readJson('recovery.json')
  const attempts = await readFile(join(out, 'forbidden-attempts.jsonl'), 'utf8')
  assert.equal(attempts, '', '全程不得尝试平台 submit 或网络 fetch')
  report.providerAttempts = 0
  report.fetchAttempts = 0
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = (error as Error).stack ?? String(error)
  throw error
} finally {
  if (activeGroup) {
    try {
      process.kill(-activeGroup, 'SIGKILL')
    } catch {
      /* 子进程可能已经退出。 */
    }
  }
  report.finishedAt = new Date().toISOString()
  await persist()
}
