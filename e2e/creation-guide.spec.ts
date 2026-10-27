import { expect, test, type Page } from './fixtures'
import { addNode, newProject, showStoryboardCards, waitEngine, waitNode } from './canvas'

const canvasId = (page: Page) => decodeURIComponent(page.url().split('#/c/')[1]!.split('?')[0]!)
const guide = (page: Page) => page.getByTestId('creation-guide')
const stage = (page: Page, id: string) => guide(page).locator(`[data-guide-step="${id}"]`)
const watchSubmissions = (page: Page) => {
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/(?:run|run-flow|run-batch)(?:\?|$)/.test(request.url()))
      requests.push(request.url())
  })
  return requests
}
async function seedBoard(page: Page, name: string, count = 1) {
  return page.evaluate(
    ({ name, count }) =>
      window.__plein.addNode({
        type: 'plein/storyboard',
        name,
        x: 100,
        y: 200,
        params: {
          shots: Array.from({ length: count }, (_, i) => ({
            id: `${name}-${i}`,
            no: i + 1,
            duration: 5,
            shotSize: '中景',
            description: `${name}画面${i + 1}`,
            characters: [],
            emotion: '',
            lighting: '',
            sfx: '',
            dialogue: [],
            imagePrompt: '测试构图',
            motionPrompt: '缓慢推近',
          })),
        },
      }),
    { name, count },
  )
}
async function runMock(page: Page, id: string) {
  await expect
    .poll(async () =>
      (await page.request.get(`/api/canvases/${canvasId(page)}/nodes/${id}/input`)).status(),
    )
    .toBe(200)
  expect(
    (
      await page.request.post(`/api/canvases/${canvasId(page)}/nodes/${id}/run`, { data: {} })
    ).status(),
  ).toBe(202)
  await waitNode(page, id)
}

test('模板后持续显示六步；定位梗概和分镜零提交，收起刷新后保持', async ({ page }, testInfo) => {
  await newProject(page)
  await expect(guide(page)).toHaveCount(0)
  const submitted = watchSubmissions(page)
  await addNode(page, '短剧')
  await expect(guide(page)).toBeVisible()
  await expect(guide(page).locator('[data-guide-step]')).toHaveCount(6)
  await stage(page, 'brief').getByRole('button').click()
  await expect(page.locator('.plein-md-editor')).toBeVisible()
  await page.keyboard.press('Escape')
  await stage(page, 'storyboard').getByRole('button').click()
  await expect(page.getByRole('dialog', { name: '分镜表', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await guide(page).getByRole('button', { name: '收起创作引导' }).click()
  await page.reload()
  await waitEngine(page)
  await expect(page.getByRole('button', { name: '展开创作引导' })).toBeVisible()
  await expect(guide(page).locator('[data-guide-step]')).toHaveCount(0)
  await page.getByRole('button', { name: '展开创作引导' }).click()
  await expect(guide(page).locator('[data-guide-step]')).toHaveCount(6)
  await guide(page).screenshot({ path: testInfo.outputPath('persistent-creation-guide.png') })
  expect(submitted).toEqual([])
})

test('多分镜显式选择，只定位选中的表，不猜一份也不自动提交', async ({ page }) => {
  await newProject(page)
  await seedBoard(page, '第一分镜')
  await seedBoard(page, '第二分镜')
  const submitted = watchSubmissions(page)
  await expect(guide(page)).toContainText('画布有多份分镜')
  await expect(guide(page).locator('[data-guide-step]')).toHaveCount(0)
  await guide(page).getByRole('combobox', { name: '创作引导分镜' }).click()
  await page.getByRole('option', { name: '第二分镜', exact: true }).click()
  await stage(page, 'storyboard').getByRole('button').click()
  const editor = page.getByRole('dialog', { name: '分镜表', exact: true })
  await expect(editor.getByLabel('画面', { exact: true }).first()).toHaveValue('第二分镜画面1')
  await page.keyboard.press('Escape')
  expect(submitted).toEqual([])
})

test('明确核对当前分镜后改计划，持续引导立即回到待检查', async ({ page }) => {
  await newProject(page)
  await seedBoard(page, '计划变更')
  await guide(page).getByRole('button', { name: '我已人工核对这份分镜' }).click()
  await expect(stage(page, 'storyboard')).toHaveAttribute('data-guide-state', 'done')
  await stage(page, 'storyboard').getByRole('button').click()
  const editor = page.getByRole('dialog', { name: '分镜表', exact: true })
  // 逐镜头字段在详细卡片视图上
  await showStoryboardCards(editor)
  await editor.getByLabel('画面', { exact: true }).first().fill('协作修改后的新画面')
  await editor.getByLabel('运动提示词', { exact: true }).first().click()
  await page.keyboard.press('Escape')
  await expect(stage(page, 'storyboard')).toHaveAttribute('data-guide-state', 'attention')
  await expect(stage(page, 'storyboard')).toContainText('计划或确认范围已变化')
})

test('mock产物完成不等于人工通过，审片后换候选重新待审', async ({ page }) => {
  await newProject(page)
  const board = await seedBoard(page, '样片审片')
  const nodes = await page.evaluate(
    (board) =>
      ['image', 'video'].map((role) =>
        window.__plein.addNode({
          type: `plein/${role}`,
          name: `样片-${role}`,
          x: 600,
          y: role === 'image' ? 0 : 500,
          params: {
            model: `plein/mock:${role}`,
            prompt: '测试样片',
            source: { storyboard: board, shot: '样片审片-0', role },
          },
        }),
      ),
    board,
  )
  for (const id of nodes) await runMock(page, id)
  await expect(stage(page, 'trial')).toHaveAttribute('data-guide-state', 'done')
  await expect(stage(page, 'review')).toHaveAttribute('data-guide-state', 'ready')
  for (const id of nodes) {
    await stage(page, 'review').getByRole('button').click()
    const review = page.locator(`[data-review-node="${id}"]`)
    await expect(review).toBeVisible()
    await review.locator('summary').click()
    await review.getByRole('button', { name: '保存为可用', exact: true }).click()
    await page.keyboard.press('Escape')
  }
  await expect(stage(page, 'review')).toHaveAttribute('data-guide-state', 'done')
  // 新候选复用真实mock素材，只改变候选身份；不触发额外submit。
  const submitted = watchSubmissions(page)
  await page.evaluate((id) => {
    const doc = window.__plein.engine.doc
    const el = doc.get(id)!,
      previous = el.results![0]!
    const map = doc.mutable(id) as unknown as { set(key: string, value: unknown): void }
    map.set('results', [
      {
        ...previous,
        id: 'e2e-next-candidate',
        runId: 'e2e-next-run',
        port: 'video',
        at: Date.now(),
      },
      ...el.results!,
    ])
    map.set('adopted', 'e2e-next-candidate')
  }, nodes[1]!)
  await expect(stage(page, 'review')).toHaveAttribute('data-guide-state', 'ready')
  expect(submitted).toEqual([])
})
