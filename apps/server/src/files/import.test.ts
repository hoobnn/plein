import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import { bootServer, createCanvas, request, tempDir } from '../testing'

/** 同内容的资产只存一份，名字沿用先入库的那份；要区分的测试给不同颜色 */
const png = (background = '#336699') =>
  sharp({ create: { width: 8, height: 6, channels: 3, background } })
    .png()
    .toBuffer()

let running: Awaited<ReturnType<typeof bootServer>>
let root: string
let outside: string
let canvasId: string
let rpc: (
  name: string,
  args?: Record<string, unknown>,
) => Promise<{ error: boolean; text: string; content: Array<Record<string, string>> }>
let n = 0

beforeAll(async () => {
  root = tempDir('plein-import-root-')
  outside = tempDir('plein-import-out-')
  running = await bootServer({ env: { PLEIN_IMPORT_ROOTS: root } })
  const { server } = running
  canvasId = (await createCanvas(server)).id
  const { token } = (await (
    await request(server, '/api/mcp/external', { method: 'POST' })
  ).json()) as {
    token: string
  }
  rpc = async (name, args = {}) => {
    const res = await server.app.request('/mcp', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:8787',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++n,
        method: 'tools/call',
        params: { name, arguments: { canvas_id: canvasId, ...args } },
      }),
    })
    const r = (await res.json()) as {
      result: { content: Array<Record<string, string>>; isError?: boolean }
    }
    return {
      error: r.result.isError === true,
      text: r.result.content[0]?.text ?? '',
      content: r.result.content,
    }
  }
})
afterAll(() => running.close())

interface Out {
  asset_id: string
  kind: string
  width?: number
  element_id?: string
  reason?: string
  url: string
  max_bytes: number
}
const asJson = (r: { text: string }) => JSON.parse(r.text) as Out

describe('import_asset', () => {
  it('base64 入库并可摆到画布上', async () => {
    const data = (await png()).toString('base64')
    const r = await rpc('import_asset', {
      source: { base64: `data:image/png;base64,${data}`, name: 'pic.png' },
      place: { x: 10, y: 20 },
    })
    expect(r.error).toBe(false)
    const out = asJson(r)
    expect(out.kind).toBe('image')
    expect(out.width).toBe(8)
    expect(out.element_id).toBeTruthy()
    expect(running.server.assets.get('local', out.asset_id)?.name).toBe('pic.png')
    const el = running.server.rooms.withDoc(canvasId, (doc) => doc.get(out.element_id!))
    expect(el?.assetId).toBe(out.asset_id)
  })

  it('source 必须只给一个来源', async () => {
    expect((await rpc('import_asset', { source: {} })).text).toContain('必须且只能给一个')
    expect(
      (await rpc('import_asset', { source: { url: 'http://x.test/a', base64: 'AAAA' } })).text,
    ).toContain('必须且只能给一个')
  })

  it('base64 超过 8 MiB 拒绝', async () => {
    const big = Buffer.alloc(8 * 1024 * 1024 + 10, 1).toString('base64')
    const r = await rpc('import_asset', { source: { base64: big } })
    expect(r.error).toBe(true)
    expect(r.text).toMatch(/8 MiB|参数不对/)
  })

  it('非图片文件入库但不能摆上画布', async () => {
    const r = await rpc('import_asset', {
      source: { base64: Buffer.from('hello').toString('base64'), name: 'a.txt' },
      place: {},
    })
    const out = asJson(r)
    expect(out.kind).toBe('file')
    expect(out.element_id).toBeUndefined()
    expect(out.reason).toContain('不能直接放上画布')
  })

  it('path：目录内可读，符号链接逃逸、隐藏目录、数据目录和目录外被拒', async () => {
    writeFileSync(join(root, 'a.png'), await png())
    writeFileSync(join(outside, 'o.png'), await png())
    mkdirSync(join(root, '.ssh'))
    writeFileSync(join(root, '.ssh', 'k.png'), await png())
    symlinkSync(join(outside, 'o.png'), join(root, 'link.png'))
    const ok = await rpc('import_asset', { source: { path: join(root, 'a.png') } })
    expect(ok.error).toBe(false)
    expect(asJson(ok).kind).toBe('image')
    for (const p of [
      join(outside, 'o.png'),
      join(root, 'link.png'),
      join(root, '.ssh', 'k.png'),
      join(running.dataDir, 'external-mcp.json'),
      '/etc/passwd',
      'relative.png',
    ]) {
      const r = await rpc('import_asset', { source: { path: p } })
      expect(r.error, p).toBe(true)
    }
  })

  it('path 在没有本机授权的入口不可用', async () => {
    const { server } = await bootServer()
    server.files!.local = undefined
    const { token } = (await (
      await request(server, '/api/mcp/external', { method: 'POST' })
    ).json()) as {
      token: string
    }
    const { id } = await createCanvas(server)
    const res = await server.app.request('/mcp', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:8787',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'import_asset',
          arguments: { canvas_id: id, source: { path: join(root, 'a.png') } },
        },
      }),
    })
    const r = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError: boolean }
    }
    expect(r.result.isError).toBe(true)
    expect(r.result.content[0]!.text).toContain('只在本机模式可用')
  })

  it('url：内网、回环、重定向到内网都拒绝；公网放行（测试里换解析）', async () => {
    for (const url of [
      'http://127.0.0.1:9/a.png',
      'http://169.254.169.254/x',
      'file:///etc/passwd',
    ]) {
      const r = await rpc('import_asset', { source: { url } })
      expect(r.error, url).toBe(true)
    }
    const body = await png()
    const srv = http.createServer((req, res) => {
      if (req.url === '/redir') {
        res.writeHead(302, { location: 'http://10.0.0.1/secret' })
        return res.end()
      }
      if (req.url === '/huge') {
        res.writeHead(200, { 'content-type': 'image/png' })
        return res.end(Buffer.alloc(3000))
      }
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(body)
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as AddressInfo).port
    const { files } = running.server
    const saved = files!.remote
    files!.remote = {
      allowAddress: (ip) => ip === '127.0.0.1' || !ip.startsWith('10.'),
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    }
    try {
      const ok = await rpc('import_asset', { source: { url: `http://pub.test:${port}/p.png` } })
      expect(ok.error).toBe(false)
      expect(asJson(ok).kind).toBe('image')
      const redir = await rpc('import_asset', { source: { url: `http://pub.test:${port}/redir` } })
      expect(redir.error).toBe(true)
      expect(redir.text).toMatch(/内网|本机/)
    } finally {
      files!.remote = saved
      srv.close()
    }
  })
})

