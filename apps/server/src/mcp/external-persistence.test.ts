import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vite-plus/test'
import { tempDir } from '../testing'
import { ExternalMcp } from './external'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
    rmSync: vi.fn(actual.rmSync),
  }
})

function fixture() {
  const dataDir = tempDir('plein-mcp-persistence-')
  const mcp = new ExternalMcp(dataDir, undefined as never)
  const file = join(dataDir, 'external-mcp.json')
  return { mcp, file }
}

it.each([writeFileSync, renameSync])(
  'issue 持久化失败保留旧令牌、旧状态和旧磁盘文件，成功重试才轮换 (%#)',
  (persist) => {
    const { mcp, file } = fixture()
    const old = mcp.issue('local')
    const status = mcp.status()
    const disk = readFileSync(file, 'utf8')
    vi.mocked(persist).mockImplementationOnce(() => {
      throw new Error('注入写盘失败')
    })

    expect(() => mcp.issue('local')).toThrow('注入写盘失败')
    expect(mcp.status()).toEqual(status)
    expect(mcp.matches(old.token)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(disk)

    const next = mcp.issue('local')
    expect(mcp.matches(next.token)).toBe(true)
    expect(mcp.matches(old.token)).toBe(false)
  },
)

it('revoke 删除失败仍 enabled 且原令牌可用，成功重试才关闭', () => {
  const { mcp, file } = fixture()
  const old = mcp.issue('local')
  const disk = readFileSync(file, 'utf8')
  vi.mocked(rmSync).mockImplementationOnce(() => {
    throw new Error('注入删除失败')
  })

  expect(() => mcp.revoke()).toThrow('注入删除失败')
  expect(mcp.status().enabled).toBe(true)
  expect(mcp.matches(old.token)).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe(disk)

  mcp.revoke()
  expect(mcp.status()).toEqual({ enabled: false })
  expect(mcp.matches(old.token)).toBe(false)
})
