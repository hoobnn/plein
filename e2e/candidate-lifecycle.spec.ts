import { expect, test, type Page } from './fixtures'
import {
  centerOf,
  clickElement,
  newProject,
  revealGenerator,
  waitEngine,
  waitNode,
  zoomTo,
} from './canvas'

test(
  '首次生成期间修改输入，结果只进候选，查看采用及撤销刷新不隐式生效',
  { tag: '@core' },
  async ({ page, context }) => {
    await newProject(page)
    const config = '/api/providers/plein/mock/config'
    const original = await (await page.request.get(config)).json()
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/image',
        name: '首次待采用候选',
        params: { prompt: '透明水杯', model: 'plein/mock:image' },
        x: 400,
        y: 200,
      }),
    )
    try {
      expect(
        (
          await page.request.put(config, {
            data: { settings: { ...original.settings, latencyMs: 3000 } },
          })
        ).ok(),
      ).toBe(true)
      await clickElement(page, id)
      // 编辑器固定在卡片下方，先把它移进窗口再点生成
      await revealGenerator(page)
      const generator = page.getByTestId('generator')
      await generator.getByRole('button', { name: '生成', exact: true }).click()
      await expect(generator.getByRole('button', { name: '取消', exact: true })).toBeEnabled()
      await generator.getByRole('textbox', { name: '提示词', exact: true }).fill('改为陶瓷水杯')
      await waitNode(page, id)
      const adopted = () => page.evaluate((id) => window.__plein.engine.doc.get(id)?.adopted, id)
      await expect.poll(adopted).toBeNull()
      await expect(page.locator('.plein-node-status')).toHaveText('待采用')
      await expect(
        page.locator('.plein-node').getByText('1 个候选待采用，当前没有生效的结果'),
      ).toBeVisible()
      await page
        .locator('.plein-node')
        .screenshot({ path: test.info().outputPath('held-first-candidate.png') })
      const open = () => page.getByRole('button', { name: '查看待采用候选', exact: true }).click()
      await open()
      const viewer = page.getByRole('dialog', { name: '查看「首次待采用候选」', exact: true })
      await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
      const chosen = await adopted()
      expect(typeof chosen).toBe('string')
      await viewer.getByRole('button', { name: '关闭', exact: true }).click()
      await page.getByRole('button', { name: '撤销', exact: true }).click()
      await expect.poll(adopted).toBeNull()
      await page.reload()
      await waitEngine(page)
      await expect.poll(adopted).toBeNull()
      await open()
      await expect(viewer.getByRole('button', { name: '采用此候选', exact: true })).toBeEnabled()
      await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
      await expect.poll(adopted).toBe(chosen)
      await viewer.getByRole('button', { name: '关闭', exact: true }).click()
      await page.getByRole('button', { name: '撤销', exact: true }).click()
      await expect.poll(adopted).toBeNull()

      // 真实剪贴板跨画布保留待采用状态；连线不能让下游隐式使用候选。
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      await page.evaluate((id) => window.__plein.engine.selection.set([id]), id)
      await page.keyboard.press('ControlOrMeta+c')
      await newProject(page)
      await page.keyboard.press('ControlOrMeta+v')
      const copied = () =>
        page.evaluate(() =>
          [...window.__plein.engine.doc.elements()].find((el) => el.name === '首次待采用候选'),
        )
      await expect.poll(async () => (await copied())?.adopted).toBeNull()
      const source = (await copied())!
      expect(source.results?.[0]?.id).toBe(chosen)
      await expect(page.locator('.plein-node-status')).toHaveText('待采用')
      const downstream = await page.evaluate((source) => {
        const id = window.__plein.addNode({
          type: 'plein/image',
          name: '下游图片',
          params: { model: 'plein/mock:image', prompt: '保持参考素材' },
          x: 1000,
          y: 200,
        })
        window.__plein.connect([source, 'images'], [id, 'references'])
        window.__plein.engine.zoomToFit()
        return id
      }, source.id)
      await clickElement(page, downstream)
      // 编辑器固定在卡片下方，先把它移进窗口再操作里面的控件
      await revealGenerator(page)
      const preview = page.getByTestId('input-preview')
      await preview.getByRole('button', { name: /实际输入/ }).click()
      await expect(generator).toContainText('有候选待采用，请先查看并采用结果')
      await expect(generator.getByRole('button', { name: '生成', exact: true })).toBeDisabled()
      await generator.screenshot({ path: test.info().outputPath('held-upstream-input.png') })
      await generator
        .getByRole('button', { name: '「首次待采用候选」有候选待采用，点击定位来源', exact: true })
        .click()
      await page.getByRole('button', { name: '查看待采用候选', exact: true }).click()
      await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
      await viewer.getByRole('button', { name: '关闭', exact: true }).click()
      await page.evaluate(() => window.__plein.engine.zoomToFit())
      await clickElement(page, downstream)
      await expect(generator).not.toContainText('有候选待采用')
      await expect(generator.getByRole('button', { name: '生成', exact: true })).toBeEnabled()
      const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
      const input = await (
        await page.request.get(`/api/canvases/${canvas}/nodes/${downstream}/input`)
      ).json()
      expect(input.inputs.references).toMatchObject([
        { type: 'image', assetId: source.results![0]!.value.assetId, source: source.id },
      ])
      await page.getByRole('button', { name: '故事板', exact: true }).click()
      await page.getByRole('button', { name: '查看首次待采用候选', exact: true }).click()
      await expect(viewer.getByRole('button', { name: '已采用', exact: true })).toBeVisible()
      await viewer.getByRole('button', { name: '关闭', exact: true }).click()
    } finally {
      await page.request.put(config, { data: { settings: original.settings } })
    }
  },
)

