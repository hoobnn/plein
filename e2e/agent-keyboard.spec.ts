import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

for (const mode of ['composing', 'legacy', 'end-229'] as const) {
  test(`助手 IME ${mode} 的确认和取消键保留输入，正常 Escape 关闭后返回开关`, async ({ page }) => {
    await newProject(page)
    await page.getByRole('button', { name: '打开助手', exact: true }).click()
    const panel = page.getByRole('complementary', { name: '助手', exact: true })
    const input = panel.getByPlaceholder('让小满帮你做点什么…')
    await expect(input).toBeFocused()
    await input.fill('中文组字中的未发送内容')
    const sends: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/agent/')) sends.push(r.url())
    })
    for (const key of ['Enter', 'Escape']) {
      const prevented = await input.evaluate(
        (node, { mode, key }) => {
          node.dispatchEvent(
            new CompositionEvent('compositionstart', { bubbles: true, data: 'zhong' }),
          )
          if (mode === 'end-229')
            node.dispatchEvent(
              new CompositionEvent('compositionend', { bubbles: true, data: '中' }),
            )
          const event = new KeyboardEvent('keydown', {
            key,
            code: key,
            keyCode: mode === 'end-229' ? 229 : key === 'Enter' ? 13 : 27,
            isComposing: mode === 'composing',
            bubbles: true,
            cancelable: true,
          })
          node.dispatchEvent(event)
          return event.defaultPrevented
        },
        { mode, key },
      )
      expect(prevented).toBe(false)
      await expect(input).toBeFocused()
      await expect(input).toHaveValue('中文组字中的未发送内容')
      await expect(panel).toBeVisible()
      await input.evaluate((node) =>
        node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' })),
      )
    }
    expect(sends).toEqual([])
    await input.press('Escape')
    await expect(panel).toHaveCount(0)
    const trigger = page.getByRole('button', { name: '打开助手', exact: true })
    await expect(trigger).toBeFocused()
    await trigger.press('Enter')
    await expect(input).toBeFocused()
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(panel).toHaveCount(0)
    await expect(trigger).toBeFocused()
    if (mode === 'composing')
      await page.screenshot({ path: test.info().outputPath('agent-close-focus.png') })
  })
}

test('助手尊重已处理的 Escape，组字输入失焦后不阻断正常关闭', async ({ page }) => {
  await newProject(page)
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await expect(input).toBeFocused()
  await input.fill('不能被关闭覆盖的输入')
  await input.evaluate((node) =>
    node.addEventListener('keydown', (e) => e.preventDefault(), { once: true }),
  )
  await input.press('Escape')
  await expect(input).toBeFocused()
  await expect(panel).toBeVisible()
  await input.evaluate((node) =>
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'zhong' })),
  )
  const close = panel.getByRole('button', { name: '关闭', exact: true })
  await close.focus()
  await close.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(page.getByRole('button', { name: '打开助手', exact: true })).toBeFocused()
})
