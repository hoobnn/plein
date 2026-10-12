import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import {
  connect,
  createDoc,
  createElement,
  currentResult,
  type PleinDoc,
  writeRun,
} from '@plein/doc'
import type { Canvas } from '@plein/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from '../app'
import { loadConfig } from '../config'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const textPorts = { inputs: [], outputs: [{ id: 'text', label: '文本', type: 'text' as const }] }
const imagePorts = {
  inputs: [
    { id: 'prompt', label: '提示词', type: 'text' as const, multiple: true },
    { id: 'references', label: '参考图', type: 'image' as const, multiple: true },
  ],
  outputs: [{ id: 'images', label: '图片', type: 'image' as const }],
}

async function waitFor(doc: PleinDoc, id: string, done: (s?: string) => boolean) {
  for (let i = 0; i < 100; i++) {
    if (done(doc.get(id)?.run?.status)) return doc.get(id)!
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('等待超时')
}

describe('节点运行接口', () => {
  let stop: () => Promise<void>
  let base: string
  let server: Awaited<ReturnType<typeof createServer>>

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'plein-runs-'))
    dirs.push(dataDir)
    server = await createServer({
      ...loadConfig({ PLEIN_DATA_DIR: dataDir, PLEIN_MOCK_PROVIDER: '1' }),
      webDist: null,
    })
    const http = serve({ fetch: server.app.fetch, hostname: '127.0.0.1', port: 0 })
    await new Promise<void>((r) => http.once('listening', () => r()))
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
    stop = async () => {
      server.close()
      await new Promise((r) => http.close(r))
    }
  })
  afterAll(() => stop())

  it('文本节点连到生成图片：就地计算上游，结果和状态写回画布', async () => {
    const canvas = (await (
      await fetch(`${base}/api/canvases`, { method: 'POST', body: '{}' })
    ).json()) as Canvas
    const doc = createDoc(server.rooms.get(canvas.id).doc, { schedule: () => {} })
    const text = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/text',
      nodeVersion: 1,
      params: { text: '天台 夜景' },
      ports: textPorts,
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    })
    const image = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/image',
      nodeVersion: 1,
      params: { count: 2 },
      ports: imagePorts,
      x: 300,
      y: 0,
      w: 200,
      h: 200,
    })
    connect(doc, [text, 'text'], [image, 'prompt'])

    const res = await fetch(`${base}/api/canvases/${canvas.id}/nodes/${image}/run`, {
      method: 'POST',
    })
    expect(res.status).toBe(202)
    const busy = await fetch(`${base}/api/canvases/${canvas.id}/nodes/${image}/run`, {
      method: 'POST',
    })
    expect(busy.status).toBe(409)

    const el = await waitFor(doc, image, (s) => s === 'succeeded' || s === 'failed')
    expect(el.run?.error).toBeUndefined()
    expect(el.results).toHaveLength(2)
    expect(currentResult(el)?.value).toMatchObject({ type: 'image', mime: 'image/png' })
    expect(el.adopted).toBe(el.results![0]!.id)
  })

  it('上游生成节点没有结果时报错', async () => {
    const canvas = (await (
      await fetch(`${base}/api/canvases`, { method: 'POST', body: '{}' })
    ).json()) as Canvas
    const doc = createDoc(server.rooms.get(canvas.id).doc, { schedule: () => {} })
    const a = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/image',
      nodeVersion: 1,
      name: '角色图',
      ports: imagePorts,
      x: 0,
      y: 0,
      w: 200,
      h: 200,
    })
    const b = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/image',
      nodeVersion: 1,
      params: { prompt: '换个角度' },
      ports: imagePorts,
      x: 300,
      y: 0,
      w: 200,
      h: 200,
    })
    connect(doc, [a, 'images'], [b, 'references'])
    await fetch(`${base}/api/canvases/${canvas.id}/nodes/${b}/run`, { method: 'POST' })
    const el = await waitFor(doc, b, (s) => s === 'failed' || s === 'succeeded')
    expect(el.run).toMatchObject({ status: 'failed' })
    expect(el.run?.error).toContain('角色图')
  })

  it('取消残留的运行中状态', async () => {
    const canvas = (await (
      await fetch(`${base}/api/canvases`, { method: 'POST', body: '{}' })
    ).json()) as Canvas
    const doc = createDoc(server.rooms.get(canvas.id).doc, { schedule: () => {} })
    const id = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/image',
      nodeVersion: 1,
      ports: imagePorts,
      x: 0,
      y: 0,
      w: 200,
      h: 200,
    })
    writeRun(doc, id, { id: 'old', status: 'running', at: 1 })
    const res = await fetch(`${base}/api/canvases/${canvas.id}/nodes/${id}/cancel`, {
      method: 'POST',
    })
    expect(res.status).toBe(204)
    expect(doc.get(id)?.run?.status).toBe('canceled')
  })

  it('分镜节点：剧本拆成镜头写回参数', async () => {
    const canvas = (await (
      await fetch(`${base}/api/canvases`, { method: 'POST', body: '{}' })
    ).json()) as Canvas
    const doc = createDoc(server.rooms.get(canvas.id).doc, { schedule: () => {} })
    const script = createElement(doc, {
      kind: 'markdown',
      text: '雨夜，林夏推开天台的门。她看见了陈默。两人对视。',
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    })
    const board = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/storyboard',
      nodeVersion: 1,
      params: { shots: [] },
      ports: {
        inputs: [{ id: 'script', label: '剧本', type: 'text', multiple: true }],
        outputs: [{ id: 'shots', label: '分镜', type: 'json' }],
      },
      x: 300,
      y: 0,
      w: 200,
      h: 200,
    })
    connect(doc, [script, 'text'], [board, 'script'])
    await fetch(`${base}/api/canvases/${canvas.id}/nodes/${board}/run`, { method: 'POST' })
    const el = await waitFor(doc, board, (s) => s === 'succeeded' || s === 'failed')
    expect(el.run?.error).toBeUndefined()
    const shots = el.params!.shots as Array<{ no: number; description: string; id: string }>
    expect(shots.map((s) => s.description)).toEqual([
      '雨夜，林夏推开天台的门',
      '她看见了陈默',
      '两人对视',
    ])
    expect(shots[0]!.id).toMatch(/^shot_/)
  })
})
