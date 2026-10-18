import { expect, test, type Page } from '@playwright/test'
import { clickElement, newProject, waitNode } from './canvas'

async function setup(page: Page) {
  await newProject(page)
  const ids = await page.evaluate(() => {
    const target = window.__plein.addNode({
      type: 'plein/character',
      name: '小岚 · 引用',
      params: {},
      x: -800,
      y: 0,
    })
    const text = window.__plein.addNode({
      type: 'plein/text',
      name: '引用测试正文',
      params: { text: '清晨，@小岚 · 引用 走进院子。' },
      x: 0,
      y: 0,
    })
    return { target, text }
  })
  await page.waitForFunction(
    (id) =>
      (window.__plein.engine as unknown as { scene: { rect(id: string): unknown } }).scene.rect(id),
    ids.text,
  )
  await clickElement(page, ids.text)
  return ids
}
const generator = (page: Page) => page.getByTestId('generator')
const field = (page: Page) => generator(page).getByRole('textbox', { name: '提示词', exact: true })
const mark = (page: Page) => generator(page).getByTestId('mention-highlights').locator('mark')
const openText = (page: Page) =>
  page.getByRole('treeitem', { name: '引用测试正文 定位到画布', exact: true }).click()

test('邮箱及转义说明不触发引用补全、失效提示或实际生成素材', async ({ page }) => {
  await setup(page)
  const id = await page.evaluate(() => {
    window.__plein.addNode({
      type: 'plein/prop',
      name: 'example.com',
      params: { description: '不应送入的设定' },
      x: -800,
      y: 600,
    })
    return window.__plein.addNode({
      type: 'plein/image',
      name: '普通文字边界',
      params: { model: 'plein/mock:image' },
      x: 700,
      y: 0,
    })
  })
  await page.getByRole('treeitem', { name: '普通文字边界 定位到画布', exact: true }).click()
  const text = '联系 test@example.com；说明 \\@小岚 · 引用；@@不存在'
  await field(page).fill(text)
  await expect(mark(page)).toHaveCount(0)
  await expect(generator(page).getByRole('listbox')).toHaveCount(0)
  await expect(generator(page)).not.toContainText('未找到：')
  const canvas = decodeURIComponent(page.url().split('#/c/')[1]!.split('?')[0]!)
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/canvases/${canvas}/nodes/${id}/input`)
      if (!response.ok()) return null
      const input = await response.json()
      return { prompt: input.prompt, refs: input.refs }
    })
    .toEqual({ prompt: text, refs: [] })
  await generator(page).getByRole('button', { name: '生成', exact: true }).click()
  await waitNode(page, id)
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length, id)).toBe(
    1,
  )
})

test('正文引用普通点击编辑，组合点击和卡片引用点击准确定位且不改文案', async ({ page }) => {
  const ids = await setup(page)
  const initial = await field(page).inputValue()
  const hit = await mark(page).boundingBox()
  const input = await field(page).boundingBox()
  await field(page).click({
    position: { x: hit!.x + hit!.width / 2 - input!.x, y: hit!.y + hit!.height / 2 - input!.y },
  })
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([ids.text])
  await field(page).click({
    position: { x: hit!.x + hit!.width / 2 - input!.x, y: hit!.y + hit!.height / 2 - input!.y },
    modifiers: ['ControlOrMeta'],
  })
  await expect
    .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
    .toEqual([ids.target])
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, ids.text),
  ).toBe(initial)
  await clickElement(page, ids.text)
  await page.locator('.plein-node-body mark[role="button"]').click()
  await expect
    .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
    .toEqual([ids.target])
})

test('重命名、删除显示失效，撤销重做和刷新还原对应引用状态', async ({ page }) => {
  const ids = await setup(page)
  const tree = page.getByRole('tree', { name: '画布元素' })
  await tree.getByRole('treeitem', { name: '小岚 · 引用 定位到画布', exact: true }).dblclick()
  const rename = tree.getByRole('textbox', { name: '元素名称' })
  await rename.fill('小岚 · 新名称')
  await rename.press('Enter')
  await openText(page)
  await expect(mark(page)).toHaveAttribute('data-state', 'missing')
  await expect(generator(page)).toContainText('未找到：')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(mark(page)).toHaveAttribute('data-state', 'resolved')
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect(mark(page)).toHaveAttribute('data-state', 'missing')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await clickElement(page, ids.target)
  await page.keyboard.press('Delete')
  await openText(page)
  await expect(mark(page)).toHaveAttribute('data-state', 'missing')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(mark(page)).toHaveAttribute('data-state', 'resolved')
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect(mark(page)).toHaveAttribute('data-state', 'missing')
  await page.reload()
  await page.waitForFunction(() => !!window.__plein)
  await openText(page)
  await expect(mark(page)).toHaveText('@小岚 · 引用')
  await expect(mark(page)).toHaveAttribute('data-state', 'missing')
})

test('引用以纯文本复制粘贴，输入撤销重做保持原文和标记同步，邮件地址不误报', async ({
  page,
  context,
}) => {
  await setup(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const original = await field(page).inputValue()
  await field(page).focus()
  await field(page).press('ControlOrMeta+a')
  await field(page).press('ControlOrMeta+c')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(original)
  await field(page).press('ArrowRight')
  await field(page).press('ControlOrMeta+v')
  await expect(field(page)).toHaveValue(original + original)
  await expect(mark(page)).toHaveCount(2)
  await field(page).press('ControlOrMeta+z')
  await expect(field(page)).toHaveValue(original)
  await expect(mark(page)).toHaveCount(1)
  await field(page).press('ControlOrMeta+Shift+z')
  await expect(field(page)).toHaveValue(original + original)
  await expect(mark(page)).toHaveCount(2)
  await field(page).fill('联系 test@example.com；看着@已删除元素。')
  await expect(mark(page)).toHaveText('@已删除元素')
  await expect(mark(page)).toHaveAttribute('data-state', 'missing')
})
