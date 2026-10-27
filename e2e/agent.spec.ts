import { expect, test } from './fixtures'
import type { AgentSession } from '../packages/protocol/src/agent'
import { clickElement, elements, newProject, waitEngine, waitNode } from './canvas'

// UI 批准经真实 API 执行，再由同步文档回到画布；纯状态边界留在组件与合同测试。
test('计划和运行分别批准，修改只改文字，整轮撤销恢复原画布', { tag: '@core' }, async ({ page }) => {
  await newProject(page)
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await panel.getByRole('combobox', { name: '确认方式', exact: true }).click()
  await page.getByRole('option', { name: '每次运行和删除都先问我', exact: true }).click()
  await panel.getByRole('button', { name: '先出计划', exact: true }).click()
  await input.fill('画一张雨夜天台')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  const plan = panel.locator('.plein-agent-plan')
  await expect(plan.getByRole('button', { name: '同意并执行' })).toBeEnabled()
  expect(await elements(page)).toEqual([])
  await plan.getByRole('button', { name: '同意并执行' }).click()
  const allow = panel.getByRole('button', { name: '允许', exact: true })
  await expect(allow).toBeEnabled()
  await expect
    .poll(async () => (await elements(page)).find((el) => el.nodeType === 'plein/image')?.results)
    .toBe(0)
  await allow.click()
  await expect(panel.getByText('【mock】好了')).toBeVisible()
  await expect(plan.locator('[data-status="done"]')).toHaveCount(2)
  const id = (await elements(page)).find((el) => el.nodeType === 'plein/image')!.id
  const snapshot = () =>
    page.evaluate((id) => {
      const el = window.__plein.engine.doc.get(id)!
      return { prompt: el.params?.prompt, results: el.results?.map((result) => result.id) }
    }, id)
  const before = await snapshot()
  expect(before.results).toHaveLength(1)
  await panel.getByRole('button', { name: '先出计划', exact: true }).click()
  await input.fill('让画面更紧张')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  const card = panel.locator('.plein-edit-plan')
  await card.getByRole('button', { name: '改提示词', exact: true }).click()
  const field = card.getByRole('textbox', { name: '提示词改成', exact: true })
  await field.fill(`${before.prompt}，只留一盏顶灯`)
  await card.getByRole('button', { name: '重新检查', exact: true }).click()
  await expect(card).toContainText('只留一盏顶灯')
  expect(await snapshot()).toEqual(before)
  await card.getByRole('button', { name: '只改文字', exact: true }).click()
  await expect(card).toHaveAttribute('data-status', 'applied')
  await expect.poll(snapshot).toEqual({ ...before, prompt: `${before.prompt}，只留一盏顶灯` })
  await panel.getByRole('button', { name: '撤销这一轮', exact: true }).last().click()
  await expect.poll(snapshot).toEqual(before)
  await panel.getByRole('button', { name: '撤销这一轮', exact: true }).click()
  await expect.poll(() => elements(page)).toEqual([])
})

