import { describe, expect, it } from 'vite-plus/test'
import { arkProvider } from './ark'
import { bailianProvider } from './bailian'
import { minimaxProvider } from './minimax'
import { fakeContext } from './testing'

/** 请求已收到 200 响应头，读响应体时连接断开。 */
const interrupted = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"task'))
        controller.error(new TypeError('connection reset'))
      },
    }),
  )

const platforms = [
  {
    name: 'MiniMax',
    prepare(reply: Response) {
      const { ctx, fetch } = fakeContext(minimaxProvider, [reply])
      return {
        fetch,
        submit: () =>
          minimaxProvider.submit(
            { capability: 'video.generate', model: 'MiniMax-H3', input: { prompt: '天台' } },
            ctx,
          ),
        poll: () => minimaxProvider.poll!('r1', ctx),
        next: { task: { id: 'r1', status: 'queued' } },
      }
    },
  },
  {
    name: '火山方舟',
    prepare(reply: Response) {
      const { ctx, fetch } = fakeContext(arkProvider, [reply])
      return {
        fetch,
        submit: () =>
          arkProvider.submit(
            {
              capability: 'video.generate',
              model: 'doubao-seedance-2-5-260628',
              input: { prompt: '天台' },
            },
            ctx,
          ),
        poll: () => arkProvider.poll!('r1', ctx),
        next: { id: 'r1', status: 'queued' },
      }
    },
  },
  {
    name: '百炼',
    prepare(reply: Response) {
      const { ctx, fetch } = fakeContext(bailianProvider, [reply])
      return {
        fetch,
        submit: () =>
          bailianProvider.submit(
            {
              capability: 'video.generate',
              model: 'wan3.0-video',
              input: { prompt: '天台', duration: 5 },
            },
            ctx,
          ),
        poll: () => bailianProvider.poll!('r1', ctx),
        next: { output: { task_id: 'r1', task_status: 'PENDING' } },
      }
    },
  },
]

describe.each(platforms)('$name 响应体断流', ({ prepare }) => {
  it('提交保留未知状态且不自动重试', async () => {
    const { submit, fetch } = prepare(interrupted())
    await expect(submit()).rejects.toMatchObject({
      code: 'unavailable',
      retryable: false,
      outcome: 'unknown',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('POST')
  })

  it('查询可重试，并能继续查同一个远端任务', async () => {
    const { poll, fetch, next } = prepare(interrupted())
    await expect(poll()).rejects.toMatchObject({ code: 'unavailable', retryable: true })
    fetch.mockResolvedValueOnce(Response.json(next))
    expect(await poll()).toMatchObject({ state: 'pending' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0]?.[0]).toBe(fetch.mock.calls[1]?.[0])
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
  })
})

describe('百炼任务状态', () => {
  it.each([{}, { output: {} }, { output: { task_status: 'UNKNOWN' } }])(
    '缺失或未知状态不能宣称远端失败：%j',
    async (reply) => {
      const { ctx } = fakeContext(bailianProvider, [reply])
      await expect(bailianProvider.poll!('r1', ctx)).rejects.toMatchObject({ code: 'unknown' })
    },
  )
})
