import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Asset, Canvas, UserTemplate } from '@plein/protocol'
import sharp from 'sharp'
import { beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { hasFfmpeg } from './assets/media'
import { parseRange } from './http/files'
import type { Config } from './config'
import { startTestServer, tempDir, until } from './testing'

const ffmpeg = await hasFfmpeg()

const start = (dataDir = tempDir(), config: Partial<Config> = {}) =>
  startTestServer({ dataDir, config, mock: false })

function connect(base: string, room: string, doc = new Y.Doc()) {
  const provider = new WebsocketProvider(`${base.replace('http', 'ws')}/sync`, room, doc, {
    WebSocketPolyfill: WebSocket as never,
    disableBc: true,
  })
  const synced = new Promise<void>((r) => provider.once('sync', () => r()))
  return { doc, provider, synced }
}

/** WebSocket 握手的结果：升级成功记 101，被拒绝时是 HTTP 状态码 */
function handshake(url: string, headers?: Record<string, string>) {
  return new Promise<number>((resolve) => {
    const ws = new WebSocket(url, { headers })
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
    ws.on('open', () => {
      ws.close()
      resolve(101)
    })
  })
}

describe('server', () => {
  let s: Awaited<ReturnType<typeof start>>
  beforeAll(async () => {
    s = await start()
  })

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
    const first = await start()
    const canvas = (await (
      await fetch(`${first.base}/api/canvases`, { method: 'POST' })
    ).json()) as Canvas
    const a = connect(first.base, canvas.id)
    const b = connect(first.base, canvas.id)
    await Promise.all([a.synced, b.synced])
    a.doc.getMap('elements').set('el1', 'hello')
    await until(() => b.doc.getMap('elements').get('el1') === 'hello', 3000)
    a.provider.destroy()
    b.provider.destroy()

    await first.close()
    const again = await start(first.dataDir)
    const c = connect(again.base, canvas.id)
    await c.synced
    expect(c.doc.getMap('elements').get('el1')).toBe('hello')
    c.provider.destroy()
  })

  it('不存在的画布不能同步', async () => {
    expect(await handshake(`${s.base.replace('http', 'ws')}/sync/cv_missing`)).toBe(404)
  })

  it('同步握手同样拒绝跨站 Origin', async () => {
    const canvas = (await (
      await fetch(`${s.base}/api/canvases`, { method: 'POST' })
    ).json()) as Canvas
    const url = `${s.base.replace('http', 'ws')}/sync/${canvas.id}`
    expect(await handshake(url, { origin: 'https://evil.example' })).toBe(403)
    expect(await handshake(url, { origin: s.base })).toBe(101)
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

  it('HTML 等可执行类型的资产按附件下发，不在应用源内渲染', async () => {
    const res = await fetch(`${s.base}/api/assets`, {
      method: 'POST',
      headers: { 'content-type': 'text/html' },
      body: '<script>alert(1)</script>',
    })
    const asset = (await res.json()) as Asset
    const file = await fetch(`${s.base}/api/assets/${asset.id}`)
    expect(file.headers.get('content-type')).toBe('application/octet-stream')
    expect(file.headers.get('content-disposition')).toBe('attachment')
    expect(file.headers.get('content-security-policy')).toContain('sandbox')
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
    await local.close()

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
      await s.close()
    }
    // 回到本机模式仍能看到这个画布
    const again = await start(dir)
    const list = (await (await fetch(`${again.base}/api/canvases`)).json()) as Canvas[]
    expect(list.map((c) => c.id)).toEqual([canvas.id])
    await again.close()
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

      expect(await handshake(`${s.base.replace('http', 'ws')}/sync/x`)).toBe(403)
    } finally {
      await s.close()
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
    expect(parseRange('bytes=-0', 100)).toBe('invalid')
    expect(parseRange('bytes=5-2', 100)).toBe('invalid')
    // 不认识的写法当作没有 Range
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull()
  })
})
