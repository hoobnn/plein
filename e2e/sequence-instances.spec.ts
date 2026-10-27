import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { API } from '../packages/protocol/src/api'
import type { GenerationOrigin } from '../packages/doc/src/video-segment'
import { centerOf, newProject, waitEngine, waitNode, zoomTo } from './canvas'

/** 本机 ffmpeg 是否带 libass：烧字幕要用 ass 滤镜，缺了就跑不了这条 */
const hasLibass = () => {
  try {
    return / ass /.test(execFileSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' }))
  } catch {
    return false
  }
}

let directory = ''
test.beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'plein-instance-ui-'))
  // Independent temporary browser-decodable inputs; never overwrite the frozen MP4/goldens.
  for (const [name, pattern] of [
    ['shared', 'testsrc2'],
    ['alternate', 'smptebars'],
  ])
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-f',
      'lavfi',
      '-i',
      `${pattern}=size=160x90:rate=30:duration=8`,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=8',
      '-c:v',
      'libvpx-vp9',
      '-threads',
      '1',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-c:a',
      'libopus',
      '-shortest',
      join(directory, name + '.webm'),
    ])
})
test.afterAll(() => rmSync(directory, { recursive: true, force: true }))
const editor = (page: Page) => page.getByRole('dialog', { name: '序列', exact: true })
const operation = (page: Page) =>
  page.getByRole('dialog', { name: '固定素材与实例操作', exact: true })
interface Instance {
  clipInstanceId: string
  source: string
  port: string
  sound: string
  in: number
  out?: number
  speed?: number
  subtitle?: string
  segment?: {
    segmentId: string
    asset: { assetId: string }
    origin?: GenerationOrigin
    selection?: GenerationOrigin
  }
  narrative?: { boardId: string; shotId: string }
}
const read = (page: Page, id: string) =>
  page.evaluate((id) => JSON.parse(JSON.stringify(window.__plein.engine.doc.get(id))), id)
const clips = async (page: Page, id: string): Promise<Instance[]> =>
  (await read(page, id)).params.clips
async function open(page: Page, id: string) {
  await zoomTo(page, [id])
  const point = await centerOf(page, id)
  await page.mouse.dblclick(point.x, point.y)
  await expect(editor(page)).toHaveCSS('opacity', '1')
}
async function number(panel: Locator, label: string, value: number) {
  const field = panel.getByRole('spinbutton', { name: label, exact: true })
  await field.fill(String(value))
  await field.press('Enter')
}
async function choice(page: Page, panel: Locator, label: string, option: string) {
  await panel.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}
async function fixture(page: Page, generated = false) {
  await newProject(page)
  const bytes = readFileSync(join(directory, 'shared.webm'))
  const response = await page.request.post(API.assets, {
    headers: { 'content-type': 'video/webm', 'x-file-name': 'shared-eight-seconds.webm' },
    data: bytes,
  })
  expect(response.status()).toBe(201)
  const asset = await response.json()
  expect(asset.duration).toBeGreaterThanOrEqual(7.9)
  const ids = await page.evaluate(
    ({ assetId, generated }) => {
      const source = window.__plein.addNode({
        type: 'plein/video',
        name: '受控候选来源',
        x: 0,
        y: 100,
        params: {},
      })
      const map = window.__plein.engine.doc.mutable(source)! as unknown as {
        set(k: string, v: unknown): void
      }
      map.set('results', [
        {
          id: 'controlled-current',
          runId: 'controlled-history-fixture',
          port: 'video',
          at: 2,
          value: { type: 'video', assetId },
        },
      ])
      map.set('adopted', 'controlled-current')
      const sequence = window.__plein.addNode({
        type: 'plein/sequence',
        name: 'P11 两个独立实例',
        x: 600,
        y: 100,
        params: {
          subtitles: true,
          aspectRatio: '16:9',
          resolution: '720p',
          instanceVersion: 2,
          clips: [],
        },
      })
      const board = window.__plein.addNode({
        type: 'plein/storyboard',
        name: 'P11 稳定叙事范围',
        x: 100,
        y: 600,
        params: {
          shots: [1, 2].map((no) => ({
            id: `action-continuity-${no}`,
            no,
            description: `受控动作镜${no}`,
            duration: 2,
            dialogue: [],
            characters: [],
          })),
        },
      })
      if (!window.__plein.connect([source, 'video'], [sequence, 'clips']))
        throw new Error('connect')
      return { source, sequence, board, generated }
    },
    { assetId: asset.id as string, generated },
  )
  const canvas = decodeURIComponent(page.url().split('#/c/')[1]!.split('?')[0]!)
  const execution: string[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/(run|run-flow|run-batch|commit)$/.test(new URL(request.url()).pathname)
    )
      execution.push(new URL(request.url()).pathname)
  })
  return {
    ...ids,
    assetId: asset.id as string,
    canvas,
    execution,
    sha: createHash('sha256').update(bytes).digest('hex'),
  }
}
function providerSubmits(canvas: string) {
  if (!process.env.PLEIN_E2E_DATA) throw new Error('missing isolated data directory')
  const db = new DatabaseSync(join(process.env.PLEIN_E2E_DATA, 'plein.db'), { readOnly: true })
  try {
    return (
      db.prepare('SELECT node_type,call_history FROM jobs WHERE canvas_id=?').all(canvas) as Array<{
        node_type: string
        call_history: string
      }>
    ).map((r) => ({
      type: r.node_type,
      submits: (JSON.parse(r.call_history || '[]') as Array<{ kind: string }>).filter(
        (e) => e.kind === 'submit_started',
      ).length,
    }))
  } finally {
    db.close()
  }
}
async function fix(page: Page, sound = 'native') {
  await editor(page).getByRole('button', { name: '选定候选并固定素材', exact: true }).click()
  await expect(
    operation(page).getByRole('button', { name: '确认本次实例操作', exact: true }),
  ).toBeDisabled()
  await operation(page)
    .getByRole('combobox', { name: '明确选择新实例声音路线', exact: true })
    .selectOption(sound)
  await operation(page).getByRole('button', { name: '确认本次实例操作', exact: true }).click()
  await expect(operation(page)).toBeHidden()
}

