import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { tempDir } from '../testing'
import { isBlockedAddress } from './address'
import { type LocalAccess, localAccess, openLocalFile, resolveSaveTarget } from './local-path'
import { fetchRemote } from './remote'
import { FileTickets } from './tickets'

describe('地址检查', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '64:ff9b::10.0.0.1',
    'not-an-ip',
  ])('拒绝 %s', (ip) => expect(isBlockedAddress(ip)).toBe(true))

  it.each(['8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111'])(
    '放行公网 %s',
    (ip) => expect(isBlockedAddress(ip)).toBe(false),
  )
})

describe('远程下载', () => {
  const servers: http.Server[] = []
  afterEach(() => {
    for (const s of servers.splice(0)) s.close()
  })
  const serve = async (handler: http.RequestListener) => {
    const s = http.createServer(handler)
    servers.push(s)
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    return (s.address() as AddressInfo).port
  }
  const read = async (stream: AsyncIterable<Buffer>) => {
    const parts: Buffer[] = []
    for await (const c of stream) parts.push(c)
    return Buffer.concat(parts)
  }
  // 测试服务器在回环上：放行 127.0.0.1，其余沿用真实规则
  const allowLoopback = (ip: string) => ip === '127.0.0.1' || !isBlockedAddress(ip)

  it('默认拒绝回环、内网与元数据地址', async () => {
    for (const url of [
      'http://127.0.0.1:1/',
      'http://localhost:1/',
      'http://10.0.0.5/x',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]:1/',
      'http://[::ffff:127.0.0.1]/',
    ])
      await expect(fetchRemote(url, { maxBytes: 1024 })).rejects.toThrow(/内网|本机/)
  })

  it('只允许 http / https，不允许内嵌账号密码', async () => {
    await expect(fetchRemote('file:///etc/passwd', { maxBytes: 1024 })).rejects.toThrow('http')
    await expect(fetchRemote('ftp://example.com/a', { maxBytes: 1024 })).rejects.toThrow('http')
    await expect(fetchRemote('http://u:p@example.com/a', { maxBytes: 1024 })).rejects.toThrow(
      '账号密码',
    )
  })

  it('域名解析到内网地址时拒绝，且连接前校验（防 DNS 换解析）', async () => {
    await expect(
      fetchRemote('http://evil.test/a', {
        maxBytes: 1024,
        lookup: async () => [{ address: '10.0.0.8', family: 4 }],
      }),
    ).rejects.toThrow(/内网|本机/)
    // 混合解析结果里只要有一个内网地址就拒绝
    await expect(
      fetchRemote('http://mixed.test/a', {
        maxBytes: 1024,
        lookup: async () => [
          { address: '8.8.8.8', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
      }),
    ).rejects.toThrow(/内网|本机/)
  })

  it('下载成功并带回类型与长度', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png; charset=x', 'content-length': '5' })
      res.end('hello')
    })
    const file = await fetchRemote(`http://127.0.0.1:${port}/a.png`, {
      maxBytes: 1024,
      allowAddress: allowLoopback,
    })
    expect(file.mime).toBe('image/png')
    expect((await read(file.body)).toString()).toBe('hello')
  })

  it('重定向逐跳检查：跳到内网被拒', async () => {
    const port = await serve((req, res) => {
      if (req.url === '/to-meta') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' })
        return res.end()
      }
      if (req.url === '/to-local') {
        res.writeHead(302, { location: 'http://10.0.0.1:8787/api/health' })
        return res.end()
      }
      if (req.url === '/ok') {
        res.writeHead(302, { location: '/final' })
        return res.end()
      }
      res.writeHead(200, { 'content-length': '2' })
      res.end('ok')
    })
    const opts = { maxBytes: 1024, allowAddress: allowLoopback }
    await expect(fetchRemote(`http://127.0.0.1:${port}/to-meta`, opts)).rejects.toThrow(/内网|本机/)
    await expect(fetchRemote(`http://127.0.0.1:${port}/to-local`, opts)).rejects.toThrow(
      /内网|本机/,
    )
    const ok = await fetchRemote(`http://127.0.0.1:${port}/ok`, opts)
    expect((await read(ok.body)).toString()).toBe('ok')
  })

  it('重定向次数有上限', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(302, { location: '/again' })
      res.end()
    })
    await expect(
      fetchRemote(`http://127.0.0.1:${port}/`, {
        maxBytes: 1024,
        allowAddress: allowLoopback,
        maxRedirects: 3,
      }),
    ).rejects.toThrow('重定向次数过多')
  })

  it('声明长度或实际流超过上限都拒绝', async () => {
    const port = await serve((req, res) => {
      if (req.url === '/declared') {
        res.writeHead(200, { 'content-length': '5000' })
        return res.end('x'.repeat(5000))
      }
      // 不声明长度（chunked），实际一直发
      res.writeHead(200)
      res.write('x'.repeat(4000))
      res.end('x'.repeat(4000))
    })
    const opts = { maxBytes: 1000, allowAddress: allowLoopback }
    await expect(fetchRemote(`http://127.0.0.1:${port}/declared`, opts)).rejects.toThrow('上限')
    const streamed = await fetchRemote(`http://127.0.0.1:${port}/chunked`, opts)
    await expect(read(streamed.body)).rejects.toThrow('上限')
  })

  it('超时中止', async () => {
    const port = await serve(() => {
      // 永不应答
    })
    await expect(
      fetchRemote(`http://127.0.0.1:${port}/`, {
        maxBytes: 1000,
        allowAddress: allowLoopback,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('超时')
  })
})

describe('本机路径', () => {
  const setup = async () => {
    const root = tempDir('plein-root-')
    const outside = tempDir('plein-outside-')
    const data = join(root, 'plein-data')
    mkdirSync(data)
    writeFileSync(join(data, 'secret.json'), 'token')
    writeFileSync(join(root, 'a.png'), 'png')
    writeFileSync(join(outside, 'o.txt'), 'out')
    mkdirSync(join(root, '.ssh'))
    writeFileSync(join(root, '.ssh', 'id'), 'key')
    symlinkSync(join(outside, 'o.txt'), join(root, 'link.txt'))
    symlinkSync(outside, join(root, 'dirlink'))
    const access: LocalAccess = await localAccess(data, [root])
    return { root, outside, data, access }
  }

  it('读取允许目录内的普通文件', async () => {
    const { root, access } = await setup()
    const f = await openLocalFile(access, join(root, 'a.png'), 1024)
    expect(f.size).toBe(3)
    expect(f.name).toBe('a.png')
    await f.handle.close()
  })

  it('拒绝目录外、符号链接逃逸、隐藏目录、数据目录、相对路径、超限', async () => {
    const { root, outside, data, access } = await setup()
    await expect(openLocalFile(access, join(outside, 'o.txt'), 1024)).rejects.toThrow('不在允许')
    await expect(openLocalFile(access, join(root, 'link.txt'), 1024)).rejects.toThrow('不在允许')
    await expect(openLocalFile(access, join(root, 'dirlink', 'o.txt'), 1024)).rejects.toThrow(
      '不在允许',
    )
    await expect(openLocalFile(access, join(root, '..', 'x'), 1024)).rejects.toThrow()
    await expect(openLocalFile(access, join(root, '.ssh', 'id'), 1024)).rejects.toThrow('隐藏')
    await expect(openLocalFile(access, join(data, 'secret.json'), 1024)).rejects.toThrow('数据目录')
    await expect(openLocalFile(access, 'a.png', 1024)).rejects.toThrow('绝对路径')
    await expect(openLocalFile(access, root, 1024)).rejects.toThrow('普通文件')
    await expect(openLocalFile(access, join(root, 'a.png'), 2)).rejects.toThrow('上限')
    await expect(openLocalFile(access, join(root, 'missing'), 1024)).rejects.toThrow('不存在')
  })

  it('写入目标：不覆盖、不出目录、不写隐藏目录', async () => {
    const { root, outside, access } = await setup()
    expect(await resolveSaveTarget(access, join(root, 'new.png'))).toBe(
      join(access.roots[0]!, 'new.png'),
    )
    await expect(resolveSaveTarget(access, join(root, 'a.png'))).rejects.toThrow('已存在')
    await expect(resolveSaveTarget(access, join(root, 'link.txt'))).rejects.toThrow()
    await expect(resolveSaveTarget(access, join(root, 'dirlink', 'x.png'))).rejects.toThrow(
      '不在允许',
    )
    await expect(resolveSaveTarget(access, join(outside, 'x.png'))).rejects.toThrow('不在允许')
    await expect(resolveSaveTarget(access, join(root, '.ssh', 'authorized'))).rejects.toThrow(
      '隐藏',
    )
    await expect(resolveSaveTarget(access, join(root, 'nodir', 'x.png'))).rejects.toThrow(
      '目录不存在',
    )
  })
})

describe('文件票据', () => {
  const grant = { ownerId: 'u1', name: 'a.png', mime: 'image/png', maxBytes: 100 }

  it('上传票据一次性，用过即作废', () => {
    const t = new FileTickets()
    const { ticket } = t.issueUpload(grant)
    expect(t.takeUpload(ticket)).toEqual(grant)
    expect(t.takeUpload(ticket)).toBeNull()
    expect(t.takeUpload('nope')).toBeNull()
  })

  it('上传票据过期后不可用', () => {
    let now = 1000
    const t = new FileTickets({ now: () => now, uploadTtlMs: 60_000 })
    const { ticket, expires } = t.issueUpload(grant)
    expect(expires).toBe(61_000)
    now += 60_000
    expect(t.takeUpload(ticket)).toBeNull()
  })

  it('下载票据过期前可重复读取，过期后失效，并绑定用户', () => {
    let now = 0
    const t = new FileTickets({ now: () => now, downloadTtlMs: 1000 })
    const { ticket } = t.issueDownload('u1', { kind: 'asset', assetId: 'a'.repeat(64) })
    expect(t.getDownload(ticket)?.ownerId).toBe('u1')
    expect(t.getDownload(ticket)?.ownerId).toBe('u1')
    now = 1000
    expect(t.getDownload(ticket)).toBeNull()
  })

  it('代理下载只放行登记的内部路径', () => {
    const t = new FileTickets()
    expect(() => t.issueDownload('u1', { kind: 'proxy', path: '/api/canvases' })).toThrow()
    expect(() =>
      t.issueDownload('u1', { kind: 'proxy', path: '/api/media/sequence-export/../../x' }),
    ).toThrow()
    expect(
      t.issueDownload('u1', { kind: 'proxy', path: '/api/media/sequence-export/abc-123' }).ticket,
    ).toBeTruthy()
  })

  it('同一用户未使用的上传票据有数量上限', () => {
    const t = new FileTickets({ maxOutstanding: 2 })
    t.issueUpload(grant)
    t.issueUpload(grant)
    expect(() => t.issueUpload(grant)).toThrow('太多')
    expect(() => t.issueUpload({ ...grant, ownerId: 'u2' })).not.toThrow()
  })

  it('URL 用最近一次来源拼出绝对地址，配置了 publicUrl 时以它为准', () => {
    const t = new FileTickets({ fallbackOrigin: () => 'http://127.0.0.1:9' })
    expect(t.uploadUrl('x')).toBe('http://127.0.0.1:9/mcp/upload/x')
    t.noteOrigin('http://localhost:5555')
    expect(t.downloadUrl('x')).toBe('http://localhost:5555/mcp/files/x')
    expect(new FileTickets({ publicUrl: 'https://p.example/' }).downloadUrl('x')).toBe(
      'https://p.example/mcp/files/x',
    )
  })
})
