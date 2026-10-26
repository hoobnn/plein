import { readFile, rm, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { addNode, tempDir, until } from '../testing'
import {
  addResults,
  connect,
  createElement,
  currentResult,
  deleteElements,
  setParam,
  updateElement,
  type SequenceInstance,
} from '@plein/doc'
import { mockProvider } from '@plein/providers'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { ffmpegBin, hasFfmpeg, probeMedia } from '../assets/media'
import { sequenceSegmentFixture } from './sequence-segment-fixture'
import { runGraph } from './runs'
import { batchItem, expectOf } from './batch'
import type { BatchItemRow } from './store'
import { ProviderError } from '@plein/plugin-sdk'

const available = await hasFfmpeg()
afterEach(() => vi.restoreAllMocks())
describe.skipIf(!available)('P11固定段与批准序列范围', () => {
  it('直接合成前拒绝损坏实例、冲突出处与越界源区间', async () => {
    const f = await sequenceSegmentFixture()
    const submit = vi.spyOn(mockProvider, 'submit')
    const row = f.fixed(0)
    const cases = [
      { clips: [{ ...row, clipInstanceId: '' }], reason: '序列实例损坏' },
      {
        clips: [{ ...row, segment: { ...row.segment!, duration: row.segment!.duration + 1 } }],
        reason: '同一固定段存在文件或出处冲突',
      },
      { clips: [{ ...row, out: row.segment!.duration + 1 }], reason: '固定时长或源区间无效' },
    ]
    for (const { clips, reason } of cases) {
      setParam(f.doc, f.sequence, 'clips', clips)
      await expect(
        f.server.runs.verifySequenceAssets(
          f.doc,
          f.sequence,
          'local',
          new AbortController().signal,
        ),
      ).rejects.toThrow(reason)
    }
    expect(submit).not.toHaveBeenCalled()
  }, 30_000)

  it('第二shot没有独立video仍复用，native不认领旧配音；显式重拍只列真实users并阻塞', async () => {
    const f = await sequenceSegmentFixture()
    const submit = vi.spyOn(mockProvider, 'submit')
    const verify = vi.spyOn(f.server.plugins, 'verifyAsset')
    const request = {
      shotIds: f.shots.slice(0, 2).map((shot) => shot.id),
      role: 'video' as const,
      reuseExisting: true,
    }
    const plan = await f.preview(request)
    expect(plan.scope?.sequenceId).toBe(f.sequence)
    expect(plan.summary).toMatchObject({ run: 0, reuse: 2, blocked: 0, calls: 0 })
    expect(verify.mock.calls.filter(([, id]) => id === f.asset.id)).toHaveLength(1)
    expect(plan.rows.every((row) => row.mapping?.users.length === 2)).toBe(true)
    expect(f.node(1, 'video')).toBeUndefined()
    const speech = await f.preview({ ...request, role: 'speech' })
    expect(speech.summary).toMatchObject({ run: 0, skip: 2, calls: 0 })
    const retake = await f.preview({ ...request, reuseExisting: false })
    expect(retake.summary).toMatchObject({ run: 0, blocked: 2, calls: 0 })
    expect(retake.rows[0]!.mapping?.instances[0]).toMatchObject({
      clipInstanceId: 'fixed-0',
      in: 0,
      out: 2,
      sound: 'native',
    })
    deleteElements(f.doc, [f.view, f.originalVideo])
    expect((await f.preview(request)).summary.reuse).toBe(2)
    expect(submit).not.toHaveBeenCalled()
  }, 30_000)

  it('真实2s视频/4s音轨不能用容器时长伪造视频覆盖，固定补缺零submit阻塞', async () => {
    const f = await sequenceSegmentFixture()
    const file = join(tempDir(), 'video2-audio4.mp4')
    execFileSync(ffmpegBin(), [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=96x64:rate=30:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=4',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-c:a',
      'aac',
      '-pix_fmt',
      'yuv420p',
      file,
    ])
    const asset = await f.server.assets.ingest('local', createReadStream(file), {
      mime: 'video/mp4',
      name: 'video2-audio4.mp4',
    })
    const actual = await probeMedia(file)
    expect(actual.duration).toBeCloseTo(4, 1)
    expect(actual.videoDuration).toBeCloseTo(2, 1)
    const row = f.fixed(0)
    setParam(f.doc, f.sequence, 'clips', [
      {
        ...row,
        in: 2.5,
        out: 3.5,
        segment: {
          ...row.segment!,
          segmentId: 'invalid-video-coverage',
          duration: asset.duration!,
          asset: { assetId: asset.id, kind: 'video' as const, mime: asset.mime },
        },
      },
    ])
    const submit = vi.spyOn(mockProvider, 'submit')
    const plan = await f.preview({ shotIds: [f.shots[0]!.id], role: 'video', reuseExisting: true })
    expect(plan.summary).toMatchObject({ run: 0, calls: 0, blocked: 1 })
    expect(plan.rows[0]!.reason).toContain('视频覆盖')
    const input = await f.server.runs.preview(f.id, f.sequence, 'local')
    expect(input.status).not.toBe('ready')
    expect(input.blocked.map((issue) => issue.message).join('；')).toContain('视频覆盖')
    expect(submit).not.toHaveBeenCalled()
  }, 30_000)

  it('明确外部配音零生成复用，非主音频候选在排队间变更也需要重新审查', async () => {
    const f = await sequenceSegmentFixture()
    const assets = []
    for (const frequency of [440, 660]) {
      const file = join(tempDir(), `${frequency}.wav`)
      execFileSync(ffmpegBin(), [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${frequency}:sample_rate=48000:duration=8`,
        '-c:a',
        'pcm_s16le',
        file,
      ])
      assets.push(
        await f.server.assets.ingest('local', createReadStream(file), {
          mime: 'audio/wav',
          name: `${frequency}.wav`,
        }),
      )
    }
    const audio = createElement(f.doc, {
      kind: 'node',
      nodeType: 'controlled/audio-source',
      nodeVersion: 1,
      x: 0,
      y: 0,
      w: 200,
      h: 100,
      ports: {
        inputs: [],
        outputs: [
          { id: 'text', type: 'text', label: '说明' },
          { id: 'audio', type: 'audio', label: '配音' },
        ],
      },
    })
    const candidate = (suffix: string, assetId: string) =>
      addResults(f.doc, audio, [
        {
          id: `text-${suffix}`,
          port: 'text',
          runId: `source-${suffix}`,
          outputGroup: suffix,
          at: 1,
          value: { type: 'text', text: 'controlled fixture' },
        },
        {
          id: `audio-${suffix}`,
          port: 'audio',
          runId: `source-${suffix}`,
          outputGroup: suffix,
          at: 1,
          value: { type: 'audio', assetId },
        },
      ])
    candidate('A', assets[0]!.id)
    connect(f.doc, [audio, 'audio'], [f.sequence, 'dialogue'])
    const rows = structuredClone(f.doc.get(f.sequence)!.params!.clips as SequenceInstance[])
    setParam(
      f.doc,
      f.sequence,
      'clips',
      rows.map((row) =>
        row.segment
          ? { ...row, sound: row.clipInstanceId === 'fixed-0' ? 'mix' : 'voice', dialogue: audio }
          : row,
      ),
    )
    const speech = await f.preview({
      shotIds: f.shots.slice(0, 2).map((shot) => shot.id),
      role: 'speech',
      reuseExisting: true,
    })
    expect(speech.summary).toMatchObject({ run: 0, reuse: 2, blocked: 0, calls: 0 })
    expect(speech.rows[0]!.mapping?.audioSources).toEqual([
      {
        source: audio,
        port: 'audio',
        assetId: assets[0]!.id,
        resultId: 'audio-A',
        runId: 'source-A',
      },
    ])
    ;(f.server.runs as unknown as { concurrency: number }).concurrency = 1
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const submit = vi.spyOn(mockProvider, 'submit').mockImplementation(async (request) => {
      if (request.capability !== 'text.chat') throw new Error('unexpected video submit')
      enter()
      await gate
      return { state: 'succeeded', outputs: [{ type: 'text', text: 'controlled blocker' }] }
    })
    try {
      const blocker = addNode(f.doc, 'plein/llm', { params: { prompt: 'hold' } })
      const blocked = f.server.runs.start(f.id, blocker, 'local')
      await entered
      const plan = await f.preview({
        shotIds: [f.shots[0]!.id, f.shots[2]!.id],
        role: 'video',
        reuseExisting: true,
      })
      expect(plan.summary.run).toBe(1)
      await f.batches.commit(f.id, f.board, 'local', plan.token)
      await until(
        () => f.server.runs.store.latestForNodes(f.id, [f.thirdVideo])[0]?.status === 'queued',
      )
      const queued = f.server.runs.store.latestForNodes(f.id, [f.thirdVideo])[0]!
      expect(JSON.parse(queued.expect!).sequenceScope.audioSources[0].resultId).toBe('audio-A')
      candidate('B', assets[1]!.id)
      release()
      await f.server.runs.wait(blocked)
      await until(() => f.server.runs.store.get(queued.id)?.status === 'failed')
      expect(
        f.server.runs.list(f.id).jobs.find((job) => job.id === queued.id)?.recovery?.state,
      ).toBe('review')
      expect(
        submit.mock.calls.filter(([request]) => request.capability === 'video.generate'),
      ).toHaveLength(0)
      await rm(f.server.assets.originalPath(assets[1]!.id))
      expect(
        (await f.preview({ shotIds: [f.shots[0]!.id], role: 'speech', reuseExisting: true }))
          .summary.blocked,
      ).toBe(1)
    } finally {
      release()
    }
  }, 45_000)

  it('多sequence不借其他映射，坏fixed/缺文件/同大小篡改明确blocked而不付费补缺', async () => {
    const f = await sequenceSegmentFixture(),
      submit = vi.spyOn(mockProvider, 'submit')
    const request = { shotIds: [f.shots[1]!.id], role: 'video' as const, reuseExisting: true }
    addNode(f.doc, 'plein/sequence', {
      nodeVersion: 2,
      params: {
        instanceVersion: 2,
        clips: [{ ...f.fixed(1), clipInstanceId: 'other', in: 1, out: 3 }],
      },
    })
    expect((await f.preview(request)).summary.blocked).toBe(1)
    expect((await f.preview({ ...request, sequenceId: f.sequence })).summary.reuse).toBe(1)
    const original = structuredClone(f.doc.get(f.sequence)!.params!.clips as SequenceInstance[])
    setParam(
      f.doc,
      f.sequence,
      'clips',
      original.map((row) =>
        row.clipInstanceId === 'fixed-1'
          ? { ...row, segment: { ...row.segment!, asset: { assetId: 'broken', kind: 'video' } } }
          : row,
      ),
    )
    expect((await f.preview({ ...request, sequenceId: f.sequence })).summary.blocked).toBe(1)
    setParam(f.doc, f.sequence, 'clips', original)
    const path = f.server.assets.originalPath(f.asset.id),
      bytes = await readFile(path)
    await rm(path)
    expect((await f.preview({ ...request, sequenceId: f.sequence })).rows[0]!.reason).toContain(
      '核查失败',
    )
    const tampered = Buffer.from(bytes)
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1
    await writeFile(path, tampered)
    expect((await f.preview({ ...request, sequenceId: f.sequence })).rows[0]!.reason).toContain(
      '哈希',
    )
    await writeFile(path, bytes)
    expect((await f.preview({ ...request, sequenceId: f.sequence })).summary.reuse).toBe(1)
    expect(submit).not.toHaveBeenCalled()
  }, 30_000)

  it('预检后映射/声音或文件变化使原token变更，不消费旧范围', async () => {
    const f = await sequenceSegmentFixture(),
      submit = vi.spyOn(mockProvider, 'submit')
    const request = { shotIds: [f.shots[0]!.id], role: 'video' as const, reuseExisting: true }
    const before = await f.preview(request)
    const rows = structuredClone(f.doc.get(f.sequence)!.params!.clips as SequenceInstance[])
    setParam(
      f.doc,
      f.sequence,
      'clips',
      rows.map((row) => (row.clipInstanceId === 'fixed-0' ? { ...row, sound: 'mix' } : row)),
    )
    expect(await f.batches.commit(f.id, f.board, 'local', before.token)).toHaveProperty('changed')
    const next = await f.preview(request)
    await rm(f.server.assets.originalPath(f.asset.id))
    const changed = await f.batches.commit(f.id, f.board, 'local', next.token)
    expect(changed).toHaveProperty('changed')
    expect(submit).not.toHaveBeenCalled()
  }, 30_000)

  it('queued范围核对覆盖同清单reuse素材，映射/删文件/篡改均不提交paid目标', async () => {
    for (const mutation of ['mapping', 'missing-file', 'tampered-file']) {
      const f = await sequenceSegmentFixture()
      ;(f.server.runs as unknown as { concurrency: number }).concurrency = 1
      let entered!: () => void, release!: () => void
      const held = new Promise<void>((resolve) => {
        entered = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const submit = vi.spyOn(mockProvider, 'submit').mockImplementation(async (request) => {
        if (request.capability !== 'text.chat') throw new Error('unexpected paid video submit')
        entered()
        await gate
        return { state: 'succeeded', outputs: [{ type: 'text', text: 'controlled blocker' }] }
      })
      try {
        const blocker = addNode(f.doc, 'plein/llm', { params: { prompt: 'hold' } })
        const blockerJob = f.server.runs.start(f.id, blocker, 'local')
        await held
        const plan = await f.preview({
          shotIds: [f.shots[0]!.id, f.shots[2]!.id],
          role: 'video',
          reuseExisting: true,
        })
        expect(plan.summary.run, JSON.stringify(plan.rows)).toBe(1)
        const started = await f.batches.commit(f.id, f.board, 'local', plan.token)
        expect(started).toHaveProperty('started')
        await until(
          () => f.server.runs.store.latestForNodes(f.id, [f.thirdVideo])[0]?.status === 'queued',
        )
        const item = f.server.db.$client
          .prepare('SELECT * FROM batch_items WHERE group_id=? AND node_id=?')
          .get('started' in started ? started.started.groupId : '', f.thirdVideo) as BatchItemRow
        expect(JSON.parse(item.input!).kind).toBe('plein-reviewed-sequence-input')
        const storedScope = expectOf(item).sequenceScope!
        expect(storedScope.clipInstanceIds).toContain('fixed-0')
        expect(storedScope.shotIds).toEqual([f.shots[0]!.id, f.shots[2]!.id])
        expect(batchItem(item).input).not.toHaveProperty('kind')
        const queuedJob = f.server.runs.store.latestForNodes(f.id, [f.thirdVideo])[0]!
        expect(JSON.parse(queuedJob.expect!).sequenceScope).toEqual(storedScope)
        if (mutation === 'mapping') {
          const rows = structuredClone(f.doc.get(f.sequence)!.params!.clips as SequenceInstance[])
          setParam(
            f.doc,
            f.sequence,
            'clips',
            rows.map((row) =>
              row.clipInstanceId === 'fixed-0' ? { ...row, sound: 'voice' } : row,
            ),
          )
        } else if (mutation === 'missing-file') await rm(f.server.assets.originalPath(f.asset.id))
        else {
          const path = f.server.assets.originalPath(f.asset.id)
          const bytes = await readFile(path)
          bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
          await writeFile(path, bytes)
        }
        release()
        await f.server.runs.wait(blockerJob)
        await until(() =>
          ['failed', 'canceled'].includes(
            f.server.runs.store.latestForNodes(f.id, [f.thirdVideo])[0]?.status ?? '',
          ),
        )
        expect(
          f.server.runs.list(f.id).jobs.find((job) => job.nodeId === f.thirdVideo)?.recovery?.state,
          mutation,
        ).toBe('review')
        expect(
          submit.mock.calls.filter(([request]) => request.capability === 'video.generate'),
        ).toHaveLength(0)
      } finally {
        release()
        submit.mockRestore()
      }
    }
  }, 45_000)

  it('v2只收实际live端口并冻结精确来源，fixed遗留边不递归旧生成或配音', async () => {
    const f = await sequenceSegmentFixture()
    const submit = vi.spyOn(mockProvider, 'submit')
    const rows = structuredClone(f.doc.get(f.sequence)!.params!.clips as SequenceInstance[])
    setParam(f.doc, f.sequence, 'clips', rows.slice(0, 2))
    f.doc.edgeMap.set('stale-fixed-edge', {
      id: 'stale-fixed-edge',
      from: [f.originalVideo, 'video'],
      to: [f.sequence, 'clips'],
    })
    deleteElements(f.doc, [f.originalVideo])
    const speech = f.node(0, 'speech')!
    f.doc.edgeMap.set('unused-native-voice', {
      id: 'unused-native-voice',
      from: [speech, 'audio'],
      to: [f.sequence, 'dialogue'],
    })
    expect(runGraph(f.doc).ancestors(f.sequence).has(speech)).toBe(false)
    const fixed = await f.server.runs.inspect(
      f.doc,
      f.doc.get(f.sequence)!,
      'local',
      new AbortController().signal,
      f.id,
    )
    expect(fixed.input.status).toBe('ready')
    expect(fixed.inputs.clips).toBeUndefined()
    expect(fixed.inputs.dialogue).toBeUndefined()
    updateElement(f.doc, f.thirdVideo, {
      ports: {
        inputs: [],
        outputs: [
          { id: 'video', type: 'video', label: '主视频' },
          { id: 'alternate', type: 'video', label: '第二视频' },
        ],
      },
    })
    addResults(f.doc, f.thirdVideo, [
      {
        id: 'primary',
        port: 'video',
        runId: 'two-ports',
        outputGroup: 'same',
        at: 1,
        value: { type: 'video', assetId: 'f'.repeat(64) },
      },
      {
        id: 'alternate',
        port: 'alternate',
        runId: 'two-ports',
        outputGroup: 'same',
        at: 1,
        value: { type: 'video', assetId: f.asset.id },
      },
    ])
    f.doc.edgeMap.set('exact-alternate', {
      id: 'exact-alternate',
      from: [f.thirdVideo, 'alternate'],
      to: [f.sequence, 'clips'],
    })
    setParam(f.doc, f.sequence, 'clips', [
      {
        clipInstanceId: 'live-alt',
        source: f.thirdVideo,
        port: 'alternate',
        edgeId: 'exact-alternate',
        sound: 'native',
        in: 0,
        out: 2,
      },
    ])
    const live = await f.server.runs.inspect(
      f.doc,
      f.doc.get(f.sequence)!,
      'local',
      new AbortController().signal,
      f.id,
    )
    expect(live.inputs.clips).toHaveLength(1)
    expect(live.inputs.clips![0]).toMatchObject({
      assetId: f.asset.id,
      sourcePort: 'alternate',
      edgeId: 'exact-alternate',
      resultId: 'alternate',
      runId: 'two-ports',
      sourceCanvasId: f.id,
    })
    expect(currentResult(f.doc.get(f.thirdVideo)!)?.id).toBe('primary')
    expect(submit).not.toHaveBeenCalled()
  }, 30_000)

  it('unknown原job人工恢复沿原freeze，当前scope变更只令结果入历史，不绕过或重跑其他镜', async () => {
    const f = await sequenceSegmentFixture()
    const bytes = await readFile(f.file)
    const submit = vi.spyOn(mockProvider, 'submit').mockImplementation(async () => {
      if (submit.mock.calls.length === 1)
        throw new ProviderError('unavailable', 'controlled response loss', { outcome: 'unknown' })
      return {
        state: 'succeeded',
        outputs: [{ type: 'file', kind: 'video', mime: 'video/mp4', data: bytes }],
      }
    })
    const lookup = mockProvider.lookup
    mockProvider.lookup = undefined
    try {
      const plan = await f.preview({
        shotIds: [f.shots[2]!.id],
        role: 'video',
        reuseExisting: true,
      })
      const started = await f.batches.commit(f.id, f.board, 'local', plan.token)
      expect(started).toHaveProperty('started')
      await until(
        () => f.server.runs.store.latestForNodes(f.id, [f.thirdVideo])[0]?.status === 'failed',
      )
      const job = f.server.runs.store.latestForNodes(f.id, [f.thirdVideo])[0]!
      expect(f.server.runs.list(f.id).jobs.find((row) => row.id === job.id)?.recovery?.state).toBe(
        'submit_unknown',
      )
      const frozen = job.frozen
      const rows = structuredClone(f.doc.get(f.sequence)!.params!.clips as SequenceInstance[])
      setParam(
        f.doc,
        f.sequence,
        'clips',
        rows.map((row) => (row.source === f.thirdVideo ? { ...row, sound: 'native' } : row)),
      )
      expect(
        (await f.preview({ shotIds: [f.shots[2]!.id], role: 'video', reuseExisting: true })).summary
          .blocked,
      ).toBe(1)
      f.server.runs.recoverJob(f.id, job.id, 'local', { action: 'resubmit' })
      await until(() => f.server.runs.store.get(job.id)?.status === 'succeeded')
      const { outputEvidence: _afterEvidence, ...afterExecution } = JSON.parse(
        f.server.runs.store.get(job.id)!.frozen!,
      )
      const { outputEvidence: _beforeEvidence, ...beforeExecution } = JSON.parse(frozen!)
      expect(afterExecution).toEqual(beforeExecution)
      expect(currentResult(f.doc.get(f.thirdVideo)!)).toBeUndefined()
      expect(f.doc.get(f.thirdVideo)!.results).toHaveLength(1)
      expect(f.server.runs.store.countForNode(f.id, f.thirdVideo)).toBe(1)
      const history = JSON.parse(f.server.runs.store.get(job.id)!.call_history) as Array<{
        kind: string
      }>
      expect(history.filter((event) => event.kind === 'submit_started')).toHaveLength(2)
      expect(history.filter((event) => event.kind === 'manual_resubmit')).toHaveLength(1)
      expect(submit).toHaveBeenCalledTimes(2)
      expect(JSON.parse(frozen!).params).not.toHaveProperty('sequenceScope')
      expect(JSON.parse(frozen!).inputs).not.toHaveProperty('sequenceScope')
    } finally {
      mockProvider.lookup = lookup
    }
  }, 30_000)
})
