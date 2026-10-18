import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

async function setup(page: Page) {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '恢复输入测试',
      params: {},
      x: 300,
      y: 200,
    }),
  )
  await page.route('**/api/canvases/*/jobs', (route) =>
    route.fulfill({
      json: {
        jobs: [
          {
            id: 'keyboard-job',
            nodeId: id,
            nodeType: 'plein/image',
            status: 'failed',
            attempts: 1,
            createdAt: Date.now(),
            recovery: { state: 'submit_unknown', attachable: true },
          },
        ],
        groups: [],
      },
    }),
  )
  const calls: unknown[] = []
  await page.route('**/jobs/keyboard-job/recover', (route) => {
    calls.push(route.request().postDataJSON())
    return route.fulfill({
      status: 503,
      json: { error: 'recover_failed', message: '任务 ID 核查测试失败' },
    })
  })
  const toolbar = page.getByRole('button', { name: '任务', exact: true })
  await toolbar.click()
  const panel = page.getByRole('complementary', { name: '任务', exact: true })
  const attach = panel.getByRole('button', { name: '填写平台任务 ID', exact: true })
  await attach.click()
  const input = panel.getByRole('textbox', { name: '平台任务 ID', exact: true })
  return { toolbar, panel, attach, input, calls }
}

for (const mode of ['composing', 'legacy', 'end-229'] as const) {
  test(`平台任务 ID 的 IME ${mode} 不提交或关闭，普通 Enter 与分层 Escape 正常`, async ({
    page,
  }) => {
    const f = await setup(page)
    await f.input.fill('remote-keyboard-id')
    for (const key of ['Enter', 'Escape']) {
      const prevented = await f.input.evaluate(
        (node, { mode, key }) => {
          node.dispatchEvent(
            new CompositionEvent('compositionstart', { bubbles: true, data: 'ren' }),
          )
          if (mode === 'end-229')
            node.dispatchEvent(
              new CompositionEvent('compositionend', { bubbles: true, data: '任' }),
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
          // 受控模拟浏览器在组字确认键后触发表单提交，检查业务层也有保护。
          if (key === 'Enter') (node as HTMLInputElement).form!.requestSubmit()
          return event.defaultPrevented
        },
        { mode, key },
      )
      expect(prevented).toBe(false)
      expect(f.calls).toEqual([])
      await expect(f.panel).toBeVisible()
      await expect(f.input).toHaveValue('remote-keyboard-id')
      await f.input.evaluate((node) =>
        node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '任' })),
      )
    }
    await f.input.press('Enter')
    await expect.poll(() => f.calls).toEqual([{ action: 'attach', remoteId: 'remote-keyboard-id' }])
    await expect(f.panel.getByRole('alert')).toHaveText('任务 ID 核查测试失败')
    await f.input.press('Escape')
    await expect(f.input).toHaveCount(0)
    await expect(f.panel).toBeVisible()
    await expect(f.attach).toBeFocused()
    await f.attach.press('Escape')
    await expect(f.panel).toHaveCount(0)
    await expect(f.toolbar).toBeFocused()
  })
}

test('任务表单自动聚焦、尊重已处理 Escape，取消与上层设置关闭不误关任务', async ({ page }) => {
  const f = await setup(page)
  await expect(f.input).toBeFocused()
  await f.input.fill('保留中的平台任务 ID')
  await f.input.evaluate((node) =>
    node.addEventListener('keydown', (e) => e.preventDefault(), { once: true }),
  )
  await f.input.press('Escape')
  await expect(f.input).toHaveValue('保留中的平台任务 ID')
  await expect(f.panel).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings).toBeVisible()
  await settings.press('Escape')
  await expect(settings).toHaveCount(0)
  await expect(f.panel).toBeVisible()
  await expect(f.input).toHaveValue('保留中的平台任务 ID')
  await f.panel.getByRole('button', { name: '取消', exact: true }).click()
  await expect(f.attach).toBeFocused()
  expect(f.calls).toEqual([])
  await f.panel.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(f.panel).toHaveCount(0)
  await expect(f.toolbar).toBeFocused()
  await page.screenshot({
    path: test.info().outputPath('task-keyboard-focus.png'),
    animations: 'disabled',
  })
})

for (const close of ['Escape', 'button'] as const) {
  test(`重新提交确认通过 ${close} 取消，只退出确认并返回原入口`, async ({ page }) => {
    const f = await setup(page)
    await f.input.press('Escape')
    const trigger = f.panel.getByRole('button', { name: '确认未受理，重新提交', exact: true })
    await trigger.click()
    const resubmit = f.panel.getByRole('button', { name: '重新提交', exact: true })
    const cancel = f.panel.getByRole('button', { name: '取消', exact: true })
    await expect(resubmit).toBeVisible()
    await expect(cancel).toBeFocused()
    if (close === 'Escape') await page.keyboard.press('Escape')
    else await cancel.click()
    await expect(f.panel).toBeVisible()
    await expect(resubmit).toHaveCount(0)
    await expect(trigger).toBeFocused()
    expect(f.calls).toEqual([])
    await page.keyboard.press('Escape')
    await expect(f.panel).toHaveCount(0)
    await expect(f.toolbar).toBeFocused()
  })
}
