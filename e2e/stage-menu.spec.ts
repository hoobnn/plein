import { expect, type Page, test } from './fixtures'
import { addNode, centerOf, elements, newProject, zoomTo } from './canvas'
import { slowFile } from './slow-file'

async function fixture(page: Page) {
  await newProject(page)
  await addNode(page, '3D 构图')
  const stage = (await elements(page)).find((el) => el.nodeType === 'plein/stage')!
  await page.keyboard.press('Escape')
  await zoomTo(page, [stage.id])
  const at = await centerOf(page, stage.id)
  await page.mouse.dblclick(at.x, at.y)
  const dialog = page.getByRole('dialog', { name: '3D 构图', exact: true })
  await expect(dialog.locator('canvas.stage-canvas')).toBeVisible()
  const trigger = dialog.getByRole('button', { name: '添加场景件', exact: true })
  const menu = page.getByRole('menu', { name: '添加场景件', exact: true })
  const rawMenu = page.getByRole('menu', { name: '添加场景件', exact: true, includeHidden: true })
  const scene = () =>
    page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.scene, stage.id)
  return { dialog, trigger, menu, rawMenu, scene }
}

test('3D 添加菜单叠加设置后不遮挡上层，Esc 只关闭设置', async ({ page }) => {
  const f = await fixture(page)
  const before = await f.scene()
  await f.trigger.click()
  await expect(f.menu).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('plein:open-settings')))
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings).toBeVisible()
  await settings.getByRole('button', { name: '关闭', exact: true }).focus()
  await expect(f.rawMenu).toBeHidden()
  await page.screenshot({ path: test.info().outputPath('stage-settings-menu-dismissed.png') })
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await expect(f.dialog).toHaveCSS('opacity', '1')
  await expect(f.trigger).toBeFocused()
  expect(await f.scene()).toEqual(before)
})

test('3D 添加菜单快速取消后可再次键盘选择，关闭菜单不关闭构图', async ({ page }) => {
  const f = await fixture(page)
  await f.trigger.click()
  await page.keyboard.press('Escape')
  await expect(f.rawMenu).toHaveCount(0)
  await expect(f.dialog).toHaveCSS('opacity', '1')
  await expect(f.trigger).toBeFocused()
  await f.trigger.press('ArrowDown')
  await expect(f.menu).toBeVisible()
  await f.menu.getByRole('menuitem', { name: '桌子', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(f.rawMenu).toHaveCount(0)
  await expect(f.dialog.getByRole('button', { name: '桌子 1', exact: true })).toBeVisible()
  await expect(f.dialog).toHaveCSS('opacity', '1')
})

test('3D 添加菜单打开时按钮上的撤销不改背景，关闭后恢复构图撤销', async ({ page }) => {
  const f = await fixture(page)
  await f.dialog.getByRole('button', { name: '坐', exact: true }).click()
  const before = await f.scene()
  await f.trigger.click()
  await expect(f.menu).toBeVisible()
  await f.trigger.focus()
  await expect(f.menu).toBeVisible()
  await page.keyboard.press('ControlOrMeta+z')
  expect(await f.scene()).toEqual(before)
  await page.keyboard.press('Escape')
  await expect(f.rawMenu).toHaveCount(0)
  await expect(f.dialog).toHaveCSS('opacity', '1')
  await expect(f.trigger).toBeFocused()
  await page.keyboard.press('ControlOrMeta+z')
  await expect
    .poll(async () => ((await f.scene()) as { figures: Array<{ pose: string }> }).figures[0]!.pose)
    .toBe('stand')
})

// 这批用例要跑真实渲染、编码或很大的工程，单条本来就慢
slowFile(test)
