import { expect, test } from '@playwright/test'
import { addNode, elements, newProject } from './canvas'

test('添加菜单键盘选项保持可见，中文组字不误建节点', async ({ page }) => {
  await newProject(page)
  await page.getByRole('button', { name: '添加节点', exact: true }).click()
  const menu = page.getByRole('dialog', { name: '添加节点', exact: true })
  const search = menu.getByRole('textbox', { name: '搜索节点' })
  const options = menu.getByRole('option')
  const count = await options.count()
  for (let i = 1; i < count; i++) await search.press('ArrowDown')
  const selected = menu.getByRole('option', { selected: true })
  await expect(selected).toHaveText('从生成历史选择')
  await expect(selected).toBeInViewport({ ratio: 1 })
  await search.fill('文本')
  await search.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
  await expect(menu).toBeVisible()
  expect(await elements(page)).toHaveLength(0)
  await search.press('Enter')
  await expect.poll(async () => (await elements(page)).length).toBe(1)
})

test('放大提示词立即可编辑，中文确认不误选候选或触发生成', async ({ page }) => {
  await newProject(page)
  await addNode(page, '生成图片')
  let runs = 0
  await page.route('**/api/canvases/*/nodes/*/run', (route) => {
    runs++
    return route.fulfill({ status: 503, json: { message: '测试拦截生成' } })
  })
  const generator = page.getByTestId('generator')
  const inline = generator.getByRole('textbox', { name: '提示词', exact: true })
  await inline.fill('/')
  const preset = generator.getByRole('listbox', { name: '提示词预设' })
  await expect(preset).toBeVisible()
  await inline.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
  await expect(inline).toHaveValue('/')
  const composingDefault = await inline.evaluate((el) =>
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        ctrlKey: true,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  )
  expect(composingDefault).toBe(true)
  expect(runs).toBe(0)
  await generator.getByRole('button', { name: '放大编辑提示词' }).click()
  const editor = page.getByRole('dialog', { name: '编辑提示词', exact: true })
  const expanded = editor.getByRole('textbox', { name: '提示词', exact: true })
  await expect(expanded).toBeFocused()
  await expanded.fill('放大编辑后的内容')
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
  await expect(inline).toHaveValue('放大编辑后的内容')
  await inline.press('ControlOrMeta+Enter')
  await expect.poll(() => runs).toBe(1)
})

test('生成器打开时，底部添加菜单保持在前面并可点击', async ({ page }) => {
  await newProject(page)
  await addNode(page, '生成图片')
  const menu = page.getByRole('dialog', { name: '添加节点', exact: true })
  await expect(menu).toHaveCount(0)
  await expect(page.getByTestId('generator')).toBeVisible()
  await page.getByRole('button', { name: '添加节点', exact: true }).click()
  const search = menu.getByRole('textbox', { name: '搜索节点' })
  await search.click()
  await search.fill('文本')
  await menu.getByRole('option', { name: '文本', exact: true }).click()
  await expect(menu).toHaveCount(0)
  await expect.poll(async () => (await elements(page)).length).toBe(2)
})
