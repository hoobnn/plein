import { createHash } from 'node:crypto'
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
  'issue 持久化失败保留旧状态和旧磁盘文件，成功重试才新增，旧令牌不受影响 (%#)',
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
    expect(mcp.matches(old.token)).toBe(true)
    expect(mcp.status().tokens).toHaveLength(2)
  },
)

it('旧的单令牌文件迁移成一枚全权限令牌，原令牌继续可用', () => {
  const dataDir = tempDir('plein-mcp-legacy-')
  const token = 'plein_legacy'
  writeFileSync(
    join(dataDir, 'external-mcp.json'),
    JSON.stringify({
      hash: createHash('sha256').update(token).digest('hex'),
      ownerId: 'local',
      createdAt: 123,
    }),
  )
  const mcp = new ExternalMcp(dataDir, undefined as never)
  expect(mcp.matches(token)).toBe(true)
  expect(mcp.status()).toMatchObject({
    enabled: true,
    createdAt: 123,
    tokens: [{ scopes: ['read', 'edit', 'run', 'destructive'], createdAt: 123 }],
  })
  // 之后新增令牌时才写成新格式，旧令牌保留
  mcp.issue('local', { name: '只读', scopes: ['read'] })
  expect(JSON.parse(readFileSync(join(dataDir, 'external-mcp.json'), 'utf8')).version).toBe(2)
  expect(mcp.matches(token)).toBe(true)
})

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
  expect(mcp.status()).toEqual({ enabled: false, tokens: [] })
  expect(mcp.matches(old.token)).toBe(false)
})
