import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  expect,
  type ElementHandle,
  type Locator,
  type Page,
  type Route,
  type TestInfo,
  test,
} from '@playwright/test'
import { centerOf, newProject, waitEngine, waitNode, zoomTo } from './canvas'

const fixtureFile = join(
  import.meta.dirname,
  '../docs/benchmarks/creative-baselines/two-person-dialogue.json',
)
const fixtureBytes = readFileSync(fixtureFile)
const fixtureHash = createHash('sha256').update(fixtureBytes).digest('hex')
const baseline = JSON.parse(fixtureBytes.toString('utf8')) as {
  id: string
  brief: string
  aspectRatio: string
  trialShotId: string
  shots: Array<
    Record<string, unknown> & {
      id: string
      no: number
      description: string
      motionPrompt: string
      dialogue: Array<{ id: string; character: string; line: string }>
    }
  >
}
const firstShot = baseline.trialShotId
const secondShot = baseline.shots[1]!.id
const wb = (page: Page) => page.getByRole('dialog', { name: '镜头工作台', exact: true })
function mediaReleaseState(element: HTMLElement | SVGElement) {
  const media = element as HTMLVideoElement
  return {
    connected: media.isConnected,
    paused: media.paused,
    attribute: media.getAttribute('src'),
    srcObject: media.srcObject,
    sources: media.querySelectorAll('source').length,
    currentSrc: media.currentSrc,
    network: media.networkState,
    readyState: media.readyState,
    buffered: media.buffered.length,
    seekable: media.seekable.length,
    width: media.videoWidth,
    height: media.videoHeight,
  }
}
async function expectMediaReleased(
  handle: ElementHandle<HTMLElement | SVGElement>,
  info: TestInfo,
  label: string,
) {
  // currentSrc can retain its diagnostic URL after load() has emptied the player.
  await expect
    .poll(() => handle.evaluate(mediaReleaseState))
    .toMatchObject({
      connected: false,
      paused: true,
      attribute: null,
      srcObject: null,
      sources: 0,
      network: 0,
      readyState: 0,
      buffered: 0,
      seekable: 0,
    })
  const path = info.outputPath(label + '-media-release.json')
  writeFileSync(path, JSON.stringify(await handle.evaluate(mediaReleaseState), null, 2) + '\n')
  await info.attach(label + '-media-release.json', { path, contentType: 'application/json' })
}
const inputSection = (page: Page, historical = false) =>
  wb(page)
    .getByRole('heading', {
      name: historical ? '此候选生成时实际输入' : '当前节点实际输入',
      exact: true,
    })
    .locator('..')
const canvasId = (page: Page) => decodeURIComponent(page.url().split('#/c/')[1]!.split('?')[0]!)
const nodeInputPath = (canvas: string, node: string) =>
  '/api/canvases/' + encodeURIComponent(canvas) + '/nodes/' + encodeURIComponent(node) + '/input'
const jobPath = (canvas: string, job: string) =>
  '/api/canvases/' + encodeURIComponent(canvas) + '/jobs/' + encodeURIComponent(job)

interface Candidate {
  id: string
  runId?: string
  port: string
  at: number
  value: { type: string; assetId?: string; [key: string]: unknown }
}
interface NodeSnapshot {
  id: string
  params: Record<string, unknown>
  results?: Candidate[]
  adopted?: string | null
  reviews?: Array<{ status: string; target: { resultId?: string }; note?: string }>
}
interface Audit {
  phase: 'setup' | 'path'
  requests: Array<{ phase: string; method: string; path: string; execution: boolean; at: number }>
  scriptedActions: Array<{ phase: string; label: string; outcome: string; at: number }>
  setupRun?: { nodeId: string; runId: string; inputHash: string; request: string }
}
function watch(page: Page): Audit {
  const audit: Audit = { phase: 'setup', requests: [], scriptedActions: [] }
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (!path.startsWith('/api/')) return
    audit.requests.push({
      phase: audit.phase,
      method: request.method(),
      path,
      at: Date.now(),
      execution:
        request.method() === 'POST' &&
        /\/(?:run|run-flow|run-batch|storyboard-batch\/commit)$/.test(path),
    })
  })
  return audit
}
async function act<T>(audit: Audit, label: string, action: () => Promise<T>) {
  let outcome = 'failed'
  try {
    const result = await action()
    outcome = 'completed'
    return result
  } finally {
    audit.scriptedActions.push({ phase: audit.phase, label, outcome, at: Date.now() })
  }
}
const executions = (audit: Audit) =>
  audit.requests.filter((item) => item.phase === 'path' && item.execution)
