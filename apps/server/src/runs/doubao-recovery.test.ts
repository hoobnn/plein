import { afterEach, expect, it, vi } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, until } from '../testing'

afterEach(() => vi.restoreAllMocks())

it.each(['504', '503', 'incomplete'] as const)(
  '豆包 %s 保留未知调用与核查标识，再运行不盲目提交',
  async (mode) => {
    const { server } = await bootServer()
    server.plugins.configs.update('doubao/speech', {
      enabled: true,
      secrets: { VOLC_SPEECH_API_KEY: 'local-test-key' },
    })
    let requestId: string | null = null
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = input as Request
      expect(request.url).toBe('https://openspeech.bytedance.com/api/v3/tts/unidirectional')
      requestId = request.headers.get('X-Api-Request-Id')
      return new Response(mode !== 'incomplete' ? 'gateway error' : '{"code":0,"data":"AQID"}', {
        status: mode === 'incomplete' ? 200 : Number(mode),
        headers: { 'X-Tt-Logid': 'local-platform-log' },
      })
    })
    const { id, doc } = await createCanvas(server)
    const node = addNode(doc, 'plein/speech', {
      params: {
        model: 'doubao/speech:seed-tts-2.0',
        text: '本地回归，不发送到平台。',
      },
    })
    const run = server.runs.start(id, node, 'local')
    expect(await server.runs.wait(run)).toBe('failed')
    await until(() => !server.runs.isRunning(id, node))
    const row = server.runs.store.get(run)!
    expect(requestId).toBeTruthy()
    expect(row.error).toContain(requestId!)
    expect(row.error).toContain('local-platform-log')
    const calls = Object.values(JSON.parse(row.calls))
    expect(calls).toEqual([
      expect.objectContaining({ state: 'unknown', message: expect.stringContaining(requestId!) }),
    ])
    expect(server.runs.list(id).jobs[0]?.recovery).toMatchObject({
      state: 'submit_unknown',
      attachable: false,
      refetchable: false,
    })
    expect(() => server.runs.start(id, node, 'local')).toThrow('请先恢复或标记已处理')
    expect(() => server.runs.recoverJob(id, run, 'local', { action: 'refetch' })).toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(server.runs.store.get(run)?.attempts).toBe(1)
  },
)
