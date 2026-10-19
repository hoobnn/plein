import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

test('提交未知可复制核查信息，复制失败可重试且不提交或恢复任务', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/speech',
      name: '核查信息复制',
      params: {},
      x: 400,
      y: 200,
    }),
  )
  let mutations = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/(?:run|recover)$/.test(request.url())) mutations++
  })
  await page.route('**/api/canvases/*/jobs', (route) =>
    route.fulfill({
      json: {
        groups: [],
        jobs: [
          {
            id: 'copy-evidence-fixture',
            nodeId: id,
            nodeType: 'plein/speech',
            status: 'failed',
            attempts: 1,
            createdAt: 1792425426642,
            startedAt: 1792425581695,
            finishedAt: 1792425881805,
            error:
              '模拟 504（客户端请求 ID 11111111-1111-4111-8111-111111111111；平台日志 ID platform-fixture-log）',
            input: {
              v: 1,
              nodeId: id,
              nodeType: 'plein/speech',
              status: 'ready',
              preparedAt: 1792425581695,
              model: {
                ref: 'doubao/speech:seed-tts-2.0',
                provider: 'doubao/speech',
                title: '豆包语音合成 2.0',
              },
              prompt: '此正文不应复制',
              params: { example: '此参数不应复制' },
              refs: [],
              inputs: {},
              notices: [],
              blocked: [],
            },
            recovery: {
              state: 'submit_unknown',
              provider: '豆包语音',
              attachable: false,
              refetchable: false,
            },
          },
        ],
      },
    }),
  )
  await page.getByRole('button', { name: '任务', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '任务', exact: true })
  const copy = panel.getByRole('button', { name: '复制核查信息', exact: true })
  await expect(copy).toBeVisible()
  await expect(panel.getByRole('button', { name: '填写平台任务 ID', exact: true })).toHaveCount(0)
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: () => Promise.reject(new DOMException('fixture denied', 'NotAllowedError')),
      },
    }),
  )
  await copy.click()
  await expect(panel.getByRole('alert')).toHaveText('复制核查信息失败，请重试')
  await expect(copy).toBeEnabled()
  await page.evaluate(() => Reflect.deleteProperty(navigator, 'clipboard'))
  await copy.click()
  await expect(page.getByText('核查信息已复制', { exact: true })).toBeVisible()
  const text = await page.evaluate(() => navigator.clipboard.readText())
  expect(text).toContain('copy-evidence-fixture（不是平台任务 ID）')
  expect(text).toContain('doubao/speech:seed-tts-2.0')
  expect(text).toContain('2026-10-19T15:59:41.695Z')
  expect(text).toContain('平台任务 ID：未记录')
  expect(text).toContain('11111111-1111-4111-8111-111111111111')
  expect(text).toContain('platform-fixture-log')
  expect(text).not.toContain('此正文不应复制')
  expect(text).not.toContain('此参数不应复制')
  await expect(panel.getByRole('alert')).toHaveCount(0)
  expect(mutations).toBe(0)
  await panel.screenshot({ path: test.info().outputPath('copy-recovery-evidence.png') })
})

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
