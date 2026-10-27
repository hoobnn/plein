import { expect, test, type Page } from './fixtures'
import { clickElement, revealGenerator, newProject } from './canvas'

const waitPlaced = (page: Page, id: string) =>
  page.waitForFunction(
    (id) =>
      (window.__plein.engine as unknown as { scene: { rect(id: string): unknown } }).scene.rect(id),
    id,
  )

test('文本正文和展开编辑器直接标记引用，保留普通文字、输入和补全', async ({ page }, info) => {
  await newProject(page)
  const id = await page.evaluate(() => {
    for (const [type, name] of [
      ['character', '小岚 · 测试'],
      ['scene', '雨后木桌'],
      ['prop', '玻璃杯'],
    ])
      window.__plein.addNode({ type: `plein/${type}`, name: name!, params: {}, x: -900, y: 0 })
    return window.__plein.addNode({
      type: 'plein/text',
      name: '引用正文',
      params: { text: '清晨，@小岚 · 测试 在@雨后木桌旁看着@玻璃杯。待补充 @someone。' },
      x: 0,
      y: 0,
    })
  })
  await waitPlaced(page, id)
  await clickElement(page, id)
  await revealGenerator(page)
  const generator = page.getByTestId('generator')
  const field = generator.getByRole('textbox', { name: '提示词', exact: true })
  const original = await field.inputValue()
  const marks = generator.getByTestId('mention-highlights').locator('mark')
  await expect(marks).toHaveText(['@小岚 · 测试', '@雨后木桌', '@玻璃杯', '@someone'])
  await expect(marks.last()).toHaveAttribute('data-state', 'missing')
  await expect(page.locator('.plein-node-body mark')).toHaveCount(4)
  await expect(field).toHaveValue(original)
  await generator.screenshot({ path: info.outputPath('inline-mentions.png') })
  await generator.getByRole('button', { name: '放大编辑提示词' }).click()
  const editor = page.getByRole('dialog', { name: '编辑提示词', exact: true })
  await expect(editor.getByTestId('mention-highlights').locator('mark')).toHaveCount(4)
  const expanded = editor.getByRole('textbox', { name: '提示词', exact: true })
  await expanded.fill('@玻')
  await expect(editor.getByRole('listbox', { name: '引用资产' })).toBeVisible()
  await expect(editor.getByRole('option')).toContainText('道具')
  await expanded.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  await expect(expanded).toHaveValue('@玻')
  await expanded.press('Enter')
  await expect(expanded).toHaveValue('@玻璃杯 ')
  await expect(editor.getByTestId('mention-highlights').locator('mark')).toHaveText(['@玻璃杯'])
  await page.keyboard.press('Escape')
  await expect(field).toHaveValue('@玻璃杯 ')
})

test('重名引用警示、消歧引用正常显示，新增目标立即更新正文标记', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() => {
    for (const x of [-900, -1300])
      window.__plein.addNode({ type: 'plein/character', name: '林夏', params: {}, x, y: 0 })
    return window.__plein.addNode({
      type: 'plein/text',
      name: '消歧正文',
      params: { text: '@林夏 与 @林夏#1 看向 @新场景。' },
      x: 0,
      y: 0,
    })
  })
  await waitPlaced(page, id)
  await clickElement(page, id)
  await revealGenerator(page)
  const marks = page.getByTestId('generator').getByTestId('mention-highlights').locator('mark')
  await expect(marks).toHaveCount(3)
  await expect(marks.last()).toHaveAttribute('data-state', 'missing')
  await expect(marks.nth(0)).toHaveAttribute('data-state', 'warning')
  await expect(marks.nth(1)).toHaveAttribute('data-state', 'resolved')
  await page.evaluate(() =>
    window.__plein.addNode({ type: 'plein/scene', name: '新场景', params: {}, x: -1700, y: 0 }),
  )
  await expect(marks).toHaveCount(3)
  await expect(page.locator('.plein-node-body mark')).toHaveCount(3)
})

test('长文本滚动时引用标记跟随文字，选区替换和原始文本保持一致', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() => {
    window.__plein.addNode({ type: 'plein/character', name: '小岚', params: {}, x: -900, y: 0 })
    return window.__plein.addNode({
      type: 'plein/text',
      name: '滚动正文',
      params: {
        text: Array.from({ length: 60 }, (_, i) => `第${i + 1}行 @小岚，检查换行与滚动。`).join(
          '\n',
        ),
      },
      x: 0,
      y: 0,
    })
  })
  await waitPlaced(page, id)
  await clickElement(page, id)
  await revealGenerator(page)
  const generator = page.getByTestId('generator')
  const field = generator.getByRole('textbox', { name: '提示词', exact: true })
  await field.hover()
  await page.mouse.wheel(0, 900)
  await expect.poll(() => field.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  const scroll = await field.evaluate((el) => el.scrollTop)
  const offset = await generator
    .getByTestId('mention-highlights')
    .locator(':scope > div')
    .evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m42)
  expect(offset).toBe(-scroll)
  await field.press('ControlOrMeta+a')
  await field.press('Backspace')
  await field.pressSequentially('@小岚 ')
  await expect(field).toHaveValue('@小岚 ')
  await expect(generator.getByTestId('mention-highlights').locator('mark')).toHaveCount(1)
})

test('@ 菜单先展示已引用和分类，搜索不修改正文，选择后保留原有内容', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() => {
    for (const name of ['常用角色', ...Array.from({ length: 12 }, (_, i) => `人物${i + 1}`)]) {
      window.__plein.addNode({ type: 'plein/character', name, params: {}, x: -900, y: 0 })
    }
    return window.__plein.addNode({
      type: 'plein/text',
      name: '引用菜单验收',
      params: { text: '@常用角色 与 ' },
      x: 0,
      y: 0,
    })
  })
  await clickElement(page, id)
  await revealGenerator(page)
  const panel = page.getByTestId('generator')
  const field = panel.getByRole('textbox', { name: '提示词', exact: true })
  await field.fill('@常用角色 与 ')
  await field.pressSequentially('@')
  const menu = page.getByRole('dialog', { name: '引用素材', exact: true })
  await expect(menu).toContainText('已引用')
  await menu.screenshot({ path: test.info().outputPath('mention-menu-home.png') })
  await expect(menu.getByRole('option', { name: /常用角色/ })).toBeVisible()
  for (const name of ['图片', '视频', '音频', '资产']) {
    await expect(menu.getByRole('option', { name, exact: true })).toBeVisible()
  }
  await menu.getByRole('option', { name: '资产', exact: true }).click()
  await expect(menu.getByRole('option')).toHaveCount(13)
  const search = menu.getByRole('textbox', { name: '搜索引用素材', exact: true })
  await search.fill('人物11')
  await expect(menu.getByRole('option')).toHaveCount(1)
  await expect(field).toHaveValue('@常用角色 与 @')
  await search.press('Enter')
  await expect(menu).toHaveCount(0)
  await expect(field).toHaveValue('@常用角色 与 @人物11 ')
  await expect(field).toBeFocused()
})
