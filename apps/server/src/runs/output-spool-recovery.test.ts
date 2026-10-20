import { createHash } from 'node:crypto'
import { readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { minimaxProvider, mockProvider } from '@plein/providers'
import { ProviderError, type ProviderOutput } from '@plein/plugin-sdk'
import { afterEach, expect, it, onTestFinished, vi } from 'vite-plus/test'
import { type CallJournal, type CallRecord, NodeRunError } from '../plugins/host'
import { recoveryAfter } from './recovery'
import { outputSpoolRefs } from '../assets/output-spool'
import { addNode, bootServer, createCanvas, mockSettings, request, until } from '../testing'

afterEach(() => vi.restoreAllMocks())
const fileOutput = (data: Uint8Array): ProviderOutput => ({
  type: 'file',
  kind: 'audio',
  mime: 'application/octet-stream',
  data,
})
const callsOf = (server: Awaited<ReturnType<typeof bootServer>>['server'], run: string) =>
  JSON.parse(server.runs.store.get(run)!.calls) as Record<string, CallRecord>

it.each(['ingest-failed', 'ready-before-journal'] as const)(
  '%s 后重启仅从持久字节取回；大字节不进done JSON、不再submit',
  async (mode) => {
    const first = await bootServer()
    mockSettings(first.server, { latencyMs: 0 })
    const bytes = new Uint8Array(mode === 'ingest-failed' ? 16 * 1024 * 1024 + 1 : 4096).fill(7)
    const expected = createHash('sha256').update(bytes).digest('hex')
    const submit = vi
      .spyOn(mockProvider, 'submit')
      .mockResolvedValueOnce({ state: 'succeeded', outputs: [fileOutput(bytes)] })
    if (mode === 'ingest-failed')
      vi.spyOn(first.server.assets, 'ingest').mockRejectedValueOnce(
        new Error('local storage offline'),
      )
    else {
      const write = first.server.assets.outputSpool.write.bind(first.server.assets.outputSpool)
      vi.spyOn(first.server.assets.outputSpool, 'write').mockImplementationOnce(async (...args) => {
        await write(...args)
        throw new Error('interrupted after atomic publish')
      })
    }
    const { id, doc } = await createCanvas(first.server)
    const node = addNode(doc, 'plein/speech', { params: { text: '本地故障恢复' } })
    const run = first.server.runs.start(id, node, 'local')
    expect(await first.server.runs.wait(run)).toBe('failed')
    await until(() => !first.server.runs.isRunning(id, node))
    expect(first.server.runs.list(id).jobs[0]?.recovery).toMatchObject({
      state: 'fetch_failed',
      refetchable: true,
    })
    const latestResponse = await request(first.server, `/api/canvases/${id}/jobs/latest`, {
      method: 'POST',
      body: JSON.stringify({ nodes: [node] }),
    })
    expect(latestResponse.status).toBe(200)
    const latest = (await latestResponse.json()) as {
      jobs: Array<{ recovery?: { refetchable?: boolean } }>
    }
    // Tasks/结果条消费的真实接口必须允许取回，不能只检查内部恢复函数。
    expect(latest.jobs[0]?.recovery?.refetchable).toBe(true)
    expect(Object.values(callsOf(first.server, run))[0]).not.toHaveProperty('remoteId')
    const refs = outputSpoolRefs(callsOf(first.server, run))
    expect(refs).toHaveLength(1)
    expect(refs[0]?.state).toBe(mode === 'ingest-failed' ? 'ready' : 'writing')
    expect(first.server.runs.store.get(run)!.calls.length).toBeLessThan(5000)
    await first.close()
    const second = await bootServer({ dataDir: first.dataDir })
    second.server.runs.recoverJob(id, run, 'local', { action: 'refetch' })
    expect(await second.server.runs.wait(run)).toBe('succeeded')
    await until(() => !second.server.runs.isRunning(id, node))
    expect(submit).toHaveBeenCalledTimes(1)
    const records = Object.values(callsOf(second.server, run)),
      done = records[0]!
    expect(done.state).toBe('done')
    if (done.state !== 'done') throw new Error('missing done')
    const asset = done.dataAssets?.[0]
    expect(asset?.assetId).toBe(expected)
    expect(
      createHash('sha256')
        .update(await second.server.assets.readOriginal('local', asset!.assetId))
        .digest('hex'),
    ).toBe(expected)
    expect(done.result.outputs[0]).not.toHaveProperty('data')
    expect(second.server.runs.store.get(run)!.calls.length).toBeLessThan(5000)
    expect(await readdir(second.server.assets.outputSpool.root)).toEqual([])
  },
)

it.each(['missing', 'corrupt'] as const)(
  'ready %s 时明确失败、保留原记录、不重新生成',
  async (mode) => {
    const { server } = await bootServer()
    mockSettings(server, { latencyMs: 0 })
    const submit = vi.spyOn(mockProvider, 'submit').mockResolvedValueOnce({
      state: 'succeeded',
      outputs: [fileOutput(new Uint8Array([1, 2, 3, 4]))],
    })
    const ingest = vi
      .spyOn(server.assets, 'ingest')
      .mockRejectedValueOnce(new Error('storage offline'))
    const { id, doc } = await createCanvas(server),
      node = addNode(doc, 'plein/speech', { params: { text: '本地' } })
    const run = server.runs.start(id, node, 'local')
    expect(await server.runs.wait(run)).toBe('failed')
    await until(() => !server.runs.isRunning(id, node))
    const original = server.runs.store.get(run)!.calls,
      ref = outputSpoolRefs(JSON.parse(original))[0]!
    const path = join(server.assets.outputSpool.root, ref.id)
    if (mode === 'missing') await rm(path)
    else await writeFile(path, new Uint8Array([4, 3, 2, 1]))
    ingest.mockRestore()
    server.runs.recoverJob(id, run, 'local', { action: 'refetch' })
    expect(await server.runs.wait(run)).toBe('failed')
    await until(() => !server.runs.isRunning(id, node))
    expect(server.runs.store.get(run)!.calls).toBe(original)
    expect(server.runs.list(id).jobs[0]?.recovery?.state).toBe('fetch_failed')
    expect(() => server.runs.start(id, node, 'local')).toThrow('请先恢复或标记已处理')
    expect(submit).toHaveBeenCalledTimes(1)
  },
)

it('done内部只存资产映射，首次/重复读取公开字节等价；丢失或跨owner不能伪造成功', async () => {
  const { server } = await bootServer()
  mockSettings(server, { latencyMs: 0 })
  const bytes = new Uint8Array([1, 2, 3, 4, 5])
  const submit = vi
    .spyOn(mockProvider, 'submit')
    .mockResolvedValueOnce({ state: 'succeeded', outputs: [fileOutput(bytes)] })
  const records = new Map<string, CallRecord>()
  const store: CallJournal = {
    id: 'direct-local-call',
    get: (key) => records.get(key),
    set: (key, value) => {
      records.set(key, value)
    },
    delete: (key) => {
      records.delete(key)
    },
  }
  const call = (ownerId = 'local') =>
    server.plugins.call(
      'audio.speech',
      'plein/mock:audio',
      { text: '本地' },
      { ownerId, journal: { store, key: 'generate' } },
    )
  const first = await call(),
    restored = await call()
  expect(first.outputs[0]).toEqual({ ...fileOutput(bytes), data: bytes })
  expect(restored).toEqual(first)
  expect(JSON.stringify(records.get('generate'))).not.toContain('"data":')
  expect(await readdir(server.assets.outputSpool.root)).toEqual([])
  await expect(call('other-owner')).rejects.toMatchObject({
    stage: 'fetch_failed',
    retryable: false,
  })
  const asset = first.assets[0]!
  await rm(server.assets.originalPath(asset.assetId))
  await expect(call()).rejects.toMatchObject({ stage: 'fetch_failed', retryable: false })
  expect(submit).toHaveBeenCalledTimes(1)
})

it('done已登记但任务未结束时重启，原资产缺失不能假报成功或重新submit', async () => {
  const first = await bootServer()
  mockSettings(first.server, { latencyMs: 0 })
  const submit = vi.spyOn(mockProvider, 'submit').mockResolvedValueOnce({
    state: 'succeeded',
    outputs: [fileOutput(new Uint8Array([1, 2, 3, 4]))],
  })
  const { id, doc } = await createCanvas(first.server),
    node = addNode(doc, 'plein/speech', { params: { text: '本地' } })
  const run = first.server.runs.start(id, node, 'local')
  expect(await first.server.runs.wait(run)).toBe('succeeded')
  await until(() => !first.server.runs.isRunning(id, node))
  const done = Object.values(callsOf(first.server, run))[0]!
  if (done.state !== 'done') throw new Error('missing done')
  await rm(first.server.assets.originalPath(done.dataAssets![0]!.assetId))
  first.server.runs.store.update(run, { status: 'running', recovery: null })
  await first.close()
  const second = await bootServer({ dataDir: first.dataDir })
  expect(await second.server.runs.wait(run)).toBe('failed')
  await until(() => !second.server.runs.isRunning(id, node))
  expect(second.server.runs.list(id).jobs[0]?.recovery?.state).toBe('fetch_failed')
  expect(() => second.server.runs.start(id, node, 'local')).toThrow('请先恢复或标记已处理')
  expect(submit).toHaveBeenCalledTimes(1)
})

it('磁盘写入失败保留writing事实，重新获取也不会变成再次submit', async () => {
  const { server } = await bootServer()
  mockSettings(server, { latencyMs: 0 })
  const submit = vi.spyOn(mockProvider, 'submit').mockResolvedValueOnce({
    state: 'succeeded',
    outputs: [fileOutput(new Uint8Array([1, 2, 3, 4]))],
  })
  vi.spyOn(server.assets.outputSpool, 'write').mockRejectedValueOnce(
    Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
  )
  const { id, doc } = await createCanvas(server),
    node = addNode(doc, 'plein/speech', { params: { text: '本地' } })
  const run = server.runs.start(id, node, 'local')
  expect(await server.runs.wait(run)).toBe('failed')
  await until(() => !server.runs.isRunning(id, node))
  const original = server.runs.store.get(run)!.calls
  expect(outputSpoolRefs(JSON.parse(original))[0]?.state).toBe('writing')
  server.runs.recoverJob(id, run, 'local', { action: 'refetch' })
  expect(await server.runs.wait(run)).toBe('failed')
  await until(() => !server.runs.isRunning(id, node))
  expect(server.runs.store.get(run)!.calls).toBe(original)
  expect(server.runs.list(id).jobs[0]?.recovery?.state).toBe('fetch_failed')
  expect(() => server.runs.start(id, node, 'local')).toThrow('请先恢复或标记已处理')
  expect(submit).toHaveBeenCalledTimes(1)
})

it('ingest后done登记失败保留恢复副本，重试入库不重复生成', async () => {
  const { server } = await bootServer()
  mockSettings(server, { latencyMs: 0 })
  const submit = vi.spyOn(mockProvider, 'submit').mockResolvedValueOnce({
    state: 'succeeded',
    outputs: [fileOutput(new Uint8Array([1, 2, 3, 4]))],
  })
  const journal = server.runs.store.journal.bind(server.runs.store)
  let fail = true
  vi.spyOn(server.runs.store, 'journal').mockImplementation((id) => {
    const store = journal(id)
    return {
      ...store,
      set(key, record, audit) {
        if (record.state === 'done' && fail) {
          fail = false
          throw new Error('local done transaction failed')
        }
        store.set(key, record, audit)
      },
    }
  })
  const { id, doc } = await createCanvas(server),
    node = addNode(doc, 'plein/speech', { params: { text: '本地' } })
  const run = server.runs.start(id, node, 'local')
  expect(await server.runs.wait(run)).toBe('failed')
  await until(() => !server.runs.isRunning(id, node))
  expect(server.runs.list(id).jobs[0]?.recovery?.state).toBe('fetch_failed')
  expect(outputSpoolRefs(callsOf(server, run))).toHaveLength(1)
  server.runs.recoverJob(id, run, 'local', { action: 'refetch' })
  expect(await server.runs.wait(run)).toBe('succeeded')
  expect(submit).toHaveBeenCalledTimes(1)
  expect(await readdir(server.assets.outputSpool.root)).toEqual([])
})

it.each([
  ['url-only', 'missing'],
  ['url-only', 'corrupt'],
  ['mixed', 'missing'],
  ['mixed', 'corrupt'],
] as const)('%s done原件%s时拒绝成功、跨owner也拒绝且不submit/不下载', async (mode, fault) => {
  const { server } = await bootServer()
  server.plugins.configs.update('minimax/api', {
    enabled: true,
    secrets: { MINIMAX_API_KEY: 'local-test-key' },
  })
  const url = 'https://api.minimax.cn/local-fixture-video.bin'
  const outputs: ProviderOutput[] = [
    { type: 'file', kind: 'video', mime: 'application/octet-stream', url },
  ]
  if (mode === 'mixed') outputs.push(fileOutput(new Uint8Array([7, 8, 9, 10])))
  const submit = vi
    .spyOn(minimaxProvider, 'submit')
    .mockResolvedValueOnce({ state: 'succeeded', outputs })
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    expect((input as Request).url).toBe(url)
    return new Response(new Uint8Array([1, 2, 3, 4]))
  })
  const records = new Map<string, CallRecord>()
  const store: CallJournal = {
    id: `done-${mode}-${fault}`,
    get: (key) => records.get(key),
    set: (key, value) => {
      records.set(key, value)
    },
    delete: (key) => {
      records.delete(key)
    },
  }
  const call = (ownerId = 'local') =>
    server.plugins.call(
      'video.generate',
      'minimax/api:MiniMax-H3',
      { prompt: 'local-only fixture' },
      { ownerId, journal: { store, key: 'video' } },
    )
  const first = await call()
  expect(await call()).toEqual(first)
  await expect(call('other-owner')).rejects.toMatchObject({
    stage: 'fetch_failed',
    retryable: false,
  })
  // mixed覆盖dataAssets；URL-only必须同样核对所有result.assets，不能只检查dataAssets。
  const asset = first.assets[mode === 'mixed' && fault === 'corrupt' ? 1 : 0]!
  if (fault === 'missing') await rm(server.assets.originalPath(asset.assetId))
  else await writeFile(server.assets.originalPath(asset.assetId), new Uint8Array([9, 9, 9, 9]))
  await expect(call()).rejects.toMatchObject({ stage: 'fetch_failed', retryable: false })
  expect(submit).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('新提交返回pending但无poll：先持久化远端ID，重启也不再submit', async () => {
  const first = await bootServer()
  mockSettings(first.server, { latencyMs: 0 })
  const poll = mockProvider.poll
  mockProvider.poll = undefined
  onTestFinished(() => {
    mockProvider.poll = poll
  })
  const submit = vi
    .spyOn(mockProvider, 'submit')
    .mockResolvedValueOnce({ state: 'pending', remoteId: 'accepted-without-poll' })
  const { id, doc } = await createCanvas(first.server),
    node = addNode(doc, 'plein/speech', { params: { text: '本地' } })
  const run = first.server.runs.start(id, node, 'local')
  expect(await first.server.runs.wait(run)).toBe('failed')
  await until(() => !first.server.runs.isRunning(id, node))
  expect(Object.values(callsOf(first.server, run))[0]).toMatchObject({
    state: 'pending',
    remoteId: 'accepted-without-poll',
  })
  expect(first.server.runs.list(id).jobs[0]?.recovery).toMatchObject({
    state: 'remote_pending',
    remoteId: 'accepted-without-poll',
    refetchable: false,
  })
  expect(() => first.server.runs.start(id, node, 'local')).toThrow('请先恢复或标记已处理')
  // 复现“远端已受理、任务尚未结束时进程退出”的持久任务状态。
  first.server.runs.store.update(run, { status: 'running', recovery: null })
  await first.close()
  const second = await bootServer({ dataDir: first.dataDir })
  expect(await second.server.runs.wait(run)).toBe('failed')
  expect(Object.values(callsOf(second.server, run))[0]).toMatchObject({
    state: 'pending',
    remoteId: 'accepted-without-poll',
  })
  expect(submit).toHaveBeenCalledTimes(1)
})

it.each(['unknown', 'fetched'] as const)(
  '%s journal写失败但finish能写时，持久submitting仍阻止再次start',
  async (failedState) => {
    const { server } = await bootServer()
    mockSettings(server, { latencyMs: 0 })
    const submit = vi.spyOn(mockProvider, 'submit')
    if (failedState === 'unknown')
      submit.mockRejectedValueOnce(
        new ProviderError('unavailable', 'response lost', { outcome: 'unknown', retryable: false }),
      )
    else
      submit.mockResolvedValueOnce({
        state: 'succeeded',
        outputs: [fileOutput(new Uint8Array([1, 2, 3, 4]))],
      })
    const journal = server.runs.store.journal.bind(server.runs.store)
    vi.spyOn(server.runs.store, 'journal').mockImplementation((id) => {
      const store = journal(id)
      return {
        ...store,
        set(key, record, audit) {
          if (record.state === failedState) throw new Error('controlled journal write failure')
          store.set(key, record, audit)
        },
      }
    })
    const { id, doc } = await createCanvas(server),
      node = addNode(doc, 'plein/speech', { params: { text: '本地' } })
    const run = server.runs.start(id, node, 'local')
    expect(await server.runs.wait(run)).toBe('failed')
    await until(() => !server.runs.isRunning(id, node))
    expect(Object.values(callsOf(server, run))[0]).toMatchObject({ state: 'submitting' })
    expect(server.runs.list(id).jobs[0]?.recovery?.state).toBe('submit_unknown')
    expect(() => server.runs.start(id, node, 'local')).toThrow('请先恢复或标记已处理')
    expect(submit).toHaveBeenCalledTimes(1)
  },
)

it('明确remote_failed stage优先于残留调用记录，不被兜底推导覆盖', () => {
  const error = new NodeRunError('unavailable', 'remote failed')
  error.stage = 'remote_failed'
  for (const call of [
    { state: 'submitting', at: 1 },
    { state: 'unknown', at: 1, message: 'old unknown' },
    { state: 'fetched', outputs: [] },
  ] as CallRecord[])
    expect(recoveryAfter('failed', error, [call])?.state).toBe('remote_failed')
})