async function readNode(page: Page, id: string): Promise<NodeSnapshot> {
  return page.evaluate((id) => JSON.parse(JSON.stringify(window.__plein.engine.doc.get(id))), id)
}
async function setParam(page: Page, id: string, key: string, value: unknown) {
  await page.evaluate(
    ({ id, key, value }) => {
      const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
        set(key: string, value: unknown): void
      }
      params.set(key, value)
    },
    { id, key, value },
  )
}
async function openBoard(page: Page, board: string) {
  await zoomTo(page, [board])
  const at = await centerOf(page, board)
  await page.mouse.dblclick(at.x, at.y)
  const dialog = page.getByRole('dialog', { name: '分镜表', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}
async function openRow(page: Page, board: string, no = 1) {
  const dialog = await openBoard(page, board)
  await dialog.getByRole('button', { name: '编辑分镜', exact: true }).click()
  await dialog.getByRole('button', { name: '镜头 ' + no + ' 工作台', exact: true }).click()
  await expect(wb(page)).toBeVisible()
  await expect(dialog).toBeHidden()
}
async function chooseVideo(page: Page, node: string) {
  await wb(page).getByRole('combobox', { name: '工作台阶段节点', exact: true }).selectOption(node)
}
async function closeWorkbench(page: Page) {
  await wb(page).getByRole('button', { name: '关闭', exact: true }).click()
  await expect(wb(page)).toBeHidden()
}

async function captureSource(editor: Locator) {
  await editor.getByRole('button', { name: '剧情来源', exact: true }).click()
  const mapping = editor.getByTestId('source-mapping')
  await mapping.getByRole('button', { name: '固定为新版本', exact: true }).click()
  const original = mapping.getByRole('textbox', { name: '固定原文', exact: true })
  const quote = baseline.shots[0]!.dialogue[0]!.line
  const start = (await original.inputValue()).indexOf(quote)
  expect(start).toBeGreaterThanOrEqual(0)
  await original.focus()
  await original.evaluate(
    (element: HTMLTextAreaElement, start) => element.setSelectionRange(start, start),
    start,
  )
  for (let i = 0; i < quote.length; i++) await original.press('Shift+ArrowRight')
  await mapping
    .getByRole('combobox', { name: '原文标注类型', exact: true })
    .selectOption('dialogue')
  await mapping.getByRole('button', { name: '将选中原文加入标注', exact: true }).click()
  await mapping.getByRole('button', { name: '我已核对本版原文', exact: true }).click()
  await mapping
    .getByRole('combobox', { name: '关联或定位镜头', exact: true })
    .selectOption(firstShot)
  await mapping.getByRole('combobox', { name: '覆盖处理', exact: true }).selectOption('retain')
  const unit = mapping.getByRole('list', { name: '原文标注', exact: true }).locator('> li').first()
  await unit.getByRole('button', { name: '关联所选镜头', exact: true }).click()
  await expect(unit).toContainText('已映射')
}

async function prepare(page: Page, audit: Audit, sourceMapping = false) {
  expect(fixtureHash).toBe('30d9746e4157876a503e46dc231b6fa521c742dfbbe3231b2bc9305abc15492e')
  await newProject(page)
  expect(
    (
      await page.request.put('/api/providers/plein/mock/config', {
        data: { settings: { latencyMs: 0, failWith: 'none' } },
      })
    ).ok(),
  ).toBe(true)
  const script =
    baseline.brief +
    '\n' +
    baseline.shots
      .map(
        (shot) =>
          '镜头 ' +
          shot.no +
          '：' +
          shot.description +
          '\n' +
          shot.dialogue.map((line) => line.character + '：' + line.line).join('\n'),
      )
      .join('\n')
  const ids = await page.evaluate(
    ({ baseline, script }) => {
      const source = window.__plein.addNode({
        type: 'plein/text',
        name: 'P01 双人对白原文',
        x: -450,
        y: 100,
        params: { text: script },
      })
      const sequence = window.__plein.addNode({
        type: 'plein/sequence',
        name: 'P07 实际下游序列',
        x: 1300,
        y: 100,
        params: { aspectRatio: baseline.aspectRatio, resolution: '720p' },
      })
      const board = window.__plein.addNode({
        type: 'plein/storyboard',
        name: 'P01 双人对白镜头工作台',
        x: 100,
        y: 100,
        params: { shots: baseline.shots },
      })
      if (!window.__plein.connect([source, 'text'], [board, 'script']))
        throw new Error('source link')
      return { source, board, sequence }
    },
    { baseline, script },
  )
  const editor = await act(audit, '实际双击打开分镜编辑器', () => openBoard(page, ids.board))
  if (sourceMapping)
    await act(audit, 'P05实际捕获原文、声明核对并关联一条本镜对白', () => captureSource(editor))
  await act(audit, '实际编辑器展开原始三镜，保留稳定shot/dialogue身份', () =>
    editor.getByRole('button', { name: '展开为节点', exact: true }).click(),
  )
  await expect(editor).toBeHidden()

  // Controlled preparation only: genuine PNG files supply image prerequisites; no image/speech run.
  const png = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=blue:s=64x64:d=0.1',
    '-frames:v',
    '1',
    '-c:v',
    'png',
    '-f',
    'image2pipe',
    'pipe:1',
  ])
  const upload = await page.request.post('/api/assets', {
    headers: { 'Content-Type': 'image/png' },
    data: png,
  })
  expect(upload.status()).toBe(201)
  const imageAssetId = (await upload.json()).id as string
  const nodes = await page.evaluate(
    ({ board, imageAssetId }) => {
      const videos: Record<string, string> = {}
      for (const element of window.__plein.engine.doc.elements()) {
        const source = element.params?.source as
          | { storyboard?: string; shot?: string; role?: string }
          | undefined
        if (source?.storyboard !== board || !source.shot) continue
        const map = window.__plein.engine.doc.mutable(element.id)! as unknown as {
          get(key: string): unknown
          set(key: string, value: unknown): void
        }
        const params = map.get('params') as { set(key: string, value: unknown): void }
        if (source.role === 'video') {
          params.set('model', 'plein/mock:video')
          videos[source.shot] = element.id
        } else if (source.role === 'image') {
          params.set('model', 'plein/mock:image')
          const id = 'controlled-image-' + source.shot
          map.set('results', [
            {
              id,
              port: 'images',
              runId: 'controlled-image-preparation',
              at: 1,
              value: { type: 'image', assetId: imageAssetId },
            },
          ])
          map.set('adopted', id)
        }
      }
      return videos
    },
    { board: ids.board, imageAssetId },
  )
  const canvas = canvasId(page),
    video = nodes[firstShot]!
  let prepared: { status: string; nodeId: string; inputHash?: string; prompt?: string }
  await expect
    .poll(
      async () => {
        const response = await page.request.get(nodeInputPath(canvas, video))
        if (!response.ok()) return response.status().toString()
        prepared = await response.json()
        return prepared.status
      },
      { message: '受控图片已同步，目标视频的真实预检必须ready' },
    )
    .toBe('ready')
  const runPath =
    '/api/canvases/' + encodeURIComponent(canvas) + '/nodes/' + encodeURIComponent(video) + '/run'
  const started = await page.request.post(runPath, { data: { expect: prepared!.inputHash } })
  expect(started.status()).toBe(202)
  const runId = (await started.json()).runId as string
  audit.setupRun = { nodeId: video, runId, inputHash: prepared!.inputHash!, request: runPath }
  await waitNode(page, video)
  const snapshot = await readNode(page, video)
  const old = snapshot.results!.find(
    (candidate) =>
      candidate.runId === runId && candidate.port === 'video' && candidate.value.type === 'video',
  )!
  expect(old.value.type).toBe('video')
  const frozen = await page.request.get(jobPath(canvas, runId))
  expect(frozen.status()).toBe(200)
  const job = await frozen.json()
  expect(job.id).toBe(old.runId)
  expect(job.nodeId).toBe(video)
  expect(job.input.nodeId).toBe(video)
  expect(job.input.prompt).toContain(baseline.shots[0]!.motionPrompt)
  audit.phase = 'path'
  return { ...ids, canvas, video, videos: nodes, old, frozen: job, imageAssetId }
}
type Fixture = Awaited<ReturnType<typeof prepare>>

