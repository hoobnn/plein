import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { connect, createElement, type PleinDoc } from '@plein/doc'
import { stableStringify } from '@plein/flow'
import { parseModelRef, ProviderError } from '@plein/plugin-sdk'
import { API, type SubtitleRecognitionInfo } from '@plein/protocol'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { AuthEnv } from '../auth'
import { addNode, bootServer, createCanvas, mockModel, mockSettings } from '../testing'
import { subtitleRoutes } from './routes'
import * as journal from './journal'
import { cacheParams } from '../runs/runs'
import { sequenceNode } from '@plein/nodes'

afterEach(() => vi.restoreAllMocks())

async function setup() {
  const { server, dataDir } = await bootServer()
  mockSettings(server, {})
  const result = await server.plugins.call(
    'audio.speech',
    mockModel('audio.speech'),
    { text: '一。二。' },
    { ownerId: 'local' },
  )
  const assetId = result.assets[0]!.assetId
  const deps = { db: server.db, host: server.plugins, assets: server.assets, dataDir }
  const app = (owner = 'local', role: 'owner' | 'viewer' = 'owner') =>
    new Hono<AuthEnv>()
      .use('*', (c, next) => {
        c.set('principal', { id: owner, role })
        return next()
      })
      .route('/', subtitleRoutes(deps))
  const call = (a = app()) =>
    a.request(API.subtitleRecognize, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: mockModel('audio.transcribe'), assetIds: [assetId] }),
    })
  const entry = server.plugins.registry.providers.get('plein/mock')!
  entry.def = { ...entry.def }
  return { server, dataDir, assetId, app, call, entry }
}

