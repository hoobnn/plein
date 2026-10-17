import { expect, test } from '@playwright/test'
import { addNode, centerOf, deselect, elements, newProject } from './canvas'

test('设置中的删除、复制粘贴和撤销按键不修改背后的画布', async ({ page }) => {
  await newProject(page)
  await addNode(page, '文本')
  await page.getByRole('textbox', { name: '提示词' }).fill('应该保留的多行文本\n第二行')
  await page.keyboard.press('Escape')
  const snapshot = () => page.evaluate(() => [...window.__plein.engine.doc.elements()])
  const before = await snapshot()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  const close = settings.getByRole('button', { name: '关闭', exact: true })
  await close.focus()
  for (const key of ['Backspace', 'Delete', 'ControlOrMeta+d', 'ControlOrMeta+z']) {
    await close.press(key)
    expect(await snapshot()).toEqual(before)
  }
  const copied = await close.evaluate((button) => {
    const data = new DataTransfer()
    data.setData('text/plain', '不应被画布覆盖的剪贴板')
    for (const type of ['copy', 'cut', 'paste']) {
      button.dispatchEvent(
        new ClipboardEvent(type, {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        }),
      )
    }
    return data.getData('text/plain')
  })
  expect(copied).toBe('不应被画布覆盖的剪贴板')
  expect(await snapshot()).toEqual(before)
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await deselect(page)
})

test('工具按钮上的 Tab 正常切换焦点，空格正常激活按钮', async ({ page }) => {
  await newProject(page)
  const settings = page.getByRole('button', { name: '设置', exact: true })
  await settings.focus()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('dialog', { name: '添加节点', exact: true })).toHaveCount(0)
  await expect(settings).not.toBeFocused()
  await settings.focus()
  await page.keyboard.press('Space')
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible()
})

test('侧栏折叠和展开分组不微移画布中的分组', async ({ page }) => {
  await newProject(page)
  await addNode(page, '文本', { x: 500, y: 400 })
  await page.keyboard.press('Escape')
  await addNode(page, '文本', { x: 1000, y: 400 })
  await page.keyboard.press('Escape')
  await page.mouse.click(700, 120)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+g')
  const frame = (await elements(page)).find((el) => el.kind === 'frame')!
  const rect = () => page.evaluate((id) => window.__plein.engine.doc.worldRect(id), frame.id)
  const before = await rect()
  const tree = page.getByRole('tree', { name: '画布元素' })
  const group = tree.getByRole('treeitem', { name: '折叠 分组 定位到画布' })
  await group.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(tree.getByRole('treeitem')).toHaveCount(1)
  expect(await rect()).toEqual(before)
  await page.keyboard.press('ArrowRight')
  await expect(tree.getByRole('treeitem')).toHaveCount(3)
  expect(await rect()).toEqual(before)
})

test('右键菜单内删除和方向键不改节点，Esc 只关闭菜单并保留选区', async ({ page }) => {
  await newProject(page)
  await addNode(page, '文本')
  await page.getByRole('textbox', { name: '提示词' }).fill('右键菜单测试')
  await page.keyboard.press('Escape')
  const [node] = await elements(page)
  const rect = () => page.evaluate((id) => window.__plein.engine.doc.worldRect(id), node!.id)
  const before = await rect()
  const point = await centerOf(page, node!.id)
  await page.mouse.click(point.x, point.y, { button: 'right' })
  const menu = page.getByRole('menu')
  const items = menu.getByRole('menuitem')
  await expect(items.first()).toBeFocused()
  await page.keyboard.press('End')
  await expect(items.last()).toBeFocused()
  await page.keyboard.press('Home')
  await expect(items.first()).toBeFocused()
  for (const key of ['Backspace', 'ArrowLeft', 'ArrowRight']) await page.keyboard.press(key)
  expect(await elements(page)).toHaveLength(1)
  expect(await rect()).toEqual(before)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([node!.id])
})

test('中文组字的确认和取消不结束侧栏重命名或关闭输入对话框', async ({ page }) => {
  await newProject(page)
  await addNode(page, '文本')
  const tree = page.getByRole('tree', { name: '画布元素' })
  await tree.getByRole('treeitem').dblclick()
  const name = tree.getByRole('textbox', { name: '画布名称' })
  await name.fill('中文节点名称')
  for (const key of ['Enter', 'Escape']) {
    await name.dispatchEvent('keydown', { key, isComposing: true })
    await expect(name).toBeVisible()
  }
  await name.press('Enter')
  await expect(name).toHaveCount(0)
  await expect(tree.getByRole('treeitem')).toContainText('中文节点名称')
  await page.getByRole('button', { name: '切换画布' }).click()
  await page.getByRole('button', { name: '新建画布', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新建画布', exact: true })
  await dialog.getByRole('textbox').dispatchEvent('keydown', { key: 'Escape', isComposing: true })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('侧栏重命名有独立撤销边界，不连带撤销刚完成的位置修改', async ({ page }) => {
  await newProject(page)
  await addNode(page, '文本')
  const row = page.getByRole('treeitem', { name: '文本 定位到画布', exact: true })
  const id = await page.evaluate(() => [...window.__plein.engine.doc.elements()][0]!.id)
  await row.dblclick()
  const rename = page.getByRole('tree').getByRole('textbox', { name: '画布名称' })
  await rename.fill('改名后的文本')
  // 与提交紧邻的一次位置事务，避免用睡眠跨过 Yjs 的默认捕获窗口掩盖问题。
  await page.evaluate((id) => {
    const doc = window.__plein.engine.doc as unknown as {
      origin: unknown
      ydoc: { transact(fn: () => void, origin: unknown): void }
      mutable(id: string): { set(k: string, v: number): void }
    }
    doc.ydoc.transact(() => doc.mutable(id).set('x', 101), doc.origin)
  }, id)
  await rename.press('Enter')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const el = window.__plein.engine.doc.get(id)
        return { name: el?.name, x: el && window.__plein.engine.doc.worldRect(id).x }
      }, id),
    )
    .toEqual({ name: '文本', x: 101 })
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect(
    page.getByRole('treeitem', { name: '改名后的文本 定位到画布', exact: true }),
  ).toBeVisible()
})
