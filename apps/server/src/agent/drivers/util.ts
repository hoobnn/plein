import { type ChildProcess, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/** 工具参数的一行摘要 */
export function brief(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  const pick =
    o.type ?? o.kind ?? o.id ?? o.element_id ?? o.query ?? o.url ?? o.command ?? o.file_path
  const extra =
    o.params && typeof o.params === 'object' ? (o.params as Record<string, unknown>).prompt : o.text
  const parts = [pick, extra].filter((v): v is string => typeof v === 'string' && v.length > 0)
  const s = parts.join(' · ')
  return s ? (s.length > 120 ? `${s.slice(0, 120)}…` : s) : undefined
}

/** MCP 工具结果内容转成一段文字 */
export function toolText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  return (
    content
      .map((c: { type?: string; text?: string }) =>
        c.type === 'text' ? (c.text ?? '') : c.type === 'image' ? '[图片]' : '',
      )
      .filter(Boolean)
      .join('\n')
      // Claude Code 把图片结果另存到本地，并在文字里附上路径，对用户没用
      .replace(/\[Image: source: [^\]]*\]/g, '')
      .trim()
  )
}

/** 把常见的 CLI 报错翻译成能操作的提示 */
export function explain(name: string, stderr: string): string | undefined {
  const s = stderr.trim()
  if (!s) return undefined
  if (/log ?in|logged in|authenticat|unauthori[sz]ed|401/i.test(s)) {
    return `${name} 还没有登录：请先在终端运行 ${name === 'Codex' ? 'codex login' : 'claude auth login'} 完成登录。\n${s.slice(-300)}`
  }
  return `${name} 出错：${s.slice(-600)}`
}

/** 子进程的环境：不把 Plein 自己的配置和外层 Claude Code 的标记带进去 */
export function childEnv(env: NodeJS.ProcessEnv, keep: string[]): NodeJS.ProcessEnv {
  const out = { ...env }
  for (const k of Object.keys(out)) if (k.startsWith('PLEIN_') && !keep.includes(k)) delete out[k]
  delete out.CLAUDECODE
  delete out.CLAUDE_CODE_ENTRYPOINT
  delete out.CLAUDE_CODE_SESSION_ID
  delete out.CODEX_THREAD_ID
  delete out.ELECTRON_RUN_AS_NODE
  return out
}

/** 按行收发 JSON 的子进程 */
export class JsonLines {
  readonly child: ChildProcess
  private stderr = ''
  private closed = false

  constructor(
    bin: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv },
    onMessage: (msg: Record<string, unknown>) => void,
    onClose: (code: number | null, stderr: string) => void,
  ) {
    this.child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    // CLI 读 stdin 之前就退出时写入会 EPIPE；没有监听会变成未捕获异常让服务崩溃
    this.child.stdin?.on('error', () => {})
    createInterface({ input: this.child.stdout! }).on('line', (line) => {
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object') return
      try {
        onMessage(msg as Record<string, unknown>)
      } catch (err) {
        console.warn('[agent] 解析事件失败：', (err as Error).message)
      }
    })
    this.child.stderr?.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-4000)
    })
    const done = (code: number | null) => {
      if (this.closed) return
      this.closed = true
      onClose(code, this.stderr)
    }
    this.child.on('error', (err) => {
      this.stderr += `\n${err.message}`
      done(null)
    })
    this.child.on('close', done)
  }

  get alive() {
    return !this.closed
  }

  write(msg: unknown) {
    if (this.closed) return
    this.child.stdin?.write(`${JSON.stringify(msg)}\n`)
  }

  /** 先 SIGTERM，3 秒不退再 SIGKILL */
  kill() {
    if (this.closed) return
    this.child.kill('SIGTERM')
    const child = this.child
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 3000).unref()
  }
}