test('同一固定段两实例：明确声音与叙事、独立修剪重排字幕、实际重叠输出和双来源回到具体实例，零Provider提交', async ({
  page,
}, info) => {
  // 导出要烧字幕，本机 ffmpeg 没有 libass 时跑不了（属环境限制，用例留在这里）
  test.skip(!hasLibass(), '本机 ffmpeg 无 libass，烧字幕的成片导不出来')
  const f = await fixture(page)
  await open(page, f.sequence)
  await expect(
    editor(page).getByRole('spinbutton', { name: '出点（秒）', exact: true }),
  ).toBeVisible()
  await fix(page)
  const a = (await clips(page, f.sequence))[0]!
  expect(a.segment?.asset.assetId).toBe(f.assetId)
  expect((await read(page, f.source)).adopted).toBe('controlled-current')
  await editor(page)
    .getByRole('combobox', { name: '实例叙事分镜', exact: true })
    .selectOption(f.board)
  await editor(page)
    .getByRole('combobox', { name: '实例叙事镜头', exact: true })
    .selectOption('action-continuity-1')
  await editor(page).getByRole('button', { name: '保存本实例叙事绑定', exact: true }).click()
  await number(editor(page), '出点（秒）', 2)
  await editor(page).getByRole('textbox', { name: '字幕', exact: true }).fill('A 独立字幕')
  await editor(page).getByRole('textbox', { name: '字幕', exact: true }).press('Enter')
  await editor(page).getByRole('button', { name: '复制独立实例', exact: true }).click()
  await operation(page)
    .getByRole('combobox', { name: '明确选择新实例声音路线', exact: true })
    .selectOption('native')
  await operation(page).getByRole('button', { name: '确认本次实例操作', exact: true }).click()
  await expect(operation(page)).toBeHidden()
  const b = (await clips(page, f.sequence))[1]!
  expect(b.clipInstanceId).not.toBe(a.clipInstanceId)
  expect(b.segment).toEqual((await clips(page, f.sequence))[0]!.segment)
  expect(b.narrative).toBeUndefined()
  // The old out=2 must be extended before in=4, respecting actual boundaries.
  await number(editor(page), '出点（秒）', 6)
  await number(editor(page), '入点（秒）', 4)
  await choice(page, editor(page), '速度', '2×')
  await choice(page, editor(page), '进入这段的转场', '叠化')
  await editor(page).getByRole('textbox', { name: '字幕', exact: true }).fill('B 独立字幕')
  await editor(page).getByRole('textbox', { name: '字幕', exact: true }).press('Enter')
  await editor(page)
    .getByRole('combobox', { name: '实例叙事分镜', exact: true })
    .selectOption(f.board)
  await editor(page)
    .getByRole('combobox', { name: '实例叙事镜头', exact: true })
    .selectOption('action-continuity-2')
  await editor(page).getByRole('button', { name: '保存本实例叙事绑定', exact: true }).click()
  const beforeMove = await clips(page, f.sequence)
  await editor(page).getByRole('button', { name: '前移', exact: true }).click()
  expect((await clips(page, f.sequence)).map((c) => c.clipInstanceId)).toEqual([
    b.clipInstanceId,
    a.clipInstanceId,
  ])
  await editor(page).getByRole('button', { name: '后移', exact: true }).click()
  expect(await clips(page, f.sequence)).toEqual(beforeMove)
  await editor(page).getByRole('button', { name: '字幕', exact: true }).click()
  await editor(page).getByRole('button', { name: '按当前台词创建字幕', exact: true }).click()
  const firstText = editor(page).getByRole('textbox', { name: '镜头 1 字幕 1 文本', exact: true })
  await firstText.fill('只改 A 的手工字幕')
  await expect(
    editor(page).getByRole('textbox', { name: '镜头 2 字幕 1 文本', exact: true }),
  ).toHaveValue('B 独立字幕')
  await editor(page).screenshot({ path: info.outputPath('independent-instance-subtitles.png') })
  expect(f.execution).toEqual([])
  await editor(page).getByRole('button', { name: '导出 MP4', exact: true }).click()
  await waitNode(page, f.sequence)
  const data = await read(page, f.sequence),
    delivery = data.deliveries[0]
  expect(delivery.duration).toBeCloseTo(2.5, 1)
  expect(delivery.sources.map((s: { clipInstanceId: string }) => s.clipInstanceId)).toEqual([
    a.clipInstanceId,
    b.clipInstanceId,
  ])
  const actual = editor(page).getByLabel('实际导出 MP4', { exact: true })
  await expect
    .poll(() => actual.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(1)
  await actual.evaluate((v: HTMLVideoElement) => {
    v.muted = true
    v.currentTime = 1.75
  })
  const sources = editor(page).getByRole('region', { name: '当前成片时间全部来源', exact: true })
  await expect(sources.locator('[data-clip-instance]')).toHaveCount(2)
  await expect(sources.locator(`[data-clip-instance="${a.clipInstanceId}"]`)).toHaveAttribute(
    'data-source-time',
    '1.75',
  )
  await expect(sources.locator(`[data-clip-instance="${b.clipInstanceId}"]`)).toHaveAttribute(
    'data-source-time',
    '4.5',
  )
  await editor(page).screenshot({ path: info.outputPath('overlap-two-exact-origins.png') })
  await sources
    .locator(`[data-clip-instance="${b.clipInstanceId}"]`)
    .getByRole('button', { name: '定位此具体实例', exact: true })
    .click()
  await expect(editor(page).locator(`[data-clip-instance="${b.clipInstanceId}"]`)).toHaveAttribute(
    'data-selected',
    'true',
  )
  expect(await clips(page, f.sequence)).toEqual(beforeMove)
  const journal = providerSubmits(f.canvas)
  expect(journal.every((r) => r.type === 'plein/sequence' && r.submits === 0)).toBe(true)
  writeFileSync(
    info.outputPath('P11-ui-evidence.json'),
    JSON.stringify(
      {
        fixtureSha: f.sha,
        instanceIds: [a.clipInstanceId, b.clipInstanceId],
        journal,
        requests: f.execution,
        humanActions: null,
        quality: null,
        audioPlayback: false,
      },
      null,
      2,
    ),
  )
})

test('明确历史端口候选不改变采用；关闭固定小窗的迟到文件读取不写入，同帧只读拒绝修改', async ({
  page,
}, info) => {
  const f = await fixture(page, true)
  const alternate = await page.request.post(API.assets, {
    headers: { 'content-type': 'video/webm' },
    data: readFileSync(join(directory, 'alternate.webm')),
  })
  expect(alternate.status()).toBe(201)
  const otherId = (await alternate.json()).id as string
  await page.evaluate(
    ({ source, assetId }) => {
      const m = window.__plein.engine.doc.mutable(source)! as unknown as {
        get(k: string): unknown
        set(k: string, value: unknown): void
      }
      m.set('results', [
        ...(m.get('results') as unknown[]),
        {
          id: 'controlled-history',
          runId: 'controlled-old-job',
          port: 'video',
          at: 1,
          value: { type: 'video', assetId },
        },
      ])
    },
    { source: f.source, assetId: otherId },
  )
  await open(page, f.sequence)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((done) => {
      release = done
    }),
    ready = new Promise<void>((done) => {
      entered = done
    })
  await page.route(
    '**' + API.assetMeta(otherId),
    async (route) => {
      const response = await route.fetch()
      entered()
      await gate
      await route.fulfill({ response })
    },
    { times: 1 },
  )
  const before = await clips(page, f.sequence)
  await editor(page).getByRole('button', { name: '选定候选并固定素材', exact: true }).click()
  await operation(page)
    .getByRole('combobox', { name: '固定具体视频候选', exact: true })
    .selectOption('controlled-history')
  await operation(page)
    .getByRole('combobox', { name: '明确选择新实例声音路线', exact: true })
    .selectOption('native')
  await operation(page).getByRole('button', { name: '确认本次实例操作', exact: true }).click()
  await ready
  await operation(page).getByRole('button', { name: '关闭', exact: true }).click()
  const completed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === API.assetMeta(otherId),
  )
  release()
  await (await completed).finished()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(operation(page)).toBeHidden()
  await expect.poll(async () => (await clips(page, f.sequence))[0]?.segment).toBeUndefined()
  expect(await clips(page, f.sequence)).toEqual(before)
  await editor(page).getByRole('button', { name: '选定候选并固定素材', exact: true }).click()
  await operation(page)
    .getByRole('combobox', { name: '固定具体视频候选', exact: true })
    .selectOption('controlled-history')
  await operation(page)
    .getByRole('combobox', { name: '明确选择新实例声音路线', exact: true })
    .selectOption('voice')
  await operation(page).getByRole('button', { name: '确认本次实例操作', exact: true }).click()
  await expect(operation(page)).toBeHidden()
  const segment = (await clips(page, f.sequence))[0]?.segment
  expect(segment?.origin).toBeUndefined()
  expect(segment?.selection).toEqual({
    canvasId: f.canvas,
    nodeId: f.source,
    port: 'video',
    resultId: 'controlled-history',
    runId: 'controlled-old-job',
  })
  await expect(
    editor(page).getByRole('region', { name: '独立剪辑实例', exact: true }),
  ).toContainText('原始生成出处：未知')
  expect((await read(page, f.source)).adopted).toBe('controlled-current')
  const fixed = await clips(page, f.sequence)
  await editor(page)
    .getByRole('button', { name: '保存本实例叙事绑定', exact: true })
    .evaluate((button) => {
      const doc = window.__plein.engine.doc as unknown as {
        schemaVersion: number
        meta: { set(k: string, v: unknown): void }
      }
      doc.meta.set('schemaVersion', doc.schemaVersion + 1)
      ;(button as HTMLButtonElement).click()
    })
  expect(await clips(page, f.sequence)).toEqual(fixed)
  await expect(editor(page)).toContainText('当前画布为只读')
  expect(f.execution).toEqual([])
  await editor(page).screenshot({ path: info.outputPath('historical-candidate-and-readonly.png') })
  writeFileSync(
    info.outputPath('P11-ui-evidence.json'),
    JSON.stringify(
      {
        fixtureSha: f.sha,
        controlledOrigins: true,
        journal: providerSubmits(f.canvas),
        requests: f.execution,
        humanActions: null,
        quality: null,
        audioPlayback: false,
      },
      null,
      2,
    ),
  )
})

