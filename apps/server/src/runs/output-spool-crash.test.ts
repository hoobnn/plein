import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { expect, it, onTestFinished } from 'vite-plus/test'
import { tempDir } from '../testing'
import { outputSpoolRefs } from '../assets/output-spool'

it.each(['ready', 'ingest'])(
  '真实SIGKILL于%s窗口，17MiB字节恢复且累计submit仍为1',
  async (gate) => {
    const dataDir = tempDir('spool-sigkill-'),
      children: ChildProcess[] = []
    onTestFinished(() => {
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
    })
    const start = (mode: string) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          createRequire(import.meta.url).resolve('tsx'),
          fileURLToPath(new URL('./fixtures/output-spool-crash.child.ts', import.meta.url)),
          dataDir,
          mode,
          gate,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      children.push(child)
      let output = '',
        reached!: () => void
      const atGate = new Promise<void>((resolve) => {
        reached = resolve
      })
      child.stdout!.on('data', (data) => {
        output += String(data)
        if (output.includes('at-gate')) reached()
      })
      child.stderr!.on('data', (data) => {
        output += String(data)
      })
      return { child, output: () => output, atGate }
    }
    const first = start('start')
    await Promise.race([
      first.atGate,
      once(first.child, 'exit').then(() => {
        throw new Error(`fixture exited before gate: ${first.output()}`)
      }),
      new Promise<never>((_, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`fixture timeout: ${first.output()}`)),
          10000,
        )
        timeout.unref()
      }),
    ])
    const before = new Database(join(dataDir, 'plein.db'), { readonly: true })
    const row = before.prepare('SELECT calls FROM jobs WHERE id=?').get('spool-crash-job') as {
      calls: string
    }
    const refs = outputSpoolRefs(JSON.parse(row.calls))
    expect(refs).toHaveLength(1)
    expect(refs[0]?.state).toBe(gate === 'ready' ? 'writing' : 'ready')
    expect(row.calls.length).toBeLessThan(5000)
    before.close()
    const killed = once(first.child, 'exit')
    first.child.kill('SIGKILL')
    expect(await killed).toEqual([null, 'SIGKILL'])
    const second = start('recover'),
      [code] = await once(second.child, 'exit')
    expect(code, second.output()).toBe(0)
    expect(second.output()).toContain('"state":"succeeded"')
    expect(
      (await readFile(join(dataDir, 'fixture-submit-count'), 'utf8')).trim().split('\n'),
    ).toHaveLength(1)
    expect(await readdir(join(dataDir, 'job-outputs'))).toEqual([])
    const after = new Database(join(dataDir, 'plein.db'), { readonly: true })
    const done = after.prepare('SELECT calls FROM jobs WHERE id=?').get('spool-crash-job') as {
      calls: string
    }
    expect(JSON.parse(done.calls).speech).toMatchObject({
      state: 'done',
      dataAssets: { 0: { assetId: refs[0]?.sha256 } },
    })
    expect(done.calls.length).toBeLessThan(5000)
    after.close()
  },
  20000,
)
