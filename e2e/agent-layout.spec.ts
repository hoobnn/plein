import { expect, test } from '@playwright/test'
import { newProject, settle } from './canvas'

for (const initialWidth of [639, 1440]) {
  test(`助手从 ${initialWidth} 宽度打开后随断点变化同步避让，草稿与焦点保留`, async ({ page }) => {
    await page.setViewportSize({ width: initialWidth, height: 900 })
    await newProject(page)
    await page.getByRole('button', { name: '打开助手', exact: true }).click()
    const panel = page.getByRole('complementary', { name: '助手', exact: true })
    const input = panel.getByPlaceholder('让小满帮你做点什么…')
    await expect(input).toBeFocused()
    await input.fill('保留这段未发送的草稿')
    const toggle = page.getByRole('button', { name: '收起助手', exact: true })
    const send = panel.getByRole('button', { name: '发送', exact: true })
    await expect(send).toBeEnabled()
    const right = () =>
      page.evaluate(
        () =>
          (window.__plein.engine as unknown as { camera: { insets: { right: number } } }).camera
            .insets.right,
      )
    for (const width of [640, 639, 1440, 320, 390, 664, 700, 800, 900, 600, 640]) {
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(right).toBe(width >= 640 ? 424 : 0)
      await expect(panel).toBeVisible()
      await expect
        .poll(async () => Math.round((await panel.boundingBox())!.width))
        .toBe(width >= 640 ? 400 : width - 24)
      await expect(input).toBeFocused()
      await expect(input).toHaveValue('保留这段未发送的草稿')
      // 两个方向都不能遮挡：单纯提升吉祥物层级会反过来盖住发送按钮。
      for (const button of [toggle, send]) {
        await expect
          .poll(() =>
            button.evaluate((el) => {
              const r = el.getBoundingClientRect()
              return (
                document
                  .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
                  ?.closest('button') === el
              )
            }),
          )
          .toBe(true)
      }
      const buttonRect = (await toggle.boundingBox())!
      const panelRect = (await panel.boundingBox())!
      expect(panelRect.y + panelRect.height).toBeLessThanOrEqual(buttonRect.y - 8)
    }
    await page.screenshot({ path: test.info().outputPath('agent-breakpoint.png') })
    await page.getByRole('button', { name: '收起助手', exact: true }).click()
    await expect.poll(right).toBe(0)
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect.poll(right).toBe(0)
    await expect(panel).toHaveCount(0)
  })
}

test('空间不足时助手临时收起侧栏，放大或主动切回后恢复用户偏好', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 })
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/text',
      name: '检查可用画布空间',
      params: {},
      x: 3000,
      y: 2000,
    }),
  )
  await settle(page, id)
  const sidebar = page.locator('aside[aria-label="侧栏"]')
  const assistant = page.getByRole('complementary', { name: '助手', exact: true })
  const openAssistant = async () => {
    await page.getByRole('button', { name: '打开助手', exact: true }).click()
    await expect(assistant.getByPlaceholder('让小满帮你做点什么…')).toBeFocused()
  }
  await expect(sidebar).toHaveAttribute('aria-hidden', 'false')
  await openAssistant()
  await expect(sidebar).toHaveAttribute('aria-hidden', 'true')
  await expect(sidebar).toHaveAttribute('inert', '')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.__plein.engine as unknown as { camera: { insets: { left: number } } }).camera
            .insets.left,
      ),
    )
    .toBe(0)
  expect(await page.evaluate(() => localStorage.getItem('plein:sidebar'))).not.toBe('closed')
  await page.getByRole('button', { name: '缩放选项', exact: true }).click()
  await page.getByRole('button', { name: /^适应画布/ }).click()
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const engine = window.__plein.engine
        const r = engine.doc.worldRect(id)
        const a = engine.worldToClient(r.x, r.y)
        const b = engine.worldToClient(r.x + r.w, r.y + r.h)
        return a.x >= 0 && b.x <= 800 - 424 && a.y >= 64 && b.y <= 836
      }, id),
    )
    .toBe(true)
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(sidebar).toHaveAttribute('aria-hidden', 'false')
  const handle = page.getByRole('separator', { name: '调整侧栏宽度', exact: true })
  await handle.focus()
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', '480')
  await page.setViewportSize({ width: 1100, height: 900 })
  await expect(sidebar).toHaveAttribute('aria-hidden', 'true')
  await page.screenshot({ path: test.info().outputPath('assistant-with-canvas-space.png') })
  await page.keyboard.press('ControlOrMeta+Backslash')
  await expect(assistant).toHaveCount(0)
  await expect(sidebar).toHaveAttribute('aria-hidden', 'false')
  await expect(handle).toHaveAttribute('aria-valuenow', '480')
  await openAssistant()
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
  await expect(assistant).toHaveCount(0)
  await expect(sidebar).toHaveAttribute('aria-hidden', 'false')
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
  await openAssistant()
  await page.getByRole('button', { name: '收起助手', exact: true }).click()
  await expect(sidebar).toHaveAttribute('aria-hidden', 'true')
  expect(await page.evaluate(() => localStorage.getItem('plein:sidebar'))).toBe('closed')
})
