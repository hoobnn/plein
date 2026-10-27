import { mockProvider } from '@plein/providers'
import type { JobInfo, PreparedInput } from '@plein/protocol'
import { expect, it, vi } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, mockSettings, request } from '../testing'

it('复制音色附带空白时，真实预检、执行请求和作业快照都使用规范化引用', async () => {
  const { server } = await bootServer()
  mockSettings(server, { latencyMs: 0 })
  const { id, doc } = await createCanvas(server)
  const node = addNode(doc, 'plein/speech', {
    params: {
      model: 'plein/mock:audio',
      text: '音色边界检查。',
      voice: { provider: ' plein/mock ', voiceId: ' mock-female\t' },
    },
  })
  const submit = vi.spyOn(mockProvider, 'submit')
  try {
    const input = await request(server, `/api/canvases/${id}/nodes/${node}/input`)
    expect(input.status).toBe(200)
    const prepared = (await input.json()) as PreparedInput
    expect(prepared.voice).toEqual({ provider: 'plein/mock', voiceId: 'mock-female' })
    const result = await request(server, `/api/canvases/${id}/nodes/${node}/run`, {
      method: 'POST',
      body: JSON.stringify({ expect: prepared.inputHash }),
    })
    expect(result.status).toBe(202)
    const { runId } = (await result.json()) as { runId: string }
    expect(await server.runs.wait(runId)).toBe('succeeded')
    expect(submit).toHaveBeenCalledOnce()
    expect(submit.mock.calls[0]![0].input).toMatchObject({ voice: 'mock-female' })
    const job = (await (
      await request(server, `/api/canvases/${id}/jobs/${runId}`)
    ).json()) as JobInfo
    expect(job.input?.voice).toEqual(prepared.voice)
    expect(doc.get(node)?.results?.[0]?.value.type).toBe('audio')
  } finally {
    submit.mockRestore()
  }
})
