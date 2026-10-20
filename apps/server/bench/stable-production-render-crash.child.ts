/** 独立真实媒体中断验收子进程；不是生产入口。 */
import assert from 'node:assert/strict'
import { createReadStream, appendFileSync } from 'node:fs'
import { copyFile, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { createDoc, currentResult, type PleinDoc } from '@plein/doc'
import { createServer } from '../src/app'
import { loadConfig } from '../src/config'
import { builtinPlugins } from '../src/plugins/builtin'
import { inspectPackage, commitImport } from '../src/projects/package'
import { sequenceEditState } from './stable-production-snapshot'

const [mode, out] = process.argv.slice(2)
assert((mode === 'interrupt' || mode === 'recover') && out)
const packagePath = process.env.PLEIN_ACCEPTANCE_PACKAGE
assert(packagePath)
const audit = join(out, 'forbidden-attempts.jsonl')
if (mode === 'interrupt') await writeFile(audit, '')
function forbidden(kind: string): never {
  appendFileSync(
    audit,
    `${JSON.stringify({ kind, pid: process.pid, at: new Date().toISOString() })}\n`,
  )
  throw new Error(`零付费验收禁止 ${kind}`)
}
// 在 createServer 恢复队列之前安装；先同步留下尝试证据，再阻止请求。
for (const plugin of builtinPlugins({ mock: false }))
  for (const provider of plugin.providers) provider.submit = async () => forbidden('submit')
globalThis.fetch = async () => forbidden('fetch')
const exec = promisify(execFile)
const hash = async (path: string) => {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(path)) digest.update(bytes)
  return digest.digest('hex')
}
const save = (name: string, value: unknown) =>
  writeFile(join(out, name), `${JSON.stringify(value, null, 2)}\n`)
const upstream = (doc: PleinDoc, sequenceId: string) =>
  JSON.parse(
    JSON.stringify(
      Object.fromEntries(
        [...doc.elements()]
          .filter((el) => el.id !== sequenceId && el.results?.length)
          .map((el) => [
            el.id,
            { adopted: el.adopted, results: el.results, current: currentResult(el) },
          ]),
      ),
    ),
  )
