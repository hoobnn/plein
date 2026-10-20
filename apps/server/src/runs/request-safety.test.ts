import { mockProvider } from '@plein/providers'
import { afterEach, expect, it, onTestFinished, vi } from 'vite-plus/test'
import type { CallRecord } from '../plugins/host'
import { addNode, bootServer, createCanvas, mockSettings, until } from '../testing'

afterEach(() => vi.restoreAllMocks())

const providers = [
  { id: 'minimax/api', secret: 'MINIMAX_API_KEY', model: 'MiniMax-H3', node: 'plein/video' },
  {
    id: 'volc/ark',
    secret: 'ARK_API_KEY',
    model: 'doubao-seedance-2-0-260128',
    node: 'plein/video',
  },
  {
    id: 'aliyun/bailian',
    secret: 'DASHSCOPE_API_KEY',
    model: 'qwen3-tts-flash',
    node: 'plein/speech',
  },
] as const

for (const provider of providers)
  it.each([408, 500, 502, 503, 504])(
    `${provider.id} POST HTTP %i 保留未知，重复 start 不再提交`,
    async (status) => {
      const { server } = await bootServer()
      server.plugins.configs.update(provider.id, {
        enabled: true,
        secrets: { [provider.secret]: 'local-test-key' },
      })
      // 全部请求在传输边界被本地响应替换，不调用真实平台。
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => new Response('<html>gateway error</html>', { status }))
      const { id, doc } = await createCanvas(server)
      const node = addNode(doc, provider.node, {
        params: {
          model: `${provider.id}:${provider.model}`,
          prompt: 'local only',
          text: '本地回归。',
        },
      })
      const run = server.runs.start(id, node, 'local')
      expect(await server.runs.wait(run)).toBe('failed')
      await until(() => !server.runs.isRunning(id, node))
      const row = server.runs.store.get(run)!
      expect(Object.values(JSON.parse(row.calls))).toEqual([
        expect.objectContaining({ state: 'unknown' }),
      ])
      expect(server.runs.list(id).jobs[0]?.recovery?.state).toBe('submit_unknown')
      expect(row.attempts).toBe(1)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(() => server.runs.start(id, node, 'local')).toThrow('请先恢复或标记已处理')
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

it.each(['pending-no-poll', 'fetched-dropped'] as const)(
  '%s 重启恢复保留原记录，不退回 submit，也不解锁新 start',
  async (mode) => {
    const first = await bootServer()
    mockSettings(first.server, { latencyMs: 0 })
    const submit = vi.spyOn(mockProvider, 'submit')
    const { id, doc } = await createCanvas(first.server)
    const node = addNode(doc, 'plein/speech', { params: { text: '本地恢复回归。' } })
    const run = first.server.runs.start(id, node, 'local')
    expect(await first.server.runs.wait(run)).toBe('succeeded')
    await until(() => !first.server.runs.isRunning(id, node))
    const calls = JSON.parse(first.server.runs.store.get(run)!.calls)
    const key = Object.keys(calls)[0]!
    // 重建“已受理、结果入库前退出”的持久事实；不伪造新的运行输入。
    const recorded: CallRecord =
      mode === 'pending-no-poll'
        ? { state: 'pending', remoteId: 'accepted-before-upgrade' }
        : {
            state: 'fetched',
            outputs: [{ type: 'file', kind: 'audio', mime: 'audio/wav', dropped: true }],
          }
    first.server.runs.store.journal(run).set(key, recorded)
    first.server.runs.store.update(run, { status: 'running', recovery: null })
    await first.close()
    if (mode === 'pending-no-poll') {
      const poll = mockProvider.poll
      mockProvider.poll = undefined
      onTestFinished(() => {
        mockProvider.poll = poll
      })
    }
    const before = submit.mock.calls.length
    const second = await bootServer({ dataDir: first.dataDir })
    expect(await second.server.runs.wait(run)).toBe('failed')
    await until(() => !second.server.runs.isRunning(id, node))
    expect(submit).toHaveBeenCalledTimes(before)
    expect(second.server.runs.store.journal(run).get(key)).toEqual(recorded)
    expect(second.server.runs.list(id).jobs[0]?.recovery).toMatchObject({
      state: mode === 'pending-no-poll' ? 'remote_pending' : 'fetch_failed',
      refetchable: false,
    })
    expect(() => second.server.runs.start(id, node, 'local')).toThrow('请先恢复或标记已处理')
    expect(submit).toHaveBeenCalledTimes(before)
  },
)
