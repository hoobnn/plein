import { expect, test } from './fixtures'
import { addNode, contextMenu, deselect, elements, newProject } from './canvas'

/** 双击空白处打开添加菜单，搜索模板名 */
async function searchAdd(page: Parameters<typeof deselect>[0], query: string) {
  await deselect(page)
  await page.mouse.dblclick(720, 780)
  await page.getByPlaceholder('添加节点').fill(query)
  return page.getByRole('dialog', { name: '添加节点' })
}

test('分组存为模板，从「我的模板」铺回画布，不要了可以删掉', { tag: '@core' }, async ({ page }) => {
  await newProject(page)
  await addNode(page, '文本', { x: 400, y: 300 })
  await deselect(page)
  await addNode(page, '生成图片', { x: 1000, y: 300 })
  await deselect(page)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+g')
  const frame = (await elements(page)).find((e) => e.kind === 'frame')!
  const name = `出图流程 ${Date.now()}`

  await contextMenu(page, frame.id, '存为模板…')
  const dialog = page.getByRole('dialog', { name: '存为模板' })
  await dialog.getByRole('textbox').fill(name)
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/templates') && response.request().method() === 'POST',
  )
  await dialog.getByRole('button', { name: '保存' }).click()
  expect((await (await saved).json()).data.extensions).toHaveProperty('plein/mentions')
  await expect(page.locator('.ui-toast')).toContainText(`已存为模板「${name}」`)

  const before = (await elements(page)).length
  let menu = await searchAdd(page, name)
  await menu.getByRole('option', { name }).click()
  // 分组和里面的两个节点一起铺出来
  await expect.poll(async () => (await elements(page)).length).toBe(before + 3)

  menu = await searchAdd(page, name)
  await menu.getByRole('option', { name }).hover()
  await menu.getByRole('button', { name: `删除模板「${name}」` }).click()
  const confirm = page.getByRole('dialog', { name: `删除模板「${name}」？` })
  await confirm.getByRole('button', { name: '删除' }).click()
  await expect(page.locator('.ui-toast')).toContainText(`已删除模板「${name}」`)
  menu = await searchAdd(page, name)
  await expect(menu.getByRole('option', { name })).toHaveCount(0)
  // 铺出来的内容不受影响
  expect((await elements(page)).length).toBe(before + 3)
})