test('原来源与固定视图删除后文件仍可预览；锁定与viewer保留只读实例，未新增生成', async ({
  page,
}, info) => {
  const f = await fixture(page)
  await open(page, f.sequence)
  await fix(page)
  const saved = (await clips(page, f.sequence))[0]!
  await editor(page).getByRole('button', { name: '关闭', exact: true }).click()
  await expect(editor(page)).toBeHidden()
  await page.evaluate((ids) => window.__plein.engine.selection.set(ids), [f.source, saved.source])
  await page.keyboard.press('Backspace')
  await expect
    .poll(() =>
      page.evaluate(
        (ids) => ids.every((id) => !window.__plein.engine.doc.get(id)),
        [f.source, saved.source],
      ),
    )
    .toBe(true)
  await open(page, f.sequence)
  await expect(editor(page)).toContainText('固定素材视图已删除')
  await expect(editor(page).locator('.seq-filmstrip > span').first()).toBeVisible()
  expect(await clips(page, f.sequence)).toEqual([saved])
  await editor(page)
    .getByRole('button', { name: '保存本实例叙事绑定', exact: true })
    .evaluate((button, id) => {
      const map = window.__plein.engine.doc.mutable(id)! as unknown as {
        set(k: string, v: unknown): void
      }
      map.set('locked', true)
      ;(button as HTMLButtonElement).click()
    }, f.sequence)
  expect(await clips(page, f.sequence)).toEqual([saved])
  await expect(
    editor(page).getByRole('button', { name: '复制独立实例', exact: true }),
  ).toBeDisabled()
  await page.evaluate((id) => {
    ;(
      window.__plein.engine.doc.mutable(id)! as unknown as { set(k: string, v: unknown): void }
    ).set('locked', false)
  }, f.sequence)
  await editor(page).getByRole('button', { name: '关闭', exact: true }).click()
  await page.route('**' + API.session, async (route) => {
    const response = await route.fetch()
    const session = await response.json()
    await route.fulfill({
      response,
      json: { ...session, principal: { ...session.principal, role: 'viewer' } },
    })
  })
  await page.reload()
  await waitEngine(page)
  await open(page, f.sequence)
  await expect(editor(page)).toContainText('当前画布为只读')
  await expect(
    editor(page).getByRole('button', { name: '复制独立实例', exact: true }),
  ).toBeDisabled()
  await expect(editor(page).getByRole('button', { name: '导出 MP4', exact: true })).toBeDisabled()
  expect(await clips(page, f.sequence)).toEqual([saved])
  expect(f.execution).toEqual([])
  await editor(page).screenshot({ path: info.outputPath('deleted-view-and-viewer.png') })
  writeFileSync(
    info.outputPath('P11-ui-evidence.json'),
    JSON.stringify(
      {
        fixtureSha: f.sha,
        saved,
        journal: providerSubmits(f.canvas),
        humanActions: null,
        quality: null,
        audioPlayback: false,
      },
      null,
      2,
    ),
  )
})

