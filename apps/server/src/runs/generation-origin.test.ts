import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, mockSettings, until } from '../testing'
import {
  connect,
  createDoc,
  currentResult,
  fixSequenceInstance,
  sequenceInstancesOf,
  writeRun,
  type PleinDoc,
} from '@plein/doc'
import { referenceClipboard } from '@plein/capabilities'
import { arrangeSequence, sequenceNode, sequenceSpec } from '@plein/nodes'
import { mockProvider } from '@plein/providers'
import { hasFfmpeg } from '../assets/media'
import type { PortValue } from '@plein/plugin-sdk'
import { batchSourceKey } from './batch'
import { PluginHost } from '../plugins/host'

const available = await hasFfmpeg()
afterEach(() => vi.restoreAllMocks())

async function generated(
  checkBeforeSubmit?: (
    scope: { canvasId: string; nodeId: string; runId: string },
    frozen: Record<string, unknown>,
  ) => void,
  checkPublished?: (frozen: Record<string, unknown>, result: unknown) => void,
) {
  const running = await bootServer()
  const { server } = running
  mockSettings(server, { latencyMs: 0 })
  const { id, doc } = await createCanvas(server)
  const source = addNode(doc, 'plein/video', {
    nodeVersion: 2,
    params: { mode: 'text', prompt: 'controlled original execution scope', duration: 2 },
  })
  const sequence = addNode(doc, 'plein/sequence', {
    nodeVersion: 2,
    params: { instanceVersion: 2, clips: [], subtitles: false },
  })
  connect(doc, [source, 'video'], [sequence, 'clips'])
  const published = () => {
    const rows = doc.mutable(source)?.get('results') as unknown[] | undefined
    const job = server.runs.store.latestForNodes(id, [source])[0]
    if (checkPublished && rows?.length && job?.frozen)
      checkPublished(JSON.parse(job.frozen), rows[0])
  }
  doc.ydoc.on('update', published)
  if (checkBeforeSubmit) {
    const original = mockProvider.submit
    vi.spyOn(mockProvider, 'submit').mockImplementation(async (...args) => {
      const job = server.runs.store.latestForNodes(id, [source])[0]!
      checkBeforeSubmit({ canvasId: id, nodeId: source, runId: job.id }, JSON.parse(job.frozen!))
      return original(...args)
    })
  }
  const run = server.runs.start(id, source, 'local')
  expect(await server.runs.wait(run)).toBe('succeeded')
  doc.ydoc.off('update', published)
  await until(() => !server.runs.isRunning(id, source))
  const result = currentResult(doc.get(source)!, 'video')!
  if (result.value.type !== 'video') throw new Error('expected mock video')
  const asset = server.assets.get('local', result.value.assetId)!
  return { ...running, id, doc, source, sequence, run, result, asset }
}

async function inputs(
  f: Awaited<ReturnType<typeof generated>>,
  doc: PleinDoc,
  id: string,
  canvas: string,
) {
  return (
    f.server.runs as unknown as {
      collectInputs(
        doc: PleinDoc,
        id: string,
        owner: string,
        signal: AbortSignal,
        depth: number,
        origins: undefined,
        lenient: boolean,
        canvas: string,
      ): Promise<Record<string, PortValue[]>>
    }
  ).collectInputs(doc, id, 'local', new AbortController().signal, 0, undefined, false, canvas)
}

