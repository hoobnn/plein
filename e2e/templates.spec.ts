import { expect, test } from '@playwright/test'
import { addNode, contextMenu, deselect, elements, newProject } from './canvas'

const MOCK = '/api/providers/plein/mock/config'

test.afterEach(async ({ request }) => {
  await request.put(MOCK, { data: { settings: { latencyMs: 0 } } })
})

/** 双击空白处打开添加菜单，搜索模板名 */
async function searchAdd(page: Parameters<typeof deselect>[0], query: string) {
  await deselect(page)
  await page.mouse.dblclick(720, 780)
  await page.getByPlaceholder('添加节点').fill(query)
  return page.getByRole('dialog', { name: '添加节点' })
}

test('分组存为模板，从「我的模板」铺回画布，不要了可以删掉', async ({ page }) => {
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
  await dialog.getByRole('button', { name: '保存' }).click()
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

test('生成中途取消：节点标为已取消，任务面板里记着，之后能重新生成', async ({ page, request }) => {
  await request.put(MOCK, { data: { settings: { latencyMs: 20_000 } } })
  await newProject(page)
  await addNode(page, '生成图片')
  const generator = page.getByTestId('generator')
  await generator.locator('textarea').first().fill('雨夜天台上的铁盒')
  await generator.getByRole('button', { name: '生成', exact: true }).click()
  const [node] = (await elements(page)).filter((e) => e.kind === 'node')
  await expect
    .poll(async () => (await elements(page)).find((e) => e.id === node!.id)?.status)
    .toBe('running')

  await generator.getByRole('button', { name: '取消' }).click()
  await expect
    .poll(async () => (await elements(page)).find((e) => e.id === node!.id)?.status)
    .toBe('canceled')
  await page.getByRole('button', { name: '任务' }).click()
  const tasks = page.getByRole('complementary', { name: '任务' })
  await expect(tasks.getByText('已取消').first()).toBeVisible()
  await page.getByRole('button', { name: '任务' }).click()

  await request.put(MOCK, { data: { settings: { latencyMs: 0 } } })
  await generator.getByRole('button', { name: '生成', exact: true }).click()
  await expect
    .poll(async () => (await elements(page)).find((e) => e.id === node!.id)?.status, {
      timeout: 30_000,
    })
    .toBe('succeeded')
})