describe('request_upload 与上传端点', () => {
  const upload = (url: string, body: Buffer | string, method = 'PUT') => {
    const u = new URL(url)
    return running.server.app.request(u.pathname, {
      method,
      headers: { host: '127.0.0.1:8787', 'content-type': 'application/octet-stream' },
      body,
    })
  }

  it('票据上传一次成功，再用同一票据 404，且带回 asset_id', async () => {
    const data = await png('#aa2200')
    const t = asJson(
      await rpc('request_upload', { name: 'u.png', mime: 'image/png', size: data.length }),
    )
    expect(t.url).toMatch(/\/mcp\/upload\//)
    expect(t.max_bytes).toBe(data.length)
    const res = await upload(t.url, data)
    expect(res.status).toBe(201)
    const out = (await res.json()) as { asset_id: string; mime: string; name: string }
    expect(out.mime).toBe('image/png')
    expect(out.name).toBe('u.png')
    expect(running.server.assets.get('local', out.asset_id)).toBeTruthy()
    expect((await upload(t.url, data)).status).toBe(404)
  })

  it('超过票据声明的大小 413，且票据同样作废', async () => {
    const t = asJson(await rpc('request_upload', { name: 'x.bin', mime: 'image/png', size: 10 }))
    const res = await upload(t.url, Buffer.alloc(100))
    expect(res.status).toBe(413)
    expect((await upload(t.url, Buffer.alloc(5))).status).toBe(404)
  })

  it('实际数据流超过票据上限（无 Content-Length）也被拒绝', async () => {
    const t = asJson(await rpc('request_upload', { name: 'x.bin', mime: 'image/png', size: 10 }))
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(50))
        c.close()
      },
    })
    const u = new URL(t.url)
    const res = await running.server.app.request(u.pathname, {
      method: 'POST',
      headers: { host: '127.0.0.1:8787' },
      body: stream,
      duplex: 'half',
    } as RequestInit)
    expect(res.status).toBe(413)
  })

  it('伪造票据 404；过期票据 404', async () => {
    expect((await upload('http://127.0.0.1:8787/mcp/upload/forged', 'x')).status).toBe(404)
    const t = asJson(await rpc('request_upload', { name: 'x.bin', mime: 'image/png', size: 10 }))
    const ticket = t.url.split('/').pop() as string
    // 把票据的过期时间推到过去
    const tickets = running.server.files!.tickets as unknown as {
      uploads: Map<string, { expires: number }>
    }
    for (const v of tickets.uploads.values()) v.expires = 0
    expect((await upload(`http://x/mcp/upload/${ticket}`, Buffer.alloc(5))).status).toBe(404)
  })

  it('声明大小超过服务端上限时不签发', async () => {
    const r = await rpc('request_upload', { name: 'big.mp4', mime: 'video/mp4', size: 1e13 })
    expect(r.error).toBe(true)
    expect(r.text).toContain('上限')
  })
})

