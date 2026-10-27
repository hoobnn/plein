import { expect, test } from './fixtures'
import { newProject } from './canvas'

for (const theme of ['light', 'dark'] as const) {
  test(`${theme} 主题预览可切换，辅助文字在各级阅读材质上清晰可读`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('plein.welcome', '1'))
    await page.goto('/')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    const themes = settings.getByRole('group', { name: '主题', exact: true })
    await expect(themes.locator('[aria-hidden="true"].settings-theme-preview')).toHaveCount(3)
    const option = themes.getByRole('button', {
      name: theme === 'light' ? '浅色' : '深色',
      exact: true,
    })
    await option.click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(option).toHaveAttribute('aria-pressed', 'true')
    const contrast = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      const luminance = (hex: string) => {
        const raw = hex.trim().replace('#', '')
        const full = raw.length === 3 ? raw.replace(/./g, (v) => v + v) : raw
        const values = full.match(/../g)!.map((v) => {
          const s = Number.parseInt(v, 16) / 255
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
        })
        return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722
      }
      const text = luminance(style.getPropertyValue('--ink-subtle'))
      return ['--canvas', '--surface', '--surface-2', '--surface-3'].map((token) => {
        const background = luminance(style.getPropertyValue(token))
        return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05)
      })
    })
    for (const ratio of contrast) expect(ratio).toBeGreaterThanOrEqual(4.5)
    await page.setViewportSize({ width: 320, height: 800 })
    await expect.poll(() => themes.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
  })
}

test('减少动态效果即时生效，组件具体样式不会恢复循环动画或悬停位移', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.addInitScript(() => localStorage.setItem('plein.welcome', '1'))
  await newProject(page)
  const mascot = page.locator('.plein-mascot-body').first()
  await expect(mascot).toBeAttached()
  expect(await mascot.evaluate((el) => getComputedStyle(el).animationDuration)).not.toBe('0s')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect
    .poll(() => mascot.evaluate((el) => Number.parseFloat(getComputedStyle(el).animationDuration)))
    .toBeLessThanOrEqual(0.001)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  expect(
    await dialog.evaluate((el) => Number.parseFloat(getComputedStyle(el).animationDuration)),
  ).toBeLessThanOrEqual(0.001)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await page.goto('/')
  const card = page.locator('.home-card').first()
  await card.hover()
  await expect(card).toHaveCSS('transform', 'none')
  expect(
    await card.evaluate((el) => Number.parseFloat(getComputedStyle(el).transitionDuration)),
  ).toBeLessThanOrEqual(0.001)
})
