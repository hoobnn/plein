import { setParams } from '@plein/doc'
import type { PreparedInput } from '@plein/protocol'
import { mockProvider } from '@plein/providers'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, mockSettings, request, until } from '../testing'

afterEach(() => vi.restoreAllMocks())

it('未选模型的损坏参数不阻断当前生成，当前项损坏会阻断且可恢复', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const model = 'plein/mock:image'
  const other = 'plein/mock:video'
  const options = { [model]: { watermark: false, custom: 'keep' }, [other]: null }
  const node = addNode(doc, 'plein/image', { params: { model, prompt: '参数隔离', options } })
  const preview = async () => {
    const res = await request(server, `/api/canvases/${id}/nodes/${node}/input`)
    expect(res.status).toBe(200)
    return (await res.json()) as PreparedInput
  }
  const before = await preview()
  expect(before.status).toBe('ready')
  const submit = vi.spyOn(mockProvider, 'submit')
  const run = server.runs.start(id, node, 'local')
  expect(await server.runs.wait(run)).toBe('succeeded')
  expect(submit).toHaveBeenCalledTimes(1)
  expect(submit.mock.calls[0]![0].input.extra).toEqual({
    aspectRatio: '16:9',
    watermark: false,
    custom: 'keep',
  })
  expect(doc.get(node)!.params!.options).toEqual(options)
  await until(() => !server.runs.isRunning(id, node))
  for (const inactive of [[], 'broken', false, 7]) {
    const changed = { [model]: options[model], [other]: inactive }
    setParams(doc, node, { options: changed })
    const input = await preview()
    expect(input.status).toBe('ready')
    expect(input.inputHash).toBe(before.inputHash)
    expect(doc.get(node)!.params!.options).toEqual(changed)
  }
  // 把损坏项换到当前模型，必须在提交前阻断。
  setParams(doc, node, { options: { [model]: null, [other]: { keep: 1 } } })
  const blocked = await preview()
  expect(blocked.status).toBe('blocked')
  expect(blocked.blocked[0]?.message).toContain('参数格式')
  const failed = server.runs.start(id, node, 'local')
  expect(await server.runs.wait(failed)).toBe('failed')
  expect(submit).toHaveBeenCalledTimes(1)
  await until(() => !server.runs.isRunning(id, node))
  setParams(doc, node, { options: { [model]: {}, [other]: { keep: 1 } } })
  expect((await preview()).status).toBe('ready')
  const repaired = server.runs.start(id, node, 'local')
  expect(await server.runs.wait(repaired)).toBe('succeeded')
  expect(doc.get(node)!.params!.options).toEqual({ [model]: {}, [other]: { keep: 1 } })
}, 30_000)

it('直接执行也拒绝当前模型的错误容器，不向平台发送空参数请求', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const submit = vi.spyOn(mockProvider, 'submit')
  for (const kind of ['image', 'video']) {
    const model = `plein/mock:${kind}`
    for (const value of [null, [], 'broken', false]) {
      await expect(
        server.plugins.runNode({
          type: `plein/${kind}`,
          version: 1,
          ownerId: 'local',
          params: { model, prompt: '检查格式', options: { [model]: value } },
        }),
      ).rejects.toMatchObject({
        code: 'invalid_input',
        message: expect.stringContaining('专属参数格式无效'),
      })
    }
  }
  expect(submit).not.toHaveBeenCalled()
})
