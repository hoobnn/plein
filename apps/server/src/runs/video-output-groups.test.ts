import { adoptResult, connect, currentResult } from '@plein/doc'
import { mockProvider } from '@plein/providers'
import { solidPng } from '../../../../packages/providers/src/mock/media'
import { MOCK_WEBM_BASE64 } from '../../../../packages/providers/src/mock/video-fixture'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, mockSettings } from '../testing'

afterEach(() => vi.restoreAllMocks())

it.each([null, 0, 1])('两条视频的执行输出和实际输入按候选关联，缺帧序号=%s', async (missing) => {
  const { server } = await bootServer()
  mockSettings(server, { latencyMs: 0 })
  const { id, doc } = await createCanvas(server)
  let calls = 0
  const completed: number[] = []
  const original = mockProvider.submit
  vi.spyOn(mockProvider, 'submit').mockImplementation(async (req, ctx) => {
    if (req.capability !== 'video.generate') return original(req, ctx)
    const index = calls++
    // 第一条后完成，返回顺序不能改变视频和尾帧的关联。
    if (index === 0) await new Promise((resolve) => setTimeout(resolve, 30))
    completed.push(index)
    return {
      state: 'succeeded',
      outputs: [
        {
          type: 'file',
          kind: 'video',
          mime: 'video/webm',
          data: new Uint8Array(Buffer.from(MOCK_WEBM_BASE64, 'base64')),
        },
        ...(index !== missing
          ? [
              {
                type: 'file' as const,
                kind: 'image' as const,
                mime: 'image/png',
                data: solidPng(64, 64, [index * 150, 100, 200]),
              },
            ]
          : []),
      ],
    }
  })
  const source = addNode(doc, 'plein/video', {
    params: { model: 'plein/mock:video', prompt: '水杯', mode: 'text', count: 2 },
  })
  const run = server.runs.start(id, source, 'local')
  expect(await server.runs.wait(run)).toBe('succeeded')
  expect(calls).toBe(2)
  expect(completed).toEqual([1, 0])
  const results = doc.get(source)!.results!
  const videos = results.filter((r) => r.port === 'video')
  expect(videos.map((r) => r.outputGroup)).toEqual(['0', '1'])
  const tails = results.filter((r) => r.port === 'lastFrame')
  expect(tails.map((r) => r.outputGroup)).toEqual([0, 1].filter((i) => i !== missing).map(String))
  expect(currentResult(doc.get(source)!, 'lastFrame')?.id).toBe(
    tails.find((r) => r.outputGroup === '0')?.id,
  )
  adoptResult(doc, source, videos[1]!.id)
  const target = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: '沿用尾帧' },
    x: 600,
  })
  connect(doc, [source, 'lastFrame'], [target, 'references'])
  const input = await server.runs.preview(id, target, 'local')
  if (missing === 1) {
    expect(currentResult(doc.get(source)!, 'lastFrame')).toBeUndefined()
    expect(input.status).toBe('unprepared')
    expect(input.blocked[0]?.message).toContain('当前候选没有可确认的「尾帧」输出')
    expect(input.inputs.references).toBeUndefined()
  } else {
    const tail = tails.find((r) => r.outputGroup === '1')!
    expect(currentResult(doc.get(source)!, 'lastFrame')?.id).toBe(tail.id)
    expect(input.inputs.references).toMatchObject([
      { assetId: 'assetId' in tail.value ? tail.value.assetId : '', source },
    ])
    adoptResult(doc, source, tail.id)
    expect(currentResult(doc.get(source)!, 'video')?.id).toBe(videos[1]!.id)
  }
})
