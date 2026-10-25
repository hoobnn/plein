import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PluginManifest } from '@plein/plugin-sdk'
import { describe, expect, it, vi } from 'vite-plus/test'
import { bootServer } from '../testing'
import { ExternalPlugins } from './external'
import { PluginProcess } from './process'

const failure = vi.hoisted(() => ({ writing: false }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof writeFileSync>) => {
      if (failure.writing && String(args[0]).includes('.plugins-state-')) {
        fs.writeFileSync(args[0], 'partial')
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
      }
      return fs.writeFileSync(...args)
    },
  }
})

const disk = {
  id: 'acme/contracts',
  name: '清单合同测试',
  version: '1.0.0',
  engines: { plein: '^0.1.0' },
  main: { server: 'server.mjs' },
}
function writePlugin(root: string, manifest = disk) {
  const dir = join(root, 'contracts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plein-plugin.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'server.mjs'), 'throw new Error("test uses descriptor stub")')
}

describe('插件状态与确认合同', () => {
  it('状态写入 ENOSPC 保留旧文件和内存启用意图，清理临时半文件', async () => {
    const f = await bootServer()
    const root = join(f.dataDir, 'plugins')
    writePlugin(root)
    const file = join(f.dataDir, 'plugins-state.json')
    const original = JSON.stringify({ enabled: ['acme/contracts', 'acme/stale'] })
    writeFileSync(file, original)
    const ext = new ExternalPlugins(f.server.plugins, root, file)
    ext.scan() // 不执行入口，只检查状态持久化。
    failure.writing = true
    try {
      await expect(ext.setEnabled('acme/contracts', false)).rejects.toThrow('ENOSPC')
      expect(ext.list()[0]?.enabled).toBe(true)
      expect(() => ext.prepareInstall('acme/stale')).toThrow('ENOSPC')
      expect(readFileSync(file, 'utf8')).toBe(original)
      expect(readdirSync(f.dataDir).filter((name) => name.startsWith('.plugins-state-'))).toEqual(
        [],
      )
    } finally {
      failure.writing = false
      ext.close()
    }
    // 保存成功后仍可停用旧插件；失败没有使内存和磁盘永久分叉。
    await ext.setEnabled('acme/contracts', false)
    expect(JSON.parse(readFileSync(file, 'utf8')).enabled).toEqual(['acme/stale'])
  })

  it('同 ID 入口不能更改用户看到的权限、贡献、版本、API 或入口合同', async () => {
    const alternatives = [
      { ...disk, permissions: { network: ['example.com'], assets: 'read' } },
      { ...disk, contributes: { nodes: ['acme/extra@1'] } },
      { ...disk, version: '2.0.0' },
      { ...disk, engines: { plein: '*' } },
      { ...disk, main: { server: 'other.mjs' } },
    ]
    for (const manifest of alternatives) {
      const f = await bootServer()
      const root = join(f.dataDir, 'plugins')
      writePlugin(root)
      const ext = new ExternalPlugins(f.server.plugins, root, join(f.dataDir, 'plugins-state.json'))
      ext.scan()
      const request = vi.spyOn(PluginProcess.prototype, 'request').mockResolvedValue({
        rpc: 1,
        manifest,
        sandbox: { permission: true, fsWrite: false, net: false },
        nodes: [],
        executors: [],
        providers: [],
        prompts: [],
        templates: [],
        elements: 0,
        capabilities: 0,
      })
      try {
        expect(await ext.setEnabled(disk.id, true)).toMatchObject({
          status: 'error',
          error: expect.stringContaining('清单与已确认的磁盘清单不一致'),
        })
        expect(f.server.plugins.registry.plugin(disk.id)).toBeUndefined()
      } finally {
        request.mockRestore()
        ext.close()
      }
    }
  })
  it('清单按 schema 补默认值并稳定排序后相等，允许正常注册', async () => {
    const f = await bootServer()
    const root = join(f.dataDir, 'plugins')
    writePlugin(root)
    const ext = new ExternalPlugins(f.server.plugins, root, join(f.dataDir, 'plugins-state.json'))
    ext.scan()
    const normalized = PluginManifest.parse(disk)
    const request = vi.spyOn(PluginProcess.prototype, 'request').mockResolvedValue({
      rpc: 1,
      manifest: { ...normalized, engines: { ...normalized.engines } },
      sandbox: { permission: true, fsWrite: false, net: false },
      nodes: [],
      executors: [],
      providers: [],
      prompts: [],
      templates: [],
      elements: 0,
      capabilities: 0,
    })
    try {
      expect(await ext.setEnabled(disk.id, true)).toMatchObject({ status: 'active', enabled: true })
    } finally {
      request.mockRestore()
      ext.close()
    }
  })
})
