/**
 * 三类固定输入的本机HTTP+mock+FFmpeg测量；不访问真实平台，不测真人成功率或质量。
 * pnpm --filter @plein/server exec tsx bench/workflow-baselines.ts --output ../../test-results/workflow-baselines.json
 * 默认只展开每类首镜，覆盖图/声→脚本审片标记→样片复用→视频→交付→局部返工。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import * as Y from 'yjs'
import { expandedNodes, expandShots, nodeElementOf, type ShotSource } from '@plein/capabilities'
import {
  connect,
  createDoc,
  createElement,
  creativeReviewTarget,
  currentResult,
  editDelivery,
  recordCreativeReview,
  setParams,
  type PleinDoc,
} from '@plein/doc'
import {
  ANIMATIC_TYPE,
  animaticNode,
  sequenceNode,
  SEQUENCE_TYPE,
  STORYBOARD_TYPE,
} from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Project } from '@plein/protocol'
import { mediaCaps, probeMedia } from '../src/assets/media'
import { loadConfig } from '../src/config'
import { startServer, type RunningServer } from '../src/start'
import {
  countBaselineSubmits,
  candidateDelta,
  CreativeBaselineFixture,
  type BaselineSubmit,
  type CreativeBaselineFixture as Fixture,
} from './workflow-baseline-helpers'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const { values } = parseArgs({
  options: { output: { type: 'string' }, 'keep-data': { type: 'boolean', default: false } },
})
const output = resolve(values.output ?? join(repo, 'test-results/workflow-baselines.json'))
const reportId = randomUUID()
const startedAt = Date.now()
const fixtureIds = ['two-person-dialogue', 'action-continuity', 'strong-style']
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const git = () => {
  const run = (args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const status = run(['status', '--porcelain=v1'])
  return {
    head: run(['rev-parse', 'HEAD']).trim(),
    dirty: !!status.trim(),
    status: status.trim().split('\n').filter(Boolean),
    trackedDiffSha256: hash(run(['diff', '--binary', 'HEAD'])),
  }
}
const base = git()
const rows: CaseResult[] = []
interface ScriptAction {
  at: number
  phase: string
  type: 'command' | 'http-run'
  label: string
  nodeId?: string
}
interface Check {
  name: string
  passed: boolean
}
interface CaseResult {
  fixtureId: string
  fixtureSha256: string
  title: string
  scope: string
  startedAt: number
  finishedAt?: number
  passed: boolean
  machineFirstShotComplete: boolean | null
  error?: string
  canvasId?: string
  checks: Check[]
  phases: Array<{
    name: string
    submits: ReturnType<typeof countBaselineSubmits>
    candidates: Record<string, string[]>
  }>
  submits: BaselineSubmit[]
  actions: ScriptAction[]
  artifacts: Array<{
    path: string
    nodeId: string
    resultId: string
    assetId: string
    bytes: number
    sha256: string
    duration?: number
    width?: number
    height?: number
  }>
  totals?: {
    providerSubmits: ReturnType<typeof countBaselineSubmits>
    scriptedActions: number
    localReworkScriptedActions: number
    candidates: number
    humanFirstShotCompletionRate: null
    humanActions: null
    quality: 'pending-manual'
    paidCost: null
  }
}

async function measure(fixture: Fixture, fixtureSha256: string): Promise<CaseResult> {
  const result: CaseResult = {
    fixtureId: fixture.id,
    fixtureSha256,
    title: fixture.title,
    scope: `仅选定首镜 ${fixture.trialShotId}；其余${fixture.shots.length - 1}镜不生成，不宣称跨镜头质量或整片完成`,
    startedAt: Date.now(),
    passed: false,
    machineFirstShotComplete: null,
    checks: [],
    phases: [],
    submits: [],
    actions: [],
    artifacts: [],
  }
  const dataDir = await mkdtemp(join(tmpdir(), `plein-workflow-baseline-${fixture.id}-`))
  let running: RunningServer | undefined, doc: PleinDoc | undefined
  let phase = 'boot'
  const action = (type: ScriptAction['type'], label: string, nodeId?: string) =>
    result.actions.push({ at: Date.now(), phase, type, label, nodeId })
  const check = (name: string, passed: boolean) => {
    result.checks.push({ name, passed })
    assert(passed, name)
  }
  try {
    running = await startServer({
      ...loadConfig({
        PLEIN_DATA_DIR: dataDir,
        PLEIN_PORT: '0',
        PLEIN_HOST: '127.0.0.1',
        PLEIN_MOCK_PROVIDER: '1',
        PLEIN_AGENT: '0',
        PLEIN_MCP: '0',
      }),
      webDist: null,
    })
    const live = running
    const server = live.server
    const caps = await mediaCaps()
    check('本机FFmpeg可用', caps.ffmpeg)
    server.plugins.configs.update('plein/mock', {
      settings: { latencyMs: 0, queueMs: 0, failWith: 'none' },
    })
    // 只替换本次服务registry的定义，不修改共享导出的mock对象。
    const mock = server.plugins.registry.providers.get('plein/mock')!
    const original = mock.def.submit
    mock.def = {
      ...mock.def,
      async submit(request, context) {
        const event: BaselineSubmit = {
          id: randomUUID(),
          fixtureId: fixture.id,
          phase,
          capability: request.capability,
          model: request.model,
          startedAt: Date.now(),
        }
        result.submits.push(event)
        try {
          const response = await original(request, context)
          event.outcome = response.state
          return response
        } catch (error) {
          event.outcome = 'threw'
          throw error
        } finally {
          event.finishedAt = Date.now()
        }
      },
    }
    const http = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
      const init: RequestInit = {
        method,
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(180_000),
      }
      if (body !== undefined) init.body = JSON.stringify(body)
      const response = await fetch(`${live.url}${path}`, init)
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${text}`)
      return (text ? JSON.parse(text) : undefined) as T
    }
    const project = await http<Project>('/api/projects', 'POST', {
      title: `机器基线 · ${fixture.title}`,
    })
    assert(project.lastCanvasId)
    const canvasId = project.lastCanvasId
    result.canvasId = canvasId
    doc = createDoc(server.rooms.get(canvasId).doc, { schedule: () => {} })
    const document = doc
    const nodeIds = new Set<string>()
    const add = (type: string, params: Record<string, unknown>, name: string) => {
      const entry = server.plugins.registry.latestNode(type)
      assert(entry, `节点未安装：${type}`)
      const id = createElement(document, {
        ...nodeElementOf(describeNode(entry.def, entry.plugin), params),
        name,
        x: 0,
        y: nodeIds.size * 240,
      })
      nodeIds.add(id)
      return id
    }
    const candidates = () =>
      Object.fromEntries(
        [...nodeIds].map((id) => [id, (document.get(id)?.results ?? []).map((r) => r.id)]),
      )
    const stamp = (name: string) => {
      result.phases.push({
        name,
        submits: countBaselineSubmits(result.submits),
        candidates: candidates(),
      })
    }
    const run = async (id: string) => {
      document.flush()
      server.rooms.get(canvasId).flush()
      const input = await http<{ status: string; model?: string | { provider?: string } }>(
        `/api/canvases/${canvasId}/nodes/${id}/input`,
      )
      // 每个可能收费的节点都显式指定mock；本地合成节点没有模型调用。
      const model = document.get(id)?.params?.model
      if (![ANIMATIC_TYPE, SEQUENCE_TYPE].includes(document.get(id)?.nodeType ?? ''))
        assert(typeof model === 'string' && model.startsWith('plein/mock:'), '只允许mock模型')
      assert.equal(input.status, 'ready', `输入未就绪：${id}`)
      action('http-run', 'POST节点运行', id)
      const accepted = await http<{ runId: string }>(
        `/api/canvases/${canvasId}/nodes/${id}/run`,
        'POST',
        {},
      )
      const status = await server.runs.wait(accepted.runId)
      assert.equal(status, 'succeeded', document.get(id)?.run?.error ?? `运行失败：${id}`)
      const current = currentResult(document.get(id)!)
      assert(current, '任务成功必须有真实候选')
      return current
    }
    const artifact = async (id: string) => {
      const current = currentResult(document.get(id)!)
      assert(current && 'assetId' in current.value)
      const response = await fetch(`${live.url}/api/assets/${current.value.assetId}`)
      assert(response.ok, '真实HTTP素材读取失败')
      const bytes = new Uint8Array(await response.arrayBuffer())
      assert(bytes.byteLength > 0)
      assert.equal(hash(bytes), current.value.assetId)
      const probe =
        current.value.type === 'image'
          ? undefined
          : await probeMedia(server.assets.originalPath(current.value.assetId))
      const mime = server.assets.get('local', current.value.assetId)?.mime
      const ext =
        mime === 'image/png'
          ? 'png'
          : mime === 'video/mp4'
            ? 'mp4'
            : mime === 'video/webm'
              ? 'webm'
              : mime?.includes('wav')
                ? 'wav'
                : 'bin'
      const path = join(
        dirname(output),
        'workflow-baseline-artifacts',
        reportId,
        fixture.id,
        `${result.artifacts.length + 1}-${current.id.replaceAll(/[^A-Za-z0-9_-]/g, '_')}.${ext}`,
      )
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, bytes)
      result.artifacts.push({
        path,
        nodeId: id,
        resultId: current.id,
        assetId: current.value.assetId,
        bytes: bytes.byteLength,
        sha256: hash(bytes),
        duration: probe?.duration,
        width: probe?.width,
        height: probe?.height,
      })
    }

    phase = 'setup'
    action('command', '固定fixture写入梗概、分镜与角色卡；无模型执行')
    createElement(document, {
      kind: 'markdown',
      name: fixture.title,
      text: fixture.brief,
      x: -500,
      y: 0,
      w: 320,
      h: 240,
    })
    const names = [...new Set(fixture.shots.flatMap((shot) => shot.characters))]
    for (const [i, name] of names.entries())
      add(
        'plein/character',
        {
          description: `固定基线角色 ${name}`,
          voice: { provider: 'plein/mock', voiceId: i % 2 ? 'mock-male' : 'mock-female' },
        },
        name,
      )
    const board = add(
      STORYBOARD_TYPE,
      { shots: fixture.shots, model: 'plein/mock:chat', aspectRatio: fixture.aspectRatio },
      fixture.title,
    )
    const expanded = expandShots(document, board, [fixture.trialShotId], (type) => {
      const entry = server.plugins.registry.latestNode(type)
      return entry && nodeElementOf(describeNode(entry.def, entry.plugin))
    })
    check('只展开选定首镜', expanded.frames.length === 1)
    const nodes = expandedNodes(document, board).get(fixture.trialShotId)!
    for (const el of nodes) {
      nodeIds.add(el.id)
      const source = el.params?.source as ShotSource | undefined
      assert(source)
      const role = source.role
      setParams(document, el.id, {
        ...(role === 'image' || role === 'video' ? { aspectRatio: fixture.aspectRatio } : {}),
        model:
          role === 'image'
            ? 'plein/mock:image'
            : role === 'video'
              ? 'plein/mock:video'
              : role === 'speech'
                ? 'plein/mock:audio'
                : 'plein/mock:sfx',
      })
    }
    const first = fixture.shots.find((shot) => shot.id === fixture.trialShotId)!
    const ofRole = (role: ShotSource['role']) =>
      nodes.filter((el) => (el.params?.source as ShotSource | undefined)?.role === role)
    const image = ofRole('image')[0]!,
      video = ofRole('video')[0]!,
      voices = ofRole('speech')
    phase = 'first-shot-image-and-audio'
    for (const el of [image, ...voices, ...ofRole('sfx')]) {
      await run(el.id)
      await artifact(el.id)
    }
    stamp(phase)
    phase = 'scripted-review-mark'
    for (const el of [image, ...voices, ...ofRole('sfx')]) {
      action('command', '脚本写入usable，仅测命令与持久化，不代表真人审片', el.id)
      check(
        '脚本审片命令绑定当前采用候选',
        recordCreativeReview(document, el.id, {
          target: creativeReviewTarget(document.get(el.id))!,
          status: 'usable',
          note: '机器基线脚本标记；未作人工质量判定',
        }),
      )
    }
    const imageResult = currentResult(document.get(image.id)!)!
    assert(imageResult.value.type === 'image')
    phase = 'animatic-first-export'
    const draft = add(
      ANIMATIC_TYPE,
      animaticNode.params.parse({
        boardId: board,
        aspectRatio: fixture.aspectRatio,
        resolution: '720p',
        subtitles: caps.subtitles,
        asrTiming: false,
        loudnorm: false,
        shots: [
          {
            shotId: first.id,
            imageSource: image.id,
            imageAssetId: imageResult.value.assetId,
            duration: first.duration,
            dialogue: voices.map((el) => {
              const current = currentResult(document.get(el.id)!)!
              assert(current.value.type === 'audio')
              return {
                source: el.id,
                assetId: current.value.assetId,
                caption: current.value.caption ?? String(el.params?.text ?? ''),
              }
            }),
          },
        ],
      }),
      `${fixture.title} · 首镜草稿`,
    )
    const beforeDraft = result.submits.length
    await run(draft)
    await artifact(draft)
    check('样片合成不提交任何模型', result.submits.length === beforeDraft)
    const draftRecord = document.get(draft)?.deliveries?.[0]
    check('样片成功写入真实animatic交付记录', draftRecord?.kind === 'animatic')
    action('command', '脚本确认草稿，只测metadata命令', draft)
    check(
      '草稿确认可绑定真实导出',
      editDelivery(document, draft, draftRecord!.id, { confirm: true }),
    )
    stamp(phase)
    phase = 'animatic-reuse-export'
    const beforeReuse = candidates()
    await run(draft)
    await artifact(draft)
    check('重复样片导出仍零模型提交', result.submits.length === beforeDraft)
    check(
      '复用样片不会删除已有候选',
      candidateDelta(beforeReuse, candidates()).removed.length === 0,
    )
    check('新样片版本不继承旧确认', !document.get(draft)!.deliveries![0]!.confirmedAt)
    stamp(phase)

    phase = 'first-video'
    await run(video.id)
    await artifact(video.id)
    check('首镜视频阶段仅一次video.submit', countBaselineSubmits(result.submits).video === 1)
    result.machineFirstShotComplete =
      [image, video, ...voices, ...ofRole('sfx')].every(
        (el) => !!currentResult(document.get(el.id)!),
      ) && voices.length === first.dialogue.filter((line) => line.line.trim()).length
    check('首镜计划媒体均已真实生成且可读取', result.machineFirstShotComplete)
    action('command', '脚本标记视频可用，非真实质量验收', video.id)
    check(
      '视频审片命令绑定当前候选',
      recordCreativeReview(document, video.id, {
        target: creativeReviewTarget(document.get(video.id))!,
        status: 'usable',
        note: '机器基线脚本标记；未作人工质量判定',
      }),
    )
    stamp(phase)
    phase = 'single-shot-film-delivery'
    const film = add(
      SEQUENCE_TYPE,
      sequenceNode.params.parse({
        aspectRatio: fixture.aspectRatio,
        resolution: '720p',
        subtitles: caps.subtitles,
        asrTiming: false,
        loudnorm: false,
        clips: [
          {
            source: video.id,
            in: 0,
            dialogue: voices[0]?.id ?? '',
            more: voices.slice(1).map((el) => el.id),
          },
        ],
      }),
      `${fixture.title} · 首镜成片验收`,
    )
    assert(connect(document, [video.id, 'video'], [film, 'clips']))
    for (const voice of voices) assert(connect(document, [voice.id, 'audio'], [film, 'dialogue']))
    const beforeFilm = result.submits.length
    await run(film)
    await artifact(film)
    check('成片合成本地执行，不新增模型提交', result.submits.length === beforeFilm)
    const filmRecord = document.get(film)?.deliveries?.[0]
    check(
      '成功导出建立film记录与首镜来源',
      filmRecord?.kind === 'film' &&
        filmRecord.sources.some((source) => source.shotId === first.id),
    )
    action('command', '脚本记录返工意见并验证未解决时不可交付', film)
    const note = {
      id: 'baseline-rework-note',
      time: 0,
      text: '机器流程检查用意见；不作质量结论',
      resolved: false,
      source: video.id,
      shotId: first.id,
    }
    check('交付意见命令可写入', editDelivery(document, film, filmRecord!.id, { notes: [note] }))
    check('未解决意见阻止确认', !editDelivery(document, film, filmRecord!.id, { confirm: true }))
    action('command', '脚本解决意见并确认真实首镜导出版本', film)
    check(
      '意见解决后可确认当前版本',
      editDelivery(document, film, filmRecord!.id, {
        notes: [{ ...note, resolved: true }],
        confirm: true,
      }),
    )
    stamp(phase)

    phase = 'local-video-rework'
    const preserved = candidates(),
      submitsBeforeRework = result.submits.length
    action('command', '仅修改首镜video提示词，不更动分镜图或配音', video.id)
    setParams(document, video.id, {
      prompt: `${String(document.get(video.id)?.params?.prompt ?? '')}；机器返工对照：镜头再缓慢一点`,
    })
    await run(video.id)
    await artifact(video.id)
    check(
      '局部返工仅新增一次视频提交',
      result.submits.length === submitsBeforeRework + 1 &&
        result.submits.at(-1)?.capability === 'video.generate',
    )
    check('局部返工保留全部旧候选', candidateDelta(preserved, candidates()).removed.length === 0)
    check(
      '未返工节点候选保持一致',
      [image, ...voices].every(
        (el) => JSON.stringify(preserved[el.id]) === JSON.stringify(candidates()[el.id]),
      ),
    )
    stamp(phase)
    phase = 'film-new-version'
    await run(film)
    await artifact(film)
    check('新成片版本不继承旧交付确认', !document.get(film)!.deliveries![0]!.confirmedAt)
    check(
      '旧版本确认和候选仍保留',
      document
        .get(film)!
        .deliveries!.some((record) => record.id === filmRecord!.id && !!record.confirmedAt),
    )
    check(
      '整个流程没有隐式ASR提交',
      !result.submits.some((event) => event.capability === 'audio.transcribe'),
    )
    check(
      '总video.submit为首次生成和单镜返工两次',
      countBaselineSubmits(result.submits).video === 2,
    )
    stamp(phase)
    document.flush()
    server.rooms.get(canvasId).flush()
    const persistedYdoc = new Y.Doc()
    let persistedDoc: PleinDoc | undefined
    try {
      const updates = server.db.$client
        .prepare('SELECT data FROM doc_updates WHERE canvas_id=? ORDER BY id')
        .all(canvasId) as Array<{ data: Buffer }>
      for (const update of updates) Y.applyUpdate(persistedYdoc, update.data)
      persistedDoc = createDoc(persistedYdoc, { schedule: () => {} })
      const metadata = (source: PleinDoc) =>
        [...nodeIds].map((id) => ({
          id,
          results: source.get(id)?.results,
          reviews: source.get(id)?.reviews,
          deliveries: source.get(id)?.deliveries,
        }))
      check(
        '审片、候选和交付元数据从SQLite重放后完整一致',
        JSON.stringify(metadata(persistedDoc)) === JSON.stringify(metadata(document)),
      )
    } finally {
      persistedDoc?.destroy()
      persistedYdoc.destroy()
    }
    const documentEvidence = join(
      dirname(output),
      'workflow-baseline-artifacts',
      reportId,
      fixture.id,
      'final-document.json',
    )
    await writeFile(
      documentEvidence,
      JSON.stringify(
        {
          fixtureId: fixture.id,
          scope: result.scope,
          elements: [...document.elements()],
          edges: [...document.edges()],
        },
        null,
        2,
      ),
    )
    result.passed = true
    result.totals = {
      providerSubmits: countBaselineSubmits(result.submits),
      scriptedActions: result.actions.length,
      localReworkScriptedActions: result.actions.filter(
        (event) => event.phase === 'local-video-rework',
      ).length,
      candidates: Object.values(candidates()).reduce((n, ids) => n + ids.length, 0),
      humanFirstShotCompletionRate: null,
      humanActions: null,
      quality: 'pending-manual',
      paidCost: null,
    }
  } catch (error) {
    result.error = `${phase}: ${(error as Error).message}`
  } finally {
    result.finishedAt = Date.now()
    doc?.destroy()
    await running?.close()
    if (!values['keep-data']) await rm(dataDir, { recursive: true, force: true })
    else console.log(`保留本次临时数据：${dataDir}`)
  }
  return result
}

try {
  for (const id of fixtureIds) {
    const file = join(repo, 'docs/benchmarks/creative-baselines', `${id}.json`)
    const bytes = await readFile(file)
    const fixture = CreativeBaselineFixture.parse(JSON.parse(bytes.toString()))
    assert(
      fixture.shots.some((shot) => shot.id === fixture.trialShotId),
      'trialShotId必须属于固定输入',
    )
    const row = await measure(fixture, hash(bytes))
    rows.push(row)
    console.log(
      `${id}: ${row.passed ? '机器流程通过' : `失败 ${row.error}`}；provider.submit=${row.submits.length}，video.submit=${countBaselineSubmits(row.submits).video}`,
    )
  }
} finally {
  const end = git()
  const report = {
    format: 'plein-workflow-baselines',
    version: 1,
    reportId,
    startedAt,
    finishedAt: Date.now(),
    environment: 'real-local-http-with-mock-provider',
    git: base,
    gitAtFinish: end,
    trackedCodeChangedDuringRun:
      base.head !== end.head || base.trackedDiffSha256 !== end.trackedDiffSha256,
    scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    counting: {
      providerSubmit:
        'wrapper around this server registry mockProvider.submit; each invocation counted, including throws; no poll/download/candidate proxy',
      scriptedActions:
        'explicit command and POST-run actions logged by this harness; not browser gestures or real human actions',
      candidateCount:
        'actual node.results IDs, preserving prior candidates across one video rework',
      humanSuccessRate: null,
      humanActions: null,
      creativeQuality: 'pending-manual',
      paidCost: null,
      scope:
        'each fixture first-shot slice only; no claims about all-shots continuity, actual humans, paid platforms or quality',
    },
    rows,
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`结构化报告：${output}`)
}
if (rows.length !== fixtureIds.length || rows.some((row) => !row.passed)) process.exitCode = 1
