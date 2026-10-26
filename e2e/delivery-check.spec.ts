import { execFileSync } from 'node:child_process'
import { expect, type Page, test } from '@playwright/test'
import { centerOf, newProject, zoomTo } from './canvas'

const panel = (page: Page) => page.getByTestId('delivery-check')
const overview = (page: Page) => page.getByTestId('production-overview')
const watchRuns = (page: Page) => {
  const calls: string[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/(?:run|run-flow|run-batch|storyboard-batch\/commit)(?:\?|$)/.test(request.url())
    )
      calls.push(request.url())
  })
  return calls
}
async function editGoal(page: Page, text: string) {
  const button = overview(page).getByRole('button', { name: '填写或修订制作目标', exact: true })
  if (!(await button.isVisible()))
    await overview(page).getByText('编辑制作目标', { exact: true }).click()
  await button.click()
  await overview(page).getByRole('combobox', { name: '目标画幅', exact: true }).selectOption('16:9')
  await overview(page)
    .getByRole('combobox', { name: '目标分辨率', exact: true })
    .selectOption('720p')
  await overview(page).getByRole('spinbutton', { name: '目标最短时长' }).fill('1.8')
  await overview(page).getByRole('spinbutton', { name: '目标最长时长' }).fill('2.2')
  await overview(page)
    .getByRole('combobox', { name: '目标对白要求', exact: true })
    .selectOption('required')
  await overview(page)
    .getByRole('combobox', { name: '目标字幕要求', exact: true })
    .selectOption('none')
  await overview(page).getByRole('textbox', { name: '文字创作要求', exact: true }).fill(text)
  await overview(page).getByRole('button', { name: '保存目标新版本', exact: true }).click()
}
async function openDelivery(page: Page, sequence: string) {
  await zoomTo(page, [sequence])
  const at = await centerOf(page, sequence)
  await page.mouse.dblclick(at.x, at.y)
  await page
    .getByRole('dialog', { name: '序列', exact: true })
    .getByRole('button', { name: '实际 MP4 回看 / 交付', exact: true })
    .click()
  await expect(panel(page)).toBeVisible()
  const video = page.getByLabel('实际导出 MP4', { exact: true })
  await expect(video).toBeVisible()
  expect(
    await video.evaluate((element: HTMLVideoElement) => ({
      paused: element.paused,
      autoplay: element.autoplay,
    })),
  ).toEqual({ paused: true, autoplay: false })
  // File-only test policy: set this newly mounted player's test state before any action.
  await video.evaluate((element: HTMLVideoElement) => {
    element.muted = true
    element.pause()
  })
}
async function fixture(page: Page) {
  await newProject(page)
  const bytes = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=yellow:s=1280x720:r=10:d=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    '-movflags',
    'frag_keyframe+empty_moov',
    '-f',
    'mp4',
    'pipe:1',
  ])
  const uploaded = await page.request.post('/api/assets', {
    headers: { 'Content-Type': 'video/mp4' },
    data: bytes,
  })
  expect(uploaded.status()).toBe(201)
  const assetId = (await uploaded.json()).id as string
  const ids = await page.evaluate((assetId) => {
    const board = window.__plein.addNode({
      type: 'plein/storyboard',
      name: '技术检查分镜',
      x: 100,
      y: 100,
      params: {
        shots: [{ id: 'one', no: 1, duration: 2, description: '明亮静态画面，动作需人工检查' }],
      },
    })
    const sequence = window.__plein.addNode({
      type: 'plein/sequence',
      name: '技术检查真实文件',
      x: 600,
      y: 100,
      params: { aspectRatio: '16:9', resolution: '720p' },
    })
    const m = window.__plein.engine.doc.mutable(sequence)! as unknown as {
      set(key: string, value: unknown): void
    }
    m.set('results', [
      {
        id: 'real-output',
        runId: 'export-fixture',
        port: 'video',
        at: 1,
        value: { type: 'video', assetId },
      },
    ])
    m.set('adopted', 'real-output')
    m.set('deliveries', [
      {
        id: 'real-delivery',
        resultId: 'real-output',
        runId: 'export-fixture',
        assetId,
        kind: 'film',
        version: 'v1',
        createdAt: 1,
        width: 1280,
        height: 720,
        duration: 2,
        boardId: board,
        sources: [],
        notes: [],
        subtitleEvidence: {
          version: 1,
          basis: 'executed-sequence-spec',
          enabled: false,
          cues: [],
          assetId,
          resultId: 'real-output',
        },
      },
    ])
    return { board, sequence }
  }, assetId)
  await editGoal(page, '音轨存在不代表对白内容通过；不自动确认交付')
  await expect
    .poll(() =>
      page.evaluate(
        (id) => window.__plein.engine.doc.get(id)!.production?.goals?.length,
        ids.board,
      ),
    )
    .toBe(1)
  await openDelivery(page, ids.sequence)
  return { ...ids, assetId }
}

