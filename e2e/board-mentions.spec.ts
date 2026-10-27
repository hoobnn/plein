import { expect, type Page, test } from './fixtures'
import { newProject } from './canvas'

async function fixture(page: Page) {
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

for (const keyboard of [false, true]) {
  test(`故事板引用${keyboard ? '键盘' : '点击'}定位目标，卡片标题定位正文`, async ({ page }) => {
    const { ids, card } = await fixture(page)
    const mention = card.locator('mark[data-mention-id]')
    await expect(mention).toHaveText('@小岚')
    await expect(mention).toHaveAttribute('data-state', 'resolved')
    if (keyboard) {
      await mention.focus()
      await page.keyboard.press('Enter')
    } else await mention.click()
    await expect
      .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
      .toEqual([ids.target])
    await expect(card).toHaveCount(0)
    await page.getByRole('button', { name: '故事板', exact: true }).click()
    await card.getByRole('button', { name: '引用正文', exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
      .toEqual([ids.text])
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, ids.text),
    ).toBe('清晨，@小岚 走进院子。\n联系 test@example.com。')
  })
}

test('目标重命名、删除和撤销后引用状态更新，不把缺失引用绑定到其他元素', async ({ page }) => {
  const { ids, card } = await fixture(page)
  const mark = card.locator('mark')
  await expect(mark).toHaveAttribute('data-state', 'resolved')
  await mark.focus()
  await page.evaluate((id) => {
    const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
      origin: unknown
      ydoc: { transact(fn: () => void, origin: unknown): void }
      undo: { stopCapturing(): void }
    }
    doc.undo.stopCapturing()
    doc.ydoc.transact(
      () =>
        (doc.mutable(id) as unknown as { set(key: string, value: unknown): void }).set(
          'name',
          '小岚新名字',
        ),
      doc.origin,
    )
  }, ids.target)
  await expect(mark).toHaveAttribute('data-state', 'missing')
  await expect(card.getByRole('button', { name: '引用正文', exact: true })).toBeFocused()
  await expect(mark).not.toHaveAttribute('role', 'button')
  await page.evaluate(() =>
    (window.__plein.engine as typeof window.__plein.engine & { undo(): void }).undo(),
  )
  await expect(mark).toHaveAttribute('data-state', 'resolved')
  await page.evaluate((id) => {
    const engine = window.__plein.engine as typeof window.__plein.engine & {
      deleteSelection(): void
      doc: typeof window.__plein.engine.doc & { undo: { stopCapturing(): void } }
    }
    engine.doc.undo.stopCapturing()
    engine.selection.set([id])
    engine.deleteSelection()
  }, ids.target)
  await expect(mark).toHaveAttribute('data-state', 'missing')
  await page.evaluate(() =>
    (window.__plein.engine as typeof window.__plein.engine & { undo(): void }).undo(),
  )
  await expect(mark).toHaveAttribute('data-state', 'resolved')
})

test('生成正文的重名引用保持警示，明确序号定位正确目标，邮件保持普通文本', async ({ page }) => {
  const { ids } = await fixture(page)
  const expected = await page.evaluate((target) => {
    const other = window.__plein.addNode({
      type: 'plein/character',
      name: '小岚',
      params: {},
      x: -800,
      y: 500,
    })
    const id = window.__plein.addNode({
      type: 'plein/llm',
      name: '生成引用正文',
      params: {},
      x: 0,
      y: 500,
    })
    const node = window.__plein.engine.doc.mutable(id) as unknown as {
      set(key: string, value: unknown): void
    }
    node.set('results', [
      {
        id: 'mention-result',
        port: 'text',
        runId: 'mention-fixture',
        at: 1,
        value: { type: 'text', text: '@小岚，@小岚#2，@不存在。test@example.com' },
      },
    ])
    node.set('adopted', 'mention-result')
    return [target, other].sort()[1]!
  }, ids.target)
  const card = page
    .getByRole('region', { name: '文本', exact: true })
    .locator('.board-text')
    .filter({ hasText: '生成引用正文' })
  const marks = card.locator('mark')
  await expect(marks).toHaveCount(3)
  await expect(marks.nth(0)).toHaveAttribute('data-state', 'warning')
  await expect(marks.nth(0)).not.toHaveAttribute('role', 'button')
  await expect(marks.nth(1)).toHaveAttribute('data-mention-id', expected)
  await expect(marks.nth(2)).toHaveAttribute('data-state', 'missing')
  const handwritten = page
    .getByRole('region', { name: '文本', exact: true })
    .locator('.board-text')
    .filter({ has: page.getByRole('button', { name: '引用正文', exact: true }) })
    .locator('.line-clamp-2')
  const before = await handwritten.screenshot({
    animations: 'disabled',
    path: test.info().outputPath('before-remount.png'),
  })
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await page.getByRole('button', { name: '故事板', exact: true }).click()
  await page.waitForFunction(() => !document.documentElement.dataset.viewSlide)
  const after = await handwritten.screenshot({
    animations: 'disabled',
    path: test.info().outputPath('after-remount.png'),
  })
  expect(before.equals(after)).toBe(true)
  await page.screenshot({
    path: test.info().outputPath('board-mentions.png'),
    animations: 'disabled',
  })
  await marks.nth(1).focus()
  await page.keyboard.press('Space')
  await expect
    .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
    .toEqual([expected])
})

test('两行摘要被截掉的引用不进入键盘导航，展开和还原分栏后重新判断', async ({ page }) => {
  const { ids, card } = await fixture(page)
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
