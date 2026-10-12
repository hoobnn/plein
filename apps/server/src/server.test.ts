import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Asset, Canvas, UserTemplate } from '@plein/protocol'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { hasFfmpeg } from './assets/media'
import { type Config, loadConfig } from './config'
import { parseRange } from './http/files'
import { startServer } from './start'

const ffmpeg = await hasFfmpeg()
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'plein-test-'))
  dirs.push(d)
  return d
}

async function start(dataDir: string, overrides: Partial<Config> = {}) {
  const config = {
    ...loadConfig({ PLEIN_DATA_DIR: dataDir, PLEIN_PORT: '0' }),
    webDist: null,
    ...overrides,
  }
  const running = await startServer(config)
  return { server: running.server, base: running.url, stop: () => running.close() }
}

function connect(base: string, room: string, doc = new Y.Doc()) {
  const provider = new WebsocketProvider(base.replace('http', 'ws') + '/sync', room, doc, {
    WebSocketPolyfill: WebSocket as never,
    disableBc: true,
  })
  const synced = new Promise<void>((r) => provider.once('sync', () => r()))
  return { doc, provider, synced }
}

async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('server', () => {
  let dataDir: string
  let s: Awaited<ReturnType<typeof start>>
  beforeAll(async () => {
    dataDir = tempDir()
    s = await start(dataDir)
  })
  afterAll(() => s.stop())

  it('画布增删改查', async () => {
    const created = (await (
      await fetch(`${s.base}/api/canvases`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '第一集' }),
      })
    ).json()) as Canvas
    expect(created.title).toBe('第一集')
    const res = await fetch(`${s.base}/api/canvases/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '第二集' }),
    })
    expect(((await res.json()) as Canvas).title).toBe('第二集')
    const list = (await (await fetch(`${s.base}/api/canvases`)).json()) as Canvas[]
    expect(list.map((c) => c.id)).toContain(created.id)
    expect((await fetch(`${s.base}/api/canvases/${created.id}`, { method: 'DELETE' })).status).toBe(
      204,
    )
    expect((await fetch(`${s.base}/api/canvases/${created.id}`)).status).toBe(404)
  })

  it('用户模板：保存、列出、删除，格式不对时拒绝', async () => {
    const post = (body: unknown) =>
      fetch(`${s.base}/api/templates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const data = {
      plein: 1,
      elements: [{ id: 'el_a', kind: 'frame', x: 0, y: 0, w: 640, h: 400, name: '镜头' }],
      edges: [],
    }
    const created = (await (await post({ title: '一镜到底', data })).json()) as UserTemplate
    expect(created.title).toBe('一镜到底')
    expect((await post({ title: '空的', data: { ...data, elements: [] } })).status).toBe(400)
    expect((await post({ title: '', data })).status).toBe(400)
    const list = (await (await fetch(`${s.base}/api/templates`)).json()) as UserTemplate[]
    expect(list.find((t) => t.id === created.id)?.data.elements[0]?.name).toBe('镜头')
    const del = await fetch(`${s.base}/api/templates/${created.id}`, { method: 'DELETE' })
    expect(del.status).toBe(204)
    expect(
      (await fetch(`${s.base}/api/templates/${created.id}`, { method: 'DELETE' })).status,
    ).toBe(404)
  })

  it('拒绝跨站请求', async () => {
    const res = await fetch(`${s.base}/api/canvases`, {
      headers: { origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
    const ok = await fetch(`${s.base}/api/canvases`, {
      headers: { origin: 'http://localhost:5173' },
    })
    expect(ok.status).toBe(200)
  })

  it('两个客户端实时同步，重启后数据仍在', async () => {
    const canvas = (await (
      await fetch(`${s.base}/api/canvases`, { method: 'POST' })
    ).json()) as Canvas
    const a = connect(s.base, canvas.id)
    const b = connect(s.base, canvas.id)
    await Promise.all([a.synced, b.synced])
    a.doc.getMap('elements').set('el1', 'hello')
    await until(() => b.doc.getMap('elements').get('el1') === 'hello')
    a.provider.destroy()
    b.provider.destroy()

    await s.stop()
    s = await start(dataDir)
    const c = connect(s.base, canvas.id)
    await c.synced
    expect(c.doc.getMap('elements').get('el1')).toBe('hello')
    c.provider.destroy()
  })

  it('不存在的画布不能同步', async () => {
    const ws = new WebSocket(`${s.base.replace('http', 'ws')}/sync/cv_missing`)
    const status = await new Promise((r) =>
      ws.once('unexpected-response', (_req, res) => r(res.statusCode)),
    )
    expect(status).toBe(404)
  })

  it('图片入库：元数据、缩略图、去重、Range', async () => {
    const png = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: { r: 200, g: 80, b: 40 } },
    })
      .png()
      .toBuffer()
    const upload = () =>
      fetch(`${s.base}/api/assets`, {
        method: 'POST',
        headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent('封面.png') },
        body: png,
      })
    const asset = (await (await upload()).json()) as Asset
    expect(asset).toMatchObject({ kind: 'image', width: 1600, height: 900, name: '封面.png' })
    expect(asset.variants).toEqual(['thumb-256', 'thumb-1024'])
    expect(((await (await upload()).json()) as Asset).id).toBe(asset.id)

    const thumb = await fetch(`${s.base}/api/assets/${asset.id}/thumb-256`)
    expect(thumb.headers.get('content-type')).toBe('image/webp')
    const meta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata()
    expect(meta.width).toBe(256)

    const part = await fetch(`${s.base}/api/assets/${asset.id}`, {
      headers: { range: 'bytes=0-9' },
    })
    expect(part.status).toBe(206)
    expect((await part.arrayBuffer()).byteLength).toBe(10)
    expect((await fetch(`${s.base}/api/assets/${asset.id}/poster`)).status).toBe(404)
  })

  it('损坏的图片仍然保存原文件', async () => {
    const res = await fetch(`${s.base}/api/assets`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: 'not a png',
    })
    const asset = (await res.json()) as Asset
    expect(asset.variants).toEqual([])
    expect(await (await fetch(`${s.base}/api/assets/${asset.id}`)).text()).toBe('not a png')
  })

  it.runIf(ffmpeg)('视频封面与音频波形', async () => {
    const dir = tempDir()
    const video = join(dir, 'v.mp4')
    const audio = join(dir, 'a.mp3')
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=10:duration=2',
      '-pix_fmt',
      'yuv420p',
      video,
    ])
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      audio,
    ])
    const up = async (file: string, mime: string) =>
      (await (
        await fetch(`${s.base}/api/assets`, {
          method: 'POST',
          headers: { 'content-type': mime },
          body: readFileSync(file),
        })
      ).json()) as Asset
    const v = await up(video, 'video/mp4')
    expect(v).toMatchObject({ kind: 'video', width: 320, height: 240, variants: ['poster'] })
    expect(v.duration).toBeCloseTo(2, 0)
    const a = await up(audio, 'audio/mpeg')
    expect(a).toMatchObject({ kind: 'audio', variants: ['waveform'] })
    expect((await fetch(`${s.base}/api/assets/${a.id}/waveform`)).headers.get('content-type')).toBe(
      'image/png',
    )
  })
})

