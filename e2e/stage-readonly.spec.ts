import { expect, test } from './fixtures'
import { addNode, centerOf, elements, newProject, zoomTo } from './canvas'

// 3D 构图走真实 WebGL 渲染和截图编码，单条用例天然比界面冒烟的其余部分慢
test.beforeEach(() => {
  test.slow()
})

test('3D 只读可查看对象和视角，不抛错或修改场景，恢复可写后可继续', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await newProject(page)
  await addNode(page, '3D 构图')
  const stage = (await elements(page)).find((el) => el.nodeType === 'plein/stage')!
  await page.keyboard.press('Escape')
  await zoomTo(page, [stage.id])
  const at = await centerOf(page, stage.id)
  await page.mouse.dblclick(at.x, at.y)
  const dialog = page.getByRole('dialog', { name: '3D 构图', exact: true })
  await expect(dialog.locator('canvas.stage-canvas')).toBeVisible()
  const original = await elements(page)
  await page.evaluate(() => {
    ;(
      window.__plein.engine.doc as typeof window.__plein.engine.doc & { readOnly: boolean }
    ).readOnly = true
  })
  await dialog.getByRole('button', { name: '自由视角', exact: true }).click()
  const add = dialog.getByRole('button', { name: '添加人物', exact: true })
  if (await add.isEnabled()) await add.click()
  expect(errors).toEqual([])
  await expect(add).toBeDisabled()
  await expect(dialog.getByRole('textbox', { name: '名字', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '截图', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('status')).toContainText('只读')
  await dialog.locator('.stage-canvas').focus()
  await page.keyboard.press('Delete')
  await page.keyboard.press('ControlOrMeta+z')
  expect(await elements(page)).toEqual(original)
  await dialog.getByRole('button', { name: /mm ·/ }).click()
  await expect(dialog.getByRole('slider', { name: '焦距', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.mouse.dblclick(at.x, at.y)
  await expect(dialog.getByRole('status')).toContainText('只读')
  await expect(add).toBeDisabled()
  expect(await elements(page)).toEqual(original)
  await page.evaluate(() => {
    ;(
      window.__plein.engine.doc as typeof window.__plein.engine.doc & { readOnly: boolean }
    ).readOnly = false
  })
  await dialog.getByRole('button', { name: '自由视角', exact: true }).click()
  await expect(add).toBeEnabled()
  await add.click()
  await expect(dialog.getByRole('textbox', { name: '名字', exact: true })).toHaveValue('人物 2')
  expect(errors).toEqual([])
})

test('3D 输入坐标草稿后转为只读，显示恢复已保存值且不复活草稿', async ({ page }) => {
  await newProject(page)
  await addNode(page, '3D 构图')
  const stage = (await elements(page)).find((el) => el.nodeType === 'plein/stage')!
  await page.keyboard.press('Escape')
  await zoomTo(page, [stage.id])
  const at = await centerOf(page, stage.id)
  await page.mouse.dblclick(at.x, at.y)
  const dialog = page.getByRole('dialog', { name: '3D 构图', exact: true })
  const field = dialog.getByRole('spinbutton', { name: '左右', exact: true })
  const before = await field.inputValue()
  await field.fill('7.25')
  await page.evaluate((id) => {
    const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
      readOnly: boolean
    }
    doc.readOnly = true
    const node = doc.mutable(id)! as unknown as { set(k: string, v: unknown): void }
    node.set('name', '只读检查')
  }, stage.id)
  await expect(field).toBeDisabled()
  await expect(field).toHaveValue(before)
  await page.evaluate((id) => {
    const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
      readOnly: boolean
    }
    doc.readOnly = false
    const node = doc.mutable(id)! as unknown as { set(k: string, v: unknown): void }
    node.set('name', '恢复编辑')
  }, stage.id)
  await expect(field).toBeEnabled()
  await field.press('Enter')
  await expect(field).toHaveValue(before)
})
