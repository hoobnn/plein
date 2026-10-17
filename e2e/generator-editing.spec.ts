import { expect, test } from '@playwright/test'
import { clickElement, newProject } from './canvas'

test('正在编辑长正文时平移与窗口缩小不收起输入框，选区和正文保持', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 560 })
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/text',
      name: '连续编辑',
      params: { text: '初始正文' },
      x: 400,
      y: 200,
    }),
  )
  await clickElement(page, id)
  await page.evaluate(() =>
    (
      window.__plein.engine as Window['__plein']['engine'] & {
        camera: { panBy(x: number, y: number): void }
      }
    ).camera.panBy(0, -180),
  )
  const panel = page.getByTestId('generator')
  await expect(panel).toHaveAttribute('data-compact', 'false')
  const prompt = panel.getByRole('textbox', { name: '提示词', exact: true })
  const text = '雨后场景，角色拿起透明水杯 🌧️\n'.repeat(80)
  await prompt.fill(text)
  await prompt.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(12, 38, 'backward'))
  const selection = () =>
    prompt.evaluate((el) => {
      const input = el as HTMLTextAreaElement
      return [input.selectionStart, input.selectionEnd, input.selectionDirection]
    })
  const before = await selection()
  await page.evaluate(() =>
    (
      window.__plein.engine as Window['__plein']['engine'] & {
        camera: { panBy(x: number, y: number): void }
      }
    ).camera.panBy(0, 180),
  )
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(panel).toHaveAttribute('data-compact', 'false')
  await expect(prompt).toBeFocused()
  expect(await selection()).toEqual(before)
  await page.setViewportSize({ width: 1000, height: 320 })
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(panel).toHaveAttribute('data-compact', 'false')
  await expect(prompt).toBeFocused()
  await expect(prompt).toHaveValue(text)
  expect(await selection()).toEqual(before)
  await page.screenshot({ path: 'test-results/generator-long-editing.png' })
  await panel.getByRole('button', { name: '收起编辑器' }).click()
  await expect(panel).toHaveAttribute('data-compact', 'true')
  await panel.getByRole('button', { name: '编辑文本', exact: true }).click()
  await expect(prompt).toHaveValue(text)
  await prompt.evaluate((el) => {
    const input = el as HTMLTextAreaElement
    input.setSelectionRange(input.value.length, input.value.length)
  })
  await page.keyboard.insertText(' tail')
  await expect(prompt).toHaveValue(`${text} tail`)
  await prompt.press('ControlOrMeta+z')
  await expect(prompt).toHaveValue(text)
  await prompt.press('ControlOrMeta+Shift+z')
  await expect(prompt).toHaveValue(`${text} tail`)
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, id))
    .toBe(`${text} tail`)
})

test('角色名称草稿在平移时不失焦或提前提交，手动收起后保存并可撤销', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 560 })
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/character',
      name: '原角色名称',
      params: {},
      x: 400,
      y: 200,
    }),
  )
  await clickElement(page, id)
  await page.evaluate(() =>
    (
      window.__plein.engine as Window['__plein']['engine'] & {
        camera: { panBy(x: number, y: number): void }
      }
    ).camera.panBy(0, -180),
  )
  const panel = page.getByTestId('generator')
  await expect(panel).toHaveAttribute('data-compact', 'false')
  const name = panel.getByRole('textbox', { name: '节点名称', exact: true })
  await name.fill('尚未提交的角色草稿')
  await page.evaluate(() =>
    (
      window.__plein.engine as Window['__plein']['engine'] & {
        camera: { panBy(x: number, y: number): void }
      }
    ).camera.panBy(0, 180),
  )
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(name).toBeFocused()
  await expect(name).toHaveValue('尚未提交的角色草稿')
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, id)).toBe(
    '原角色名称',
  )
  await panel.getByRole('button', { name: '收起编辑器' }).click()
  await expect(panel).toHaveAttribute('data-compact', 'true')
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, id))
    .toBe('尚未提交的角色草稿')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, id))
    .toBe('原角色名称')
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, id))
    .toBe('尚未提交的角色草稿')
  await panel.getByRole('button', { name: '编辑角色', exact: true }).click()
  await expect(name).toHaveValue('尚未提交的角色草稿')
})