test('实际文件本地检查、目标改版历史、重新检查与刷新；交付确认不变且打开零执行', async ({
  page,
}, testInfo) => {
  const calls = watchRuns(page),
    f = await fixture(page)
  expect(calls).toEqual([])
  const before = await page.evaluate(
    (id) => window.__plein.engine.doc.get(id)!.deliveries,
    f.sequence,
  )
  await panel(page).getByRole('button', { name: '执行免费本地技术检查', exact: true }).click()
  await expect(panel(page).getByTestId('delivery-check-report')).toContainText('技术范围通过', {
    timeout: 30_000,
  })
  await expect(panel(page)).toContainText('不证明对白')
  await panel(page).screenshot({ path: testInfo.outputPath('technical-report-real-file.png') })
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)!.deliveries, f.sequence),
  ).toEqual(before)
  const video = page.getByLabel('实际导出 MP4', { exact: true })
  expect(await video.evaluate((element: HTMLVideoElement) => element.muted && element.paused)).toBe(
    true,
  )
  await page
    .getByRole('dialog', { name: '序列', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  await editGoal(page, '目标已修订，原技术报告不能自动满足新版')
  await openDelivery(page, f.sequence)
  await expect(panel(page)).toContainText('历史报告：不能作为当前输出／目标')
  await panel(page).screenshot({ path: testInfo.outputPath('technical-report-goal-changed.png') })
  await panel(page).getByRole('button', { name: '执行免费本地技术检查', exact: true }).click()
  await expect(panel(page).getByTestId('delivery-check-report')).toContainText(
    '当前输出与目标对应的报告',
    { timeout: 30_000 },
  )
  const localNodes = await page.evaluate(() =>
    [...window.__plein.engine.doc.elements()]
      .filter((el) => el.nodeType === 'plein/delivery-check')
      .map((el) => el.id),
  )
  expect(calls).toHaveLength(2)
  expect(calls.every((url) => localNodes.some((id) => url.includes(`/nodes/${id}/run`)))).toBe(true)
  await page.reload()
  await expect(page.getByTestId('creation-guide')).toBeVisible()
  await openDelivery(page, f.sequence)
  await expect(panel(page)).toContainText('当前输出与目标对应的报告')
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)!.deliveries, f.sequence),
  ).toEqual(before)
})

for (const kind of ['output', 'readonly'] as const)
  test(`预检等待期间${kind === 'output' ? '输出身份变化' : '升级只读'}拒绝迟到执行`, async ({
    page,
  }, testInfo) => {
    const calls = watchRuns(page),
      f = await fixture(page)
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => {
        enter = resolve
      }),
      held = new Promise<void>((resolve) => {
        release = resolve
      })
    await page.route('**/api/canvases/*/nodes/*/input', async (route) => {
      const response = await route.fetch()
      enter()
      await held
      await route.fulfill({ response })
    })
    await panel(page).getByRole('button', { name: '执行免费本地技术检查', exact: true }).click()
    await entered
    await page.evaluate(
      ({ id, kind }) => {
        const doc = window.__plein.engine.doc
        if (kind === 'readonly') {
          const mutable = doc as typeof doc & {
            meta: { set(key: string, value: unknown): void }
            schemaVersion: number
          }
          mutable.meta.set('schemaVersion', mutable.schemaVersion + 1)
        } else {
          const node = doc.mutable(id)! as unknown as {
            get(key: string): unknown
            set(key: string, value: unknown): void
          }
          node.set(
            'deliveries',
            (node.get('deliveries') as Array<Record<string, unknown>>).map((record) => ({
              ...record,
              assetId: 'f'.repeat(64),
            })),
          )
        }
      },
      { id: f.sequence, kind },
    )
    release()
    await expect(panel(page).getByRole('alert')).toContainText(
      kind === 'output' ? '输出或目标版本已变化' : '未开始本地检查',
    )
    expect(calls).toEqual([])
    expect(
      await page.evaluate(() =>
        [...window.__plein.engine.doc.elements()]
          .filter((el) => el.nodeType === 'plein/delivery-check')
          .every((el) => !el.run),
      ),
    ).toBe(true)
    await panel(page).screenshot({ path: testInfo.outputPath(`technical-check-late-${kind}.png`) })
  })