describe('取出文件', () => {
  const get = (
    url: string,
    init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {},
  ) =>
    running.server.app.request(new URL(url).pathname, {
      ...init,
      headers: { host: '127.0.0.1:8787', ...init.headers },
    })
  const importPng = async (color: string) => {
    const r = await rpc('import_asset', {
      source: { base64: (await png(color)).toString('base64'), name: `${color.slice(1)}.png` },
    })
    return asJson(r).asset_id
  }

  it('download_asset 返回 resource_link 与带票据的绝对地址，票据 GET 免令牌、可重复、支持 Range', async () => {
    const assetId = await importPng('#11aa11')
    const r = await rpc('download_asset', { id: assetId })
    expect(r.error).toBe(false)
    const link = r.content.find((c) => c.type === 'resource_link')!
    expect(link.uri).toMatch(/^http:\/\/.+\/mcp\/files\/[\w-]+$/)
    expect(link.mimeType).toBe('image/png')
    expect(JSON.parse(r.text).download_url).toBe(link.uri)
    const first = await get(link.uri!)
    expect(first.status).toBe(200)
    expect(first.headers.get('content-disposition')).toContain('attachment')
    expect((await first.arrayBuffer()).byteLength).toBe(
      running.server.assets.get('local', assetId)!.size,
    )
    const ranged = await get(link.uri!, { headers: { range: 'bytes=0-3' } })
    expect(ranged.status).toBe(206)
    expect((await get(link.uri!)).status).toBe(200)
  })

  it('download_asset ids 逐个返回结果：失败项带 error，id 与 ids 二选一', async () => {
    const a = await importPng('#a1a1a1')
    const b = await importPng('#b2b2b2')
    const missing = 'f'.repeat(64)
    const r = await rpc('download_asset', { ids: [a, missing, b] })
    expect(r.error).toBe(false)
    const items = JSON.parse(r.text).items as Array<{
      asset_id: string
      download_url?: string
      error?: string
    }>
    expect(items.map((i) => i.asset_id)).toEqual([a, missing, b])
    expect(items[0]!.download_url).toContain('/mcp/files/')
    expect(items[1]!.error).toContain('不存在')
    expect(r.content.filter((c) => c.type === 'resource_link')).toHaveLength(2)
    expect((await get(items[2]!.download_url!)).status).toBe(200)
    expect((await rpc('download_asset', { id: a, ids: [b] })).error).toBe(true)
    expect((await rpc('download_asset', {})).error).toBe(true)
    expect((await rpc('download_asset', { ids: [a], save_to: join(root, 'x.png') })).error).toBe(
      true,
    )
  })

  it('get_asset 在外部入口也返回票据地址与 resource_link', async () => {
    const assetId = await importPng('#22bb22')
    const r = await rpc('perform_canvas_action', { action: 'get_asset', input: { id: assetId } })
    expect(r.content.some((c) => c.type === 'resource_link')).toBe(true)
    const info = JSON.parse(r.text) as { download_url: string; metadata: { id: string } }
    expect(info.download_url).toContain('/mcp/files/')
    expect(info.metadata.id).toBe(assetId)
  })

  it('不存在的资产不签发票据', async () => {
    const r = await rpc('download_asset', { id: 'f'.repeat(64) })
    expect(r.error).toBe(true)
  })

  it('票据绑定用户：换成别人的 owner 取不到；伪造与过期票据 404', async () => {
    const assetId = await importPng('#33cc33')
    const { tickets } = running.server.files!
    const other = tickets.issueDownload('someone-else', { kind: 'asset', assetId })
    expect((await get(other.url)).status).toBe(404)
    expect((await get('http://x/mcp/files/forged')).status).toBe(404)
    const mine = tickets.issueDownload('local', { kind: 'asset', assetId })
    expect((await get(mine.url)).status).toBe(200)
    const store = tickets as unknown as { downloads: Map<string, { expires: number }> }
    for (const v of store.downloads.values()) v.expires = 0
    expect((await get(mine.url)).status).toBe(404)
  })

  it('下载票据只读：不接受上传类方法', async () => {
    const assetId = await importPng('#44dd44')
    const t = running.server.files!.tickets.issueDownload('local', { kind: 'asset', assetId })
    for (const method of ['PUT', 'POST', 'DELETE'])
      expect([404, 405]).toContain((await get(t.url, { method, body: 'x' })).status)
  })

  it('save_to：目录内可保存且不覆盖；目录外、隐藏目录、已有文件被拒', async () => {
    const assetId = await importPng('#55ee55')
    const target = join(root, 'saved.png')
    const ok = await rpc('download_asset', { id: assetId, save_to: target })
    expect(ok.error).toBe(false)
    expect(JSON.parse(ok.text).saved_to).toBe(join(realpathSync(root), 'saved.png'))
    expect(readFileSync(target).length).toBe(running.server.assets.get('local', assetId)!.size)
    for (const p of [
      target,
      join(outside, 'x.png'),
      join(root, '.ssh', 'x.png'),
      join(root, 'dirlink', 'x.png'),
    ]) {
      const r = await rpc('download_asset', { id: assetId, save_to: p })
      expect(r.error, p).toBe(true)
    }
  })

  it('export_sequence_project 返回可下载的票据地址', async () => {
    const assetId = await importPng('#66ff66')
    const r = await rpc('perform_canvas_action', {
      action: 'export_sequence_project',
      input: {
        spec: {
          width: 64,
          height: 48,
          fps: 24,
          name: 'cut',
          clips: [{ asset: { assetId, kind: 'image' }, in: 0, out: 1, volume: 1 }],
          audio: [],
        },
      },
    })
    expect(r.error).toBe(false)
    const link = r.content.find((c) => c.type === 'resource_link')!
    expect(link.uri).toContain('/mcp/files/')
    expect(link.mimeType).toBe('application/zip')
    // 只登记过的内部路径可被代理：票据背后确实是导出路由
    const res = await get(link.uri!, { method: 'HEAD' })
    expect(res.status).toBe(200)
  })
})

