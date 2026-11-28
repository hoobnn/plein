import { expect, it, vi } from 'vite-plus/test'
import { CliFailure, runCli } from './cli'

const exec = vi.hoisted(() =>
  vi.fn<
    (
      bin: string,
      args: string[],
      opts: unknown,
      done: (err: Error, stdout: string, stderr: string) => void,
    ) => object
  >(),
)
vi.mock('node:child_process', () => ({ execFile: exec }))

const secret = 'private-device-code-secret'
async function failure(binary: string, stdout: string, stderr: string) {
  exec.mockImplementationOnce((_bin, _args, _opts, done) => {
    done(Object.assign(new Error('failed: ' + secret), { code: 11 }), stdout, stderr)
    return {}
  })
  const error = await runCli(binary, ['login', '--device-code', secret]).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(CliFailure)
  expect(String(error)).not.toContain(secret)
  expect(JSON.stringify(error)).not.toContain(secret)
  return error
}

it('全能画布从 stderr 提取等待错误码，即使 stdout 带独立诊断', async () => {
  const err = await failure(
    'dreamina-canvas',
    'diagnostic ' + secret,
    JSON.stringify({
      ok: false,
      error: { code: 40011, reason: 'wait_timeout', message: secret },
    }),
  )
  expect(err).toMatchObject({ authCode: 40011, authReason: 'wait_timeout' })
})

it('短剧从 stdout 提取嵌套的远端认证错误码，忽略 stderr 原文', async () => {
  const err = await failure(
    'jimeng-novel',
    JSON.stringify({
      status: 'error',
      error: {
        code: 'AUTH_FAILED',
        details: {
          auth: { upstreamCode: '40014', reason: 'authorization_expired', deviceCode: secret },
        },
      },
    }),
    'CLI command ' + secret,
  )
  expect(err).toMatchObject({ authCode: 40014, authReason: 'authorization_expired' })
})

it('首个通道没有结构化状态时单独解析另一个通道，未知 reason 不对外返回', async () => {
  const err = await failure(
    'dreamina-canvas',
    JSON.stringify({ error: { code: 40014, reason: secret } }),
    JSON.stringify({ error: { message: secret } }),
  )
  expect(err).toMatchObject({ authCode: 40014, authReason: undefined })
})

it('不拼接跨通道的片段来构造认证状态', async () => {
  const err = await failure(
    'jimeng-novel',
    '{"error":{"code":',
    '40011,"reason":"' + secret + '"}}',
  )
  expect(err).toMatchObject({ authCode: undefined, authReason: undefined })
})
