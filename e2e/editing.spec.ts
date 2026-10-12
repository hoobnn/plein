import { expect, test } from '@playwright/test'
import { addNode, edgesInto, elements, handleOf, newProject } from './canvas'

const nodes = async (page: Parameters<typeof elements>[0]) =>
  (await elements(page)).filter((e) => e.kind === 'node')

/** 画布编辑的基本功：拖线连接两个节点，撤销 / 重做连线和删除 */
test('拖线连接节点，撤销重做连线与删除', async ({ page }) => {
  await newProject(page)
  await addNode(page, '文本', { x: 360, y: 450 })
  await expect.poll(async () => (await nodes(page)).length).toBe(1)
  await page.keyboard.press('Escape')
  await addNode(page, '生成图片', { x: 1000, y: 450 })
  await expect.poll(async () => (await nodes(page)).length).toBe(2)
  await page.keyboard.press('Escape')
  const all = await nodes(page)
  const text = all.find((e) => e.nodeType === 'plein/text')!
  const image = all.find((e) => e.nodeType === 'plein/image')!

  // 从文本的输出口拖到生成图片的输入口：按类型自动接到提示词
  const from = await handleOf(page, text.id, 'out')
  const to = await handleOf(page, image.id, 'in')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, to.y, { steps: 5 })
  await page.mouse.move(to.x, to.y, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => edgesInto(page, image.id)).toEqual([[text.id, 'text', 'prompt']])

  // 撤销 / 重做连线
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => edgesInto(page, image.id)).toEqual([])
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(() => edgesInto(page, image.id)).toHaveLength(1)

  // 删除文本节点连线一起没了；撤销后节点和连线都回来
  const p = await handleOf(page, text.id, 'in')
  await page.mouse.click(p.x + 40, p.y)
  await page.keyboard.press('Delete')
  await expect.poll(async () => (await nodes(page)).length).toBe(1)
  await expect.poll(() => edgesInto(page, image.id)).toEqual([])
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await nodes(page)).length).toBe(2)
  await expect.poll(() => edgesInto(page, image.id)).toHaveLength(1)
})
