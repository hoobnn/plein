import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

const errors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
  const list: string[] = []
  errors.set(page, list)
  page.on('pageerror', (error) => list.push(error.message))
})
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]))
for (const label of ['快捷键', '生成历史', '设置']) {
  for (const mode of ['composition', 'legacy229', 'consumed']) {
    test(`${label} 的 ${mode} Esc 保留弹窗和焦点，普通 Esc 正常关闭`, async ({ page }) => {
      await newProject(page)
      await page.evaluate(() =>
        window.__plein.addNode({
          type: 'plein/text',
          name: '弹窗后方节点',
          params: { text: '保留正文' },
          x: 400,
          y: 300,
        }),
      )
      const before = await page.evaluate(() => [...window.__plein.engine.doc.elements()])
      const trigger = page.getByRole('button', { name: label, exact: true })
      await trigger.click()
      const dialog = page.getByRole('dialog', { name: label, exact: true })
      const close = dialog.getByRole('button', { name: '关闭', exact: true })
      await close.focus()
      if (mode === 'consumed')
        await close.evaluate((el) =>
          el.addEventListener('keydown', (e) => e.preventDefault(), { once: true }),
        )
      await close.dispatchEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        isComposing: mode === 'composition',
        keyCode: mode === 'legacy229' ? 229 : 27,
        bubbles: true,
        cancelable: true,
      })
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      await expect(dialog).toBeVisible({ timeout: 1500 })
      await expect(close).toBeFocused()
      expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(before)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(trigger).toBeFocused()
    })
  }
}

for (const mode of ['composition', 'legacy229']) {
  test(`${mode} 组字取消新建画布不丢草稿，正常确认只创建一次`, async ({ page }, testInfo) => {
    await newProject(page)
    const original = page.url()
    const open = async () => {
      await page.getByRole('button', { name: '切换画布', exact: true }).click()
      await page.getByRole('button', { name: '新建画布', exact: true }).click()
    }
    await open()
    const dialog = page.getByRole('dialog', { name: '新建画布', exact: true })
    const input = dialog.getByRole('textbox', { name: '画布名称', exact: true })
    await input.fill('还在组字的草稿 🌧️')
    await input.dispatchEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      isComposing: mode === 'composition',
      keyCode: mode === 'legacy229' ? 229 : 27,
      bubbles: true,
      cancelable: true,
    })
    await expect(dialog).toBeVisible()
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('还在组字的草稿 🌧️')
    expect(page.url()).toBe(original)
    await page.screenshot({
      path: testInfo.outputPath('prompt-composition.png'),
      animations: 'disabled',
    })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(page.url()).toBe(original)
    await open()
    await expect(input).not.toHaveValue('还在组字的草稿 🌧️')
    const title = `正常确认 ${mode}`
    await input.fill(title)
    await input.press('Enter')
    await expect(dialog).toHaveCount(0)
    await expect(page).not.toHaveURL(original)
    await expect(page.getByRole('button', { name: '切换画布', exact: true })).toContainText(title)
    await page.getByRole('button', { name: '切换画布', exact: true }).click()
    await expect(page.getByRole('button', { name: title, exact: true })).toHaveCount(1)
  })
}