describe('字幕显式识别与持久恢复', () => {
  it('未知识别可人工关联平台任务，状态重载后仍可见，关联只续查不提交', async () => {
    const s = await setup()
    s.entry.def.lookup = undefined
    s.entry.def.idempotent = false
    const submit = vi
      .spyOn(s.entry.def, 'submit')
      .mockRejectedValueOnce(new ProviderError('unknown', '连接中断', { outcome: 'unknown' }))
    const first = await s.call()
    const { recovery } = (await first.json()) as { recovery: SubtitleRecognitionInfo }
    expect(recovery.recovery.state).toBe('submit_unknown')
    const lookup = await s
      .app()
      .request(
        `${API.subtitleRecognition}?${new URLSearchParams({ model: mockModel('audio.transcribe'), assetId: s.assetId })}`,
      )
    expect(await lookup.json()).toMatchObject({
      expected: recovery.expected,
      recovery: { state: 'submit_unknown' },
    })
    const body = {
      assetId: s.assetId,
      model: mockModel('audio.transcribe'),
      expected: recovery.expected,
      operation: { action: 'attach', remoteId: 'manual-asr' },
    }
    const recover = () =>
      s.app().request(API.subtitleRecover, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect((await recover()).status).toBe(200)
    expect((await recover()).status).toBe(409)
    const poll = vi.fn().mockResolvedValue({
      state: 'succeeded',
      outputs: [
        { type: 'json', value: { segments: [{ start: 0.1, end: 0.8, text: '关联取回' }] } },
      ],
    })
    s.entry.def.poll = poll
    expect((await s.call()).status).toBe(200)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(poll.mock.calls[0]![0]).toBe('manual-asr')
  })

  it('未知识别只有明确确认未受理才能重提，保留原 journal 审计记录', async () => {
    const s = await setup()
    s.entry.def.lookup = undefined
    s.entry.def.idempotent = false
    const submit = vi
      .spyOn(s.entry.def, 'submit')
      .mockRejectedValueOnce(new ProviderError('unknown', '连接中断', { outcome: 'unknown' }))
    const { recovery } = (await (await s.call()).json()) as { recovery: SubtitleRecognitionInfo }
    const body = {
      assetId: s.assetId,
      model: mockModel('audio.transcribe'),
      expected: recovery.expected,
      operation: { action: 'resubmit' },
    }
    const recover = (confirmedNotAccepted: boolean) =>
      s.app().request(API.subtitleRecover, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, confirmedNotAccepted }),
      })
    expect((await recover(false)).status).toBe(400)
    expect((await recover(true)).status).toBe(200)
    expect(submit).toHaveBeenCalledTimes(1)
    expect((await s.call()).status).toBe(200)
    expect(submit).toHaveBeenCalledTimes(2)
    const file = readdirSync(join(s.dataDir, 'subtitle-recognition')).find((f) =>
      f.endsWith('.json'),
    )!
    const stored = JSON.parse(readFileSync(join(s.dataDir, 'subtitle-recognition', file), 'utf8'))
    expect(stored.history[0]).toMatchObject({
      action: 'confirmed_not_accepted',
      record: { state: 'unknown' },
    })
    expect(stored.record.state).toBe('done')
    const starts = stored.audit.filter((e: { kind: string }) => e.kind === 'submit_started')
    expect(starts).toHaveLength(2)
    expect(starts[0].requestId).not.toBe(starts[1].requestId)
    expect(stored.history[0].record.trace.requestId).toBe(starts[0].requestId)
    expect(stored.record.trace.requestId).toBe(starts[1].requestId)
    expect(stored.audit).toContainEqual(
      expect.objectContaining({
        kind: 'manual_resubmit',
        previousState: 'unknown',
        requestId: starts[0].requestId,
      }),
    )
  })

  it.each(
    (['current-source', 'legacy-no-source'] as const).flatMap((encoding) =>
      (['matching', 'owner', 'asset', 'model', 'adapter', 'unknown', 'checksum'] as const).map(
        (variant) => [encoding, variant] as const,
      ),
    ),
  )('历史 ASR 迁移只复用精确版本和来源：%s / %s', async (encoding, variant) => {
    const s = await setup()
    const { id: canvasId, doc } = await createCanvas(s.server)
    const video = await s.server.plugins.call(
      'video.generate',
      mockModel('video.generate'),
      { prompt: '历史镜头' },
      { ownerId: 'local' },
    )
    const clip = createElement(doc, {
      kind: 'video',
      assetId: video.assets[0]!.assetId,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    const audio = createElement(doc, {
      kind: 'audio',
      assetId: s.assetId,
      x: 0,
      y: 200,
      w: 100,
      h: 100,
    })
    const seq = addNode(doc, 'plein/sequence', {
      params: { asrTiming: true, model: mockModel('audio.transcribe') },
    })
    connect(doc, [clip, 'video'], [seq, 'clips'])
    connect(doc, [audio, 'audio'], [seq, 'dialogue'])
    const inspection = await s.server.runs.inspect(
      doc,
      doc.get(seq)!,
      'local',
      new AbortController().signal,
    )
    expect(inspection.input.inputHash).toMatch(/^v2:/)
    const input = inspection.inputs.dialogue![0]!
    if (!('assetId' in input)) throw new Error('fixture needs audio')
    const model = mockModel('audio.transcribe')
    const key = `${createHash('sha256')
      .update(
        stableStringify({
          capability: 'audio.transcribe',
          model,
          input: { audio: { assetId: input.assetId, kind: 'audio', mime: input.mime } },
        }),
      )
      .digest('hex')}#0`
    const jobId = 'legacy-confirmed-asr'
    s.server.runs.store.insert({
      id: jobId,
      ownerId: variant === 'owner' ? 'other' : 'local',
      canvasId,
      nodeId: seq,
      nodeType: 'plein/sequence',
    })
    const frozen = {
      params: inspection.params,
      inputs: inspection.inputs,
      inputHash: inspection.input.inputHash,
    }
    if (encoding === 'legacy-no-source') {
      // 真实旧快照既不保存新增图层/渲染默认值，也不把来源元素身份计入 v2 hash。
      const {
        overlays: _overlays,
        subtitleRender: _render,
        subtitleAnimation: _animation,
        ...oldParams
      } = frozen.params
      frozen.params = oldParams
      const modelSpec = s.entry.def.models.find((spec) => spec.id === parseModelRef(model)!.model)!
      frozen.inputHash = `v2:${createHash('sha256')
        .update(
          stableStringify({
            type: 'plein/sequence',
            // 旧任务按当前节点版本重算，版本变了就不再复用旧结果
            version: sequenceNode.version,
            params: cacheParams(oldParams),
            inputs: Object.fromEntries(
              Object.entries(frozen.inputs).map(([port, values]) => [
                port,
                values.map(({ source: _source, ...value }) => value),
              ]),
            ),
            model: {
              ref: model,
              version: modelSpec.version,
              plugin: s.server.plugins.registry.plugin(s.entry.plugin)!.manifest.version,
            },
          }),
        )
        .digest('hex')}`
    }
    if (variant === 'checksum') frozen.inputHash = `v2:${'f'.repeat(64)}`
    if (variant === 'asset') input.assetId = 'e'.repeat(64)
    if (variant === 'model') frozen.params.model = 'other/model:asr'
    s.server.runs.store.update(jobId, { status: 'succeeded', frozen: JSON.stringify(frozen) })
    s.server.runs.store.journal(jobId).set(
      key,
      variant === 'unknown'
        ? { state: 'unknown', at: Date.now(), message: '历史提交不明' }
        : {
            state: 'done',
            result: {
              outputs: [
                {
                  type: 'json',
                  value: { segments: [{ start: 0.2, end: 0.8, text: '历史确认结果' }] },
                },
              ],
              assets: [],
            },
          },
    )
    const submit = vi.spyOn(s.entry.def, 'submit')
    const manifest = s.server.plugins.registry.plugin(s.entry.plugin)!.manifest
    const original = manifest.version
    try {
      if (variant === 'adapter') manifest.version = '99.0.0'
      const response = await s.call()
      if (variant === 'unknown') {
        expect(response.status).toBe(422)
        expect(((await response.json()) as { message: string }).message).toContain(jobId)
        expect(submit).not.toHaveBeenCalled()
      } else {
        expect(response.status).toBe(200)
        const body = (await response.json()) as {
          transcripts: Record<string, Array<{ text: string }>>
        }
        expect(submit).toHaveBeenCalledTimes(variant === 'matching' ? 0 : 1)
        if (variant === 'matching')
          expect(body.transcripts[s.assetId]![0]!.text).toBe('历史确认结果')
      }
    } finally {
      manifest.version = original
      ;(doc as PleinDoc).destroy()
    }
  })

  it('远端已受理时保留任务 ID；恢复只续查，并与本地维护互斥', async () => {
    const s = await setup()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const submit = vi
      .spyOn(s.entry.def, 'submit')
      .mockResolvedValue({ state: 'pending', remoteId: 'asr-remote-1', pollAfterMs: 0 })
    const poll = vi
      .fn()
      .mockImplementationOnce(async () => {
        entered()
        await gate
        throw new Error('查询连接断开')
      })
      .mockResolvedValue({
        state: 'succeeded',
        outputs: [
          { type: 'json', value: { segments: [{ start: 0.1, end: 0.9, text: '已识别' }] } },
        ],
      })
    s.entry.def.poll = poll
    const first = s.call()
    await ready
    expect(s.server.assets.activity.busy).toBe(true)
    await expect(s.server.assets.activity.exclusive(async () => true)).rejects.toThrow(
      '素材正在写入',
    )
    release()
    expect((await first).status).toBe(422)
    expect(s.server.assets.activity.busy).toBe(false)
    expect((await s.call()).status).toBe(200)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(poll.mock.calls.map(([id]) => id)).toEqual(['asr-remote-1', 'asr-remote-1'])
    const file = readdirSync(join(s.dataDir, 'subtitle-recognition')).find((f) =>
      f.endsWith('.json'),
    )!
    const stored = JSON.parse(readFileSync(join(s.dataDir, 'subtitle-recognition', file), 'utf8'))
    expect(stored).toMatchObject({
      assetId: s.assetId,
      record: { state: 'done', remoteId: 'asr-remote-1' },
    })
  })

  it('并发、再次识别以及重新创建路由都复用已识别音频；版本变化才失效', async () => {
    const s = await setup()
    const submit = vi.spyOn(s.entry.def, 'submit')
    const app = s.app()
    const results = await Promise.all([s.call(app), s.call(app)])
    expect(results.map((r) => r.status)).toEqual([200, 200])
    const body = (await results[0]!.json()) as { transcripts: Record<string, unknown[]> }
    expect(body.transcripts[s.assetId]).toHaveLength(2)
    expect((await s.call()).status).toBe(200)
    expect(submit).toHaveBeenCalledTimes(1)
    const version = s.server.plugins.registry.plugin(s.entry.plugin)!.manifest
    const original = version.version
    try {
      version.version = '99.0.0'
      expect((await s.call()).status).toBe(200)
      expect(submit).toHaveBeenCalledTimes(2)
    } finally {
      version.version = original
    }
  })

  it('提交未知保存 journal，重复请求和重建路由都不会重新提交', async () => {
    const s = await setup()
    s.entry.def.lookup = undefined
    s.entry.def.idempotent = false
    const submit = vi
      .spyOn(s.entry.def, 'submit')
      .mockRejectedValue(new ProviderError('unknown', '连接中断', { outcome: 'unknown' }))
    expect((await s.call()).status).toBe(422)
    expect((await s.call()).status).toBe(422)
    expect(submit).toHaveBeenCalledTimes(1)
    const records = readdirSync(join(s.dataDir, 'subtitle-recognition')).filter((f) =>
      f.endsWith('.json'),
    )
    expect(records).toHaveLength(1)
    expect(
      JSON.parse(readFileSync(join(s.dataDir, 'subtitle-recognition', records[0]!), 'utf8')).record
        .state,
    ).toBe('unknown')
  })

  it('只读和其他所有者不能提交识别；未返回时间戳时明确报错且不重提', async () => {
    const s = await setup()
    const submit = vi
      .spyOn(s.entry.def, 'submit')
      .mockResolvedValue({ state: 'succeeded', outputs: [{ type: 'text', text: '没有时间戳' }] })
    expect((await s.call(s.app('local', 'viewer'))).status).toBe(403)
    expect((await s.call(s.app('other'))).status).toBe(404)
    expect(submit).not.toHaveBeenCalled()
    expect((await s.call()).status).toBe(422)
    expect((await s.call()).status).toBe(422)
    expect(submit).toHaveBeenCalledTimes(1)
  })
})

