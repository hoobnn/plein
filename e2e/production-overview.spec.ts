import { expect, type Page, test } from './fixtures'
import { newProject, waitEngine } from './canvas'

const guide = (page: Page) => page.getByTestId('creation-guide')
const overview = (page: Page) => page.getByTestId('production-overview')
const canvasId = (page: Page) => decodeURIComponent(page.url().split('#/c/')[1]!.split('?')[0]!)
const watch = (page: Page) => {
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
async function seed(page: Page, sequences = 0) {
  await newProject(page)
  return page.evaluate((sequences) => {
    const board = window.__plein.addNode({
      type: 'plein/storyboard',
      name: '目标分镜',
      x: 100,
      y: 100,
      params: { shots: [{ id: 'one', no: 1, duration: 8, description: '清楚交接红信封' }] },
    })
    const video = window.__plein.addNode({
      type: 'plein/video',
      name: '代表镜头视频',
      x: 500,
      y: 100,
      params: { source: { storyboard: board, shot: 'one', role: 'video' } },
    })
    const films: string[] = []
    for (let i = 0; i < sequences; i++) {
      const id = window.__plein.addNode({
        type: 'plein/sequence',
        name: `目标成片${i + 1}`,
        x: 900,
        y: i * 200,
        params: {},
      })
      if (!window.__plein.connect([video, 'video'], [id, 'clips']))
        throw new Error('fixture connection')
      films.push(id)
    }
    return { board, video, films }
  }, sequences)
}
const openEditor = async (page: Page) => {
  await overview(page).getByText('编辑制作目标', { exact: true }).click()
  await overview(page).getByRole('button', { name: '填写或修订制作目标', exact: true }).click()
}
const inspect = (page: Page, board: string) =>
  page.evaluate((id) => window.__plein.engine.doc.get(id)!.production?.goals ?? [], board)

test('目标保存、修订、撤销和刷新保留独立版本，不把目标文字判为创作通过', async ({
  page,
}, testInfo) => {
  const calls = watch(page)
  const f = await seed(page)
  await expect(overview(page)).toContainText('尚未保存这个范围')
  await openEditor(page)
  await overview(page).getByRole('combobox', { name: '目标画幅', exact: true }).selectOption('16:9')
  await overview(page)
    .getByRole('combobox', { name: '目标字幕要求', exact: true })
    .selectOption('required')
  await overview(page).getByRole('spinbutton', { name: '目标最短时长' }).fill('6')
  await overview(page).getByRole('spinbutton', { name: '目标最长时长' }).fill('10')
  await overview(page)
    .getByRole('textbox', { name: '文字创作要求' })
    .fill('交接动作清楚，人物关系可信')
  await overview(page).getByRole('button', { name: '保存目标新版本', exact: true }).click()
  await expect.poll(async () => (await inspect(page, f.board)).length).toBe(1)
  const first = (await inspect(page, f.board))[0]!
  await expect(overview(page)).toContainText('文字要求需人工审看')
  await overview(page).getByRole('button', { name: '填写或修订制作目标', exact: true }).click()
  await overview(page).getByRole('textbox', { name: '文字创作要求' }).fill('保留风声')
  await overview(page).getByRole('button', { name: '保存目标新版本', exact: true }).click()
  await expect.poll(async () => (await inspect(page, f.board)).length).toBe(2)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(async () => (await inspect(page, f.board)).length).toBe(1)
  expect((await inspect(page, f.board))[0]).toEqual(first)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await page.reload()
  await waitEngine(page)
  await expect(overview(page)).toContainText('保留风声')
  await overview(page).getByText('制作目标历史（2）', { exact: true }).click()
  await expect(overview(page).getByRole('list', { name: '制作目标历史' })).toContainText(first.id)
  await overview(page).screenshot({ path: testInfo.outputPath('production-goal-history.png') })
  expect(calls).toEqual([])
})

test('多个序列不借用目标，删除后同名替换不继承，旧编辑回调拒绝保存', async ({ page }, testInfo) => {
  const calls = watch(page)
  const f = await seed(page, 2)
  await expect(overview(page)).toContainText('交付序列尚未明确')
  await guide(page).getByRole('combobox', { name: '创作引导交付序列', exact: true }).click()
  await page.getByRole('option', { name: '目标成片1', exact: true }).click()
  await openEditor(page)
  await overview(page).getByRole('textbox', { name: '文字创作要求' }).fill('成片1目标')
  await overview(page).getByRole('button', { name: '保存目标新版本', exact: true }).click()
  await guide(page).getByRole('combobox', { name: '创作引导交付序列', exact: true }).click()
  await page.getByRole('option', { name: '目标成片2', exact: true }).click()
  await expect(overview(page)).toContainText('尚未保存这个范围')
  await openEditor(page)
  await overview(page).getByRole('textbox', { name: '文字创作要求' }).fill('不能写入已删目标')
  await overview(page)
    .getByRole('button', { name: '保存目标新版本', exact: true })
    .evaluate((button, id) => {
      const engine = window.__plein.engine as typeof window.__plein.engine & {
        deleteSelection(): void
      }
      engine.selection.set([id])
      engine.deleteSelection()
      ;(button as HTMLButtonElement).click()
    }, f.films[1]!)
  expect(await inspect(page, f.board)).toHaveLength(1)
  await expect(overview(page)).toContainText('交付序列尚未明确')
  await overview(page).screenshot({ path: testInfo.outputPath('production-deleted-scope.png') })
  expect(calls).toEqual([])
})

test('只读同帧升级拒绝旧保存，恢复任务和未采用候选分别可见且零提交', async ({ page }, testInfo) => {
  const calls = watch(page)
  const f = await seed(page)
  await page.route('**/api/canvases/*/jobs/latest', (route) =>
    route.fulfill({
      json: {
        jobs: [
          {
            id: 'unknown-job',
            nodeId: f.video,
            nodeType: 'plein/video',
            status: 'failed',
            attempts: 1,
            createdAt: 1,
            recovery: { state: 'submit_unknown' },
          },
        ],
      },
    }),
  )
  await page.evaluate((id) => {
    const m = window.__plein.engine.doc.mutable(id)! as unknown as {
      set(key: string, value: unknown): void
    }
    m.set('results', [
      {
        id: 'candidate-only',
        runId: 'mock-run',
        port: 'video',
        at: 1,
        value: { type: 'video', assetId: 'a'.repeat(64) },
      },
    ])
    m.set('adopted', null)
  }, f.video)
  await overview(page)
    .getByText(/阻塞、待审与任务/)
    .click()
  await expect(overview(page)).toContainText('提交结果未知')
  await expect(overview(page)).toContainText('已有产物，等待选择采用')
  await expect(overview(page).getByLabel('制作事实统计')).toContainText('已采用 0/1')
  await openEditor(page)
  await overview(page).getByRole('textbox', { name: '文字创作要求' }).fill('旧回调')
  await overview(page)
    .getByRole('button', { name: '保存目标新版本', exact: true })
    .evaluate((button) => {
      const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
        schemaVersion: number
        meta: { set(key: string, value: unknown): void }
      }
      doc.meta.set('schemaVersion', doc.schemaVersion + 1)
      ;(button as HTMLButtonElement).click()
    })
  expect(await inspect(page, f.board)).toHaveLength(0)
  await expect(guide(page).getByRole('alert')).toContainText('当前只读')
  await overview(page).screenshot({ path: testInfo.outputPath('production-readonly-recovery.png') })
  expect(calls).toEqual([])
})

