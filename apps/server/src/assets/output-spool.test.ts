import { mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vite-plus/test'
import { DataActivity } from '../maintenance/activity'
import { OutputSpool, type SpoolBinding } from './output-spool'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const binding: SpoolBinding = {
  ownerId: 'owner',
  jobId: 'run-1',
  callKey: 'generate',
  attemptId: 'attempt-1',
  outputIndex: 0,
}
const bytes = new Uint8Array([1, 2, 3, 4])
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'plein-spool-'))
  roots.push(root)
  const spool = new OutputSpool(root, new DataActivity(), 1000)
  await spool.init()
  return { root, spool }
}
async function data(stream: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

it('writing绑定先登记；原子发布后即使未更新ready记录仍可恢复', async () => {
  const { root, spool } = await fixture()
  const writing = spool.describe(bytes, binding)
  expect(writing.state).toBe('writing')
  const ready = await spool.write(writing, bytes, binding)
  expect(ready.state).toBe('ready')
  const again = new OutputSpool(root, new DataActivity(), 1000)
  await again.init()
  expect(await data(await again.read(writing, binding))).toEqual(Buffer.from(bytes))
  expect(await data(await again.read(ready, binding))).toEqual(Buffer.from(bytes))
  await again.remove(ready, binding)
  await expect(readFile(join(spool.root, ready.id))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('部分写入绝不作为ready读取；缺失、截断和哈希错误显式失败', async () => {
  const { spool } = await fixture(),
    ref = spool.describe(bytes, binding)
  await writeFile(join(spool.root, `${ref.id}.part`), bytes)
  await expect(spool.read(ref, binding)).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(join(spool.root, ref.id), new Uint8Array([1]))
  await expect(spool.read(ref, binding)).rejects.toThrow('大小不匹配')
  await writeFile(join(spool.root, ref.id), new Uint8Array([4, 3, 2, 1]))
  await expect(spool.read(ref, binding)).rejects.toThrow('哈希不匹配')
})

it('拒绝跨owner/job/call/attempt/output绑定和路径穿越', async () => {
  const { spool } = await fixture(),
    ref = spool.describe(bytes, binding)
  await spool.write(ref, bytes, binding)
  for (const changed of [
    { ownerId: 'other' },
    { jobId: 'other' },
    { callKey: 'other' },
    { attemptId: 'other' },
    { outputIndex: 1 },
  ])
    await expect(spool.read(ref, { ...binding, ...changed })).rejects.toThrow('不匹配')
  await expect(spool.read({ ...ref, id: '../escape' }, binding)).rejects.toThrow('不匹配')
  await expect(spool.remove({ ...ref, id: '/tmp/escape' }, binding)).rejects.toThrow('不匹配')
})

it('拒绝文件和目录符号链接，不跟随到外部文件', async () => {
  const { root, spool } = await fixture(),
    ref = spool.describe(bytes, binding)
  const outside = join(root, 'outside')
  await writeFile(outside, bytes)
  await symlink(outside, join(spool.root, ref.id))
  await expect(spool.read(ref, binding)).rejects.toMatchObject({ code: 'ELOOP' })
  await expect(spool.remove(ref, binding)).rejects.toThrow('不安全')
  expect(await readFile(outside)).toEqual(Buffer.from(bytes))
  await rm(spool.root, { recursive: true })
  await symlink(root, spool.root)
  await expect(spool.write(ref, bytes, binding)).rejects.toThrow('不安全')
})

it('超限/内容错误不写入；旧引用永不按TTL清理，只删除过期孤儿', async () => {
  const { spool } = await fixture()
  expect(() => spool.describe(new Uint8Array(1001), binding)).toThrow('超过')
  const held = spool.describe(bytes, binding),
    orphan = spool.describe(bytes, binding)
  await expect(spool.write(held, new Uint8Array([1]), binding)).rejects.toThrow('摘要不匹配')
  await spool.write(held, bytes, binding)
  await spool.write(orphan, bytes, binding)
  for (const ref of [held, orphan]) await utimes(join(spool.root, ref.id), new Date(0), new Date(0))
  await spool.prune([held])
  expect(await data(await spool.read(held, binding))).toEqual(Buffer.from(bytes))
  await expect(spool.read(orphan, binding)).rejects.toMatchObject({ code: 'ENOENT' })
})