test('四类报告状态与缺音频覆盖说明可读，受控UI夹具不代替真实技术测试', async ({
  page,
}, testInfo) => {
  const calls = watchRuns(page),
    f = await fixture(page)
  await page.evaluate(({ board, sequence, assetId }) => {
    const doc = window.__plein.engine.doc,
      goal = doc.get(board)!.production!.goals![0]!
    const record = doc.get(sequence)!.deliveries![0]!
    const canvasId = decodeURIComponent(location.hash.split('/c/')[1]!.split('?')[0]!)
    const request = {
      scope: { canvasId, boardId: board, sequenceId: sequence },
      deliveryId: record.id,
      runId: record.runId,
      resultId: record.resultId,
      source: { assetId, kind: 'video', mime: 'video/mp4' },
      goal: { id: goal.id, snapshot: goal.snapshot },
      subtitles: record.subtitleEvidence,
    }
    const rules = {
      version: 1,
      durationTolerance: 0.05,
      blackSeconds: 0.5,
      blackPixel: 0.1,
      blackRatio: 0.98,
      silenceDb: -50,
      silenceSeconds: 0.5,
    }
    for (const [i, status] of ['passed', 'issues', 'unchecked', 'failed'].entries()) {
      const id = window.__plein.addNode({
        type: 'plein/delivery-check',
        name: `受控UI ${status}`,
        x: 1000,
        y: i * 200,
        params: { request },
      })
      const report = {
        format: 'plein-delivery-check',
        version: 1,
        at: i + 2,
        request,
        rules,
        engine: '受控UI夹具，非实际检查',
        status,
        checks: [
          'source',
          'decode',
          'spec',
          'duration',
          'audio',
          'subtitles',
          'black',
          'silence',
        ].map((id) => ({ id, status, detail: `只验证界面 ${status}` })),
        observed: {
          sha256: assetId,
          complete: status === 'passed' || status === 'issues',
          width: 1280,
          height: 720,
          duration: 2,
          decodedFrames: status === 'passed' || status === 'issues' ? 20 : 0,
          audioTracks: 1,
          audioDecoded: true,
          audioUncovered: status === 'unchecked' ? [{ start: 0, end: 0.5 }] : [],
          black: [],
          silence: [],
        },
        unchecked: ['受控UI夹具，仅验证展示，不是实际文件技术验收；内容仍需人工核对。'],
      }
      const m = doc.mutable(id)! as unknown as { set(key: string, value: unknown): void }
      m.set('results', [
        {
          id: `report-${status}`,
          port: 'report',
          runId: `fixture-${status}`,
          at: i + 2,
          value: { type: 'json', value: report },
        },
      ])
      m.set('adopted', `report-${status}`)
    }
  }, f)
  for (const [state, label] of [
    ['passed', '通过'],
    ['issues', '问题'],
    ['unchecked', '未检查'],
    ['failed', '检查失败'],
  ]) {
    await panel(page)
      .getByRole('combobox', { name: '技术报告版本', exact: true })
      .selectOption(`report-${state}`)
    await expect(panel(page).getByTestId('delivery-check-report')).toContainText(`技术范围${label}`)
    if (state === 'unchecked')
      await expect(panel(page)).toContainText('音频样本未覆盖区间（未检查）')
    await panel(page).screenshot({ path: testInfo.outputPath(`technical-state-${state}.png`) })
  }
  expect(calls).toEqual([])
})
