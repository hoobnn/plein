import { expect, test } from '@playwright/test'
import { addNode, clickElement, edgesInto, elements, handleOf, newProject } from './canvas'

const nodes = async (page: Parameters<typeof elements>[0]) =>
  (await elements(page)).filter((e) => e.kind === 'node')

/** 画布编辑的基本功：拖线连接两个节点，撤销 / 重做连线和删除 */
test('拖线连接节点，撤销重做连线与删除', { tag: '@core' }, async ({ page }) => {
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
  await clickElement(page, text.id)
  await page.keyboard.press('Delete')
  await expect.poll(async () => (await nodes(page)).length).toBe(1)
  await expect.poll(() => edgesInto(page, image.id)).toEqual([])
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await nodes(page)).length).toBe(2)
  await expect.poll(() => edgesInto(page, image.id)).toHaveLength(1)
})

/** ⌘K：对选区可用的命令（与智能体同一套能力），回车执行，撤销一步回去 */
test('命令面板对选区打组，撤销回去', async ({ page }) => {
  await newProject(page)
  await addNode(page, '文本', { x: 360, y: 450 })
  await page.keyboard.press('Escape')
  await addNode(page, '文本', { x: 900, y: 450 })
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await nodes(page)).length).toBe(2)
  await page.mouse.click(640, 120)
  await page.keyboard.press('ControlOrMeta+a')

  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: '命令面板' })
  await expect(palette.getByText('选中的 2 个元素')).toBeVisible()
  await palette.getByRole('combobox').fill('打组')
  await expect(palette.getByRole('option')).toHaveCount(2)
  await expect(palette.getByRole('option').last()).toContainText('让小满来做')
  await page.keyboard.press('Enter')
  await expect(palette).toBeHidden()
  const frames = async () => (await elements(page)).filter((e) => e.kind === 'frame')
  await expect.poll(async () => (await frames()).length).toBe(1)

  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await frames()).length).toBe(0)
  await expect.poll(async () => (await nodes(page)).length).toBe(2)
})

/** 插件贡献的能力也在 ⌘K 里：服务端执行，提示里的“撤销”整次撤回 */
test('命令面板运行插件能力，提示里撤销', async ({ page }) => {
  await newProject(page)
  await addNode(page, '文本', { x: 500, y: 450 })
  await page.keyboard.press('Escape')
  await page.mouse.click(640, 120)
  await page.keyboard.press('ControlOrMeta+a')

  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: '命令面板' })
  await palette.getByRole('combobox').fill('便签')
  await expect(palette.getByRole('option').first()).toContainText('贴一张便签（Mock）')
  await expect(palette.getByRole('option').first()).toContainText('Mock 平台')
  await page.keyboard.press('Enter')
  const notes = async () => (await elements(page)).filter((e) => e.kind === 'markdown')
  await expect.poll(async () => (await notes()).length).toBe(1)
  const toast = page.getByRole('status').filter({ hasText: '旁边贴了便签' })
  await expect(toast).toBeVisible()

  await toast.getByRole('button', { name: '撤销' }).click()
  await expect.poll(async () => (await notes()).length).toBe(0)
  await expect.poll(async () => (await nodes(page)).length).toBe(1)
})

/** 在节点面板的输入框里按 Esc：先退出输入框，再按一次取消选中、收起面板 */
test('输入框里按 Esc 先退出输入，再按取消选中', async ({ page }) => {
  await newProject(page)
  await addNode(page, '生成图片')
  const prompt = page.getByRole('textbox', { name: '提示词' })
  await prompt.click()
  await page.keyboard.type('雨夜天台')
  await page.keyboard.press('Escape')
  await expect(prompt).not.toBeFocused()
  await expect
    .poll(() => page.evaluate(() => window.__plein.engine.selection.values().length))
    .toBe(1)
  await page.keyboard.press('Escape')
  await expect
    .poll(() => page.evaluate(() => window.__plein.engine.selection.values().length))
    .toBe(0)
  await expect(prompt).toBeHidden()
  const [node] = (await elements(page)).filter((e) => e.kind === 'node')
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.prompt, node!.id),
  ).toBe('雨夜天台')
})
