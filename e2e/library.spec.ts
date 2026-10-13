import { expect, type Page, test } from '@playwright/test'
import {
  addNode,
  byName,
  centerOf,
  contextMenu,
  edgesInto,
  elements,
  newProject,
  waitNode,
  zoomTo,
} from './canvas'

interface Item {
  id: string
  name: string
  tags: Record<string, string>
  images: Array<{ assetId: string }>
  voice: { voiceId: string } | null
  projectId: string | null
}

const library = async (page: Page) =>
  (await (await page.request.get('/api/library')).json()) as Item[]

/** 铺短剧模板，跑出角色与场景抽取，生成设定卡；返回提示 */
async function castFromTemplate(page: Page) {
  await addNode(page, '短剧')
  await expect(page.locator('.ui-toast')).toContainText('短剧模板已铺出')
  const cast = await byName(page, '角色与场景抽取')
  await zoomTo(page, [cast.id])
  await contextMenu(page, cast.id, '运行到此处')
  await waitNode(page, cast.id)
  await expect(page.locator('.ui-toast')).toContainText('运行到「角色与场景抽取」运行完成')
  await contextMenu(page, cast.id, '生成设定卡（3）')
  await expect(page.locator('.ui-toast')).toContainText('设定卡')
  return (await page.locator('.ui-toast').textContent()) ?? ''
}

/** 选中画布上的元素，打开它的生成器面板 */
async function select(page: Page, id: string) {
  await page.keyboard.press('Escape')
  await zoomTo(page, [id])
  const p = await centerOf(page, id)
  await page.mouse.click(p.x, p.y)
}

test('角色存进资产库，换个项目生成设定卡时直接套用，不再重新出定妆图', async ({ page }) => {
  // 资产库按账号共享：先清掉别的用例或上次留下的同名条目，否则同名多条会被当成指不明、不套用
  for (const i of (await library(page)).filter((i) => i.name === '林晚'))
    await page.request.delete(`/api/library/${i.id}`)
  // 项目 A：抽取出林晚，出定妆图，存进资产库
  await newProject(page)
  await castFromTemplate(page)
  const portrait = await byName(page, '林晚 · 定妆图')
  await zoomTo(page, [portrait.id])
  await contextMenu(page, portrait.id, '生成')
  await waitNode(page, portrait.id)

  const lin = await byName(page, '林晚')
  await select(page, lin.id)
  await page.getByRole('button', { name: '存入资产库' }).click()
  await expect(page.locator('.ui-toast')).toContainText('已存入资产库：角色「林晚」')
  const [saved] = (await library(page)).filter((i) => i.name === '林晚')
  // 设定里的性别、年龄存成标签；定妆图和音色一起带走
  expect(saved).toMatchObject({
    tags: { gender: '女', age: '青年' },
    voice: { voiceId: 'mock-female' },
  })
  expect(saved!.images).toHaveLength(1)

  // 资产库里按性别筛：女能看到林晚，男看不到
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '资产库' }).click()
  const panel = page.getByRole('dialog', { name: '资产库' })
  await panel.getByRole('combobox', { name: '性别' }).click()
  await page.getByRole('option', { name: '男', exact: true }).click()
  await expect(panel.getByText('林晚', { exact: true })).toBeHidden()
  await panel.getByRole('combobox', { name: '性别' }).click()
  await page.getByRole('option', { name: '女', exact: true }).click()
  await expect(panel.getByText('林晚', { exact: true })).toBeVisible()
  await expect(panel.getByText('女 · 青年')).toBeVisible()
  await panel.getByRole('button', { name: '关闭' }).click()

  // 项目 B：同一个模板，林晚直接用资产库的设定、参考图和音色
  await newProject(page)
  const notice = await castFromTemplate(page)
  expect(notice).toContain('林晚 用了资产库里的设定和参考图')
  const names = (await elements(page)).map((e) => e.name)
  expect(names).not.toContain('林晚 · 定妆图')
  expect(names).toContain('老周 · 定妆图')
  const again = await byName(page, '林晚')
  const into = await edgesInto(page, again.id)
  expect(into).toHaveLength(1)
  const ref = await page.evaluate((id) => window.__plein.engine.doc.get(id)?.assetId, into[0]![0])
  expect(ref).toBe(saved!.images[0]!.assetId)

  // 卡片上的音色是下拉选的预置音色，显示名字和性别
  await select(page, again.id)
  await page.getByText('更多设置').click()
  await expect(page.getByRole('combobox', { name: '音色' })).toContainText('Mock 女声 · 女')

  // 资产库里再点「添加到画布」：同一条目已经在画布上，只选中它
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '资产库' }).click()
  await panel.getByRole('button', { name: '全部', exact: true }).click()
  const cardItem = panel.getByRole('listitem').filter({ hasText: '林晚' })
  await cardItem.hover()
  await cardItem.getByRole('button', { name: '添加到画布' }).click()
  await expect(page.locator('.ui-toast')).toContainText('「林晚」已经在画布上，已为你选中')
})
