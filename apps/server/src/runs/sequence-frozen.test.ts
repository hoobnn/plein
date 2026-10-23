import { addNode, bootServer, until } from '../testing'
import { connect, createDoc, currentResult, SCHEMA_VERSION } from '@plein/doc'
import type { ComposeSpec } from '@plein/plugin-sdk'
import { hasFfmpeg } from '../assets/media'
import { PluginHost } from '../plugins/host'
import { sequenceSegmentFixture } from './sequence-segment-fixture'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

const available = await hasFfmpeg()
afterEach(() => vi.restoreAllMocks())

describe('序列实例损坏时直接拒绝', () => {
  it('实例版序列的镜头缺少实例身份时先修复，不猜着渲染', async () => {
    const f = await sequenceSegmentFixture()
    const sequence = addNode(f.doc, 'plein/sequence', {
      nodeVersion: 2,
      params: {
        instanceVersion: 2,
        // 缺少 clipInstanceId 的旧式镜头，不是有实例身份的镜头
        clips: [{ source: f.view, in: 1, out: 3 }],
        subtitles: false,
      },
    })
    connect(f.doc, [f.view, 'video'], [sequence, 'clips'])
    const job = f.server.runs.start(f.id, sequence, 'local')
    expect(await f.server.runs.wait(job)).toBe('failed')
    expect(f.server.runs.store.get(job)?.error).toContain('序列实例损坏')
  })
})

describe.skipIf(!available)('P11 v1在途序列冻结版本恢复', () => {
  for (const mode of ['frozen-version', 'prepared-version', 'unknown-version']) {
    it(`${mode}: shutdown后实际升级文档，不按当前v2参数猜旧任务`, async () => {
      const f = await sequenceSegmentFixture()
      const sequence = addNode(f.doc, 'plein/sequence', {
        nodeVersion: 1,
        params: {
          clips: [{ source: f.view, in: 1, out: 3 }],
          subtitles: false,
          resolution: '720p',
          aspectRatio: '16:9',
          loudnorm: false,
        },
      })
      connect(f.doc, [f.view, 'video'], [sequence, 'clips'])
      let entered!: () => void
      const waiting = new Promise<void>((resolve) => {
        entered = resolve
      })
      const firstServices = f.server.plugins.services.bind(f.server.plugins)
      const hold = vi
        .spyOn(f.server.plugins, 'services')
        .mockImplementation((manifest, options) => {
          const actual = firstServices(manifest, options)
          return {
            ...actual,
            media: {
              ...actual.media,
              compose: async () => {
                entered()
                await new Promise<never>((_resolve, reject) => {
                  if (options.signal.aborted) reject(options.signal.reason)
                  else
                    options.signal.addEventListener('abort', () => reject(options.signal.reason), {
                      once: true,
                    })
                })
                throw new Error('unreachable')
              },
            },
          }
        })
      const job = f.server.runs.start(f.id, sequence, 'local')
      await waiting
      const original = f.server.runs.store.get(job)!
      expect(JSON.parse(original.frozen!).nodeVersion).toBe(1)
      expect(JSON.parse(original.input!).nodeVersion).toBe(1)
      f.server.runs.close()
      expect(await f.server.runs.wait(job)).toBe('running')
      hold.mockRestore()
      f.doc.meta.set('schemaVersion', SCHEMA_VERSION - 1)
      f.doc.migrate()
      expect(f.doc.get(sequence)!.nodeVersion).toBe(2)
      expect(f.doc.get(sequence)!.params!.instanceVersion).toBe(2)
      if (mode !== 'frozen-version') {
        const frozen = JSON.parse(original.frozen!)
        delete frozen.nodeVersion
        const prepared = JSON.parse(original.input!)
        if (mode === 'unknown-version') delete prepared.nodeVersion
        f.server.runs.store.update(job, {
          frozen: JSON.stringify(frozen),
          input: JSON.stringify(prepared),
        })
      }
      await f.close()
      const specs: ComposeSpec[] = []
      const requests: Array<{ version: number; params: unknown; inputs: unknown }> = []
      const runNode = PluginHost.prototype.runNode
      const runTrace = vi.spyOn(PluginHost.prototype, 'runNode').mockImplementation(function (
        this: PluginHost,
        options,
      ) {
        requests.push({
          version: options.version,
          params: structuredClone(options.params),
          inputs: structuredClone(options.inputs),
        })
        return runNode.call(this, options)
      })
      const services = PluginHost.prototype.services
      // Controlled compose double: proves execution of the frozen v1 spec, not MP4 quality.
      const resumed = vi.spyOn(PluginHost.prototype, 'services').mockImplementation(function (
        this: PluginHost,
        manifest,
        options,
      ) {
        const actual = services.call(this, manifest, options)
        return {
          ...actual,
          media: {
            ...actual.media,
            compose: async (spec) => {
              specs.push(structuredClone(spec))
              return { assetId: f.asset.id, kind: 'video', mime: 'video/mp4' }
            },
          },
        }
      })
      try {
        const second = await bootServer({ dataDir: f.dataDir })
        const status = await second.server.runs.wait(job)
        await until(() => !second.server.runs.isRunning(f.id, sequence))
        if (mode === 'unknown-version') {
          expect(status).toBe('failed')
          expect(
            second.server.runs.list(f.id).jobs.find((row) => row.id === job)?.recovery?.state,
          ).toBe('review')
          expect(specs).toHaveLength(0)
          expect(requests).toHaveLength(0)
        } else {
          expect(status, JSON.stringify(second.server.runs.store.get(job))).toBe('succeeded')
          expect(specs).toHaveLength(1)
          expect(specs[0]!.clips.map((clip) => [clip.in, clip.out])).toEqual([[1, 3]])
          expect(requests[0]!.version).toBe(1)
          expect(requests[0]!.params).toEqual(JSON.parse(original.frozen!).params)
          expect(requests[0]!.inputs).toEqual(JSON.parse(original.frozen!).inputs)
          const restored = createDoc(second.server.rooms.get(f.id).doc)
          expect(currentResult(restored.get(sequence)!)).toBeUndefined()
          expect(restored.get(sequence)!.results).toHaveLength(1)
          restored.destroy()
        }
      } finally {
        resumed.mockRestore()
        runTrace.mockRestore()
      }
    }, 30_000)
  }
})
