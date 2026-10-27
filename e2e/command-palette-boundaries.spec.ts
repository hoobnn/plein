import { expect, type Page, test } from './fixtures'
import { newProject } from './canvas'

async function setup(page: Page) {
  await newProject(page)
  await page.evaluate(() => {
    const id = window.__plein.addNode({
      type: 'plein/text',
      name: '命令面板背景',
      params: { text: '不应被误执行的正文' },
      x: 600,
      y: 300,
    })
    window.__plein.engine.selection.set([id])
    ;(document.activeElement as HTMLElement)?.blur()
  })
}
const snapshot = (page: Page) => page.evaluate(() => [...window.__plein.engine.doc.elements()])
const palette = (page: Page) => page.getByRole('dialog', { name: '命令面板', exact: true })

for (const query of ['', '没有匹配的命令']) {
  test(`命令面板自身结果列表不吞 Esc，查询 ${query || '为空'} 时一次关闭且不改背景`, async ({
    page,
  }) => {
    await setup(page)
    const before = await snapshot(page)
    await page.keyboard.press('Control+k')
    const dialog = palette(page)
    await expect(dialog).toBeVisible()
    await dialog.getByRole('combobox').fill(query)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(await snapshot(page)).toEqual(before)
  })
}

test('命令面板焦点离开搜索框后 Esc 仍关闭，重新打开可继续键盘导航', async ({ page }) => {
  await setup(page)
  await page.keyboard.press('Control+k')
  const dialog = palette(page)
  await expect(dialog).toBeVisible()
  await dialog.getByText('选中的 1 个元素', { exact: true }).click()
  await dialog.focus()
  await expect(dialog).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await page.keyboard.press('Control+k')
  const input = dialog.getByRole('combobox')
  await expect(input).toBeFocused()
  await expect.poll(() => dialog.getByRole('option').count()).toBeGreaterThan(1)
  const before = await input.getAttribute('aria-activedescendant')
  await input.press('ArrowDown')
  await expect(input).not.toHaveAttribute('aria-activedescendant', before!)
})

for (const mode of ['composition', 'legacy229'] as const) {
  test(`${mode} 的 Ctrl+K 不打开命令面板，普通 Ctrl+K 仍可用`, async ({ page }) => {
    await setup(page)
    const accepted = await page
      .locator('canvas')
      .first()
      .evaluate(
        (el, mode) =>
          el.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'k',
              code: 'KeyK',
              ctrlKey: true,
              isComposing: mode === 'composition',
              keyCode: mode === 'legacy229' ? 229 : 75,
              bubbles: true,
              cancelable: true,
            }),
          ),
        mode,
      )
    expect(accepted).toBe(true)
    await expect(palette(page)).toHaveCount(0)
    await page.keyboard.press('Control+k')
    await expect(palette(page)).toBeVisible()
  })
  test(`命令面板 ${mode} 的导航、确认和 Esc 不误选、不执行或关闭`, async ({ page }) => {
    await setup(page)
    const before = await snapshot(page)
    const writes: string[] = []
    await page.route('**/api/**', (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      writes.push(route.request().url())
      return route.fulfill({ status: 503, json: { message: '回归拦截写入' } })
    })
    await page.keyboard.press('Control+k')
    const dialog = palette(page)
    const input = dialog.getByRole('combobox')
    await expect(input).toBeFocused()
    await expect.poll(() => dialog.getByRole('option').count()).toBeGreaterThan(1)
    const active = await input.getAttribute('aria-activedescendant')
    const send = (key: string) =>
      input.evaluate(
        (el, { key, mode }) =>
          el.dispatchEvent(
            new KeyboardEvent('keydown', {
              key,
              code: key,
              isComposing: mode === 'composition',
              keyCode: mode === 'legacy229' ? 229 : key === 'Enter' ? 13 : 27,
              bubbles: true,
              cancelable: true,
            }),
          ),
        { key, mode },
      )
    expect(await send('ArrowDown')).toBe(true)
    await expect(input).toHaveAttribute('aria-activedescendant', active!)
    await input.fill('组字期间不应发送请求')
    expect(await send('Enter')).toBe(true)
    await expect(dialog).toBeVisible()
    expect(await send('Escape')).toBe(true)
    await expect(dialog).toBeVisible()
    expect(writes).toEqual([])
    expect(await snapshot(page)).toEqual(before)
    await input.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
}