describe('账号登录（Better Auth）', () => {
  it('只能创建一个所有者账号，登录后可访问，本机数据归到所有者', async () => {
    const dir = tempDir()
    // 先在本机模式下建一个画布
    const local = await start(dir)
    const canvas = (await (
      await fetch(`${local.base}/api/canvases`, { method: 'POST' })
    ).json()) as Canvas
    await local.stop()

    const s = await start(dir, { auth: 'password' })
    const json = (body: unknown) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: s.base },
      body: JSON.stringify(body),
    })
    try {
      expect((await fetch(`${s.base}/api/canvases`)).status).toBe(401)
      const before = await (await fetch(`${s.base}/api/session`)).json()
      expect(before).toMatchObject({ principal: null, authRequired: true, needsSetup: true })

      const owner = { email: 'owner@example.com', password: 'correct horse', name: '所有者' }
      const signUp = await fetch(`${s.base}/api/auth/sign-up/email`, json(owner))
      expect(signUp.status).toBe(200)
      const second = await fetch(
        `${s.base}/api/auth/sign-up/email`,
        json({ ...owner, email: 'other@example.com' }),
      )
      expect(second.ok).toBe(false)

      const bad = await fetch(
        `${s.base}/api/auth/sign-in/email`,
        json({ ...owner, password: 'wrong pass' }),
      )
      expect(bad.status).toBe(401)
      const signIn = await fetch(`${s.base}/api/auth/sign-in/email`, json(owner))
      const cookie = signIn.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ')
      const list = (await (
        await fetch(`${s.base}/api/canvases`, { headers: { cookie } })
      ).json()) as Canvas[]
      expect(list.map((c) => c.id)).toEqual([canvas.id])
      const session = await (await fetch(`${s.base}/api/session`, { headers: { cookie } })).json()
      expect(session).toMatchObject({
        authRequired: true,
        needsSetup: false,
        principal: { role: 'owner' },
      })
    } finally {
      await s.stop()
    }
    // 回到本机模式仍能看到这个画布
    const again = await start(dir)
    const list = (await (await fetch(`${again.base}/api/canvases`)).json()) as Canvas[]
    expect(list.map((c) => c.id)).toEqual([canvas.id])
    await again.stop()
  })
})

describe('桌面端令牌', () => {
  it('只接受带启动令牌 Cookie 的请求，WebSocket 也一样', async () => {
    const token = 'a'.repeat(64)
    const s = await start(tempDir(), { desktopToken: token })
    try {
      expect((await fetch(`${s.base}/api/health`)).status).toBe(403)
      const wrong = await fetch(`${s.base}/api/health`, {
        headers: { cookie: `plein_desktop=${'b'.repeat(64)}` },
      })
      expect(wrong.status).toBe(403)
      const ok = await fetch(`${s.base}/api/canvases`, {
        headers: { cookie: `plein_desktop=${token}` },
      })
      expect(ok.status).toBe(200)

      const rejected = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`${s.base.replace('http', 'ws')}/sync/x`)
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
        ws.on('open', () => resolve(101))
      })
      expect(rejected).toBe(403)
    } finally {
      await s.stop()
    }
  })

  it('端口为 0 时由系统分配并返回实际端口', async () => {
    const s = await start(tempDir())
    try {
      expect(Number(new URL(s.base).port)).toBeGreaterThan(0)
      expect((await fetch(`${s.base}/api/health`)).status).toBe(200)
    } finally {
      await s.stop()
    }
  })
})

describe('parseRange', () => {
  it('解析单段 Range', () => {
    expect(parseRange(undefined, 100)).toBeNull()
    expect(parseRange('bytes=0-9', 100)).toEqual([0, 9])
    expect(parseRange('bytes=90-', 100)).toEqual([90, 99])
    expect(parseRange('bytes=-10', 100)).toEqual([90, 99])
    expect(parseRange('bytes=0-999', 100)).toEqual([0, 99])
    expect(parseRange('bytes=100-', 100)).toBe('invalid')
  })
})
