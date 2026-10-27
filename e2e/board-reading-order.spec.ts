import { expect, type Page, test } from './fixtures'
import { centerOf, newProject, zoomTo } from './canvas'

const positions = {
  A: { x: 0, y: 120 },
  B: { x: 100, y: 60 },
  C: { x: 200, y: 0 },
  D: { x: 0, y: 600 },
}
type Name = keyof typeof positions
async function fixture(page: Page, order: Name[]) {
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

for (const order of [['A', 'B', 'C']] as Name[][]) {
  test(`接近行边界的文本按位置排序，与创建顺序 ${order.join('')} 无关`, async ({ page }) => {
    await fixture(page, [...order, 'D'])
    await page.getByRole('button', { name: '故事板', exact: true }).click()
    await expect(titles(page)).toHaveText(['B', 'C', 'A', 'D'])
  })
}

test('其他类别元素不改变文本的行划分', async ({ page }) => {
  await fixture(page, ['C', 'B', 'A', 'D'])
  await page.getByRole('button', { name: '故事板', exact: true }).click()
  await expect(titles(page)).toHaveText(['B', 'C', 'A', 'D'])
  await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '不相关的图片',
      params: {},
      x: 900,
      y: -30,
    }),
  )
  await expect(titles(page)).toHaveText(['B', 'C', 'A', 'D'])
})

test('真实拖动节点到前一行，故事板重排且撤销恢复原顺序', async ({ page }) => {
  const ids = await fixture(page, ['C', 'B', 'A', 'D'])
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

test('嵌套分组保留世界阅读顺序，移动内层分组和撤销后及时更新', async ({ page }) => {
  const ids = await fixture(page, ['C', 'B', 'A', 'D'])
  const inner = await page.evaluate((ids) => {
    const engine = window.__plein.engine as typeof window.__plein.engine & {
      groupSelection(): void
    }
    engine.selection.set([ids.A!, ids.B!, ids.C!])
    engine.groupSelection()
    const inner = engine.selection.values()[0]!
    engine.selection.set([inner, ids.D!])
    engine.groupSelection()
    return inner
  }, ids)
  await page.getByRole('button', { name: '故事板', exact: true }).click()
  await expect(titles(page)).toHaveText(['B', 'C', 'A', 'D'])
  await page.evaluate((id) => {
    const engine = window.__plein.engine as typeof window.__plein.engine & {
      nudge(x: number, y: number): void
      doc: typeof window.__plein.engine.doc & { undo: { stopCapturing(): void } }
    }
    engine.doc.undo.stopCapturing()
    engine.selection.set([id])
    engine.nudge(0, 1000)
  }, inner)
  await expect(titles(page)).toHaveText(['D', 'B', 'C', 'A'])
  await page.evaluate(() =>
    (window.__plein.engine as typeof window.__plein.engine & { undo(): void }).undo(),
  )
  await expect(titles(page)).toHaveText(['B', 'C', 'A', 'D'])
  await page.screenshot({
    path: test.info().outputPath('board-reading-order.png'),
    animations: 'disabled',
  })
})
