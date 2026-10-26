import { expect, test, type Page } from '@playwright/test'
import { clickElement, newProject, revealGenerator, waitNode } from './canvas'

const canvasId = (page: Page) => decodeURIComponent(page.url().split('#/c/')[1]!.split('?')[0]!)
async function run(page: Page, id: string) {
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

test('资产库新版经过差异审阅同步，固定卡片不被后续保存覆盖', async ({ page }, testInfo) => {
  await newProject(page)
  const created = await page.request.post('/api/library', {
    data: { kind: 'character', name: '版本角色', description: '新版白色外套' },
  })
  expect(created.status()).toBe(201)
  const item = (await created.json()) as { id: string }
  const id = await page.evaluate(
    ({ libraryId }) =>
      window.__plein.addNode({
        type: 'plein/character',
        name: '版本角色',
        x: 300,
        y: 200,
        params: { libraryId, description: '旧版黑色外套' },
      }),
    { libraryId: item.id },
  )
  await clickElement(page, id)
  await page
    .getByTestId('generator')
    .getByRole('button', { name: /编辑档案|添加时期、服饰、表情/ })
    .click()
  const library = page.getByRole('dialog', { name: '资产库', exact: true })
  await library.getByRole('button', { name: '查看画布中的版本' }).click()
  const updates = library.getByRole('region', { name: '跨画布资产更新' })
  await expect(updates.getByText('设定', { exact: true })).toBeVisible()
  await updates.locator('summary').click()
  await expect(updates.getByText('旧版黑色外套', { exact: true })).toBeVisible()
  await expect(updates.getByText('新版白色外套', { exact: true })).toBeVisible()
  await library.screenshot({ path: testInfo.outputPath('library-updates.png') })
  await updates.getByRole('button', { name: '同步选中的字段' }).click()
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.description, id))
    .toBe('新版白色外套')
  await updates.getByRole('button', { name: '固定当前版本', exact: true }).click()
  // 操作结果和随后自动刷新差异的“正在读取”是两条状态，读取慢时会同时出现。
  await expect(updates.getByRole('status').filter({ hasText: '已固定当前卡片版本' })).toBeVisible()
  await expect(updates.getByRole('button', { name: '解除固定', exact: true })).toBeVisible()
  expect(
    (
      await page.request.patch(`/api/library/${item.id}`, {
        data: { description: '另一版红色外套' },
      })
    ).status(),
  ).toBe(200)
  await updates.getByRole('button', { name: '刷新差异' }).click()
  // 读取期间整组按钮本来就禁用，读完新差异后仍禁用才说明是固定挡住了同步。
  await expect(updates.getByText('正在读取差异…')).toHaveCount(0)
  // 刷新后详情收起，新值在折叠区里
  await expect(updates.getByText('另一版红色外套', { exact: true })).toBeAttached()
  await expect(updates.getByRole('button', { name: '同步选中的字段' })).toBeDisabled()
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.description, id),
  ).toBe('新版白色外套')
})

test('视频与音频参考进入实际输入，图片精修生成新候选保留原图', async ({ page }) => {
  await newProject(page)
  const sources = await page.evaluate(() => [
    window.__plein.addNode({
      type: 'plein/image',
      name: '精修原图',
      params: { model: 'plein/mock:image', prompt: '原图' },
      x: 0,
      y: 0,
    }),
    window.__plein.addNode({
      type: 'plein/video',
      name: '动作参考',
      params: { model: 'plein/mock:video', prompt: '动作' },
      x: 0,
      y: 450,
    }),
    window.__plein.addNode({
      type: 'plein/speech',
      name: '声音参考',
      params: { model: 'plein/mock:audio', text: '你好' },
      x: 0,
      y: 900,
    }),
  ])
  for (const id of sources) await run(page, id)
  const targets = await page.evaluate((sources) => {
    const video = window.__plein.addNode({
      type: 'plein/video',
      name: '多模态镜头',
      params: { model: 'plein/mock:video', prompt: '沿用动作和声音', mode: 'reference' },
      x: 500,
      y: 300,
    })
    const process = window.__plein.addNode({
      type: 'plein/image-process',
      name: 'AI 精修结果',
      params: { model: 'plein/mock:image-process', operation: 'upscale' },
      x: 500,
      y: 800,
    })
    for (const [from, output, to, input] of [
      [sources[0], 'images', video, 'images'],
      [sources[1], 'video', video, 'videos'],
      [sources[2], 'audio', video, 'audios'],
      [sources[0], 'images', process, 'image'],
    ] as string[][]) {
      if (!window.__plein.connect([from!, output!], [to!, input!]))
        throw new Error('reference connection failed')
    }
    return { video, process }
  }, sources)
  await expect
    .poll(async () => {
      const res = await page.request.get(
        `/api/canvases/${canvasId(page)}/nodes/${targets.video}/input`,
      )
      const input = (await res.json()) as {
        status?: string
        inputs?: Record<string, Array<{ type: string }>>
      }
      return (
        input.status === 'ready' &&
        input.inputs?.videos?.[0]?.type === 'video' &&
        input.inputs?.audios?.[0]?.type === 'audio'
      )
    })
    .toBe(true)
  await clickElement(page, targets.video)
  // 编辑器固定在卡片下方，先把它移进窗口再点里面的控件
  await revealGenerator(page)
  const generator = page.getByTestId('generator')
  await generator.getByRole('button', { name: /实际输入/ }).click()
  await expect(generator.getByText(/视频 ·/).first()).toBeVisible()
  await expect(generator.getByText(/音频 ·/).first()).toBeVisible()
  await run(page, targets.video)
  await run(page, targets.process)
  const state = await page.evaluate(
    ({ source, target }) => ({
      source: window.__plein.engine.doc.get(source)?.results?.[0]?.value,
      target: window.__plein.engine.doc.get(target)?.results?.[0]?.value,
    }),
    { source: sources[0]!, target: targets.process },
  )
  expect(state.source?.type).toBe('image')
  expect(state.target?.type).toBe('image')
  expect(state.target?.assetId).not.toBe(state.source?.assetId)
})

test(
  '本机数据页显示空间、备份状态并能创建恢复副本',
  { tag: '@core' },
  async ({ page }, testInfo) => {
    await page.goto('/')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: '数据', exact: true }).click()
    await expect(settings.getByText(/自动备份/).first()).toBeVisible()
    await settings.getByRole('button', { name: '立即备份', exact: true }).click()
    await expect(
      settings.getByRole('button', { name: '恢复副本', exact: true }).first(),
    ).toBeVisible()
    await settings.screenshot({ path: testInfo.outputPath('data-maintenance.png') })
    await settings.getByRole('button', { name: '恢复副本', exact: true }).first().click()
    await expect(settings.getByText(/副本|恢复/).last()).toBeVisible()
  },
)
