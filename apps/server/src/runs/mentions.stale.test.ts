import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  adoptResult,
  connect,
  createDoc,
  createElement,
  type PleinDoc,
  setParams,
  updateElement,
} from '@plein/doc'
import type { StaleNodes } from '@plein/protocol'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../app'
import { loadConfig } from '../config'

const dirs: string[] = []
const servers: Server[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'plein-refs-'))
  dirs.push(dataDir)
  const server = await createServer({
    ...loadConfig({ PLEIN_DATA_DIR: dataDir, PLEIN_MOCK_PROVIDER: '1' }),
    webDist: null,
  })
  servers.push(server)
  server.plugins.configs.update('plein/mock', {
    settings: { latencyMs: 0, failWith: 'none' },
  })
  const res = await server.app.request('/api/canvases', {
    method: 'POST',
    body: '{}',
    headers: { host: '127.0.0.1:8787' },
  })
  const { id } = (await res.json()) as { id: string }
  return { server, id, doc: createDoc(server.rooms.get(id).doc, { schedule: () => {} }) }
}

const at = (x: number) => ({ x, y: 0, w: 200, h: 200 })

const imagePorts = {
  inputs: [
    { id: 'prompt', label: '提示词', type: 'text' as const, multiple: true },
    { id: 'references', label: '参考图', type: 'image' as const, multiple: true },
  ],
  outputs: [{ id: 'images', label: '图片', type: 'image' as const }],
}

async function until<T>(fn: () => T | undefined | false, timeout = 10_000): Promise<T> {
  const end = Date.now() + timeout
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** 跑一个节点并等它结束 */
async function run(server: Server, canvas: string, node: string, doc: PleinDoc) {
  const id = server.runs.start(canvas, node, 'local')
  expect(await server.runs.wait(id)).toBe('succeeded')
  await until(() => doc.get(node)?.run?.status === 'succeeded')
}

const staleOf = async (server: Server, canvas: string): Promise<StaleNodes> =>
  (await (
    await server.app.request(`/api/canvases/${canvas}/stale`, {
      headers: { host: '127.0.0.1:8787' },
    })
  ).json()) as StaleNodes

/** 角色卡：设定 + 音色，连入的参考图就是它的输出 */
function heroCard(doc: PleinDoc, name: string, x: number) {
  return createElement(doc, {
    kind: 'node',
    nodeType: 'plein/character',
    nodeVersion: 1,
    name,
    params: { description: '二十岁，短发，白衬衫', voice: { provider: '', voiceId: '' } },
    ports: {
      inputs: [{ id: 'references', label: '参考图', type: 'image', multiple: true }],
      outputs: [{ id: 'images', label: '参考图', type: 'image' as const }],
    },
    ...at(x),
  })
}

describe('@ 引用改动后下游过期', () => {
  it('改角色设定、换参考图，引用它的节点都会被标记为需要重跑', async () => {
    const { server, id, doc } = await boot()
    const photo = createElement(doc, {
      kind: 'image',
      name: '定妆照',
      assetId: 'a'.repeat(64),
      ...at(0),
    })
    const hero = heroCard(doc, '林夏', 300)
    const shot = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/image',
      nodeVersion: 1,
      params: { prompt: '@林夏站在天台' },
      ports: imagePorts,
      ...at(600),
    })
    connect(doc, [photo, 'image'], [hero, 'references'])
    await run(server, id, shot, doc)
    expect(await staleOf(server, id)).toEqual({ stale: [], upstream: [] })

    // 改角色设定：设定会附进镜头图的提示词，结果已过期
    setParams(doc, hero, { description: '三十岁，长发，黑风衣' })
    expect((await staleOf(server, id)).stale).toEqual([shot])
    await run(server, id, shot, doc)
    expect(await staleOf(server, id)).toEqual({ stale: [], upstream: [] })

    // 换参考图：送进模型的参考图变了，结果也过期
    updateElement(doc, photo, { assetId: 'b'.repeat(64) })
    expect((await staleOf(server, id)).stale).toEqual([shot])
  }, 30_000)

  it('换采用结果：角色卡换成上游的另一张图，下游跟着过期', async () => {
    const { server, id, doc } = await boot()
    const ref = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/image',
      nodeVersion: 1,
      params: { prompt: '林夏定妆照' },
      ports: imagePorts,
      ...at(0),
    })
    const hero = heroCard(doc, '林夏', 300)
    const shot = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/image',
      nodeVersion: 1,
      params: { prompt: '@林夏站在天台' },
      ports: imagePorts,
      ...at(600),
    })
    connect(doc, [ref, 'images'], [hero, 'references'])
    await run(server, id, ref, doc)
    // 换个提示词再跑一次，产出另一张：模拟用户手上有两个候选
    setParams(doc, ref, { prompt: '林夏定妆照，另一个角度' })
    await run(server, id, ref, doc)
    const [newest, older] = doc.get(ref)!.results!
    expect(newest && older).toBeTruthy()
    adoptResult(doc, ref, newest!.id)
    await run(server, id, shot, doc)
    expect(await staleOf(server, id)).toEqual({ stale: [], upstream: [] })

    adoptResult(doc, ref, older!.id)
    // 采用的那次运行本身参数也变了，会一起标成过期；这里只关心镜头图
    expect((await staleOf(server, id)).stale).toContain(shot)
  }, 30_000)
})

describe('道具 / 风格卡', () => {
  it('和角色卡一样能 @ 引用、参考图也送得进去', async () => {
    const { server, id, doc } = await boot()
    const photo = createElement(doc, {
      kind: 'image',
      name: '打火机照片',
      assetId: 'c'.repeat(64),
      ...at(0),
    })
    const prop = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/prop',
      nodeVersion: 1,
      name: '打火机',
      params: { description: '磨砂黑，铜盖有划痕' },
      ports: {
        inputs: [{ id: 'references', label: '参考图', type: 'image' as const, multiple: true }],
        outputs: [{ id: 'images', label: '参考图', type: 'image' as const }],
      },
      ...at(200),
    })
    connect(doc, [photo, 'image'], [prop, 'references'])
    const shot = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/image',
      nodeVersion: 1,
      params: { prompt: '@打火机 特写' },
      ports: imagePorts,
      ...at(500),
    })
    await run(server, id, shot, doc)
    expect(doc.get(shot)!.results).toHaveLength(1)
  }, 30_000)
})

describe('配音节点换平台不复用音色', () => {
  const speechPorts = {
    inputs: [{ id: 'text', label: '台词', type: 'text' as const, multiple: true }],
    outputs: [{ id: 'audio', label: '语音', type: 'audio' as const }],
  }

  /** 音色挂在角色卡上，配音节点不手动选：运行前该自动沿用 */
  async function speechWith(voice: unknown) {
    const { server, id, doc } = await boot()
    const hero = heroCard(doc, '林夏', 0)
    setParams(doc, hero, { voice })
    const line = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/speech',
      nodeVersion: 1,
      params: { text: '@林夏：你来了', model: 'plein/mock:audio', voice: '' },
      ports: speechPorts,
      ...at(300),
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
    const run = server.runs.start(id, line, 'local')
    expect(await server.runs.wait(run)).toBe('succeeded')
    expect(doc.get(line)!.results).toHaveLength(1)
  })
})