describe('项目包导出与导入', () => {
  const get = (url: string) =>
    running.server.app.request(new URL(url).pathname, { headers: { host: '127.0.0.1:8787' } })
  const projectOf = async () =>
    (
      (await (await request(running.server, `/api/canvases/${canvasId}`)).json()) as {
        projectId: string
      }
    ).projectId
  const projectCount = async () =>
    ((await (await request(running.server, '/api/projects')).json()) as unknown[]).length
  const act = (action: string, input: Record<string, unknown>) =>
    rpc('perform_canvas_action', { action, input })

  it('export_project_package 返回 .plein 下载票据；import_project_package 经资产或本机路径导入', async () => {
    const projectId = await projectOf()
    const exported = await act('export_project_package', { project_id: projectId })
    expect(exported.error).toBe(false)
    const info = JSON.parse(exported.text) as { download_url: string; name: string }
    expect(info.name.endsWith('.plein')).toBe(true)
    expect(exported.content.some((c) => c.type === 'resource_link')).toBe(true)
    const res = await get(info.download_url)
    expect(res.status).toBe(200)
    const pkg = Buffer.from(await res.arrayBuffer())

    // 本机路径
    const file = join(root, 'proj.plein')
    writeFileSync(file, pkg)
    const before = await projectCount()
    const preview = await act('import_project_package', { path: file, preview_only: true })
    expect(preview.error).toBe(false)
    expect(JSON.parse(preview.text).status).toBe('preview')
    expect(await projectCount()).toBe(before)
    const done = await act('import_project_package', { path: file })
    expect(done.error).toBe(false)
    const out = JSON.parse(done.text) as { status: string; project_id: string; copy: boolean }
    expect(out.status).toBe('imported')
    expect(out.copy).toBe(true)
    expect(out.project_id).not.toBe(projectId)
    expect(await projectCount()).toBe(before + 1)

    // 已上传的资产
    const asset = asJson(
      await rpc('import_asset', { source: { base64: pkg.toString('base64'), name: 'p.plein' } }),
    )
    const again = await act('import_project_package', { asset_id: asset.asset_id })
    expect(JSON.parse(again.text).status).toBe('imported')
  })

  it('导入：来源必须二选一，不是项目包时给出原因，缺失项目导出失败', async () => {
    expect((await act('import_project_package', {})).error).toBe(true)
    const junk = join(root, 'junk.plein')
    writeFileSync(junk, 'not a zip')
    const bad = await act('import_project_package', { path: junk })
    expect(bad.error).toBe(true)
    expect((await act('export_project_package', { project_id: 'pj_missing' })).error).toBe(true)
  })
})