function sqliteEvidence(canvas: string) {
  const directory = process.env.PLEIN_E2E_DATA
  if (!directory) throw new Error('缺少PLEIN_E2E_DATA，不能测量真实持久化submit事件')
  const db = new DatabaseSync(join(directory, 'plein.db'), { readOnly: true })
  try {
    const columns = db
      .prepare('PRAGMA table_info(jobs)')
      .all()
      .map((row) => row.name)
    for (const name of [
      'canvas_id',
      'id',
      'node_id',
      'node_type',
      'calls',
      'call_history',
      'input',
    ])
      if (!columns.includes(name)) throw new Error('jobs schema缺少 ' + name)
    const rows = db
      .prepare(
        'SELECT id,node_id,node_type,status,calls,call_history,input FROM jobs WHERE canvas_id = ? ORDER BY created_at,id',
      )
      .all(canvas) as Array<{
      id: string
      node_id: string
      node_type: string
      status: string
      calls: string
      call_history: string
      input: string | null
    }>
    return rows.map((row) => {
      // Same dictionary contract as server parseCalls; current records do not count retries.
      const calls = Object.values(JSON.parse(row.calls || '{}')) as Array<{
        state: string
        remoteId?: string
        trace?: unknown
      }>
      const history = JSON.parse(row.call_history || '[]') as Array<{
        id: string
        at: number
        kind: string
        attemptId?: string
        requestId?: string
      }>
      return {
        id: row.id,
        nodeId: row.node_id,
        nodeType: row.node_type,
        status: row.status,
        submitStarted: history.filter((entry) => entry.kind === 'submit_started'),
        calls: calls.map((entry) => ({
          state: entry.state,
          remoteId: entry.remoteId,
          trace: entry.trace,
        })),
        input: row.input ? JSON.parse(row.input) : null,
      }
    })
  } finally {
    db.close()
  }
}
async function saveAudit(info: TestInfo, audit: Audit, f: Fixture | undefined, outcome: string) {
  let jobs: ReturnType<typeof sqliteEvidence> | undefined, metricsError: string | undefined
  try {
    if (f) jobs = sqliteEvidence(f.canvas)
  } catch (error) {
    metricsError = String(error)
  }
  const report = {
    format: 'plein-shot-workbench-ui-observation',
    version: 1,
    at: new Date().toISOString(),
    test: info.title,
    outcome,
    fixture: { id: baseline.id, sha256: fixtureHash },
    canvasId: f?.canvas,
    target: f && { board: f.board, shot: firstShot, video: f.video },
    setup: {
      actualMockRun: audit.setupRun,
      controlledImages: '真实64x64 PNG；直接准备分镜图结果，未运行image或speech阶段',
      requests: audit.requests.filter((entry) => entry.phase === 'setup'),
    },
    scriptedActions: audit.scriptedActions,
    pathRequests: audit.requests.filter((entry) => entry.phase === 'path'),
    journal: jobs,
    metricsError,
    counts: {
      setupSubmitStarted:
        jobs
          ?.filter((row) => row.id === audit.setupRun?.runId)
          .reduce((sum, row) => sum + row.submitStarted.length, 0) ?? null,
      pathSubmitStarted:
        jobs
          ?.filter((row) => row.id !== audit.setupRun?.runId)
          .reduce((sum, row) => sum + row.submitStarted.length, 0) ?? null,
      pathExecutionRequests: executions(audit).length,
      scriptedActionRecords: audit.scriptedActions.length,
      humanActions: null,
      quality: null,
      realProviderCost: null,
    },
    boundary:
      '脚本动作、浏览器HTTP请求与SQLite提交事件分别记录；APIRequestContext的setup run单列，准备/测量GET不算动作或提交；mock产物与脚本保存可用不代表真实平台或人工创作质量。',
  }
  const path = info.outputPath('P07-observation.json')
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n')
  await info.attach('P07 observation', { path, contentType: 'application/json' })
}
async function preserveOtherShots(page: Page, f: Fixture) {
  return page.evaluate(
    ({ board, first }) => ({
      rows: (window.__plein.engine.doc.get(board)!.params!.shots as Array<{ id: string }>).filter(
        (shot) => shot.id !== first,
      ),
      nodes: [...window.__plein.engine.doc.elements()]
        .filter((element) => {
          const source = element.params?.source as
            | { storyboard?: string; shot?: string }
            | undefined
          return source?.storyboard === board && source.shot !== first
        })
        .map((element) => ({
          id: element.id,
          params: element.params,
          results: element.results,
          adopted: element.adopted,
        })),
    }),
    { board: f.board, first: firstShot },
  )
}
async function addControlledHistory(page: Page, f: Fixture) {
  const id = f.old.id + '-controlled-history'
  await page.evaluate(
    ({ node, old, id }) => {
      const map = window.__plein.engine.doc.mutable(node)! as unknown as {
        get(key: string): unknown
        set(key: string, value: unknown): void
      }
      map.set('results', [...(map.get('results') as unknown[]), { ...old, id, at: old.at - 1 }])
    },
    { node: f.video, old: f.old, id },
  )
  return id
}
async function addLegacySecondVideo(page: Page, f: Fixture) {
  const node = f.videos[secondShot]!
  await page.evaluate(
    ({ node, value }) => {
      const map = window.__plein.engine.doc.mutable(node)! as unknown as {
        set(key: string, value: unknown): void
      }
      map.set('results', [{ id: 'legacy-without-new-evidence', port: 'video', at: 1, value }])
      map.set('adopted', 'legacy-without-new-evidence')
    },
    { node, value: f.old.value },
  )
  return node
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function holdOnce(page: Page, pattern: string) {
  const entered = deferred(),
    release = deferred(),
    finished = deferred()
  const handler = async (route: Route) => {
    try {
      const response = await route.fetch()
      entered.resolve()
      await release.promise
      await route.fulfill({ response })
    } finally {
      finished.resolve()
    }
  }
  await page.route(pattern, handler, { times: 1 })
  return { entered: entered.promise, release: release.resolve, finished: finished.promise }
}

test('P01双人对白：固定剧情和旧依据→只改本镜→显式同步→确认一项视频→新候选验收→实际下游', async ({
  page,
}, info) => {
  const audit = watch(page)
  let f: Fixture | undefined,
    outcome = 'failed'
  try {
    f = await prepare(page, audit, true)
    const original = await preserveOtherShots(page, f)
    const beforeBoard = await readNode(page, f.board)
    await act(audit, '从真实分镜行进入镜头1工作台', () => openRow(page, f!.board))
    await act(audit, '选择目标镜真实video阶段', () => chooseVideo(page, f!.video))
    await expect(inputSection(page, true)).toContainText(baseline.shots[0]!.motionPrompt)
    await expect(inputSection(page)).toContainText(baseline.shots[0]!.motionPrompt)
    await wb(page).getByText('固定原文与本镜映射', { exact: true }).click()
    await expect(wb(page)).toContainText(baseline.shots[0]!.dialogue[0]!.line)
    await expect(wb(page)).toContainText('来源与固定版一致')
    await expect(wb(page)).toContainText('配音清单包含本镜台词')
    expect(executions(audit)).toEqual([])
    await wb(page).screenshot({ path: info.outputPath('P07-fixed-source-and-frozen-input.png') })
    await inputSection(page).scrollIntoViewIfNeeded()
    await expect(inputSection(page)).toBeInViewport()
    await expect(inputSection(page, true)).toBeInViewport()
    await wb(page).screenshot({ path: info.outputPath('P07-frozen-and-current-input.png') })
    const revised = baseline.shots[0]!.motionPrompt + '；递票后停顿半拍，镜头保持稳定'
    await act(audit, '只修改本镜视频运动提示词草稿', () =>
      wb(page).getByRole('textbox', { name: '工作台视频运动提示词', exact: true }).fill(revised),
    )
    await act(audit, '保存本镜字段，不自动同步或执行', () =>
      wb(page).getByRole('button', { name: '保存本镜字段', exact: true }).click(),
    )
    const saved = await readNode(page, f.board)
    const beforeFirst = (beforeBoard.params.shots as Array<Record<string, unknown>>)[0]!
    expect((saved.params.shots as Array<Record<string, unknown>>)[0]).toEqual({
      ...beforeFirst,
      motionPrompt: revised,
      edited: true,
    })
    expect((await readNode(page, f.video)).params.prompt).not.toContain('停顿半拍')
    expect(await preserveOtherShots(page, f)).toEqual(original)
    expect(executions(audit)).toEqual([])
    await act(audit, '打开原本镜计划差异', () =>
      wb(page).getByRole('button', { name: '核对本镜计划差异', exact: true }).click(),
    )
    const sync = page.getByRole('dialog', { name: '计划差异', exact: true })
    await expect(sync).toContainText('停顿半拍')
    await expect(sync.locator('[data-node-id]')).toHaveCount(1)
    await act(audit, '显式同步计划改动到本镜视频节点', () =>
      sync.getByRole('button', { name: '同步计划改动', exact: true }).click(),
    )
    await sync.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(inputSection(page)).toContainText('停顿半拍')
    await expect(inputSection(page, true)).not.toContainText('停顿半拍')
    expect(executions(audit)).toEqual([])
    await act(audit, '打开只针对本镜视频的真实清单', () =>
      wb(page).getByRole('button', { name: '本镜视频生成清单', exact: true }).click(),
    )
    const checklist = page.getByRole('dialog', { name: '批量生成清单', exact: true })
    await expect(checklist.getByLabel('清单汇总')).toContainText('生成 1 项')
    await expect(checklist.getByRole('table').locator('tbody > tr')).toHaveCount(1)
    await expect(checklist).toContainText('价格未知')
    expect(executions(audit)).toEqual([])
    await checklist.screenshot({ path: info.outputPath('P07-one-video-checklist.png') })
    const committed = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/storyboard-batch/commit'),
    )
    await act(audit, '明确确认一项清单并等待真实mock视频候选', () =>
      checklist.getByRole('button', { name: '确认并开始生成', exact: true }).click(),
    )
    const response = await committed
    expect(response.status(), await response.text()).toBe(202)
    expect((await response.json()).total).toBe(1)
    await expect(checklist).toBeHidden()
    await expect
      .poll(
        async () =>
          (await readNode(page, f!.video)).results?.filter(
            (candidate) => candidate.port === 'video' && candidate.value.type === 'video',
          ).length,
      )
      .toBe(2)
    await waitNode(page, f.video)
    const after = await readNode(page, f.video)
    expect(after.results!.find((candidate) => candidate.id === f!.old.id)).toEqual(f.old)
    const fresh = after.results!.find(
      (candidate) =>
        candidate.id !== f!.old.id &&
        candidate.port === 'video' &&
        candidate.value.type === 'video',
    )!
    expect(after.adopted).toBe(fresh.id)
    await wb(page)
      .getByRole('textbox', { name: /^创作验收备注/ })
      .fill('自动化合同夹具：仅记录本候选，不代表人工创作质量判断')
    await act(audit, '显式保存新候选创作验收夹具', () =>
      wb(page).getByRole('button', { name: '保存为可用', exact: true }).click(),
    )
    await expect
      .poll(async () => (await readNode(page, f!.video)).reviews)
      .toEqual([
        expect.objectContaining({
          status: 'usable',
          target: expect.objectContaining({ resultId: fresh.id }),
        }),
      ])
    expect(await preserveOtherShots(page, f)).toEqual(original)
    expect(executions(audit)).toHaveLength(1)
    expect(executions(audit)[0]!.path).toMatch(/\/storyboard-batch\/commit$/)
    await wb(page).screenshot({ path: info.outputPath('P07-new-candidate-review-and-impact.png') })
    const jobs = sqliteEvidence(f.canvas)
    expect(jobs).toHaveLength(2)
    expect(jobs.every((job) => job.nodeId === f!.video && job.nodeType === 'plein/video')).toBe(
      true,
    )
    expect(
      jobs.filter((job) => job.id === f!.old.runId).flatMap((job) => job.submitStarted),
    ).toHaveLength(1)
    expect(
      jobs.filter((job) => job.id !== f!.old.runId).flatMap((job) => job.submitStarted),
    ).toHaveLength(1)
    await act(audit, '沿真实下游连线定位实际sequence', () =>
      wb(page)
        .getByRole('region', { name: '本镜下游影响', exact: true })
        .getByRole('button', { name: 'P07 实际下游序列', exact: true })
        .click(),
    )
    await expect(wb(page)).toBeHidden()
    await expect(page.getByRole('dialog', { name: '序列', exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([
      f.sequence,
    ])
    outcome = 'passed'
  } finally {
    await saveAudit(info, audit, f, outcome)
  }
})

test('同帧改绑另一shot拒绝旧候选采用与审片；关闭改参数后10秒缓存窗内重开读取新输入', async ({
  page,
}, info) => {
  const audit = watch(page)
  let f: Fixture | undefined,
    outcome = 'failed'
  try {
    f = await prepare(page, audit)
    const history = await addControlledHistory(page, f)
    const source = (await readNode(page, f.video)).params.source as Record<string, unknown>
    await openRow(page, f.board)
    await chooseVideo(page, f.video)
    await wb(page).getByRole('combobox', { name: '工作台候选', exact: true }).selectOption(history)
    const adopted = (await readNode(page, f.video)).adopted
    await wb(page)
      .getByRole('button', { name: '明确采用此候选', exact: true })
      .evaluate(
        (button, { node, shot }) => {
          const params = window.__plein.engine.doc.mutable(node)!.get('params') as {
            get(key: string): Record<string, unknown>
            set(key: string, value: unknown): void
          }
          params.set('source', { ...params.get('source'), shot })
          ;(button as HTMLButtonElement).click()
        },
        { node: f.video, shot: secondShot },
      )
    expect((await readNode(page, f.video)).adopted).toBe(adopted)
    expect((await readNode(page, f.video)).reviews ?? []).toEqual([])
    await setParam(page, f.video, 'source', source)
    await chooseVideo(page, f.video)
    await wb(page).getByRole('combobox', { name: '工作台候选', exact: true }).selectOption(f.old.id)
    await expect(wb(page).getByRole('button', { name: '保存为可用', exact: true })).toBeEnabled()
    await wb(page)
      .getByRole('button', { name: '保存为可用', exact: true })
      .evaluate(
        (button, { node, shot }) => {
          const params = window.__plein.engine.doc.mutable(node)!.get('params') as {
            get(key: string): Record<string, unknown>
            set(key: string, value: unknown): void
          }
          params.set('source', { ...params.get('source'), shot })
          ;(button as HTMLButtonElement).click()
        },
        { node: f.video, shot: secondShot },
      )
    expect((await readNode(page, f.video)).reviews ?? []).toEqual([])
    await setParam(page, f.video, 'source', source)
    await closeWorkbench(page)
    const marker = 'P07关闭期间手改参数，十秒内必须读取新依据'
    const closedAt = Date.now()
    await setParam(page, f.video, 'prompt', marker)
    await expect
      .poll(async () => {
        const response = await page.request.get(nodeInputPath(f!.canvas, f!.video))
        return (await response.json()).prompt as string
      })
      .toContain(marker)
    const beforeReads = audit.requests.filter(
      (request) => request.path === nodeInputPath(f!.canvas, f!.video),
    ).length
    await page
      .getByTestId('production-overview')
      .getByRole('button', { name: '代表镜头工作台', exact: true })
      .click()
    await expect(wb(page)).toBeVisible()
    await chooseVideo(page, f.video)
    expect(Date.now() - closedAt, '必须在旧query的10秒缓存窗内重新进入').toBeLessThan(10_000)
    await expect(inputSection(page)).toContainText(marker)
    await expect(inputSection(page, true)).toContainText(baseline.shots[0]!.motionPrompt)
    await expect(inputSection(page, true)).not.toContainText(marker)
    expect(
      audit.requests.filter((request) => request.path === nodeInputPath(f!.canvas, f!.video))
        .length,
    ).toBeGreaterThan(beforeReads)
    expect(executions(audit)).toEqual([])
    expect(sqliteEvidence(f.canvas)).toHaveLength(1)
    await wb(page).screenshot({ path: info.outputPath('P07-source-guard-and-fresh-reopen.png') })
    outcome = 'passed'
  } finally {
    await saveAudit(info, audit, f, outcome)
  }
})

test('hold旧JobInfo与nodeInput后切换镜头/阶段，晚回不串；同帧只读保存拒绝且零提交', async ({
  page,
}, info) => {
  const audit = watch(page)
  let f: Fixture | undefined,
    outcome = 'failed'
  let inputHold: Awaited<ReturnType<typeof holdOnce>> | undefined
  let jobHold: Awaited<ReturnType<typeof holdOnce>> | undefined
  try {
    f = await prepare(page, audit)
    const secondVideo = await addLegacySecondVideo(page, f)
    inputHold = await holdOnce(page, '**' + nodeInputPath(f.canvas, f.video))
    jobHold = await holdOnce(page, '**' + jobPath(f.canvas, f.old.runId!))
    await openRow(page, f.board)
    await chooseVideo(page, f.video)
    await Promise.all([inputHold.entered, jobHold.entered])
    await wb(page)
      .getByRole('combobox', { name: '工作台镜头', exact: true })
      .selectOption(secondShot)
    await chooseVideo(page, secondVideo)
    await expect(inputSection(page)).toContainText(baseline.shots[1]!.motionPrompt)
    await expect(inputSection(page, true)).toContainText('未记录生成任务')
    inputHold.release()
    jobHold.release()
    await Promise.all([inputHold.finished, jobHold.finished])
    await expect(inputSection(page)).toContainText(baseline.shots[1]!.motionPrompt)
    await expect(inputSection(page)).not.toContainText(baseline.shots[0]!.motionPrompt)
    await expect(inputSection(page, true)).not.toContainText(baseline.shots[0]!.motionPrompt)
    const before = (await readNode(page, f.board)).params.shots
    await wb(page)
      .getByRole('textbox', { name: '工作台视频运动提示词', exact: true })
      .fill('只读同帧不应保存')
    await wb(page)
      .getByRole('button', { name: '保存本镜字段', exact: true })
      .evaluate((button) => {
        const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
          schemaVersion: number
          meta: { set(key: string, value: unknown): void }
        }
        doc.meta.set('schemaVersion', doc.schemaVersion + 1)
        ;(button as HTMLButtonElement).click()
      })
    expect((await readNode(page, f.board)).params.shots).toEqual(before)
    await expect(wb(page)).toContainText('当前只读')
    await expect(
      wb(page).getByRole('button', { name: '本镜视频生成清单', exact: true }),
    ).toBeDisabled()
    expect(executions(audit)).toEqual([])
    expect(sqliteEvidence(f.canvas)).toHaveLength(1)
    await wb(page).screenshot({ path: info.outputPath('P07-late-responses-and-readonly.png') })
    outcome = 'passed'
  } finally {
    inputHold?.release()
    jobHold?.release()
    await saveAudit(info, audit, f, outcome)
  }
})

test('只挂载当前一镜，历史预览不采用；静音回放切镜/关闭回收媒体，旧字段缺失与viewer可读', async ({
  page,
}, info) => {
  const audit = watch(page)
  let f: Fixture | undefined,
    outcome = 'failed'
  try {
    f = await prepare(page, audit)
    const history = await addControlledHistory(page, f)
    const secondVideo = await addLegacySecondVideo(page, f)
    await openRow(page, f.board)
    await chooseVideo(page, f.video)
    await expect(wb(page).locator('video')).toHaveCount(1)
    const first = await wb(page).getByLabel('工作台候选视频', { exact: true }).elementHandle()
    expect(first).not.toBeNull()
    await first!.evaluate(async (element: HTMLVideoElement) => {
      element.muted = true
      element.loop = true
      await element.play()
    })
    await expect
      .poll(() => first!.evaluate((element: HTMLVideoElement) => element.muted && !element.paused))
      .toBe(true)
    const adopted = (await readNode(page, f.video)).adopted
    await wb(page).getByRole('combobox', { name: '工作台候选', exact: true }).selectOption(history)
    await expect(wb(page)).toContainText('历史预览，当前采用项保持不变')
    expect((await readNode(page, f.video)).adopted).toBe(adopted)
    await expectMediaReleased(first!, info, 'candidate-selection')
    await expect(wb(page).locator('video')).toHaveCount(1)
    const historical = await wb(page).getByLabel('工作台候选视频', { exact: true }).elementHandle()
    await historical!.evaluate(async (element: HTMLVideoElement) => {
      element.muted = true
      element.loop = true
      await element.play()
    })
    await wb(page)
      .getByRole('combobox', { name: '工作台镜头', exact: true })
      .selectOption(secondShot)
    await chooseVideo(page, secondVideo)
    await expectMediaReleased(historical!, info, 'shot-change')
    await expect(wb(page).locator('video')).toHaveCount(1)
    await expect(inputSection(page, true)).toContainText('未记录生成任务，不能用当前参数补填')
    await wb(page).getByText('固定原文与本镜映射', { exact: true }).click()
    await expect(wb(page)).toContainText('本镜尚无固定原文映射')
    const legacy = await wb(page).getByLabel('工作台候选视频', { exact: true }).elementHandle()
    await legacy!.evaluate(async (element: HTMLVideoElement) => {
      element.muted = true
      element.loop = true
      await element.play()
    })
    await wb(page).screenshot({ path: info.outputPath('P07-one-muted-legacy-video.png') })
    await closeWorkbench(page)
    await expectMediaReleased(legacy!, info, 'workbench-close')
    await expect(page.getByLabel('工作台候选视频', { exact: true })).toHaveCount(0)
    // Controlled session UI fixture; server owner/role authorization is covered by job-read.test.ts.
    await page.route('**/api/session', async (route) => {
      const response = await route.fetch()
      const session = await response.json()
      await route.fulfill({
        response,
        json: { ...session, principal: { ...session.principal, role: 'viewer' } },
      })
    })
    await page.reload()
    await waitEngine(page)
    await openRow(page, f.board, 2)
    await chooseVideo(page, secondVideo)
    await expect(wb(page)).toContainText('当前只读')
    await expect(wb(page).getByRole('button', { name: '保存本镜字段', exact: true })).toBeDisabled()
    await expect(wb(page).getByRole('button', { name: '保存为可用', exact: true })).toBeDisabled()
    await expect(
      wb(page).getByRole('button', { name: '本镜视频生成清单', exact: true }),
    ).toBeDisabled()
    await expect(wb(page).locator('video')).toHaveCount(1)
    await wb(page).screenshot({ path: info.outputPath('P07-viewer-can-read-not-write.png') })
    expect(executions(audit)).toEqual([])
    expect(sqliteEvidence(f.canvas)).toHaveLength(1)
    outcome = 'passed'
  } finally {
    await saveAudit(info, audit, f, outcome)
  }
})