/** Controlled fixed-data setup only. Every navigation and batch preview below uses the real UI. */
async function mappedFixture(page: Page) {
  const f = await fixture(page)
  const ids = await page.evaluate(
    ({ source, sequence, board, canvas, assetId }) => {
      const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
        edgeMap: { delete(id: string): void }
      }
      const segment = {
        version: 1,
        segmentId: `controlled-segment:${sequence}`,
        asset: { assetId, kind: 'video', mime: 'video/webm' },
        duration: 8,
      }
      const view = doc.mutable(source)! as unknown as {
        set(k: string, v: unknown): void
        delete(k: string): void
      }
      view.set('kind', 'video')
      view.set('assetId', assetId)
      view.set('videoSegment', segment)
      view.set('name', '受控固定真实文件（无生成出处）')
      for (const key of ['nodeType', 'nodeVersion', 'results', 'adopted', 'params'])
        view.delete(key)
      for (const edge of doc.edges())
        if (edge.to[0] === sequence && edge.to[1] === 'clips')
          doc.edgeMap.delete((edge as unknown as { id: string }).id)
      const a = `controlled-instance-a:${sequence}`,
        b = `controlled-instance-b:${sequence}`
      const params = doc.mutable(sequence)!.get('params') as { set(k: string, v: unknown): void }
      params.set('instanceVersion', 2)
      params.set('clips', [
        {
          clipInstanceId: a,
          source,
          port: 'video',
          segment,
          sound: 'native',
          in: 0,
          out: 2,
          narrative: { canvasId: canvas, boardId: board, shotId: 'action-continuity-1' },
        },
        {
          clipInstanceId: b,
          source,
          port: 'video',
          segment,
          sound: 'native',
          in: 4,
          out: 6,
          narrative: { canvasId: canvas, boardId: board, shotId: 'action-continuity-2' },
        },
      ])
      return { a, b, segmentId: segment.segmentId }
    },
    { ...f, canvas: f.canvas },
  )
  return { ...f, ...ids }
}
const workbench = (page: Page) => page.getByRole('dialog', { name: '镜头工作台', exact: true })
const checklist = (page: Page) => page.getByRole('dialog', { name: '批量生成清单', exact: true })
async function openShot(page: Page, board: string, no: number) {
  // 节点编辑器浮在画布上，可能盖住分镜卡：先收起它，卡片才点得到
  await page.evaluate(() => window.__plein.engine.selection.set([]))
  await zoomTo(page, [board])
  const point = await centerOf(page, board)
  await page.mouse.dblclick(point.x, point.y)
  const table = page.getByRole('dialog', { name: '分镜表', exact: true })
  await expect(table).toHaveCSS('opacity', '1')
  await table.getByRole('button', { name: '详细卡片', exact: true }).click()
  await table.getByRole('button', { name: `镜头 ${no} 工作台`, exact: true }).click()
  await expect(workbench(page)).toHaveCSS('opacity', '1')
}
async function missingVideoPlan(page: Page) {
  const response = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/storyboard-batch/preview'),
  )
  await workbench(page).getByRole('button', { name: '本镜视频缺项清单', exact: true }).click()
  const result = await response
  expect(result.status()).toBe(200)
  return result.json()
}

