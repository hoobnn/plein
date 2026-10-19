import { expect, type Page, test } from '@playwright/test'
import { clickElement, newProject } from './canvas'

async function fixture(page: Page, board: boolean) {
  await newProject(page)
  const ids = await page.evaluate(() => {
    const done = window.__plein.addNode({
      type: 'plein/text',
      name: '已完成文本',
      params: {},
      x: 300,
      y: 200,
    })
    const pending = window.__plein.addNode({
      type: 'plein/text',
      name: '待生成文本',
      params: {},
      x: 900,
      y: 200,
    })
    window.__plein.addNode({ type: 'plein/image', name: '待生成图片', params: {}, x: 1500, y: 200 })
    const node = window.__plein.engine.doc.mutable(done) as unknown as {
      set(key: string, value: unknown): void
    }
    node.set('results', [
      {
        id: 'done-result',
        runId: 'filter-fixture',
        port: 'text',
        at: 1,
        value: { type: 'text', text: '已完成的正文' },
      },
    ])
    node.set('adopted', 'done-result')
    return { done, pending }
  })
  if (board) await page.getByRole('button', { name: '故事板', exact: true }).click()
  const container = board
    ? page.getByRole('region', { name: '文本', exact: true })
    : page.getByRole('complementary', { name: '侧栏', exact: true })
  const label = board ? '筛选' : '按类型筛选'
  const trigger = container.getByRole('button', { name: label, exact: true })
  const menu = page.getByRole('menu', { name: label, exact: true })
  const rawMenu = page.getByRole('menu', { name: label, exact: true, includeHidden: true })
  await expect(trigger).toBeVisible()
  return { ...ids, container, trigger, menu, rawMenu }
}

for (const board of [false, true]) {
  test(`${board ? '分栏' : '侧栏'}筛选快速取消后可键盘选值，不改画布选区与位置`, async ({
    page,
  }) => {
    const f = await fixture(page, board)
    await page.evaluate((id) => window.__plein.engine.selection.set([id]), f.done)
    const before = await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), f.done)
    await f.trigger.click()
    await page.keyboard.press('Escape')
    await expect(f.rawMenu).toHaveCount(0)
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([f.done])
    await f.trigger.press('ArrowDown')
    await expect(f.menu).toBeVisible()
    await f.menu
      .getByRole('menuitemradio', { name: board ? '已生成' : '文本', exact: true })
      .focus()
    await page.keyboard.press('Space')
    await expect(f.rawMenu).toHaveCount(0)
    await expect(f.trigger).toBeFocused()
    await expect(f.trigger).toContainText(board ? '已生成' : '文本')
    if (board) {
      await expect(f.container.locator('.board-text')).toHaveCount(1)
      await expect(f.container).toContainText('已完成文本')
    } else await expect(f.container.getByRole('treeitem')).toHaveCount(2)
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([f.done])
    expect(await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), f.done)).toEqual(
      before,
    )
  })

  test(`${board ? '分栏' : '侧栏'}菜单按钮聚焦时撤销不穿透画布，关闭后恢复画布撤销`, async ({
    page,
  }) => {
    const f = await fixture(page, board)
    await page.evaluate((id) => {
      const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
        origin: unknown
        undo: { stopCapturing(): void }
        ydoc: { transact(fn: () => void, origin: unknown): void }
        flush(): void
      }
      doc.undo.stopCapturing()
      doc.ydoc.transact(
        () =>
          (doc.mutable(id)! as unknown as { set(key: string, value: unknown): void }).set(
            'name',
            '菜单前保存的名称',
          ),
        doc.origin,
      )
      doc.flush()
      doc.undo.stopCapturing()
    }, f.done)
    await f.trigger.click()
    await expect(f.menu).toBeVisible()
    await f.trigger.focus()
    await expect(f.menu).toBeVisible()
    await page.keyboard.press('ControlOrMeta+z')
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, f.done)).toBe(
      '菜单前保存的名称',
    )
    await page.keyboard.press('Escape')
    await expect(f.rawMenu).toHaveCount(0)
    await expect(f.trigger).toBeFocused()
    await page.keyboard.press('ControlOrMeta+z')
    await expect
      .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, f.done))
      .toBe('已完成文本')
  })

  test(`${board ? '分栏' : '侧栏'}筛选菜单叠加设置不遮挡，关闭设置后保留筛选和焦点`, async ({
    page,
  }) => {
    const f = await fixture(page, board)
    await f.trigger.click()
    await f.menu
      .getByRole('menuitemradio', { name: board ? '待生成' : '文本', exact: true })
      .click()
    await expect(f.rawMenu).toHaveCount(0)
    await expect(f.trigger).toContainText(board ? '待生成' : '文本')
    await f.trigger.click()
    await expect(f.menu).toBeVisible()
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('plein:open-settings')))
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await expect(settings).toBeVisible()
    await settings.getByRole('button', { name: '关闭', exact: true }).focus()
    await expect(f.rawMenu).toBeHidden()
    await page.screenshot({
      path: test.info().outputPath(`${board ? 'board' : 'sidebar'}-settings-filter-dismissed.png`),
    })
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
    await expect(f.trigger).toBeFocused()
    await expect(f.trigger).toContainText(board ? '待生成' : '文本')
    if (board) {
      await expect(f.container.getByRole('listitem')).toHaveCount(1)
      await expect(f.container).toContainText('待生成文本')
    } else await expect(f.container.getByRole('treeitem')).toHaveCount(2)
  })
}