it('字幕审计在submit入口前已持久化，同一次调用的响应关联ID也保存', async () => {
  const s = await setup()
  vi.spyOn(s.entry.def, 'submit').mockImplementationOnce(async (_request, ctx) => {
    const file = readdirSync(join(s.dataDir, 'subtitle-recognition')).find((f) =>
      f.endsWith('.json'),
    )!
    const stored = journal.readRecord(join(s.dataDir, 'subtitle-recognition', file))!
    expect(stored.record?.trace?.requestId).toBe(ctx.submission?.requestId)
    expect(stored.audit).toContainEqual(
      expect.objectContaining({ kind: 'submit_started', requestId: ctx.submission?.requestId }),
    )
    ctx.submission!.response({ logId: 'local-asr-log', httpStatus: 200 })
    return {
      state: 'succeeded',
      outputs: [{ type: 'json', value: { segments: [{ start: 0, end: 1, text: 'local' }] } }],
    }
  })
  expect((await s.call()).status).toBe(200)
  const file = readdirSync(join(s.dataDir, 'subtitle-recognition')).find((f) =>
    f.endsWith('.json'),
  )!
  const stored = journal.readRecord(join(s.dataDir, 'subtitle-recognition', file))!
  expect(stored.audit).toContainEqual(
    expect.objectContaining({ kind: 'response', logId: 'local-asr-log', httpStatus: 200 }),
  )
})