test('固定段映射第二叙事镜且无video节点：工作台与引导精确定位第二实例，真实视频缺项清单沿用且零提交', async ({
  page,
}, info) => {
  const f = await mappedFixture(page)
  expect(
    await page.evaluate(
      (board) =>
        [...window.__plein.engine.doc.elements()].filter(
          (el) =>
            el.nodeType === 'plein/video' &&
            (el.params?.source as { storyboard?: string; shot?: string } | undefined)
              ?.storyboard === board &&
            (el.params?.source as { shot?: string } | undefined)?.shot === 'action-continuity-2',
        ).length,
      f.board,
    ),
  ).toBe(0)
  await openShot(page, f.board, 2)
  let mapping = workbench(page).getByRole('region', { name: '本镜序列映射', exact: true })
  await expect(mapping).toContainText(f.b)
  await expect(mapping).not.toContainText(f.a)
  await mapping.getByRole('button', { name: '定位此剪辑实例', exact: true }).click()
  await expect(workbench(page)).toBeHidden()
  await expect(editor(page).locator(`[data-clip-instance="${f.b}"]`)).toHaveAttribute(
    'data-selected',
    'true',
  )
  await expect(
    editor(page).getByRole('spinbutton', { name: '入点（秒）', exact: true }),
  ).toHaveValue('4')
  await editor(page).getByRole('button', { name: '关闭', exact: true }).click()
  const guide = page.getByTestId('creation-guide')
  await choice(page, guide, '创作引导试做镜头', '镜头 2 · 受控动作镜2')
  const overview = page.getByTestId('production-overview')
  mapping = overview.getByRole('region', { name: '本镜序列映射', exact: true })
  await expect(mapping).toContainText(f.b)
  await expect(mapping).not.toContainText(f.a)
  await mapping.getByRole('button', { name: '定位此剪辑实例', exact: true }).click()
  await expect(editor(page).locator(`[data-clip-instance="${f.b}"]`)).toHaveAttribute(
    'data-selected',
    'true',
  )
  await editor(page).getByRole('button', { name: '关闭', exact: true }).click()
  await overview.getByRole('button', { name: '代表镜头工作台', exact: true }).click()
  const plan = await missingVideoPlan(page)
  expect(plan.request).toMatchObject({
    shotIds: ['action-continuity-2'],
    role: 'video',
    reuseExisting: true,
  })
  expect(plan.scope.sequenceId).toBe(f.sequence)
  expect(plan.summary).toMatchObject({ run: 0, reuse: 1, blocked: 0, calls: 0 })
  expect(plan.rows).toHaveLength(1)
  expect(plan.rows[0]).toMatchObject({
    action: 'reuse',
    calls: 0,
    mapping: {
      sequenceId: f.sequence,
      instances: [
        expect.objectContaining({
          clipInstanceId: f.b,
          segmentId: f.segmentId,
          assetId: f.assetId,
          sound: 'native',
        }),
      ],
    },
  })
  await expect(checklist(page).getByLabel('清单汇总')).toContainText('沿用 1 项')
  await expect(
    checklist(page).getByRole('button', { name: '确认并开始生成', exact: true }),
  ).toBeDisabled()
  await checklist(page).getByText('查看固定段与声音映射', { exact: true }).click()
  await expect(checklist(page)).toContainText(f.b)
  await expect(checklist(page)).toContainText(f.assetId)
  await expect(checklist(page)).toContainText('声音 native')
  await checklist(page).screenshot({
    path: info.outputPath('fixed-second-shot-reuse-and-exact-instance.png'),
  })
  expect(f.execution).toEqual([])
  expect(providerSubmits(f.canvas)).toEqual([])
  writeFileSync(
    info.outputPath('P11-mapping-ui-evidence.json'),
    JSON.stringify(
      {
        fixture:
          'controlled typed fixed mapping over actual owned 8-second file; no generated origin',
        assetId: f.assetId,
        fixtureSha: f.sha,
        a: f.a,
        b: f.b,
        plan,
        requests: f.execution,
        journal: providerSubmits(f.canvas),
        humanActions: null,
        quality: null,
      },
      null,
      2,
    ),
  )
})

test('真实复制第二序列后未选scope阻塞；清单与工作台显式范围只显示所选序列的确切实例，零提交', async ({
  page,
}, info) => {
  const f = await mappedFixture(page)
  await page.keyboard.press('Escape')
  await zoomTo(page, [f.sequence])
  const point = await centerOf(page, f.sequence)
  await page.mouse.click(point.x, point.y)
  await page.keyboard.press('ControlOrMeta+d')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          [...window.__plein.engine.doc.elements()].filter((el) => el.nodeType === 'plein/sequence')
            .length,
      ),
    )
    .toBe(2)
  const copy = await page.evaluate(
    (original) =>
      [...window.__plein.engine.doc.elements()].find(
        (el) => el.nodeType === 'plein/sequence' && el.id !== original,
      )!.id,
    f.sequence,
  )
  const copyB = (await clips(page, copy)).find(
    (c) => c.narrative?.shotId === 'action-continuity-2',
  )!
  expect(copyB.clipInstanceId).not.toBe(f.b)
  await openShot(page, f.board, 2)
  const mapping = workbench(page).getByRole('region', { name: '本镜序列映射', exact: true })
  await expect(mapping).toContainText('多个序列')
  const blocked = await missingVideoPlan(page)
  expect(blocked.request.sequenceId).toBeUndefined()
  expect(blocked.summary).toMatchObject({ run: 0, blocked: 1, calls: 0 })
  await expect(checklist(page)).toContainText('多个序列')
  await expect(
    checklist(page).getByRole('button', { name: '确认并开始生成', exact: true }),
  ).toBeDisabled()
  const changed = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/storyboard-batch/preview'),
  )
  await checklist(page)
    .getByRole('combobox', { name: '批量清单序列范围', exact: true })
    .selectOption(copy)
  const selectedResponse = await changed
  expect(selectedResponse.status()).toBe(200)
  const selected = await selectedResponse.json()
  expect(selected.request.sequenceId).toBe(copy)
  expect(selected.scope.sequenceId).toBe(copy)
  expect(selected.summary).toMatchObject({ run: 0, reuse: 1, blocked: 0, calls: 0 })
  expect(
    selected.rows[0].mapping.instances.map((c: { clipInstanceId: string }) => c.clipInstanceId),
  ).toEqual([copyB.clipInstanceId])
  await expect(checklist(page).getByLabel('清单冻结范围')).toContainText(copy)
  await checklist(page).getByText('查看固定段与声音映射', { exact: true }).click()
  await expect(checklist(page)).toContainText(copyB.clipInstanceId)
  await checklist(page).screenshot({
    path: info.outputPath('two-sequences-explicit-batch-scope.png'),
  })
  await checklist(page).getByRole('button', { name: '取消', exact: true }).click()
  await mapping
    .getByRole('combobox', { name: '本镜序列范围', exact: true })
    .selectOption(f.sequence)
  await expect(mapping).toContainText(f.b)
  await expect(mapping).not.toContainText(copyB.clipInstanceId)
  await mapping.getByRole('button', { name: '定位此剪辑实例', exact: true }).click()
  await expect(editor(page).locator(`[data-clip-instance="${f.b}"]`)).toHaveAttribute(
    'data-selected',
    'true',
  )
  expect(f.execution).toEqual([])
  expect(providerSubmits(f.canvas)).toEqual([])
  writeFileSync(
    info.outputPath('P11-mapping-ui-evidence.json'),
    JSON.stringify(
      {
        fixture:
          'actual keyboard sequence duplication; controlled fixed mapping over actual owned file',
        fixtureSha: f.sha,
        original: f.sequence,
        copy,
        blocked,
        selected,
        requests: f.execution,
        journal: providerSubmits(f.canvas),
        humanActions: null,
        quality: null,
      },
      null,
      2,
    ),
  )
})