async function mentionFixture(page: Page) {
  await newProject(page)
  const ids = await page.evaluate(() => {
    const target = window.__plein.addNode({
      type: 'plein/character',
      name: '小岚',
      params: {},
      x: -800,
      y: 0,
    })
    const text = window.__plein.addNode({
      type: 'plein/text',
      name: '引用正文',
      params: { text: '清晨，@小岚 走进院子。\n联系 test@example.com。' },
      x: 0,
      y: 0,
    })
    return { target, text }
  })
  await page.getByRole('button', { name: '故事板', exact: true }).click()
  const card = page.getByRole('region', { name: '文本', exact: true }).locator('.board-text')
  await expect(card).toBeVisible()
  await page.waitForFunction(() => !document.documentElement.dataset.viewSlide)
  return { ids, card }
}

test('两行摘要被截掉的引用不进入键盘导航，展开和还原分栏后重新判断 @core', async ({ page }) => {
  const { ids, card } = await mentionFixture(page)
  await page.evaluate((id) => {
    const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
      set(key: string, value: unknown): void
    }
    params.set('text', '@小岚 第一行\n第二行\n@小岚 第三行')
  }, ids.text)
  const marks = card.locator('mark')
  await expect(marks).toHaveCount(2)
  await expect(marks.nth(0)).not.toHaveAttribute('inert', '')
  await expect(marks.nth(1)).toHaveAttribute('inert', '')
  const title = card.getByRole('button', { name: '引用正文', exact: true })
  await title.focus()
  await page.keyboard.press('Tab')
  await expect(marks.nth(0)).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(marks.nth(1)).not.toBeFocused()
  const column = page.getByRole('region', { name: '文本', exact: true })
  await column.getByRole('button', { name: '展开此栏', exact: true }).click()
  await expect(marks.nth(1)).toHaveAttribute('inert', '')
  await column.getByRole('button', { name: '还原分栏', exact: true }).click()
  await expect(marks.nth(1)).toHaveAttribute('inert', '')
  await expect(card.getByRole('button')).toHaveCount(2)
  await page.evaluate((id) => {
    const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
      set(key: string, value: unknown): void
    }
    params.set('text', '说明'.repeat(35) + ' @小岚')
  }, ids.text)
  await expect(marks).toHaveCount(1)
  await expect(marks).not.toHaveAttribute('inert', '')
  await marks.focus()
  await page.setViewportSize({ width: 420, height: 900 })
  await expect(marks).toHaveAttribute('inert', '')
  await expect(title).toBeFocused()
  await page.evaluate(
    (id) =>
      (
        window.__plein.engine.doc.mutable(id) as unknown as {
          set(key: string, value: unknown): void
        }
      ).set('name', '小岚新名字'),
    ids.target,
  )
  await expect(marks).toHaveAttribute('data-state', 'missing')
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(marks).not.toHaveAttribute('inert', '')
  await expect(marks).toHaveAttribute('aria-hidden', 'false')
  await expect(marks).not.toHaveAttribute('role', 'button')
})

const positions = {
  A: { x: 0, y: 120 },
  B: { x: 100, y: 60 },
  C: { x: 200, y: 0 },
  D: { x: 0, y: 600 },
}
type Name = keyof typeof positions
async function readingFixture(page: Page, order: Name[]) {
  await newProject(page)
  return page.evaluate(
    ({ order, positions }) =>
      Object.fromEntries(
        order.map((name) => [
          name,
          window.__plein.addNode({ type: 'plein/text', name, params: {}, ...positions[name] }),
        ]),
      ),
    { order, positions },
  )
}
const titles = (page: Page) =>
  page.getByRole('region', { name: '文本', exact: true }).locator('.board-text')

test('真实拖动节点到前一行，故事板重排且撤销恢复原顺序 @core', async ({ page }) => {
  const ids = await readingFixture(page, ['C', 'B', 'A', 'D'])
  await zoomTo(page, Object.values(ids))
  const from = await centerOf(page, ids.D!)
  const to = await page.evaluate((id) => {
    const engine = window.__plein.engine
    const rect = engine.doc.worldRect(id)
    const doc = engine.doc as typeof engine.doc & { undo: { stopCapturing(): void } }
    doc.undo.stopCapturing()
    return engine.worldToClient(rect.x + rect.w / 2, rect.h / 2)
  }, ids.D!)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.worldRect(id).y, ids.D!))
    .toBeLessThan(20)
  await page.getByRole('button', { name: '故事板', exact: true }).click()
  await expect(titles(page)).toHaveText(['D', 'B', 'C', 'A'])
  await page.evaluate(() =>
    (window.__plein.engine as typeof window.__plein.engine & { undo(): void }).undo(),
  )
  await expect(titles(page)).toHaveText(['B', 'C', 'A', 'D'])
})
