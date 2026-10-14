import {
  adoptResult,
  connect,
  createElement,
  type PleinDoc,
  setParams,
  updateElement,
} from '@plein/doc'
import type { StaleNodes } from '@plein/protocol'
import { mockProvider } from '@plein/providers'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { Server } from '../app'
import {
  addCharacter,
  addNode,
  bootServer,
  createCanvas,
  mockSettings,
  request,
  until,
} from '../testing'

afterEach(() => {
  vi.restoreAllMocks()
})

async function boot() {
  const { server } = await bootServer()
  mockSettings(server, {})
  return { server, ...(await createCanvas(server)) }
}

/** 跑一个节点并等它结束 */
async function run(server: Server, canvas: string, node: string, doc: PleinDoc) {
  const id = server.runs.start(canvas, node, 'local')
  expect(await server.runs.wait(id)).toBe('succeeded')
  await until(() => doc.get(node)?.run?.status === 'succeeded', 10_000)
}

const staleOf = async (server: Server, canvas: string): Promise<StaleNodes> =>
  (await (await request(server, `/api/canvases/${canvas}/stale`)).json()) as StaleNodes

/** 角色卡：设定 + 音色，连入的参考图就是它的输出 */
const heroCard = (doc: PleinDoc, name: string, x: number) =>
  addCharacter(
    doc,
    name,
    { description: '二十岁，短发，白衬衫', voice: { provider: '', voiceId: '' } },
    { x },
  )

describe('@ 引用改动后下游过期', () => {
  it('改角色设定、换参考图，引用它的节点都会被标记为需要重跑', async () => {
    const { server, id, doc } = await boot()
    const photo = createElement(doc, {
      kind: 'image',
      name: '定妆照',
      assetId: 'a'.repeat(64),
      x: 0,
      y: 0,
      w: 200,
      h: 200,
    })
    const hero = heroCard(doc, '林夏', 300)
    const shot = addNode(doc, 'plein/image', { params: { prompt: '@林夏站在天台' }, x: 600 })
    connect(doc, [photo, 'image'], [hero, 'references'])
    await run(server, id, shot, doc)
    expect(await staleOf(server, id)).toEqual({ stale: [], upstream: [], kept: [] })

    // 改角色设定：设定会附进镜头图的提示词，结果已过期
    setParams(doc, hero, { description: '三十岁，长发，黑风衣' })
    expect((await staleOf(server, id)).stale).toEqual([shot])
    await run(server, id, shot, doc)
    expect(await staleOf(server, id)).toEqual({ stale: [], upstream: [], kept: [] })

    // 换参考图：送进模型的参考图变了，结果也过期
    updateElement(doc, photo, { assetId: 'b'.repeat(64) })
    expect((await staleOf(server, id)).stale).toEqual([shot])
  }, 30_000)

  it('换采用结果：角色卡换成上游的另一张图，下游跟着过期', async () => {
    const { server, id, doc } = await boot()
    const ref = addNode(doc, 'plein/image', { params: { prompt: '林夏定妆照' } })
    const hero = heroCard(doc, '林夏', 300)
    const shot = addNode(doc, 'plein/image', { params: { prompt: '@林夏站在天台' }, x: 600 })
    connect(doc, [ref, 'images'], [hero, 'references'])
    await run(server, id, ref, doc)
    // 换个提示词再跑一次，产出另一张：模拟用户手上有两个候选
    setParams(doc, ref, { prompt: '林夏定妆照，另一个角度' })
    await run(server, id, ref, doc)
    const [newest, older] = doc.get(ref)!.results!
    expect(newest && older).toBeTruthy()
    adoptResult(doc, ref, newest!.id)
    await run(server, id, shot, doc)
    expect(await staleOf(server, id)).toEqual({ stale: [], upstream: [], kept: [] })

    adoptResult(doc, ref, older!.id)
    // 采用的那次运行本身参数也变了，会一起标成过期；这里只关心镜头图
    expect((await staleOf(server, id)).stale).toContain(shot)
  }, 30_000)
})

describe('道具 / 风格卡', () => {
  it('和角色卡一样能 @ 引用、参考图也送得进去', async () => {
    const { server, id, doc } = await boot()
    const submit = vi.spyOn(mockProvider, 'submit')
    const photo = createElement(doc, {
      kind: 'image',
      name: '打火机照片',
      assetId: 'c'.repeat(64),
      x: 0,
      y: 0,
      w: 200,
      h: 200,
    })
    const prop = addNode(doc, 'plein/prop', {
      name: '打火机',
      params: { description: '磨砂黑，铜盖有划痕' },
      x: 200,
    })
    connect(doc, [photo, 'image'], [prop, 'references'])
    const shot = addNode(doc, 'plein/image', { params: { prompt: '@打火机 特写' }, x: 500 })
    await run(server, id, shot, doc)
    expect(doc.get(shot)!.results).toHaveLength(1)
    const input = submit.mock.calls[0]![0].input as {
      prompt: string
      references?: Array<{ assetId: string }>
    }
    expect(input.prompt).toContain('磨砂黑，铜盖有划痕')
    expect(input.references?.map((r) => r.assetId)).toEqual(['c'.repeat(64)])
  }, 30_000)
})

describe('配音节点换平台不复用音色', () => {
  /** 音色挂在角色卡上，配音节点不手动选：运行前该自动沿用 */
  async function speechWith(voice: unknown) {
    const { server, id, doc } = await boot()
    const hero = heroCard(doc, '林夏', 0)
    setParams(doc, hero, { voice })
    const line = addNode(doc, 'plein/speech', {
      params: { text: '@林夏：你来了', model: 'plein/mock:audio', voice: '' },
      x: 300,
    })
    return { server, id, doc, line }
  }

  it('角色音色属于别的平台：节点停下来并说清是哪一家', async () => {
    const { server, id, doc, line } = await speechWith({
      provider: 'plein/other-speech',
      voiceId: 'v_linxia',
    })
    const run = server.runs.start(id, line, 'local')
    expect(await server.runs.wait(run)).toBe('failed')
    expect(doc.get(line)!.run?.error).toContain('音色属于 plein/other-speech')
    expect(doc.get(line)!.results).toBeUndefined()
  })

  it('同平台：自动沿用角色音色，平台收到的是音色 ID 字符串', async () => {
    const { server, id, doc, line } = await speechWith({ provider: 'plein/mock', voiceId: 'v1' })
    const submit = vi.spyOn(mockProvider, 'submit')
    const run = server.runs.start(id, line, 'local')
    expect(await server.runs.wait(run)).toBe('succeeded')
    expect(doc.get(line)!.results).toHaveLength(1)
    expect(submit.mock.calls[0]![0].input).toMatchObject({ voice: 'v1' })
  })
})