test('两live序列可运行新候选时，同帧切换范围再旧确认click不能发出旧scope commit，零submit', async ({
  page,
}, info) => {
  const f = await fixture(page)
  expect(
    (
      await page.request.put(API.providerConfig('plein/mock'), {
        data: { settings: { latencyMs: 0, failWith: 'none' } },
      })
    ).ok(),
  ).toBe(true)
  const other = await page.evaluate(
    ({ source, board }) => {
      const params = window.__plein.engine.doc.mutable(source)!.get('params') as {
        set(k: string, v: unknown): void
      }
      params.set('model', 'plein/mock:video')
      params.set('mode', 'text')
      params.set('prompt', '受控范围授权反例，不应实际提交')
      params.set('source', { storyboard: board, shot: 'action-continuity-1', role: 'video' })
      const id = window.__plein.addNode({
        type: 'plein/sequence',
        name: '第二live范围',
        x: 1100,
        y: 100,
        params: { instanceVersion: 2, clips: [], subtitles: false },
      })
      if (!window.__plein.connect([source, 'video'], [id, 'clips']))
        throw new Error('second live input')
      return id
    },
    { source: f.source, board: f.board },
  )
  await openShot(page, f.board, 1)
  // This deliberately hand-configured live node must acknowledge its real plan differences first.
  await workbench(page).getByRole('button', { name: '核对本镜计划差异', exact: true }).click()
  const differences = page.getByRole('dialog', { name: '计划差异', exact: true })
  await differences.getByRole('button', { name: '不同步，按节点现状', exact: true }).click()
  await differences.getByRole('button', { name: '关闭', exact: true }).click()
  await workbench(page)
    .getByRole('region', { name: '本镜序列映射', exact: true })
    .getByRole('combobox', { name: '本镜序列范围', exact: true })
    .selectOption(f.sequence)
  const previewResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/storyboard-batch/preview'),
  )
  await workbench(page).getByRole('button', { name: '本镜视频生成清单', exact: true }).click()
  const plan = await (await previewResponse).json()
  expect(plan.request).toMatchObject({ reuseExisting: false, sequenceId: f.sequence })
  expect(plan.summary.run, JSON.stringify(plan.rows)).toBe(1)
  const confirm = checklist(page).getByRole('button', { name: '确认并开始生成', exact: true })
  await expect(confirm).toBeEnabled()
  await confirm.evaluate((button, nextScope) => {
    button.addEventListener(
      'click',
      () => {
        const select = button
          .closest('[role="dialog"]')!
          .querySelector<HTMLSelectElement>('select[aria-label="批量清单序列范围"]')!
        select.value = nextScope
        select.dispatchEvent(new Event('change', { bubbles: true }))
      },
      { capture: true, once: true },
    )
  }, other)
  // Trusted button click with a nested real DOM change; no React/store handler is called directly.
  await confirm.click()
  await expect(
    checklist(page).getByRole('combobox', { name: '批量清单序列范围', exact: true }),
  ).toHaveValue(other)
  await expect(checklist(page).getByLabel('清单冻结范围')).toContainText(other)
  expect(f.execution).toEqual([])
  expect(providerSubmits(f.canvas)).toEqual([])
  await checklist(page).screenshot({
    path: info.outputPath('same-frame-scope-change-rejects-old-commit.png'),
  })
  writeFileSync(
    info.outputPath('P11-mapping-ui-evidence.json'),
    JSON.stringify(
      {
        fixture: 'controlled real live-source candidates; only real UI previews, no commit',
        fixtureSha: f.sha,
        firstScope: f.sequence,
        changedScope: other,
        initialPlan: plan,
        requests: f.execution,
        journal: providerSubmits(f.canvas),
        humanActions: null,
        quality: null,
      },
      null,
      2,
    ),
  )
})