it('字幕提交前写失败不调用submit，人工恢复写失败不丢原未知证据', async () => {
  const s = await setup()
  s.entry.def.lookup = undefined
  s.entry.def.idempotent = false
  const submit = vi
    .spyOn(s.entry.def, 'submit')
    .mockRejectedValueOnce(new ProviderError('unknown', 'local lost', { outcome: 'unknown' }))
  const write = vi.spyOn(journal, 'writeRecord')
  write.mockImplementationOnce(() => {
    throw new Error('disk unavailable')
  })
  expect((await s.call()).status).toBe(422)
  expect(submit).not.toHaveBeenCalled()
  const { recovery } = (await (await s.call()).json()) as { recovery: SubtitleRecognitionInfo }
  expect(submit).toHaveBeenCalledTimes(1)
  expect(recovery.submissionHistory).toContainEqual(
    expect.objectContaining({ kind: 'submit_started' }),
  )
  const file = readdirSync(join(s.dataDir, 'subtitle-recognition')).find((f) =>
    f.endsWith('.json'),
  )!
  const path = join(s.dataDir, 'subtitle-recognition', file)
  const before = readFileSync(path, 'utf8')
  write.mockImplementationOnce(() => {
    throw new Error('disk unavailable')
  })
  const response = await s.app().request(API.subtitleRecover, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assetId: s.assetId,
      model: mockModel('audio.transcribe'),
      expected: recovery.expected,
      operation: { action: 'resubmit' },
      confirmedNotAccepted: true,
    }),
  })
  expect(response.status).toBe(500)
  expect(readFileSync(path, 'utf8')).toBe(before)
  expect(submit).toHaveBeenCalledTimes(1)
})