describe.skipIf(!available)('P11原执行出处与候选承载位置分离', () => {
  it('首执行先持久原scope；真实job复制同/跨canvas后live和fix仍指原任务，selection指本地候选', async () => {
    let checked = false
    let sawPublication = false
    let persistedBeforePublish = false
    const f = await generated(
      (scope, frozen) => {
        expect(frozen.executionOrigin).toEqual(scope)
        expect(frozen.params).not.toHaveProperty('executionOrigin')
        expect(frozen.inputs).not.toHaveProperty('executionOrigin')
        checked = true
      },
      (frozen, result) => {
        if (sawPublication) return
        sawPublication = true
        const text = JSON.stringify(frozen.outputEvidence)
        const row = result as { generationOrigin?: { resultId: string } }
        persistedBeforePublish =
          !!row.generationOrigin && !!text?.includes(row.generationOrigin.resultId)
      },
    )
    expect(checked).toBe(true)
    expect(sawPublication).toBe(true)
    expect(persistedBeforePublish).toBe(true)
    const expected = {
      canvasId: f.id,
      nodeId: f.source,
      port: 'video',
      resultId: f.result.id,
      runId: f.run,
    }
    expect(JSON.parse(f.server.runs.store.get(f.run)!.frozen!).executionOrigin).toEqual({
      canvasId: f.id,
      nodeId: f.source,
      runId: f.run,
    })
    expect(f.result.generationOrigin).toEqual(expected)
    const destination = await createCanvas(f.server)
    const data = referenceClipboard.copy(f.doc, [f.source, f.sequence])
    for (const target of [{ id: f.id, doc: f.doc }, destination]) {
      const copied = referenceClipboard.paste(target.doc, data, { canvasId: target.id })
      const source = copied.find((id) => target.doc.get(id)!.nodeType === 'plein/video')!
      const sequence = copied.find((id) => target.doc.get(id)!.nodeType === 'plein/sequence')!
      expect(source).not.toBe(f.source)
      const collected = await inputs(f, target.doc, sequence, target.id)
      expect(collected.clips![0]).toMatchObject({
        source,
        sourceCanvasId: target.id,
        generationOrigin: expected,
      })
      expect(collected.clips![0]).not.toHaveProperty('originCanvasId')
      const params = sequenceNode.params.parse(target.doc.get(sequence)!.params)
      const spec = sequenceSpec(
        params,
        arrangeSequence(params, collected),
        { clips: [f.asset.duration!], dialogue: [undefined], more: [[]] },
        undefined,
      )
      const selection = {
        canvasId: target.id,
        nodeId: source,
        port: 'video',
        resultId: f.result.id,
        runId: f.run,
      }
      expect(spec.clips[0]!.provenance).toMatchObject({ origin: expected, selection })
      const row = sequenceInstancesOf(target.doc.get(sequence)!)[0]!
      expect(
        fixSequenceInstance(target.doc, sequence, row.clipInstanceId, {
          canvasId: target.id,
          assetId: f.asset.id,
          duration: f.asset.duration!,
          sound: 'native',
          resultId: f.result.id,
        }),
      ).toBe(true)
      const segment = sequenceInstancesOf(target.doc.get(sequence)!)[0]!.segment!
      expect(segment.origin).toEqual(expected)
      expect(segment.selection).toEqual(selection)
      const [next] = referenceClipboard.paste(
        destination.doc,
        referenceClipboard.copy(target.doc, [sequence]),
        { canvasId: destination.id },
      )
      expect(sequenceInstancesOf(destination.doc.get(next!)!)[0]!.segment).toEqual(segment)
    }
  }, 30_000)

  it('旧候选无原scope不猜；元数据变化不污染PreparedInput、content/plan/source hash', async () => {
    const f = await generated()
    const before = await f.server.runs.preview(f.id, f.sequence, 'local')
    const sourceHash = batchSourceKey(f.doc, f.doc.get(f.source)!)
    const planHash = batchSourceKey(f.doc, f.doc.get(f.sequence)!)
    const legacy = { ...f.result, generationOrigin: undefined }
    f.doc.mutable(f.source)!.set('results', [legacy])
    const after = await f.server.runs.preview(f.id, f.sequence, 'local')
    expect(after.inputHash).toBe(before.inputHash)
    expect(after.inputs).toEqual(before.inputs)
    expect(after.params).toEqual(before.params)
    expect(batchSourceKey(f.doc, f.doc.get(f.source)!)).toBe(sourceHash)
    expect(batchSourceKey(f.doc, f.doc.get(f.sequence)!)).toBe(planHash)
    const collected = await inputs(f, f.doc, f.sequence, f.id)
    expect(collected.clips![0]).not.toHaveProperty('generationOrigin')
    expect(collected.clips![0]).not.toHaveProperty('originCanvasId')
    const params = sequenceNode.params.parse(f.doc.get(f.sequence)!.params)
    const spec = sequenceSpec(
      params,
      arrangeSequence(params, collected),
      { clips: [f.asset.duration!], dialogue: [undefined], more: [[]] },
      undefined,
    )
    expect(spec.clips[0]!.provenance!.origin).toBeUndefined()
    expect(spec.clips[0]!.provenance!.selection).toEqual({
      canvasId: f.id,
      nodeId: f.source,
      port: 'video',
      resultId: f.result.id,
      runId: f.run,
    })
    const row = sequenceInstancesOf(f.doc.get(f.sequence)!)[0]!
    expect(
      fixSequenceInstance(f.doc, f.sequence, row.clipInstanceId, {
        canvasId: f.id,
        assetId: f.asset.id,
        duration: f.asset.duration!,
        sound: 'native',
      }),
    ).toBe(true)
    expect(sequenceInstancesOf(f.doc.get(f.sequence)!)[0]!.segment).toMatchObject({
      selection: spec.clips[0]!.provenance!.selection,
    })
    expect(sequenceInstancesOf(f.doc.get(f.sequence)!)[0]!.segment!.origin).toBeUndefined()
  }, 30_000)

  for (const mode of [
    'known-frozen',
    'legacy-missing',
    'legacy-invalid',
    'legacy-no-scope',
    'payload-changed',
  ] as const) {
    it(`${mode}: SQLite恢复到别名位置仅用原frozen证据，不重新submit或猜旧scope`, async () => {
      const f = await generated()
      const submit = vi.spyOn(mockProvider, 'submit')
      const destination = await createCanvas(f.server)
      const [source] = referenceClipboard.paste(
        destination.doc,
        referenceClipboard.copy(f.doc, [f.source]),
        { canvasId: destination.id },
      )
      const frozen = JSON.parse(f.server.runs.store.get(f.run)!.frozen!)
      if (mode === 'legacy-missing') delete frozen.outputEvidence
      if (mode === 'legacy-invalid' && frozen.outputEvidence)
        delete frozen.outputEvidence.publications[0].outputs[0].origin.resultId
      if (mode === 'legacy-no-scope') {
        delete frozen.executionOrigin
        delete frozen.outputEvidence
      }
      const alias = `imported-alias-${mode}`
      f.server.runs.store.update(f.run, {
        frozen: JSON.stringify(frozen),
        status: 'running',
        recovery: null,
      })
      f.server.db.$client
        .prepare('UPDATE jobs SET id=?,canvas_id=?,node_id=? WHERE id=?')
        .run(alias, destination.id, source, f.run)
      writeRun(destination.doc, source!, { id: alias, status: 'running', at: Date.now() })
      await f.close()
      if (mode === 'payload-changed') {
        const runNode = PluginHost.prototype.runNode
        vi.spyOn(PluginHost.prototype, 'runNode').mockImplementation(async function (
          this: PluginHost,
          options,
        ) {
          const result = await runNode.call(this, options)
          return options.type === 'plein/video'
            ? {
                ...result,
                video: result.video!.map((value) => ({
                  ...value,
                  caption: 'changed entire payload, same file',
                })),
              }
            : result
        })
      }
      const second = await bootServer({ dataDir: f.dataDir })
      expect(await second.server.runs.wait(alias)).toBe('succeeded')
      await until(() => !second.server.runs.isRunning(destination.id, source!))
      const doc = createDoc(second.server.rooms.get(destination.id).doc, { schedule: () => {} })
      try {
        const result = doc.get(source!)!.results!.find((result) => result.runId === alias)!
        expect(result).toBeDefined()
        if (mode === 'known-frozen') {
          expect(result.id).not.toBe(f.result.id)
          expect(result.generationOrigin).toEqual(f.result.generationOrigin)
        } else expect(result.generationOrigin).toBeUndefined()
        expect(submit).not.toHaveBeenCalled()
      } finally {
        doc.destroy()
      }
    }, 30_000)
  }

  it('显式manual_resubmit新的持久提交身份不能套用同文件的旧原候选tuple', async () => {
    const f = await generated()
    const oldOrigin = structuredClone(f.result.generationOrigin)
    const row = f.server.runs.store.get(f.run)!
    const [key, call] = Object.entries(JSON.parse(row.calls!))[0]! as [
      string,
      { trace?: { attemptId: string; requestId: string } },
    ]
    f.server.runs.store.journal(f.run).set(key, {
      state: 'unknown',
      at: Date.now(),
      message: 'controlled replay of unresolved state',
      trace: call.trace,
    })
    f.server.runs.store.update(f.run, {
      status: 'failed',
      recovery: JSON.stringify({ state: 'submit_unknown' }),
    })
    const submit = vi.spyOn(mockProvider, 'submit')
    f.server.runs.recoverJob(f.id, f.run, 'local', { action: 'resubmit' })
    expect(await f.server.runs.wait(f.run)).toBe('succeeded')
    await until(() => !f.server.runs.isRunning(f.id, f.source))
    const fresh = currentResult(f.doc.get(f.source)!, 'video')!
    expect(submit).toHaveBeenCalledTimes(1)
    expect(fresh.value).toEqual(f.result.value)
    expect(fresh.generationOrigin).toEqual({ ...oldOrigin, resultId: fresh.id })
    expect(fresh.generationOrigin).not.toEqual(oldOrigin)
    const history = f.server.runs.jobInfo(f.server.runs.store.get(f.run)!).submissionHistory!
    expect(history.filter((event) => event.kind === 'submit_started')).toHaveLength(2)
    expect(history.filter((event) => event.kind === 'manual_resubmit')).toHaveLength(1)
  }, 30_000)
})
