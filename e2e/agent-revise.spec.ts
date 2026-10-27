import { expect, type Page, test } from './fixtures'
import { clickElement, elements, newProject, waitEngine, waitNode } from './canvas'

async function setup(page: Page) {
  await newProject(page)
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await input.fill('画一张雨夜天台')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect(panel.getByText('【mock】好了')).toBeVisible()
  await input.fill('让画面更紧张')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  const card = panel.locator('.plein-edit-plan')
  await card.getByRole('button', { name: '改提示词', exact: true }).click()
  const field = card.getByRole('textbox', { name: '提示词改成', exact: true })
  await expect(field).toBeFocused()
  return { panel, input, card, field }
}

test('只出候选图保留采用结果，刷新后仍需手动采用且可撤销重做', async ({ page }) => {
  const { panel, input, card, field } = await setup(page)
  await field.press('Escape')
  const id = (await elements(page)).find((el) => el.nodeType === 'plein/image')!.id
  const adopted = () => page.evaluate((id) => window.__plein.engine.doc.get(id)?.adopted, id)
  const original = await adopted()
  await card.getByRole('button', { name: '只出候选图', exact: true }).click()
  await expect(panel.getByText('【mock】方案已经按你选的范围执行。')).toBeVisible()
  await waitNode(page, id)
  expect(await adopted()).toBe(original)
  const candidate = await page.evaluate(
    ({ id, original }) =>
      window.__plein.engine.doc.get(id)?.results?.find((r) => r.id !== original),
    { id, original },
  )
  expect(candidate).toBeDefined()
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
  const jobs = await (await page.request.get(`/api/canvases/${canvas}/jobs`)).json()
  expect(jobs.jobs.find((j: { id: string }) => j.id === candidate!.runId)?.recovery).toMatchObject({
    state: 'stored',
    held: 'candidate_only',
  })
  await input.press('Escape')
  await page.getByRole('button', { name: '任务', exact: true }).click()
  const tasks = page.getByRole('complementary', { name: '任务', exact: true })
  await expect(tasks).toContainText('仅生成候选，保留原采用结果')
  await tasks.screenshot({ path: test.info().outputPath('candidate-only-task-state.png') })
  await tasks.getByRole('button', { name: '关闭', exact: true }).click()
  await page.reload()
  await waitEngine(page)
  expect(await adopted()).toBe(original)
  await clickElement(page, id)
  await page.locator('.plein-node').getByRole('button', { name: '下一个结果', exact: true }).click()
  const viewer = page.getByRole('dialog', { name: /查看「/ })
  const adopt = viewer.getByRole('button', { name: '采用此候选', exact: true })
  await expect(adopt).toBeEnabled()
  expect(await adopted()).toBe(original)
  await adopt.click()
  expect(await adopted()).toBe(candidate!.id)
  await viewer.screenshot({ path: test.info().outputPath('candidate-only-manual-adoption.png') })
  await viewer.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(adopted).toBe(original)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect.poll(adopted).toBe(candidate!.id)
})

test('取消逐项编辑回到原入口，可用键盘重新编辑，取消内容不提交', async ({ page }) => {
  const { panel, card, field } = await setup(page)
  const original = await field.inputValue()
  await field.fill('这段取消的文字不能进入方案')
  await field.press('Escape')
  await expect(field).toHaveCount(0)
  const trigger = card.getByRole('button', { name: '改提示词', exact: true })
  await expect(trigger).toBeFocused()
  await trigger.press('Enter')
  await expect(field).toBeFocused()
  await expect(field).toHaveValue(original)
  await card.getByRole('button', { name: '取消', exact: true }).click()
  await expect(trigger).toBeFocused()
  await expect(panel).toBeVisible()
})

test('重新检查完成后恢复编辑入口，用户已移开的焦点不被抢回', async ({ page }) => {
  const { input, card, field } = await setup(page)
  await field.fill('第一次重新检查后的文字')
  await field.press('ControlOrMeta+Enter')
  const trigger = card.getByRole('button', { name: '改提示词', exact: true })
  await expect(trigger).toBeFocused()
  await trigger.press('Enter')
  await expect(field).toBeFocused()
  await field.fill('第二次重新检查后的文字')
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/agent/sessions/*/approvals/*/plan', async (route) => {
    await gate
    await route.continue()
  })
  await field.press('ControlOrMeta+Enter')
  await expect(field).toBeDisabled()
  await input.focus()
  await input.fill('继续写自己的输入')
  release()
  await expect(field).toHaveCount(0)
  await expect(card).toContainText('第二次重新检查后的文字')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('继续写自己的输入')
})

test('方案逐项编辑的组字取消与确认键保留草稿，正常快捷键才重新检查', async ({ page }) => {
  const { panel, card, field } = await setup(page)
  await field.fill('雨后只留一盏灯')
  let requests = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/approvals\/[^/]+\/plan$/.test(r.url())) requests++
  })
  for (const mode of ['composing', 'legacy', 'end-229']) {
    for (const key of ['Escape', 'Enter']) {
      const prevented = await field.evaluate(
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
            metaKey: key === 'Enter',
            isComposing: mode === 'composing',
            bubbles: true,
            cancelable: true,
          })
          node.dispatchEvent(event)
          node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }))
          return event.defaultPrevented
        },
        { mode, key },
      )
      expect(prevented).toBe(false)
      await expect(field).toBeFocused()
      await expect(field).toHaveValue('雨后只留一盏灯')
      await expect(panel).toBeVisible()
    }
  }
  expect(requests).toBe(0)
  await field.press('ControlOrMeta+Enter')
  await expect(field).toHaveCount(0)
  await expect(card).toContainText('雨后只留一盏灯')
  expect(requests).toBe(1)
})

test('重新检查失败保留编辑内容，重试等待中重开面板仍锁定批准', async ({ page }) => {
  const { panel, input, card, field } = await setup(page)
  await field.fill('恢复后的新方案文字')
  let requests = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/agent/sessions/*/approvals/*/plan', async (route) => {
    requests++
    if (requests === 1)
      return route.fulfill({
        status: 503,
        json: { error: 'revise_failed', message: '重新检查测试失败' },
      })
    await gate
    await route.continue()
  })
  await card.getByRole('button', { name: '重新检查', exact: true }).click()
  await expect(card.getByRole('alert')).toHaveText('重新检查测试失败')
  await expect(field).toHaveValue('恢复后的新方案文字')
  await card.getByRole('button', { name: '重新检查', exact: true }).click()
  await expect(field).toBeDisabled()
  await input.press('Escape')
  await expect(panel).toHaveCount(0)
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  await expect(card).toHaveAttribute('data-revising', 'true')
  await expect(card.getByRole('button', { name: '只改文字', exact: true })).toBeDisabled()
  expect(requests).toBe(2)
  release()
  await expect(card).not.toHaveAttribute('data-revising')
  await expect(card).toContainText('恢复后的新方案文字')
  await expect(card.getByRole('button', { name: '只改文字', exact: true })).toBeEnabled()
  await page.screenshot({
    path: test.info().outputPath('agent-plan-revised.png'),
    animations: 'disabled',
  })
})
