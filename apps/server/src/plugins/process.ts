import { type ChildProcess, fork } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { fromRpcError, type RpcMessage, toRpcError } from '@plein/plugin-sdk'

/** 子进程反过来请宿主办的事；返回值原样回给子进程 */
export type RpcHandler = (method: string, params: unknown) => Promise<unknown>
export type RpcNote = (method: 'progress' | 'log', params: unknown) => void

/** 取消后等子进程收手的时间；过了就杀掉重启（不指望插件配合） */
const ABORT_GRACE_MS = 5_000
/** 一段时间内崩溃超过这么多次就不再拉起，等用户在设置里重新加载 */
const MAX_CRASHES = 3
const CRASH_WINDOW_MS = 10 * 60_000

/** 运行时支持 Node 权限模型时用它把子进程关起来 */
const flags = process.allowedNodeEnvironmentFlags
const PERMISSION = flags.has('--permission')
  ? '--permission'
  : flags.has('--experimental-permission')
    ? '--experimental-permission'
    : null

interface Pending {
  ok(v: unknown): void
  fail(e: Error): void
  handler?: RpcHandler
  note?: RpcNote
}

/**
 * 一个第三方插件的子进程：Node 权限模型下只能读插件自己的目录，不能写文件、开子进程、
 * 起 worker、加载原生模块，环境变量是空的。和宿主之间走 IPC 消息（见 plugin-sdk 的 rpc）。
 * 进程崩了在途请求全部失败，下次请求时再拉起；短时间反复崩溃就停在出错状态。
 */
export class PluginProcess {
  private child: ChildProcess | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private crashes: number[] = []
  private stderr: string[] = []
  /** 反复崩溃后的原因；有它就不再拉起 */
  broken: string | null = null

  constructor(
    readonly id: string,
    private dir: string,
    private entry: string,
    private log: (message: string) => void,
  ) {}

  private spawn() {
    if (this.broken) throw new Error(this.broken)
    // Node 加载入口时会解析符号链接，权限白名单和入口必须指向同一个真实目录。
    // 宿主先解析，避免子进程为 /var → /private/var 等别名探测目录外的路径。
    const dir = realpathSync(this.dir)
    const entry = realpathSync(this.entry)
    const path = relative(dir, entry)
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))
      throw new Error('插件入口必须在插件目录内')
    const execArgv = ['--max-old-space-size=512']
    if (PERMISSION) execArgv.push(PERMISSION, `--allow-fs-read=${dir}`)
    const child = fork(entry, [], {
      cwd: dir,
      execArgv,
      // 环境变量不带过去（密钥、令牌都在宿主这边）；Electron 里要靠这个变量按 Node 运行
      env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const keep = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue
        this.stderr.push(line)
        this.log(line)
      }
      this.stderr.splice(0, Math.max(0, this.stderr.length - 20))
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('message', (m) => this.onMessage(m as RpcMessage))
    child.on('exit', (code, sig) => {
      if (this.child !== child) return
      this.child = null
      const tail = this.stderr.slice(-3).join('；')
      const why = `插件进程退出了（${sig ?? `退出码 ${code}`}）${tail ? `：${tail}` : ''}`
      for (const p of this.pending.values()) p.fail(new Error(why))
      this.pending.clear()
      if (code === 0 && !sig) return
      const now = Date.now()
      this.crashes = [...this.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now]
      if (this.crashes.length >= MAX_CRASHES)
        this.broken = `插件反复崩溃，已停下；到设置里重新加载。最后一次：${why}`
    })
    this.child = child
    return child
  }

  private onMessage(m: RpcMessage) {
    if (!m || typeof m !== 'object') return
    if (m.t === 'res') {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.ok) p.ok(m.value)
      else p.fail(fromRpcError(m.error))
    } else if (m.t === 'note') {
      this.pending.get(m.ctx)?.note?.(m.method, m.params)
    } else if (m.t === 'req') {
      const owner = m.ctx !== undefined ? this.pending.get(m.ctx) : undefined
      const reply = (msg: RpcMessage) => this.child?.send(msg)
      if (!owner?.handler) {
        reply({
          t: 'res',
          id: m.id,
          ok: false,
          error: { name: 'Error', message: '没有对应的请求' },
        })
        return
      }
      owner.handler(m.method, m.params).then(
        (value) => reply({ t: 'res', id: m.id, ok: true, value: value ?? null }),
        (err) => reply({ t: 'res', id: m.id, ok: false, error: toRpcError(err) }),
      )
    }
  }

  /** 发一个请求；signal 中止时通知子进程，过一会儿还没收手就杀掉 */
  request<T>(
    method: string,
    params: unknown,
    opts: { signal?: AbortSignal; handler?: RpcHandler; note?: RpcNote; timeoutMs?: number } = {},
  ): Promise<T> {
    const child = this.child ?? this.spawn()
    const id = this.nextId++
    return new Promise<T>((ok, fail) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let killer: ReturnType<typeof setTimeout> | undefined
      const done = () => {
        clearTimeout(timer)
        clearTimeout(killer)
        opts.signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        child.send({ t: 'abort', id } satisfies RpcMessage)
        killer = setTimeout(() => {
          if (!this.pending.has(id)) return
          this.log(`取消后 ${ABORT_GRACE_MS / 1000} 秒没有收手，结束进程`)
          this.pending.get(id)?.fail(Object.assign(new Error('已取消'), { name: 'AbortError' }))
          this.pending.delete(id)
          this.kill()
        }, ABORT_GRACE_MS)
      }
      this.pending.set(id, {
        ok: (v) => {
          done()
          ok(v as T)
        },
        fail: (e) => {
          done()
          fail(e)
        },
        handler: opts.handler,
        note: opts.note,
      })
      if (opts.signal?.aborted) onAbort()
      else opts.signal?.addEventListener('abort', onAbort, { once: true })
      if (opts.timeoutMs)
        timer = setTimeout(() => {
          const p = this.pending.get(id)
          if (!p) return
          this.pending.delete(id)
          p.fail(new Error(`插件 ${opts.timeoutMs! / 1000} 秒没有回应`))
          this.kill()
        }, opts.timeoutMs)
      child.send({ t: 'req', id, method, params } satisfies RpcMessage)
    })
  }

  get running() {
    return !!this.child
  }

  kill() {
    const child = this.child
    this.child = null
    for (const p of this.pending.values()) p.fail(new Error('插件进程已停止'))
    this.pending.clear()
    child?.kill('SIGKILL')
  }
}