test('分栏筛选随采用结果变化刷新，展开还原保留筛选状态', async ({ page }) => {
  const f = await fixture(page, true)
  await f.trigger.click()
  await f.menu.getByRole('menuitemradio', { name: '已生成', exact: true }).click()
  await expect(f.container.locator('.board-text')).toHaveCount(1)
  await expect(f.container).toContainText('已完成文本')
  await f.container.getByRole('button', { name: '展开此栏', exact: true }).click()
  await expect(f.trigger).toContainText('已生成')
  await expect(f.container.locator('.board-text')).toHaveCount(1)
  await f.container.getByRole('button', { name: '还原分栏', exact: true }).click()
  await expect(f.trigger).toContainText('已生成')
  for (const adopted of [null, 'done-result']) {
    await page.evaluate(
      ({ id, adopted }) =>
        (
          window.__plein.engine.doc.mutable(id)! as unknown as {
            set(key: string, value: unknown): void
          }
        ).set('adopted', adopted),
      { id: f.done, adopted },
    )
    await expect(f.container.locator('.board-text')).toHaveCount(adopted ? 1 : 0)
    if (!adopted)
      await expect(f.container.getByText('没有符合筛选的内容', { exact: true })).toBeVisible()
  }
  await f.trigger.click()
  await f.menu.getByRole('menuitemradio', { name: '待生成', exact: true }).click()
  await expect(f.container.locator('.board-text')).toHaveCount(1)
  await expect(f.container).toContainText('待生成文本')
})

test('筛选菜单按钮不原生撤销背景正文，回到输入框后原生撤销重做仍可用', async ({ page }) => {
  const f = await fixture(page, false)
  await clickElement(page, f.done)
  const generator = page.getByTestId('generator')
  const edit = generator.getByRole('button', { name: '编辑文本', exact: true })
  if (await edit.isVisible()) await edit.click()
  const prompt = generator.getByRole('textbox', { name: '提示词', exact: true })
  await expect(prompt).toBeVisible()
  await prompt.pressSequentially('A')
  await expect(prompt).toHaveValue('A')
  await f.trigger.click()
  await expect(f.menu).toBeVisible()
  await f.trigger.focus()
  for (const key of ['ControlOrMeta+z', 'ControlOrMeta+Shift+z', 'ControlOrMeta+y']) {
    await page.keyboard.press(key)
    await expect(prompt).toHaveValue('A')
    await expect(f.trigger).toBeFocused()
    await expect(f.menu).toBeVisible()
  }
  await page.keyboard.press('Escape')
  await expect(f.rawMenu).toHaveCount(0)
  await prompt.focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(prompt).toHaveValue('')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(prompt).toHaveValue('A')
})