test('当前项目画布索引只导航现有画布，不自动读取其他画布制作状态或生成', async ({
  page,
}, testInfo) => {
  const calls = watch(page)
  await seed(page)
  const canvas = await (await page.request.get(`/api/canvases/${canvasId(page)}`)).json()
  const other = await (
    await page.request.post('/api/canvases', {
      data: { projectId: canvas.projectId, title: '另一集制作画布' },
    })
  ).json()
  await overview(page).getByText('当前项目的画布', { exact: true }).click()
  const index = overview(page).getByRole('list', { name: '制作画布索引' })
  await expect(index.getByRole('link', { name: '另一集制作画布', exact: true })).toHaveAttribute(
    'href',
    `#/c/${other.id}`,
  )
  await overview(page).screenshot({ path: testInfo.outputPath('production-canvas-index.png') })
  await index.getByRole('link', { name: '另一集制作画布', exact: true }).click()
  await expect.poll(() => canvasId(page)).toBe(other.id)
  await waitEngine(page)
  expect(calls).toEqual([])
})

test('空态、进行中、失败与当前成片确认分别由实际文档和任务夹具驱动', async ({ page }, testInfo) => {
  const calls = watch(page)
  const f = await seed(page, 1)
  await expect(overview(page).getByLabel('制作事实统计')).toContainText('已有产物 0/1')
  await overview(page).screenshot({ path: testInfo.outputPath('production-empty.png') })
  await page.evaluate(
    (id) =>
      (
        window.__plein.engine.doc.mutable(id)! as unknown as {
          set(key: string, value: unknown): void
        }
      ).set('run', { id: 'local-running', status: 'running', at: 1 }),
    f.video,
  )
  await expect(overview(page).getByLabel('制作事实统计')).toContainText('进行中 1')
  await overview(page).screenshot({ path: testInfo.outputPath('production-working.png') })
  await page.route('**/api/canvases/*/jobs/latest', (route) =>
    route.fulfill({
      json: {
        jobs: [
          {
            id: 'local-running',
            nodeId: f.video,
            nodeType: 'plein/video',
            status: 'failed',
            attempts: 1,
            createdAt: 1,
            recovery: { state: 'remote_failed' },
          },
        ],
      },
    }),
  )
  await page.evaluate(
    (id) =>
      (
        window.__plein.engine.doc.mutable(id)! as unknown as {
          set(key: string, value: unknown): void
        }
      ).set('run', { id: 'local-running', status: 'failed', at: 1 }),
    f.video,
  )
  await overview(page)
    .getByText(/阻塞、待审与任务/)
    .click()
  await expect(overview(page)).toContainText('上次任务失败')
  await overview(page).screenshot({ path: testInfo.outputPath('production-failed.png') })
  await page.evaluate(
    ({ video, sequence }) => {
      const doc = window.__plein.engine.doc as unknown as {
        mutable(id: string): { set(key: string, value: unknown): void }
      }
      const assetId = 'b'.repeat(64)
      const current = {
        id: 'video-candidate',
        runId: 'video-run',
        port: 'video',
        at: 1,
        value: { type: 'video', assetId },
      }
      doc.mutable(video)!.set('results', [current])
      doc.mutable(video)!.set('adopted', current.id)
      doc.mutable(video)!.set('reviews', [
        {
          target: { kind: 'video', assetId, resultId: current.id },
          status: 'usable',
          tags: [],
          note: '受控夹具',
          at: 2,
        },
      ])
      doc.mutable(video)!.set('run', { id: 'video-run', status: 'succeeded', at: 2 })
      const output = { ...current, id: 'film-candidate', runId: 'film-run' }
      doc.mutable(sequence)!.set('results', [output])
      doc.mutable(sequence)!.set('adopted', output.id)
      doc.mutable(sequence)!.set('deliveries', [
        {
          id: 'film-delivery',
          resultId: output.id,
          runId: output.runId,
          assetId,
          kind: 'film',
          version: 'v1',
          createdAt: 1,
          width: 1080,
          height: 1920,
          duration: 8,
          sources: [],
          notes: [],
          confirmedAt: 3,
        },
      ])
    },
    { video: f.video, sequence: f.films[0]! },
  )
  await expect(overview(page).getByLabel('制作事实统计')).toContainText('人工可用 1/1')
  await expect(overview(page).getByLabel('制作事实统计')).toContainText('已交付 当前成片已确认')
  await expect(overview(page)).toContainText('目标修订不表示已有候选')
  await overview(page).screenshot({ path: testInfo.outputPath('production-current-delivery.png') })
  expect(calls).toEqual([])
})