test('v1失去来源的手工字幕保留完整原值：只读展示、编辑当前字幕、真实复制和刷新不丢失或改写literal @文本', async ({
  page,
}, info) => {
  const f = await fixture(page)
  const orphan = {
    id: 'controlled-orphan-cue',
    source: 'controlled-deleted-video',
    start: 1.25,
    end: 2.25,
    text: '失去来源的手工原文 @林夏，不得按角色改名',
    hidden: true,
    originalExtra: { note: '完整旧值 @林夏', unknown: ['keep', 7] },
  }
  const setup = await page.evaluate(
    ({ sequence, source, assetId, orphan }) => {
      const role = window.__plein.addNode({
        type: 'plein/character',
        name: '林夏',
        x: 1100,
        y: 500,
        params: {},
      })
      const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
        meta: { set(k: string, v: unknown): void }
        migrate(): void
      }
      const map = doc.mutable(sequence)! as unknown as {
        get(k: string): unknown
        set(k: string, v: unknown): void
      }
      const params = map.get('params') as {
        set(k: string, v: unknown): void
        delete(k: string): void
      }
      const track = {
        inputKey: JSON.stringify({
          model: '',
          transition: '无',
          transitionDuration: 0.5,
          clips: [{ source, assetId, in: 0, speed: 1, delay: 0, lines: [] }],
        }),
        cues: [
          {
            id: 'controlled-active-cue',
            source,
            start: 0,
            end: 1,
            text: '当前字幕',
            hidden: false,
          },
          orphan,
        ],
      }
      // Explicit old-document fault fixture; migrate uses the actual public schema upgrade.
      map.set('nodeVersion', 1)
      params.delete('instanceVersion')
      params.set('clips', [])
      params.set('subtitleTrack', track)
      doc.meta.set('schemaVersion', 10)
      doc.migrate()
      return { role, track }
    },
    { ...f, orphan },
  )
  const migrated = (await read(page, f.sequence)).params.subtitleTrack
  expect(migrated.inputKey).toBe(setup.track.inputKey)
  expect(migrated.cues).toHaveLength(1)
  expect(migrated.unmappedCues).toHaveLength(1)
  expect(migrated.unmappedCues[0].cue).toEqual(orphan)
  expect(migrated.legacyTrack).toEqual(setup.track)
  await open(page, f.sequence)
  await editor(page).getByRole('button', { name: '字幕', exact: true }).click()
  let preserved = editor(page).getByRole('region', { name: '未映射旧字幕', exact: true })
  await expect(preserved).toContainText(migrated.unmappedCues[0].reason)
  await expect(preserved).toContainText('未加入预览或导出')
  await expect(preserved.locator('input, textarea, select, button')).toHaveCount(0)
  await preserved.locator('summary').first().click()
  const originalCue = preserved.getByLabel('未映射字幕 1 原值')
  expect(JSON.parse((await originalCue.textContent())!)).toEqual(orphan)
  await originalCue.scrollIntoViewIfNeeded()
  await expect(originalCue).toBeInViewport()
  await originalCue.screenshot({ path: info.outputPath('unmapped-subtitle-raw-json.png') })
  await editor(page).screenshot({
    path: info.outputPath('unmapped-subtitle-original-readonly.png'),
  })
  await preserved.getByText('查看迁移前完整字幕轨', { exact: true }).click()
  expect(JSON.parse((await preserved.getByLabel('迁移前完整字幕轨原值').textContent())!)).toEqual(
    setup.track,
  )
  const active = editor(page).getByRole('textbox', { name: '镜头 1 字幕 1 文本', exact: true })
  await expect(active).toHaveValue('当前字幕')
  await active.fill('只编辑当前实例的literal @林夏')
  const edited = (await read(page, f.sequence)).params.subtitleTrack
  expect(edited.unmappedCues).toEqual(migrated.unmappedCues)
  expect(edited.legacyTrack).toEqual(setup.track)
  expect(edited.cues).toHaveLength(1)
  await editor(page).screenshot({
    path: info.outputPath('unmapped-subtitle-current-edited.png'),
  })
  await editor(page).getByRole('button', { name: '关闭', exact: true }).click()
  await page.keyboard.press('Escape')
  // The generator panel can cover the character's canvas center; use the actual layers UI.
  const layers = page.getByRole('tree', { name: '画布元素', exact: true })
  await layers.locator(`[data-id="${f.sequence}"]`).click()
  await layers.locator(`[data-id="${setup.role}"]`).click({ modifiers: ['Shift'] })
  await expect
    .poll(() => page.evaluate(() => window.__plein.engine.selection.values().length))
    .toBe(2)
  await page.keyboard.press('ControlOrMeta+d')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          [...window.__plein.engine.doc.elements()].filter((el) => el.nodeType === 'plein/sequence')
            .length,
      ),
    )
    .toBe(2)
  const copy = await page.evaluate(
    (id) =>
      [...window.__plein.engine.doc.elements()].find(
        (el) => el.nodeType === 'plein/sequence' && el.id !== id,
      )!.id,
    f.sequence,
  )
  const copied = (await read(page, copy)).params.subtitleTrack
  expect(copied.unmappedCues).toEqual(migrated.unmappedCues)
  expect(copied.legacyTrack).toEqual(setup.track)
  expect(copied.cues[0].text).toBe('只编辑当前实例的literal @林夏')
  await page.reload()
  await waitEngine(page)
  expect((await read(page, copy)).params.subtitleTrack.unmappedCues).toEqual(migrated.unmappedCues)
  await open(page, copy)
  await editor(page).getByRole('button', { name: '字幕', exact: true }).click()
  preserved = editor(page).getByRole('region', { name: '未映射旧字幕', exact: true })
  await preserved.locator('summary').first().click()
  expect(JSON.parse((await preserved.getByLabel('未映射字幕 1 原值').textContent())!)).toEqual(
    orphan,
  )
  expect(f.execution).toEqual([])
  expect(providerSubmits(f.canvas)).toEqual([])
  writeFileSync(
    info.outputPath('P11-unmapped-subtitle-evidence.json'),
    JSON.stringify(
      {
        fixture: 'controlled actual v1 orphan cue migration over the owned 8-second file',
        fixtureSha: f.sha,
        orphan,
        migrated,
        edited,
        copied,
        original: f.sequence,
        copy,
        requests: f.execution,
        journal: providerSubmits(f.canvas),
        audioPlayback: false,
        humanActions: null,
        quality: null,
      },
      null,
      2,
    ),
  )
})

