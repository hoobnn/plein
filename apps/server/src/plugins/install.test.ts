import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { describe, expect, it, onTestFinished, vi } from 'vite-plus/test'
import { bootServer, tempDir } from '../testing'
import { ExternalPlugins } from './external'
import { PluginInstaller } from './install'

const manifest = {
  id: 'acme/pack',
  version: '1.0.0',
  name: '安装测试插件',
  engines: { plein: '^0.1.0' },
  main: { server: 'dist/server.mjs' },
  contributes: { nodes: ['acme/echo@1'] },
  permissions: { network: ['example.com'], secrets: ['ACME_TOKEN'], assets: 'read' },
}
const entry = 'throw new Error("预检和安装不能执行此文件");'
const zip = (extra: Record<string, Uint8Array> = {}, m: object = manifest, prefix = '') =>
  Buffer.from(
    zipSync(
      {
        [`${prefix}plein-plugin.json`]: Buffer.from(JSON.stringify(m)),
        [`${prefix}dist/server.mjs`]: Buffer.from(entry),
        ...extra,
      },
      { level: 0 },
    ),
  )

function central(data: Buffer, name: string) {
  for (let p = 0; p + 46 < data.length; p++)
    if (data.readUInt32LE(p) === 0x02014b50) {
      const length = data.readUInt16LE(p + 28)
      if (data.toString('utf8', p + 46, p + 46 + length) === name) return p
    }
  throw new Error(`找不到条目 ${name}`)
}
async function setup(clock?: () => number) {
  const f = await bootServer()
  const ext = new ExternalPlugins(
    f.server.plugins,
    join(f.dataDir, 'plugins'),
    join(f.dataDir, 'plugins-state.json'),
  )
  await ext.init()
  const service = new PluginInstaller(
    f.dataDir,
    ext,
    (id) => !!f.server.plugins.registry.plugin(id),
    clock,
  )
  onTestFinished(async () => {
    await service.close()
    ext.close()
  })
  return { ...f, ext, service }
}