const config = {
  ...loadConfig({
    ...process.env,
    PLEIN_DATA_DIR: join(out, 'data'),
    PLEIN_PORT: '0',
    PLEIN_MOCK_PROVIDER: '0',
    PLEIN_AGENT: '0',
    PLEIN_MCP: '0',
  }),
  webDist: null,
}
const server = await createServer(config)
try {
  if (mode === 'interrupt') {
    const deps = {
      db: server.db,
      rooms: server.rooms,
      assets: server.assets,
      host: server.plugins,
      dataDir: config.dataDir,
      mediaIndex: server.mediaIndex,
    }
    const preview = await inspectPackage(deps, 'local', createReadStream(packagePath))
    assert.deepEqual(preview.missing, [])
    const imported = await commitImport(deps, 'local', preview.token)
    assert(imported?.canvasId)
    const doc = createDoc(server.rooms.get(imported.canvasId).doc)
    const sequences = [...doc.elements()].filter((el) => el.nodeType === 'plein/sequence')
    assert.equal(sequences.length, 1)
    const sequence = sequences[0]!
    const accepted = currentResult(sequence)
    assert(accepted?.value.type === 'video')
    const assetId = accepted.value.assetId
    assert.equal(await hash(server.assets.originalPath(assetId)), assetId)
    const runId = server.runs.start(imported.canvasId, sequence.id, 'local')
    await save('before.json', {
      packageSha256: await hash(packagePath),
      canvasId: imported.canvasId,
      sequenceId: sequence.id,
      accepted,
      sequenceResults: sequence.results,
      sequenceState: sequenceEditState(doc, sequence.id),
      upstream: upstream(doc, sequence.id),
      runId,
    })
    const until = Date.now() + 120_000
    while (Date.now() < until) {
      const entries = await readdir(join(config.dataDir, 'tmp'), { recursive: true })
      for (const entry of entries.filter((name) => name.endsWith('/out.mp4'))) {
        const path = join(config.dataDir, 'tmp', entry)
        const info = await stat(path).catch(() => undefined)
        if (!info || info.size <= 4096) continue
        const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,args='])
        const processes = stdout
          .split('\n')
          .filter((line) => Number(line.trim().split(/\s+/)[2]) === process.pid)
        const ffmpeg = processes.find((line) => line.includes(path) && line.includes('ffmpeg'))
        if (!ffmpeg) continue
        assert.equal(server.runs.store.get(runId)?.status, 'running')
        const evidence = {
          type: 'render-started',
          pid: process.pid,
          processGroup: process.pid,
          output: path,
          bytes: info.size,
          runId,
          ffmpeg,
          processes,
          at: new Date().toISOString(),
        }
        await save('render-started.json', evidence)
        assert(process.send)
        process.send(evidence)
        // 父进程会立刻杀死本隔离组；超时也不能正常退出冒充中断成功。
        await new Promise((_, reject) =>
          setTimeout(() => reject(new Error('父进程未执行强杀')), 30_000),
        )
      }
      assert.notEqual(
        server.runs.store.get(runId)?.status,
        'succeeded',
        '合成已经结束，未命中真实中断窗口',
      )
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('未观察到真实渲染输出与本组 FFmpeg')
  }
  const before = JSON.parse(await readFile(join(out, 'before.json'), 'utf8'))
  const doc = createDoc(server.rooms.get(before.canvasId).doc)
  const oldIds = new Set(
    (before.sequenceResults as Array<{ id: string }>).map((result) => result.id),
  )
  const assertOldCandidates = () =>
    assert.deepEqual(
      doc.get(before.sequenceId)!.results?.filter((result) => oldIds.has(result.id)),
      before.sequenceResults,
      '恢复不能丢弃、修改或重排旧候选',
    )
  assert.deepEqual(
    currentResult(doc.get(before.sequenceId)!),
    before.accepted,
    '恢复开始时仍保留旧成片采用',
  )
  assert.deepEqual(upstream(doc, before.sequenceId), before.upstream)
  assert.deepEqual(
    sequenceEditState(doc, before.sequenceId),
    before.sequenceState,
    '恢复起点保留剪辑与人工字幕编辑',
  )
  assert.equal(
    await hash(server.assets.originalPath(before.accepted.value.assetId)),
    before.accepted.value.assetId,
  )
  const recovered = await server.runs.wait(before.runId)
  const recoveryJob = server.runs.store.get(before.runId)
  assert.equal(recovered, 'succeeded', recoveryJob?.error ?? '本地任务未恢复成功')
  assert.equal(recoveryJob?.attempts, 2, '真实中断后同一任务恰好重启一次')
  const recoveredResult = currentResult(doc.get(before.sequenceId)!)
  assert(recoveredResult?.value.type === 'video')
  assert.deepEqual(upstream(doc, before.sequenceId), before.upstream)
  assert.deepEqual(
    sequenceEditState(doc, before.sequenceId),
    before.sequenceState,
    '自动恢复合成不改剪辑与人工字幕编辑',
  )
  assertOldCandidates()
  const settledBy = Date.now() + 30_000
  while (server.runs.isRunning(before.canvasId, before.sequenceId)) {
    assert(Date.now() < settledBy, '恢复任务已成功但未退出运行态')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const manualRunId = server.runs.start(before.canvasId, before.sequenceId, 'local')
  assert.notEqual(manualRunId, before.runId)
  assert.equal(
    await server.runs.wait(manualRunId),
    'succeeded',
    server.runs.store.get(manualRunId)?.error ?? '',
  )
  assert.deepEqual(upstream(doc, before.sequenceId), before.upstream)
  assertOldCandidates()
  assert.deepEqual(
    sequenceEditState(doc, before.sequenceId),
    before.sequenceState,
    '人工再导出不改剪辑与人工字幕编辑',
  )
  const result = currentResult(doc.get(before.sequenceId)!)
  assert(result?.value.type === 'video')
  const verified: Array<Record<string, unknown>> = []
  for (const [label, value] of [
    ['recovered', recoveredResult],
    ['manual-reexport', result],
  ] as const) {
    const destination = join(out, `${label}.mp4`)
    assert(value.value.type === 'video')
    await copyFile(server.assets.originalPath(value.value.assetId), destination)
    assert.equal(await hash(destination), value.value.assetId)
    const decoded = await exec(
      config.ffmpegPath,
      ['-v', 'error', '-xerror', '-i', destination, '-f', 'null', '-'],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
    )
    assert.equal(decoded.stderr.trim(), '')
    const { stdout } = await exec(config.ffprobePath, [
      '-v',
      'error',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      destination,
    ])
    const probe = JSON.parse(stdout)
    assert(Math.abs(Number(probe.format.duration) - 206.167) < 2 / 30)
    const video = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video')
    const audio = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'audio')
    assert.deepEqual(
      [video?.codec_name, video?.width, video?.height, video?.r_frame_rate],
      ['h264', 1920, 1080, '30/1'],
    )
    assert.deepEqual([audio?.codec_name, audio?.sample_rate, audio?.channels], ['aac', '48000', 2])
    verified.push({
      label,
      resultId: value.id,
      assetId: value.value.assetId,
      decode: { exitCode: 0, stderr: decoded.stderr },
      probe,
    })
  }
  assert.equal(await readFile(audit, 'utf8'), '')
  await save('recovery.json', {
    interruptedRunId: before.runId,
    recoveredStatus: recovered,
    recoveryAttempts: recoveryJob?.attempts,
    originalAcceptedAssetPreserved: true,
    oldCandidatesPreserved: true,
    upstreamUnchanged: true,
    sequenceEditsUnchanged: true,
    manualRunId,
    resultId: result.id,
    assetId: result.value.assetId,
    verified,
    providerAttempts: 0,
    fetchAttempts: 0,
  })
} finally {
  await server.close()
  process.disconnect?.()
}