test('复制的旧确认只作历史：同帧历史化拒绝旧写入，真实copy后意见确认只读，新本地输出单独审阅且零Provider提交', async ({
  page,
}, info) => {
  const f = await mappedFixture(page)
  // Controlled old metadata over the owned file, not an actual old export or human approval.
  const old = {
    id: 'controlled-old-delivery',
    resultId: 'controlled-old-output',
    runId: 'controlled-not-actual-export',
    assetId: f.assetId,
    kind: 'film',
    version: 'v1',
    createdAt: 1,
    width: 160,
    height: 90,
    duration: 8,
    boardId: f.board,
    sources: [
      {
        source: f.source,
        clipInstanceId: f.a,
        segmentId: f.segmentId,
        assetId: f.assetId,
        port: 'video',
        narrative: { canvasId: f.canvas, boardId: f.board, shotId: 'action-continuity-1' },
        sourceIn: 0,
        sourceOut: 2,
        speed: 1,
        start: 0,
        end: 2,
      },
    ],
    notes: [{ id: 'controlled-old-note', time: 0.3, text: '受控旧范围意见', resolved: true }],
    confirmedAt: 1,
  }
  await page.evaluate(
    ({ sequence, old }) => {
      const map = window.__plein.engine.doc.mutable(sequence)! as unknown as {
        set(k: string, v: unknown): void
      }
      map.set('results', [
        {
          id: old.resultId,
          runId: old.runId,
          port: 'video',
          at: 1,
          value: { type: 'video', assetId: old.assetId },
        },
      ])
      map.set('adopted', old.resultId)
      map.set('deliveries', [old])
    },
    { sequence: f.sequence, old },
  )
  await open(page, f.sequence)
  await editor(page).getByRole('button', { name: '实际 MP4 回看 / 交付', exact: true }).click()
  const withdraw = editor(page).getByRole('button', { name: '撤回此版确认', exact: true })
  await expect(withdraw).toBeEnabled()
  await withdraw.evaluate((button, sequence) => {
    button.addEventListener(
      'click',
      () => {
        const doc = window.__plein.engine.doc as unknown as {
          mutable(id: string): { get(k: string): unknown; set(k: string, v: unknown): void }
          ydoc: {
            on(event: string, cb: () => void): void
            off(event: string, cb: () => void): void
          }
        }
        const map = doc.mutable(sequence)
        map.set(
          'deliveries',
          (map.get('deliveries') as Array<Record<string, unknown>>).map((r) => ({
            ...r,
            historical: true,
          })),
        )
        const proof = { writes: 0, stop: () => {} }
        const observe = () => proof.writes++
        proof.stop = () => doc.ydoc.off('update', observe)
        doc.ydoc.on('update', observe)
        ;(window as unknown as { __p11HistoryWrites: typeof proof }).__p11HistoryWrites = proof
      },
      { capture: true, once: true },
    )
  }, f.sequence)
  await withdraw.click()
  await expect(editor(page).getByLabel('交付确认状态')).toContainText('历史范围曾人工确认此文件')
  const sameFrameWrites = await page.evaluate(() => {
    const proof = (window as unknown as { __p11HistoryWrites: { writes: number; stop(): void } })
      .__p11HistoryWrites
    proof.stop()
    return proof.writes
  })
  expect(sameFrameWrites).toBe(0)
  expect((await read(page, f.sequence)).deliveries[0]).toEqual({ ...old, historical: true })
  await expect(
    editor(page).getByRole('button', { name: '历史范围确认只读', exact: true }),
  ).toBeDisabled()
  await editor(page).getByRole('button', { name: '关闭', exact: true }).click()
  // Restore the explicit old fixture so the real duplicate must establish its own history boundary.
  await page.evaluate(
    ({ sequence, old }) => {
      ;(
        window.__plein.engine.doc.mutable(sequence)! as unknown as {
          set(k: string, v: unknown): void
        }
      ).set('deliveries', [old])
    },
    { sequence: f.sequence, old },
  )
  await page.keyboard.press('Escape')
  await zoomTo(page, [f.sequence])
  const point = await centerOf(page, f.sequence)
  await page.mouse.click(point.x, point.y)
  await page.keyboard.press('ControlOrMeta+d')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          [...window.__plein.engine.doc.elements()].filter((el) => el.nodeType === 'plein/sequence')
            .length,
      ),
    )
    .toBe(2)
  const copy = await page.evaluate(
    (id) =>
      [...window.__plein.engine.doc.elements()].find(
        (el) => el.nodeType === 'plein/sequence' && el.id !== id,
      )!.id,
    f.sequence,
  )
  const historical = (await read(page, copy)).deliveries[0]
  expect(historical).toEqual({ ...old, historical: true })
  await open(page, copy)
  await editor(page).getByRole('button', { name: '实际 MP4 回看 / 交付', exact: true }).click()
  await expect(editor(page).getByLabel('交付确认状态')).toContainText('历史范围曾人工确认此文件')
  await expect(
    editor(page).getByRole('textbox', { name: '成片时间码意见', exact: true }),
  ).toBeDisabled()
  await expect(editor(page).getByRole('checkbox', { name: '已解决', exact: true })).toBeDisabled()
  await expect(editor(page).getByRole('button', { name: '删除', exact: true })).toBeDisabled()
  await expect(
    editor(page).getByRole('button', { name: '历史范围确认只读', exact: true }),
  ).toBeDisabled()
  await expect(
    editor(page).getByRole('button', { name: '定位此具体实例', exact: true }),
  ).toHaveCount(0)
  await editor(page).screenshot({ path: info.outputPath('copied-delivery-history-readonly.png') })
  expect(f.execution).toEqual([])
  await editor(page).getByRole('button', { name: '剪辑预览', exact: true }).click()
  await editor(page).getByRole('button', { name: '重新导出', exact: true }).click()
  await waitNode(page, copy)
  const after = await read(page, copy)
  const current = after.deliveries.find((r: { historical?: boolean }) => !r.historical)
  expect(current).toBeTruthy()
  expect(current.confirmedAt).toBeUndefined()
  await editor(page)
    .getByRole('combobox', { name: '交付版本', exact: true })
    .selectOption(current.id)
  await expect(
    editor(page).getByRole('textbox', { name: '成片时间码意见', exact: true }),
  ).toBeEnabled()
  await expect
    .poll(() =>
      editor(page)
        .getByLabel('实际导出 MP4')
        .evaluate((v: HTMLVideoElement) => v.readyState),
    )
    .toBeGreaterThanOrEqual(1)
  await editor(page)
    .getByRole('textbox', { name: '成片时间码意见', exact: true })
    .fill('当前输出的受控测试意见')
  await editor(page).getByRole('button', { name: '在当前时间添加意见', exact: true }).click()
  await editor(page).getByRole('checkbox', { name: '已解决', exact: true }).check()
  await editor(page).getByRole('button', { name: '确认此版本可交付', exact: true }).click()
  const final = await read(page, copy)
  expect(final.deliveries.find((r: { id: string }) => r.id === old.id)).toEqual(historical)
  expect(
    final.deliveries.find((r: { id: string }) => r.id === current.id).confirmedAt,
  ).toBeGreaterThan(1)
  const journal = providerSubmits(f.canvas)
  expect(journal.length).toBeGreaterThan(0)
  expect(journal.every((r) => r.type === 'plein/sequence' && r.submits === 0)).toBe(true)
  writeFileSync(
    info.outputPath('P11-historical-delivery-evidence.json'),
    JSON.stringify(
      {
        fixture: 'controlled old confirmation metadata, not actual old export or human approval',
        fixtureSha: f.sha,
        old,
        copy,
        historical,
        sameFrameWrites,
        current,
        final,
        requests: f.execution,
        journal,
        scriptedCurrentConfirmation: true,
        humanApproval: null,
        humanActions: null,
        quality: null,
        audioPlayback: false,
      },
      null,
      2,
    ),
  )
})