describe('本机插件 ZIP 安装', () => {
  it('预检返回贡献权限，不执行入口；确认后完整落盘并默认禁用，重用令牌被拒绝', async () => {
    const f = await setup()
    const p = await f.service.preview(zip(), 'owner')
    expect(p.manifest.permissions.secrets).toEqual(['ACME_TOKEN'])
    expect(p.manifest.contributes.nodes).toEqual(['acme/echo@1'])
    expect(f.ext.list()).toEqual([])
    const info = await f.service.install(p.token, 'owner')
    expect(info).toMatchObject({ id: 'acme/pack', enabled: false, status: 'disabled' })
    expect(await readFile(join(info.dir, 'dist/server.mjs'), 'utf8')).toBe(entry)
    expect(await readdir(join(f.dataDir, 'plugin-installs'))).toEqual([])
    await expect(f.service.install(p.token, 'owner')).rejects.toMatchObject({ code: 'expired' })
    await expect(f.service.preview(zip(), 'owner')).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(join(info.dir, 'dist/server.mjs'), 'utf8')).toBe(entry)
  })
  it('允许唯一一层外包装目录，其他目录中的文件不能混入', async () => {
    const f = await setup()
    const p = await f.service.preview(zip({}, manifest, 'package/'), 'owner')
    expect((await f.service.install(p.token, 'owner')).enabled).toBe(false)
    const g = await setup()
    await expect(
      g.service.preview(
        zip({ 'outside.txt': Buffer.from('outside') }, manifest, 'package/'),
        'owner',
      ),
    ).rejects.toMatchObject({ code: 'invalid' })
  })
  it('不同 owner 不能使用或取消令牌，过期确认清理暂存；同 owner 新预检使旧令牌失效', async () => {
    let now = 1_000
    const f = await setup(() => now)
    const a = await f.service.preview(zip(), 'owner-a')
    await f.service.cancel(a.token, 'owner-b')
    await expect(f.service.install(a.token, 'owner-b')).rejects.toMatchObject({ code: 'expired' })
    const b = await f.service.preview(zip(), 'owner-a')
    await expect(f.service.install(a.token, 'owner-a')).rejects.toMatchObject({ code: 'expired' })
    now = b.expiresAt
    await expect(f.service.install(b.token, 'owner-a')).rejects.toMatchObject({ code: 'expired' })
    expect(await readdir(join(f.dataDir, 'plugin-installs'))).toEqual([])
    const c = await f.service.preview(zip(), 'owner-a')
    now = c.expiresAt + 1
    await f.service.preview(zip(), 'owner-b')
    expect(await readdir(join(f.dataDir, 'plugin-installs'))).toHaveLength(1)
  })
  it('并发确认同一令牌最多成功一次；两个独立安装器也不能覆盖同 ID', async () => {
    const f = await setup()
    const p = await f.service.preview(zip(), 'owner')
    const results = await Promise.allSettled([
      f.service.install(p.token, 'owner'),
      f.service.install(p.token, 'owner'),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const g = await setup()
    const second = new PluginInstaller(g.dataDir, g.ext, () => false)
    onTestFinished(() => second.close())
    const a = await g.service.preview(zip(), 'a')
    const b = await second.preview(zip(), 'b')
    const installed = await Promise.allSettled([
      g.service.install(a.token, 'a'),
      second.install(b.token, 'b'),
    ])
    expect(installed.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(g.ext.list()).toHaveLength(1)
    expect(await readdir(join(g.dataDir, 'plugins'))).toHaveLength(1)
  })
  it('预检后原包变化即拒绝，失败不发布目录', async () => {
    const f = await setup()
    const p = await f.service.preview(zip(), 'owner')
    const [dir] = await readdir(join(f.dataDir, 'plugin-installs'))
    await writeFile(
      join(f.dataDir, 'plugin-installs', dir!, 'package.zip'),
      zip({ 'more.txt': Buffer.from('changed') }),
    )
    await expect(f.service.install(p.token, 'owner')).rejects.toMatchObject({ code: 'invalid' })
    expect(await readdir(join(f.dataDir, 'plugins'))).toEqual([])
    expect(await readdir(join(f.dataDir, 'plugin-installs'))).toEqual([])
  })
  it('遗留 enabled 状态不会执行新包；状态保存失败不发布目录', async () => {
    const f = await bootServer()
    const state = join(f.dataDir, 'plugins-state.json')
    await writeFile(state, JSON.stringify({ enabled: ['acme/pack'] }))
    const ext = new ExternalPlugins(f.server.plugins, join(f.dataDir, 'plugins'), state)
    await ext.init()
    const service = new PluginInstaller(f.dataDir, ext, () => false)
    onTestFinished(async () => {
      await service.close()
      ext.close()
    })
    const p = await service.preview(zip(), 'owner')
    expect(await service.install(p.token, 'owner')).toMatchObject({
      enabled: false,
      status: 'disabled',
    })
    expect(JSON.parse(await readFile(state, 'utf8')).enabled).toEqual([])

    const g = await setup()
    const q = await g.service.preview(zip(), 'owner')
    await mkdir(join(g.dataDir, 'plugins-state.json'))
    await expect(g.service.install(q.token, 'owner')).rejects.toThrow()
    expect(await readdir(join(g.dataDir, 'plugins'))).toEqual([])
    expect(await readdir(join(g.dataDir, 'plugin-installs'))).toEqual([])
    expect(g.ext.list()).toEqual([])
  })
  it('发布后立即中断，重新初始化插件也不会因旧 enabled 意图执行新包', async () => {
    const f = await bootServer()
    const state = join(f.dataDir, 'plugins-state.json')
    await writeFile(state, JSON.stringify({ enabled: [manifest.id] }))
    const root = join(f.dataDir, 'plugins')
    const ext = new ExternalPlugins(f.server.plugins, root, state)
    ext.scan()
    const service = new PluginInstaller(f.dataDir, ext, () => false)
    onTestFinished(async () => {
      await service.close()
      ext.close()
    })
    const p = await service.preview(zip(), 'owner')
    const target = join(root, `plugin-${createHash('sha256').update(manifest.id).digest('hex')}`)
    const scan = ext.scan.bind(ext)
    let restarted: Promise<Array<{ enabled: boolean; status: string }>> | undefined
    const intercept = vi.spyOn(ext, 'scan').mockImplementation(() => {
      scan()
      if (!restarted && existsSync(join(target, 'plein-plugin.json'))) {
        // 正处在目录已原子发布、安装响应尚未生成的位置，模拟此刻重启。
        const next = new ExternalPlugins(f.server.plugins, root, state)
        restarted = next.init().then(() => {
          const list = next.list()
          next.close()
          return list
        })
        throw new Error('模拟发布后中断')
      }
    })
    try {
      await expect(service.install(p.token, 'owner')).rejects.toThrow('模拟发布后中断')
      expect(restarted).toBeDefined()
      expect(await restarted).toMatchObject([{ enabled: false, status: 'disabled' }])
      expect(JSON.parse(await readFile(state, 'utf8')).enabled).toEqual([])
      expect(await readdir(root)).toEqual([])
    } finally {
      intercept.mockRestore()
    }
  })
  it('已有安装目录即使为空也不覆盖，符号链接目录也不跟随', async () => {
    const f = await setup()
    const target = join(
      f.dataDir,
      'plugins',
      `plugin-${createHash('sha256').update(manifest.id).digest('hex')}`,
    )
    const p = await f.service.preview(zip(), 'owner')
    await mkdir(target)
    await expect(f.service.install(p.token, 'owner')).rejects.toMatchObject({ code: 'conflict' })
    expect(existsSync(target)).toBe(true)
    const g = await setup()
    const outside = tempDir()
    await symlink(outside, join(g.dataDir, 'plugins'), 'dir')
    await expect(g.service.preview(zip(), 'owner')).rejects.toMatchObject({ code: 'invalid' })
    expect(await readdir(outside)).toEqual([])
  })
  it('拒绝不兼容 API、非法入口、跨命名空间贡献和内置 ID', async () => {
    const f = await setup()
    for (const m of [
      { ...manifest, engines: { plein: '^99.0.0' } },
      { ...manifest, main: { server: '../outside.mjs' } },
      { ...manifest, contributes: { nodes: ['other/echo@1'] } },
      { ...manifest, contributes: { nodes: ['acme/echo@0'] } },
    ])
      await expect(f.service.preview(zip({}, m), 'owner')).rejects.toMatchObject({
        code: 'invalid',
      })
    await expect(
      f.service.preview(zip({}, { ...manifest, id: 'plein/core', contributes: {} }), 'owner'),
    ).rejects.toMatchObject({ code: 'conflict' })
  })
  it('拒绝路径穿越、绝对路径、反斜杠、重复大小写及隐式父目录冲突', async () => {
    const f = await setup()
    const extras: Record<string, Uint8Array>[] = [
      { '../outside.js': Buffer.from('x') },
      { '/absolute.js': Buffer.from('x') },
      { 'C:/drive.js': Buffer.from('x') },
      { 'a\\b.js': Buffer.from('x') },
      { 'DIST/server.mjs': Buffer.from('x') },
      { 'lib/a.js': Buffer.from('x'), 'LIB/b.js': Buffer.from('x') },
      { dist: Buffer.from('x') },
      { 'con.js': Buffer.from('x') },
      { AUX: Buffer.from('x') },
      { 'dir./x.js': Buffer.from('x') },
      { 'file.js ': Buffer.from('x') },
    ]
    for (const extra of extras)
      await expect(f.service.preview(zip(extra), 'owner')).rejects.toMatchObject({
        code: 'invalid',
      })
    expect(existsSync(join(f.dataDir, 'outside.js'))).toBe(false)
  })
  it('拒绝符号链接、加密、ZIP64、不支持压缩方式与重叠条目', async () => {
    const f = await setup()
    for (const alter of [
      (b: Buffer, p: number) => b.writeUInt32LE((0xa1ff << 16) >>> 0, p + 38),
      (b: Buffer, p: number) => b.writeUInt16LE(1, p + 8),
      (b: Buffer, p: number) => b.writeUInt32LE(0xffffffff, p + 24),
      (b: Buffer, p: number) => b.writeUInt16LE(12, p + 10),
      (b: Buffer, p: number) => b.writeUInt32LE(0, p + 42),
    ]) {
      const b = zip()
      alter(b, central(b, 'dist/server.mjs'))
      await expect(f.service.preview(b, 'owner')).rejects.toMatchObject({ code: 'invalid' })
    }
  })
  it('验证真实 CRC 和解压字节数，声明谎报不能绕过限制', async () => {
    const f = await setup()
    const corrupt = zip()
    const at = central(corrupt, 'dist/server.mjs')
    const local = corrupt.readUInt32LE(at + 42)
    const content = local + 30 + corrupt.readUInt16LE(local + 26) + corrupt.readUInt16LE(local + 28)
    corrupt[content] = corrupt[content]! ^ 0xff
    await expect(f.service.preview(corrupt, 'owner')).rejects.toThrow('CRC')
    const forged = zip()
    const p = central(forged, 'dist/server.mjs')
    forged.writeUInt32LE(1, p + 24)
    forged.writeUInt32LE(1, forged.readUInt32LE(p + 42) + 22)
    await expect(f.service.preview(forged, 'owner')).rejects.toThrow('解压体积')
    const bomb = Buffer.from(
      zipSync({
        'plein-plugin.json': Buffer.from(JSON.stringify(manifest)),
        'dist/server.mjs': new Uint8Array(1024 * 1024),
      }),
    )
    await expect(f.service.preview(bomb, 'owner')).rejects.toThrow('压缩比')
    expect(await readdir(join(f.dataDir, 'plugin-installs'))).toEqual([])
  })
})
