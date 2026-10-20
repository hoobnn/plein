/**
 * 显式运行的零新增付费验收：真实项目包迁移、三个独立项目连续本地合成和冷启动。
 * 不进单元测试或 CI。必须提供 PLEIN_ACCEPTANCE_PACKAGE / PLEIN_ACCEPTANCE_OUT。
 * 不将既有素材复用结果解释为新增云端生成验收。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createDoc, currentResult, removeEdges, setParam, type PleinDoc } from '@plein/doc'
import {
  arrangeSequence,
  sequenceNode,
  sequenceTimeline,
  subtitleInputKey,
  type SequenceClip,
} from '@plein/nodes'
import { createServer, type Server } from '../src/app'
import { loadConfig } from '../src/config'
import { inspectPackage, commitImport } from '../src/projects/package'
import { builtinPlugins } from '../src/plugins/builtin'
import { openZipEntry, readZipIndex } from '../src/projects/zip'
import * as Y from 'yjs'

const packagePath = process.env.PLEIN_ACCEPTANCE_PACKAGE
const outputPath = process.env.PLEIN_ACCEPTANCE_OUT
assert(packagePath && outputPath, '必须显式指定输入项目包与新的独立输出目录')
assert(process.env.PLEIN_ACCEPTANCE_FREEZE_ID, '必须指定冻结版本 ID')
const out = resolve(outputPath)
await mkdir(out, { recursive: false, mode: 0o700 })
const startedAt = new Date().toISOString()
const exec = promisify(execFile)
const hash = async (file: string) => {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(file)) digest.update(bytes)
  return digest.digest('hex')
}
const report: Record<string, unknown> = {
  scope: 'existing-real-media-no-new-paid-generation',
  startedAt,
  packageSha256: await hash(packagePath),
  freezeId: process.env.PLEIN_ACCEPTANCE_FREEZE_ID ?? null,
  node: process.version,
  results: [],
}
const persist = () => writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
await persist()
let providerAttempts = 0
let fetchAttempts = 0
const originalFetch = globalThis.fetch
globalThis.fetch = async () => {
  fetchAttempts++
  throw new Error('验收禁止外部网络调用')
}
const configs = [
  { label: 'migration-full', range: null },
  { label: 'continuous-01', range: [1, 2] },
  { label: 'continuous-02', range: [3, 4] },
  { label: 'continuous-03', range: [5, 6] },
] as const

function openDoc(server: Server, id: string) {
  return createDoc(server.rooms.get(id).doc)
}
function adoption(doc: PleinDoc, except = '') {
  return JSON.parse(
    JSON.stringify(
      Object.fromEntries(
        [...doc.elements()]
          .filter((el) => el.id !== except && el.results?.length)
          .map((el) => [
            el.id,
            { adopted: el.adopted, results: el.results, current: currentResult(el) },
          ]),
      ),
    ),
  )
}
const entries = await readZipIndex(packagePath)
const sourceEntries = entries.filter((entry) => /^canvases\/\d+\.yjs$/.test(entry.name))
assert.equal(sourceEntries.length, 1, '本验收固定使用单画布青声智讲包')
assert(sourceEntries[0]!.size < 32 * 1024 * 1024)
const sourceBytes: Buffer[] = []
for await (const chunk of await openZipEntry(packagePath, sourceEntries[0]!))
  sourceBytes.push(Buffer.from(chunk))
const sourceYdoc = new Y.Doc()
Y.applyUpdate(sourceYdoc, Buffer.concat(sourceBytes))
const sourceDoc = createDoc(sourceYdoc)
const sourceSequences = [...sourceDoc.elements()].filter((el) => el.nodeType === 'plein/sequence')
assert.equal(sourceSequences.length, 1)
const sourceTrack = sequenceNode.params.parse(sourceSequences[0]!.params).subtitleTrack
assert(sourceTrack, '源包必须保存人工字幕轨')
assert.equal(sourceTrack.cues.filter((cue) => !cue.hidden).length, 56)
// 新副本重映射jobId；只归一化运行指针，候选ID、正文、资产及顺序不放宽。
const semantic = (value: unknown) =>
  JSON.parse(JSON.stringify(value, (key, item) => (key === 'runId' ? undefined : item)))
const sourceAdoption = semantic(adoption(sourceDoc))

async function compose(server: Server, canvasId: string, nodeId: string) {
  const runId = server.runs.start(canvasId, nodeId, 'local')
  const status = await Promise.race([
    server.runs.wait(runId),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('合成超过20分钟')), 20 * 60_000)
      timer.unref()
    }),
  ])
  assert.equal(status, 'succeeded', server.runs.store.get(runId)?.error ?? '')
  const end = Date.now() + 30_000
  while (server.runs.isRunning(canvasId, nodeId)) {
    assert(Date.now() < end, '合成任务未退出运行态')
    await new Promise((r) => setTimeout(r, 20))
  }
  const result = currentResult(openDoc(server, canvasId).get(nodeId)!)?.value
  assert(result && 'assetId' in result && result.type === 'video', '序列必须产生视频')
  return { runId, result }
}

const restores: Array<() => void> = []
for (const plugin of builtinPlugins({ mock: false }))
  for (const def of plugin.providers) {
    const submit = def.submit
    def.submit = async () => {
      providerAttempts++
      throw new Error('验收禁止新增生成提交')
    }
    restores.push(() => {
      def.submit = submit
    })
  }
let continuous: Server | undefined
const coldChecks: Array<{
  dataDir: string
  canvasId: string
  sequenceId: string
  assetId: string
  before: unknown
  item: Record<string, unknown>
}> = []
try {
  for (const config of configs) {
    const stepStarted = Date.now()
    const dataDir = join(out, config.range ? 'continuous-series' : config.label)
    const settings = {
      ...loadConfig({
        ...process.env,
        PLEIN_DATA_DIR: dataDir,
        PLEIN_PORT: '0',
        PLEIN_MOCK_PROVIDER: '0',
        PLEIN_AGENT: '0',
        PLEIN_MCP: '0',
      }),
      webDist: null,
    }
    const server = config.range && continuous ? continuous : await createServer(settings)
    if (config.range) continuous = server
    let closed = false
    try {
      const deps = {
        db: server.db,
        rooms: server.rooms,
        assets: server.assets,
        host: server.plugins,
        dataDir,
        mediaIndex: server.mediaIndex,
      }
      const preview = await inspectPackage(deps, 'local', createReadStream(packagePath))
      assert.deepEqual(preview.missing, [], '源包必须没有已知缺失项')
      const imported = await commitImport(deps, 'local', preview.token)
      assert(imported?.canvasId, '必须导入画布')
      const rows = server.db.$client.prepare('SELECT DISTINCT id FROM assets').all() as Array<{
        id: string
      }>
      assert(rows.length >= preview.counts.assets)
      for (const { id } of rows) assert.equal(await hash(server.assets.originalPath(id)), id)
      let doc = openDoc(server, imported.canvasId)
      const sequences = [...doc.elements()].filter((el) => el.nodeType === 'plein/sequence')
      assert.equal(sequences.length, 1, '需要唯一序列；多个序列时须显式指定目标')
      const sequence = sequences[0]!
      assert.deepEqual(
        semantic(adoption(doc)),
        sourceAdoption,
        '导入必须保留源包全部候选与采用语义',
      )
      const importedTrack = sequenceNode.params.parse(sequence.params).subtitleTrack
      assert(importedTrack)
      assert.deepEqual(importedTrack, sourceTrack, '导入必须保留原人工字幕正文与时间')
      const before = adoption(doc, sequence.id)
      if (config.range) {
        const clips = sequence.params?.clips as SequenceClip[]
        assert(clips.length >= config.range[1] + 1)
        const selected = config.range.map((i) => clips[i]!)
        const keep = new Set(selected.map((clip) => clip.source))
        const audio = new Set(
          selected
            .flatMap((clip) => [clip.dialogue, clip.sfx, ...(clip.more ?? [])])
            .filter(Boolean),
        )
        removeEdges(
          doc,
          [...doc.edges()]
            .filter(
              (edge) =>
                edge.to[0] === sequence.id &&
                ((edge.to[1] === 'clips' && !keep.has(edge.from[0])) ||
                  (['dialogue', 'sfx'].includes(edge.to[1]) && !audio.has(edge.from[0]))),
            )
            .map((edge) => edge.id),
        )
        assert.equal(
          [...doc.edges()].filter((edge) => edge.to[0] === sequence.id && edge.to[1] === 'clips')
            .length,
          2,
        )
        setParam(doc, sequence.id, 'clips', selected)
        // 不请求 ASR；保留原有人工字幕/对白文本，由序列原生本地合同处理。
        setParam(doc, sequence.id, 'asrTiming', false)
      }
      const inspection = await server.runs.inspect(
        doc,
        doc.get(sequence.id)!,
        'local',
        new AbortController().signal,
      )
      let params = sequenceNode.params.parse(inspection.params)
      const arranged = arrangeSequence(params, inspection.inputs)
      assert.equal(arranged.length, config.range ? 2 : 19)
      assert.deepEqual(
        arranged.map((clip) => clip.source),
        params.clips.map((clip) => clip.source),
      )
      assert(params.subtitleTrack, '不得丢弃人工字幕轨后改用自动字幕')
      if (config.range) {
        const sources = new Set(arranged.map((clip) => clip.source))
        const cues = params.subtitleTrack.cues.filter((cue) => sources.has(cue.source))
        assert(
          cues.some((cue) => !cue.hidden && cue.text.trim()),
          '短片保留原人工字幕',
        )
        setParam(doc, sequence.id, 'subtitleTrack', {
          cues,
          inputKey: subtitleInputKey(params, arranged),
        })
        params = sequenceNode.params.parse(doc.get(sequence.id)!.params)
      }
      const durationOf = (id: string) => server.assets.get('local', id)?.duration ?? 0
      const timeline = sequenceTimeline(params, arranged, {
        clips: arranged.map((clip) => durationOf(clip.clip.assetId)),
        dialogue: arranged.map((clip) =>
          clip.dialogue ? durationOf(clip.dialogue.assetId) : undefined,
        ),
        more: arranged.map((clip) => clip.more.map((line) => durationOf(line.assetId))),
      })
      if (config.range)
        assert(
          timeline.clips.every((clip) => clip.cues.length > 0),
          '每个短片镜头必须包含可见字幕',
        )
      else
        assert.equal(
          timeline.clips.reduce((sum, clip) => sum + clip.cues.length, 0),
          56,
        )
      assert(timeline.total > 0)
      const first = await compose(server, imported.canvasId, sequence.id)
      assert.deepEqual(adoption(doc, sequence.id), before, '本地合成不得改动上游候选或采用')
      const video = server.assets.originalPath(first.result.assetId)
      const destination = join(out, `${config.label}.mp4`)
      await copyFile(video, destination)
      const decoded = await exec(
        settings.ffmpegPath,
        ['-v', 'error', '-xerror', '-i', destination, '-f', 'null', '-'],
        {
          maxBuffer: 1024 * 1024,
          timeout: 120_000,
        },
      )
      assert.equal(decoded.stderr.trim(), '', '解码不得有被忽略的错误')
      const { stdout } = await exec(
        settings.ffprobePath,
        ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', destination],
        { timeout: 30_000 },
      )
      const probe = JSON.parse(stdout)
      assert(probe.streams.some((s: { codec_type: string }) => s.codec_type === 'video'))
      assert(probe.streams.some((s: { codec_type: string }) => s.codec_type === 'audio'))
      assert(Number(probe.format.duration) > 0)
      assert(
        Math.abs(Number(probe.format.duration) - timeline.total) < 2 / 30,
        '输出时长必须与原生序列计划相符',
      )
      const videoStream = probe.streams.find(
        (s: { codec_type: string }) => s.codec_type === 'video',
      )
      const audioStream = probe.streams.find(
        (s: { codec_type: string }) => s.codec_type === 'audio',
      )
      assert.deepEqual([videoStream.width, videoStream.height], [1920, 1080])
      assert.equal(videoStream.r_frame_rate, '30/1')
      assert.equal(videoStream.codec_name, 'h264')
      assert.equal(audioStream.codec_name, 'aac')
      assert.equal(audioStream.sample_rate, '48000')
      assert.equal(audioStream.channels, 2)
      if (!config.range) assert(Math.abs(timeline.total - 206.167) < 0.1)
      assert.equal(await hash(destination), first.result.assetId)
      assert.equal(providerAttempts, 0)
      assert.equal(fetchAttempts, 0)
      const item = {
        label: config.label,
        projectId: imported.projectId,
        canvasId: imported.canvasId,
        sequenceId: sequence.id,
        dataDir,
        sourceAssetsChecked: rows.length,
        runId: first.runId,
        assetId: first.result.assetId,
        sha256: await hash(destination),
        expectedDuration: timeline.total,
        clipCount: arranged.length,
        subtitleCues: timeline.clips.reduce((sum, clip) => sum + clip.cues.length, 0),
        output: destination,
        duration: Number(probe.format.duration),
        streams: probe.streams.map((s: Record<string, unknown>) => ({
          type: s.codec_type,
          codec: s.codec_name,
          width: s.width,
          height: s.height,
          sampleRate: s.sample_rate,
          channels: s.channels,
        })),
        decode: 'passed',
        coldStart: 'pending',
        upstreamUnchanged: true,
        producerPid: process.pid,
        elapsedMs: Date.now() - stepStarted,
      }
      ;(report.results as unknown[]).push(item)
      coldChecks.push({
        dataDir,
        canvasId: imported.canvasId,
        sequenceId: sequence.id,
        assetId: first.result.assetId,
        before,
        item,
      })
      await persist()
      console.log(JSON.stringify(item))
    } finally {
      if (!config.range && !closed) {
        await server.close()
        closed = true
      }
    }
  }
  if (continuous) {
    await continuous.close()
    continuous = undefined
  }
  const series = coldChecks.filter((check) => check.dataDir.endsWith('continuous-series'))
  assert.equal(new Set(series.map((check) => check.canvasId)).size, 3)
  assert.equal(new Set(series.map((check) => check.item.projectId)).size, 3)
  for (const check of coldChecks) {
    const cold = await exec(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./stable-production-cold-start.ts', import.meta.url)),
        check.dataDir,
        check.canvasId,
        check.sequenceId,
        check.assetId,
      ],
      {
        env: { ...process.env, PLEIN_AGENT: '0', PLEIN_MCP: '0' },
        timeout: 60_000,
      },
    )
    const proof = JSON.parse(cold.stdout.trim().split('\n').at(-1)!)
    assert.equal(proof.providerAttempts, 0)
    assert.deepEqual(proof.adoption, check.before)
    check.item.coldStart = 'passed'
    check.item.coldStartPid = proof.pid
    await persist()
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = (error as Error).message
  throw error
} finally {
  globalThis.fetch = originalFetch
  if (continuous) await continuous.close()
  restores.forEach((restore) => restore())
  report.providerAttempts = providerAttempts
  report.fetchAttempts = fetchAttempts
  report.finishedAt = new Date().toISOString()
  await persist()
}