/** 原生 EventSource 自动重试：断线期间完成的会话补回未读，绝不重发消息 */
test('原生自动重连补回断线完成状态并提示未读', { tag: '@core' }, async ({ page }) => {
  await newProject(page)
  const canvas = new URL(page.url()).hash.split('/').at(-1)!
  const created = await page.request.post(`/api/canvases/${canvas}/agent/sessions`, {
    data: { agent: 'builtin' },
  })
  const { id } = (await created.json()) as { id: string }
  const read = async () =>
    (await (await page.request.get(`/api/agent/sessions/${id}`)).json()) as AgentSession
  await page.request.post(`/api/agent/sessions/${id}/messages`, {
    data: { text: '画一张雨夜天台', approval: 'always' },
  })
  await expect
    .poll(async () =>
      (await read()).items.some((item) => item.type === 'approval' && item.status === 'pending'),
    )
    .toBe(true)
  const running = await read()
  let requests = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/api/agent/sessions/${id}/events`, async (route) => {
    requests++
    if (requests === 1)
      return route.fulfill({
        contentType: 'text/event-stream',
        body: `retry: 100\ndata: ${JSON.stringify({ type: 'session', session: running })}\n\n`,
      })
    if (requests === 2) return route.abort('failed')
    await gate
    return route.continue()
  })
  const sent: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith(`/api/agent/sessions/${id}/messages`))
      sent.push(request.url())
  })
  await page.reload()
  const open = page.getByRole('button', { name: '打开助手', exact: true })
  await open.click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await expect(panel.getByRole('button', { name: '停止', exact: true })).toBeVisible()
  await input.fill('自动重连保留的草稿')
  await input.press('Escape')
  await expect.poll(() => requests).toBe(3)
  const approval = running.items.find(
    (item) => item.type === 'approval' && item.status === 'pending',
  )!
  expect(
    (
      await page.request.post(`/api/agent/sessions/${id}/approvals/${approval.id}`, {
        data: { allow: false },
      })
    ).ok(),
  ).toBe(true)
  await expect.poll(async () => (await read()).status).toBe('idle')
  release()
  await expect(open.getByRole('img', { name: '助手有新回复', exact: true })).toBeVisible()
  expect(sent).toEqual([])
  await open.click()
  await expect(
    panel.getByText('【mock】这次运行没有执行，已保留创建的节点。', { exact: true }),
  ).toBeVisible()
  await expect(panel.getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
  await expect(input).toHaveValue('自动重连保留的草稿')
  expect(sent).toEqual([])
})

test(
  '只出候选图保留采用结果，刷新后仍需手动采用且可撤销重做',
  { tag: '@core' },
  async ({ page }) => {
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
    expect(
      jobs.jobs.find((j: { id: string }) => j.id === candidate!.runId)?.recovery,
    ).toMatchObject({
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
    await page
      .locator('.plein-node')
      .getByRole('button', { name: '下一个结果', exact: true })
      .click()
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
  },
)

test('窄屏助手避让可点击，长会话原生翻页不穿透画布', { tag: '@core' }, async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 })
  await newProject(page)
  const nodeId = await page.evaluate(() =>
    window.__plein.addNode({ type: 'plein/text', name: '保留的画布内容', params: {}, x: 0, y: 0 }),
  )
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  const sidebar = page.locator('aside[aria-label="侧栏"]')
  await expect(sidebar).toHaveAttribute('aria-hidden', 'true')
  await expect(sidebar).toHaveAttribute('inert', '')
  expect(await page.evaluate(() => localStorage.getItem('plein:sidebar'))).not.toBe('closed')
  await input.fill('历史讨论：' + '先核对角色与节奏，再讨论后续安排。'.repeat(80))
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect(panel.getByText(/【mock】看过画布了/)).toBeVisible()
  await input.fill('缩放期间保留的草稿')
  for (const width of [390, 640, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window.__plein.engine as unknown as { camera: { insets: { right: number } } }).camera
              .insets.right,
        ),
      )
      .toBe(width >= 640 ? 424 : 0)
    for (const button of [
      page.getByRole('button', { name: '收起助手', exact: true }),
      panel.getByRole('button', { name: '发送', exact: true }),
    ]) {
      await expect
        .poll(() =>
          button.evaluate((el) => {
            const rect = el.getBoundingClientRect()
            return (
              document
                .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
                ?.closest('button') === el
            )
          }),
        )
        .toBe(true)
    }
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('缩放期间保留的草稿')
  }
  await expect(sidebar).toHaveAttribute('aria-hidden', 'false')
  const transcript = panel.getByRole('region', { name: '对话记录', exact: true })
  await transcript.focus()
  const bottom = await transcript.evaluate((el) => el.scrollTop)
  expect(bottom).toBeGreaterThan(500)
  await transcript.press('PageUp')
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBeLessThan(bottom - 100)
  await page.evaluate((id) => window.__plein.engine.selection.set([id]), nodeId)
  const before = await elements(page)
  await transcript.press('Delete')
  await transcript.press('ArrowDown')
  expect(await elements(page)).toEqual(before)
  await transcript.press('End')
  await expect
    .poll(() => transcript.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThan(2)
  await page.getByRole('button', { name: '收起助手', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.__plein.engine as unknown as { camera: { insets: { right: number } } }).camera
            .insets.right,
      ),
    )
    .toBe(0)
})
