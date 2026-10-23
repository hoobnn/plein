import { Readable } from 'node:stream'
import { unlink } from 'node:fs/promises'
import { describe, expect, it } from 'vite-plus/test'
import { MotionParams } from '@plein/nodes'
import { createCanvas, bootServer, request } from '../testing'

const params = MotionParams.parse({
  title: '中文标题 <script>不能执行</script>',
  duration: 1,
  aspectRatio: '16:9',
  resolution: '720p',
})

describe('动态合成预览API与冻结源恢复', () => {
  it('提供离线runtime字体，释放后地址失效，服务关闭不留监听', async () => {
    const { server, close } = await bootServer()
    const response = await request(server, '/api/motion/preview', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:8787' },
      body: JSON.stringify({ params, inputs: {} }),
    })
    expect(response.status).toBe(201)
    const info = (await response.json()) as { id: string; url: string; origin: string }
    expect(new URL(info.url).hostname).toBe('localhost')
    expect(info.origin).not.toBe('http://127.0.0.1:8787')
    const root = new URL('.', info.url)
    const page = await fetch(info.url)
    expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'")
    expect(await page.text()).toContain('runtime-src="runtime.js"')
    for (const path of [
      'player.js',
      'runtime.js',
      'vendor/gsap.min.js',
      'fonts/noto-sans-sc.css',
    ]) {
      const file = await fetch(new URL(path, root))
      expect(file.status, path).toBe(200)
      expect((await file.text()).length).toBeGreaterThan(100)
    }
    const html = await (await fetch(new URL('composition.html', root))).text()
    expect(html).toContain('&lt;script&gt;不能执行&lt;/script&gt;')
    expect(html).not.toContain('https://')
    await request(server, `/api/motion/preview/${info.id}`, { method: 'DELETE' })
    expect((await fetch(info.url)).status).toBe(404)
    await close()
    await expect(fetch(info.url)).rejects.toThrow()
  })

  it('开发localhost主页面使用127预览，其他host别名不能读取或删除合法会话', async () => {
    const { server } = await bootServer()
    const response = await request(server, '/api/motion/preview', {
      method: 'POST',
      headers: { origin: 'http://localhost:5173' },
      body: JSON.stringify({ params, inputs: {} }),
    })
    expect(response.status).toBe(201)
    const info = (await response.json()) as { url: string }
    const own = new URL(info.url),
      other = new URL(info.url)
    expect(own.hostname).toBe('127.0.0.1')
    other.hostname = 'localhost'
    expect((await fetch(other)).status).toBe(404)
    expect((await fetch(own)).status).toBe(200)
  })

  it('拒绝外部代码、错误参数与未拥有的素材', async () => {
    const { server } = await bootServer()
    for (const body of [
      { params: { ...params, overrides: { 'hf-media.attr.src': 'https://example.com/secret' } } },
      { params, html: '<script>fetch("http://127.0.0.1")</script>' },
      { params, inputs: { image: 'a'.repeat(64) } },
    ]) {
      const response = await request(server, '/api/motion/preview', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      expect([400, 422]).toContain(response.status)
    }
  })

  it('恢复候选冻结参数和旧输入为独立节点；原件物理缺失时明确拒绝', async () => {
    const { server } = await bootServer()
    const { id: canvasId, doc } = await createCanvas(server)
    const image = await server.assets.ingest('local', Readable.from([Buffer.from('image')]), {
      mime: 'image/png',
      name: '原图.png',
    })
    const manifest = {
      schema: 'plein.motion-source.v1',
      templateVersion: 1,
      engine: { name: 'hyperframes', version: '0.8.186' },
      params: { ...params, template: 'character', title: '原版' },
      inputs: { image: { assetId: image.id, mime: image.mime } },
    }
    const file = await server.assets.ingest(
      'local',
      Readable.from([Buffer.from(JSON.stringify(manifest))]),
      { mime: 'application/json', name: 'source.json' },
    )
    const path = `/api/motion/source/${file.id}`
    const source = await request(server, path)
    expect(source.status).toBe(200)
    expect(await source.json()).toMatchObject({
      params: { title: '原版' },
      inputs: { image: image.id },
    })
    const response = await request(server, `${path}/restore`, {
      method: 'POST',
      body: JSON.stringify({ canvasId }),
    })
    expect(response.status).toBe(201)
    const { nodeId } = (await response.json()) as { nodeId: string }
    expect(doc.get(nodeId)?.params).toMatchObject({ title: '原版', template: 'character' })
    expect([...doc.edges()].filter((edge) => edge.to[0] === nodeId)).toHaveLength(1)
    const count = doc.size
    const incompatible = await server.assets.ingest(
      'local',
      Readable.from([Buffer.from(JSON.stringify({ ...manifest, templateVersion: 2 }))]),
      { mime: 'application/json', name: 'future-source.json' },
    )
    expect((await request(server, `/api/motion/source/${incompatible.id}`)).status).toBe(404)
    expect(
      (
        await request(server, `/api/motion/source/${incompatible.id}/restore`, {
          method: 'POST',
          body: JSON.stringify({ canvasId }),
        })
      ).status,
    ).toBe(422)
    expect(doc.size).toBe(count)
    await unlink(server.assets.originalPath(image.id))
    expect((await request(server, path)).status).toBe(404)
    const failed = await request(server, `${path}/restore`, {
      method: 'POST',
      body: JSON.stringify({ canvasId }),
    })
    expect(failed.status).toBe(422)
    expect(doc.size).toBe(count)
  })
})

it('受控字幕API只接受cue参数，透明会话沿用相同释放合同', async () => {
  const { server } = await bootServer()
  const params = {
    width: 1280,
    height: 720,
    fps: 30,
    duration: 2,
    style: 'boxed',
    animation: 'pop',
    cues: [
      {
        id: 'c1',
        source: 'clip1',
        origin: 'manual',
        start: 0.2,
        end: 1.8,
        text: '<script>fetch(1)</script>',
      },
    ],
  }
  const response = await request(server, '/api/motion/preview/captions', {
    method: 'POST',
    headers: { origin: 'http://localhost:5173' },
    body: JSON.stringify(params),
  })
  expect(response.status).toBe(201)
  const info = (await response.json()) as {
    id: string
    url: string
    width: number
    height: number
    duration: number
  }
  expect(info).toMatchObject({ width: 1280, height: 720, duration: 2 })
  expect(await (await fetch(info.url)).text()).toContain('background:transparent')
  const html = await (await fetch(new URL('composition.html', info.url))).text()
  expect(html).toContain('&lt;script&gt;fetch(1)&lt;/script&gt;')
  for (const bad of [
    { ...params, html: '<script/>' },
    { ...params, duration: 301 },
    { ...params, cues: [{ ...params.cues[0], origin: 'invented' }] },
  ]) {
    expect(
      (
        await request(server, '/api/motion/preview/captions', {
          method: 'POST',
          body: JSON.stringify(bad),
        })
      ).status,
    ).toBe(400)
  }
  await request(server, `/api/motion/preview/${info.id}`, { method: 'DELETE' })
  expect((await fetch(info.url)).status).toBe(404)
})
