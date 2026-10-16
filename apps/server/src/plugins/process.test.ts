import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { tempDir } from '../testing'
import { PluginProcess } from './process'

const PERMISSION =
  process.allowedNodeEnvironmentFlags.has('--permission') ||
  process.allowedNodeEnvironmentFlags.has('--experimental-permission')

const fixture = `
import { readFileSync, writeFileSync } from 'node:fs'
process.on('message', (m) => {
  if (m.t !== 'req') return
  const denied = (fn) => {
    try { fn(); return false }
    catch (e) { return e.code === 'ERR_ACCESS_DENIED' }
  }
  process.send({ t: 'res', id: m.id, ok: true, value: {
    own: readFileSync(new URL('./own.txt', import.meta.url), 'utf8'),
    outsideDenied: denied(() => readFileSync(m.params.outside, 'utf8')),
    writeDenied: denied(() => writeFileSync(new URL('./written.txt', import.meta.url), 'no')),
  } })
})
`

describe('插件进程路径与读取权限', () => {
  it.skipIf(!PERMISSION)('符号链接目录能启动，只能读取插件自身且不能写文件', async () => {
    const root = realpathSync(tempDir('plein-plugin-process-'))
    const dir = join(root, 'plugin')
    const alias = join(root, 'alias')
    mkdirSync(dir)
    writeFileSync(join(dir, 'server.mjs'), fixture)
    writeFileSync(join(dir, 'own.txt'), 'plugin data')
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'host data')
    symlinkSync(dir, alias, 'dir')
    const proc = new PluginProcess('test/alias', alias, join(alias, 'server.mjs'), () => {})
    try {
      expect(await proc.request('probe', { outside }, { timeoutMs: 3_000 })).toEqual({
        own: 'plugin data',
        outsideDenied: true,
        writeDenied: true,
      })
    } finally {
      proc.kill()
    }
  })

  it('入口经符号链接指向目录外时，在创建进程前拒绝', async () => {
    const root = tempDir('plein-plugin-entry-')
    const dir = join(root, 'plugin')
    mkdirSync(dir)
    const outside = join(root, 'outside.mjs')
    writeFileSync(outside, fixture)
    const entry = join(dir, 'server.mjs')
    symlinkSync(outside, entry)
    const proc = new PluginProcess('test/outside', dir, entry, () => {})
    try {
      await expect(async () => proc.request('probe', {}, { timeoutMs: 3_000 })).rejects.toThrow(
        '插件入口必须在插件目录内',
      )
      expect(proc.running).toBe(false)
    } finally {
      proc.kill()
    }
  })
})
