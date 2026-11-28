import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { z } from 'zod'

export class CliFailure extends Error {
  constructor(
    message: string,
    readonly authCode?: number,
    readonly authReason?: string,
  ) {
    super(message)
  }
}

const authError = z.object({
  code: z.union([z.string(), z.number()]).optional(),
  upstreamCode: z.union([z.string(), z.number()]).optional(),
  reason: z.string().optional(),
})
const failureEnvelope = z.object({
  error: authError.extend({
    details: z.object({ auth: authError.optional() }).nullish(),
  }),
})
const authReasons = new Set([
  'authorization_denied',
  'user_denied',
  'access_denied',
  'authorization_expired',
  'wait_timeout',
  'user_cancelled',
  'authorization_pending',
])
function cliFailure(message: string, streams: string[]) {
  for (const stream of streams) {
    let raw: unknown
    try {
      raw = JSON.parse(stream)
    } catch {
      continue
    }
    const result = failureEnvelope.safeParse(raw)
    if (!result.success) continue
    const fields = result.data.error.details?.auth ?? result.data.error
    const code = Number(fields.upstreamCode ?? fields.code)
    const authCode = Number.isSafeInteger(code) && code > 0 ? code : undefined
    const authReason = fields.reason && authReasons.has(fields.reason) ? fields.reason : undefined
    if (authCode || authReason) return new CliFailure(message, authCode, authReason)
  }
  return new CliFailure(message)
}

const binaries = new Set(['jimeng-novel', 'dreamina-canvas'])

export function runCli(binary: string, args: string[]): Promise<string> {
  if (!binaries.has(binary)) throw new Error('未知画布 CLI')
  const path = [
    process.env.PATH,
    join(homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
    .filter(Boolean)
    .join(delimiter)
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      {
        env: { ...process.env, PATH: path },
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout)
        // CLI output and Error.message can include the complete command, prompts and account data.
        const reason =
          error.code === 'E2BIG'
            ? '命令参数过长，请缩短标题或正文'
            : error.code === 'ENOENT'
              ? '未安装或无法找到'
              : /unauthori[sz]ed|auth.*required|not.logged.in|未登录|请先登录/i.test(
                    stdout + stderr,
                  )
                ? '需要登录'
                : error.killed
                  ? '请求超时，请刷新远端状态'
                  : '执行失败，请检查登录、项目 ID 与 CLI 版本'
        // Canvas emits its JSON error on stderr, while Novel uses stdout. Keep each
        // envelope separate from human-readable diagnostics on the other stream.
        const streams = binary === 'dreamina-canvas' ? [stderr, stdout] : [stdout, stderr]
        reject(cliFailure(binary + ' ' + reason, streams))
      },
    )
    child.stdin?.end()
  })
}
