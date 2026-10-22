import { expect, type Page, test } from '@playwright/test'
import { newProject, waitEngine } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const ids = await page.evaluate(() => ({
    text: [1, 2].map((no) =>
      window.__plein.addNode({
        type: 'plein/text',
        name: `分栏文本 ${no}`,
        x: 300,
        y: no * 600,
        params: {},
      }),
    ),
    image: window.__plein.addNode({
      type: 'plein/image',
      name: '待生成画面',
      x: 1100,
      y: 200,
      params: {},
    }),
  }))
  await page.getByRole('button', { name: '故事板', exact: true }).click()
  const text = page.getByRole('region', { name: '文本', exact: true })
  const image = page.getByRole('region', { name: '图片', exact: true })
  await expect(text.locator('.board-text')).toHaveCount(2)
  await expect(image.getByRole('button', { name: '定位待生成画面', exact: true })).toBeVisible()
  return { ids, text, image }
}

test('展开分栏中的全部节点被同伴删除后显示其他分栏，撤销恢复不再锁回旧分栏', async ({
  page,
  context,
}) => {
  const f = await fixture(page)
  await f.text.getByRole('button', { name: '展开此栏', exact: true }).click()
  await expect(f.image).toHaveCount(0)
  const peer = await context.newPage()
  try {
    await peer.goto(page.url())
    await waitEngine(peer)
    await expect
      .poll(() => peer.evaluate((id) => !!window.__plein.engine.doc.get(id), f.ids.text[0]!))
      .toBe(true)
    await peer.evaluate((ids) => {
      const engine = window.__plein.engine as typeof window.__plein.engine & {
        deleteSelection(): void
      }
      engine.selection.set(ids)
      engine.deleteSelection()
    }, f.ids.text)
    await expect
      .poll(() => page.evaluate((id) => !!window.__plein.engine.doc.get(id), f.ids.text[0]!))
      .toBe(false)
    await expect(f.text).toHaveCount(0)
    await expect(f.image).toBeVisible()
    await expect(f.image.getByRole('button', { name: '展开此栏', exact: true })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('board-expanded-column-removed.png') })
    await peer.evaluate(() =>
      (window.__plein.engine as typeof window.__plein.engine & { undo(): void }).undo(),
    )
    await expect(f.text.locator('.board-text')).toHaveCount(2)
    await expect(f.image).toBeVisible()
    await expect(page.getByRole('button', { name: '还原分栏', exact: true })).toHaveCount(0)
  } finally {
    await peer.close()
  }
})

for (const image of [false, true]) {
  test(`${image ? '待生成图片' : '筛选后的文本'}卡片准确定位到工作流节点`, async ({ page }) => {
    const f = await fixture(page)
    const id = image ? f.ids.image : f.ids.text[1]!
    const before = await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)
    await page.evaluate(() => {
      const engine = window.__plein.engine as typeof window.__plein.engine & {
        camera: { panBy(x: number, y: number): void }
      }
      engine.camera.panBy(-10000, -10000)
    })
    expect(
      await page.evaluate((id) => {
        const engine = window.__plein.engine
        const rect = engine.doc.worldRect(id)
        const center = engine.worldToClient(rect.x + rect.w / 2, rect.y + rect.h / 2)
        return center.x < 0 || center.x > innerWidth || center.y < 0 || center.y > innerHeight
      }, id),
    ).toBe(true)
    if (!image) {
      await f.text.getByRole('button', { name: '筛选', exact: true }).click()
      await page.getByRole('menuitemradio', { name: '待生成', exact: true }).click()
    }
    await (
      image
        ? f.image.getByRole('button', { name: '定位待生成画面', exact: true })
        : f.text.getByRole('button', { name: '分栏文本 2', exact: true })
    ).click()
    await expect(f.text).toHaveCount(0)
    await expect(page.getByRole('complementary', { name: '侧栏', exact: true })).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
      .toEqual([id])
    await expect
      .poll(() =>
        page.evaluate((id) => {
          const engine = window.__plein.engine
          const rect = engine.doc.worldRect(id)
          const center = engine.worldToClient(rect.x + rect.w / 2, rect.y + rect.h / 2)
          return center.x >= 0 && center.x <= innerWidth && center.y >= 0 && center.y <= innerHeight
        }, id),
      )
      .toBe(true)
    expect(await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)).toEqual(before)
  })
}

test('定位点击同帧节点已删除，不离开故事板或选中失效对象', async ({ page }) => {
  const f = await fixture(page)
  await f.text.getByRole('button', { name: '分栏文本 1', exact: true }).evaluate((button, id) => {
    const engine = window.__plein.engine as typeof window.__plein.engine & {
      deleteSelection(): void
    }
    engine.selection.set([id])
    engine.deleteSelection()
    ;(button as HTMLButtonElement).click()
  }, f.ids.text[0]!)
  await expect(f.text.locator('.board-text')).toHaveCount(1)
  await expect(f.image).toBeVisible()
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([])
  await expect(page.getByText('元素已被删除，无法定位', { exact: true })).toBeVisible()
})
