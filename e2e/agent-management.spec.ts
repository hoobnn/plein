import { expect, test, type Page } from '@playwright/test'
import type {
  AgentContext,
  AgentModelCatalog,
  AgentSession,
  AgentSettings,
} from '../packages/protocol/src/agent'
import { elements, newProject } from './canvas'

const catalogs: Record<string, AgentModelCatalog> = {
  codex: {
    defaultModel: 'codex-fast',
    models: [
      {
        id: 'codex-fast',
        title: 'Codex Fast',
        reasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'codex-deep',
        title: 'Codex Deep',
        description: '用于模型切换回归的目录项',
        reasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium',
      },
    ],
  },
  claude: {
    defaultModel: 'claude-sonnet',
    models: [{ id: 'claude-sonnet', title: 'Claude Sonnet' }],
  },
}

function session(
  id: string,
  settings: AgentSettings = { model: 'codex-fast', reasoningEffort: 'medium' },
  context: AgentContext = { source: 'unavailable', messages: 2 },
): AgentSession {
  return {
    id,
    canvasId: '',
    agent: 'codex',
    title: id,
    status: 'idle',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    settings,
    context,
    items: [
      { id: `${id}-question`, type: 'user', text: `${id} 的问题`, at: Date.now() },
      { id: `${id}-answer`, type: 'text', text: `${id} 的回复`, at: Date.now() },
    ],
  }
}

/** 所有模型和智能体请求都在浏览器边界模拟，绝不启动用户的 CLI 或外部模型。 */
async function mockAgent(page: Page, histories: AgentSession[] = []) {
  const state = {
    sessions: histories,
    created: [] as Array<{ agent: string; settings?: AgentSettings }>,
    patched: [] as Array<{ id: string; settings: AgentSettings }>,
    sent: [] as Array<{ id: string; text: string }>,
    resets: [] as string[],
    modelRequests: [] as string[],
  }
  await page.addInitScript(() => localStorage.setItem('plein:agent', 'codex'))
  await page.route('**/api/agent', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        agents: [
          { id: 'codex', name: 'Codex', available: true },
          { id: 'claude', name: 'Claude Code', available: true },
        ],
      },
    }),
  )
  await page.route(/\/api\/agent\/models\/[^/]+(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url())
    state.modelRequests.push(url.pathname + url.search)
    return route.fulfill({ json: catalogs[url.pathname.split('/').at(-1)!] })
  })
  await page.route('**/api/canvases/*/agent/sessions', (route) => {
    const canvasId = route.request().url().split('/').at(-3)!
    for (const old of state.sessions) old.canvasId = canvasId
    if (route.request().method() === 'GET') return route.fulfill({ json: state.sessions })
    const body = route.request().postDataJSON() as { agent: string; settings?: AgentSettings }
    state.created.push(body)
    const created = session(`新对话 ${state.created.length}`, body.settings ?? {})
    created.canvasId = canvasId
    created.agent = body.agent as AgentSession['agent']
    created.items = []
    state.sessions.unshift(created)
    return route.fulfill({ json: created })
  })
  await page.route(/\/api\/agent\/sessions\/[^/]+$/, (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!)
    const current = state.sessions.find((item) => item.id === id)
    if (!current) return route.fulfill({ status: 404, json: { message: '测试会话不存在' } })
    if (route.request().method() === 'PATCH') {
      const settings = route.request().postDataJSON() as AgentSettings
      state.patched.push({ id, settings })
      current.settings = settings
    }
    return route.fulfill({ json: current })
  })
  await page.route('**/api/agent/sessions/*/events', (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!)
    return route.fulfill({
      contentType: 'text/event-stream',
      body: `retry: 60000\ndata: ${JSON.stringify({ type: 'session', session: state.sessions.find((item) => item.id === id) })}\n\n`,
    })
  })
  await page.route('**/api/agent/sessions/*/messages', (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!)
    state.sent.push({ id, text: (route.request().postDataJSON() as { text: string }).text })
    return route.fulfill({ status: 204 })
  })
  await page.route('**/api/agent/sessions/*/context/reset', (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-3)!)
    const current = state.sessions.find((item) => item.id === id)!
    state.resets.push(id)
    current.context = { source: 'unavailable', messages: 0, resetAt: Date.now() }
    return route.fulfill({ json: current })
  })
  return state
}

async function openAssistant(page: Page) {
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  await expect(panel.getByRole('combobox', { name: '对话模型', exact: true })).toBeVisible()
  return panel
}

async function selectModel(page: Page, name: string) {
  await page.getByRole('combobox', { name: '对话模型', exact: true }).click()
  await page.getByRole('option', { name: new RegExp(`^${name}`) }).click()
}

async function selectEffort(page: Page, effort: 'low' | 'high') {
  await page.getByRole('combobox', { name: '推理强度', exact: true }).click()
  await page.getByRole('option', { name: effort === 'high' ? /^(high|高)/ : /^(low|低)/ }).click()
}

async function selectHistory(page: Page, name: string) {
  await page.getByRole('button', { name: '历史对话', exact: true }).click()
  await page
    .getByRole('dialog', { name: '历史对话', exact: true })
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .click()
}

test('新对话携带模型和推理强度，已有对话修改通过 PATCH 保存', async ({ page }) => {
  const mock = await mockAgent(page)
  await newProject(page)
  const panel = await openAssistant(page)
  await selectModel(page, 'Codex Deep')
  await selectEffort(page, 'high')
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await input.fill('使用选定的模型开始')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect
    .poll(() => mock.created)
    .toEqual([{ agent: 'codex', settings: { model: 'codex-deep', reasoningEffort: 'high' } }])
  await expect.poll(() => mock.sent.length).toBe(1)
  await expect(input).toHaveValue('')
  await selectEffort(page, 'low')
  await expect
    .poll(() => mock.patched)
    .toEqual([
      { id: mock.sessions[0]!.id, settings: { model: 'codex-deep', reasoningEffort: 'low' } },
    ])
  expect(mock.created).toHaveLength(1)
  await expect(panel.getByRole('combobox', { name: '对话模型', exact: true })).toContainText(
    'Codex Deep',
  )
  await page.screenshot({
    path: test.info().outputPath('agent-management-desktop.png'),
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 390, height: 844 })
  const bounds = await panel.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  await expect(input).toBeVisible()
  await page.screenshot({
    path: test.info().outputPath('agent-management-mobile.png'),
    animations: 'disabled',
  })
})

test('历史对话恢复各自模型与强度，不把另一个智能体的配置带入续聊', async ({ page }) => {
  const first = session('Codex 历史', { model: 'codex-deep', reasoningEffort: 'high' })
  const second = session('Claude 历史', { model: 'claude-sonnet' })
  second.agent = 'claude'
  const mock = await mockAgent(page, [first, second])
  await newProject(page)
  const panel = await openAssistant(page)
  const model = panel.getByRole('combobox', { name: '对话模型', exact: true })
  await expect(model).toContainText('Codex Deep')
  await expect(panel.getByRole('combobox', { name: '推理强度', exact: true })).toContainText(
    /high|高/,
  )
  await selectHistory(page, 'Claude 历史')
  await expect(model).toContainText('Claude Sonnet')
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await input.fill('继续 Claude 历史')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => mock.sent).toEqual([{ id: second.id, text: '继续 Claude 历史' }])
  await selectHistory(page, 'Codex 历史')
  await expect(model).toContainText('Codex Deep')
  await expect(panel.getByRole('combobox', { name: '推理强度', exact: true })).toContainText(
    /high|高/,
  )
  expect(mock.created).toEqual([])
  expect(mock.patched).toEqual([])
})

test('保存模型失败保留原配置和草稿，重试后才使用新模型', async ({ page }) => {
  const original = session('模型保存失败')
  const mock = await mockAgent(page, [original])
  let failed = 0
  await page.route(/\/api\/agent\/sessions\/[^/]+$/, (route) => {
    if (route.request().method() !== 'PATCH' || failed++) return route.fallback()
    return route.fulfill({ status: 503, json: { message: '模型配置暂时无法保存' } })
  })
  await newProject(page)
  const panel = await openAssistant(page)
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await input.fill('修改模型时保留的草稿')
  await selectModel(page, 'Codex Deep')
  await expect(panel.getByRole('alert')).toContainText('模型配置暂时无法保存')
  await expect(panel.getByRole('combobox', { name: '对话模型', exact: true })).toContainText(
    'Codex Fast',
  )
  await expect(input).toHaveValue('修改模型时保留的草稿')
  expect(original.settings?.model).toBe('codex-fast')
  expect(mock.sent).toEqual([])
  await selectModel(page, 'Codex Deep')
  await expect.poll(() => mock.patched.length).toBe(1)
  await expect(panel.getByRole('combobox', { name: '对话模型', exact: true })).toContainText(
    'Codex Deep',
  )
  await expect(input).toHaveValue('修改模型时保留的草稿')
})

test('迟到的模型保存结果不覆盖已切换历史的模型或草稿', async ({ page }) => {
  const old = session('等待保存的历史')
  const target = session('目标历史', { model: 'codex-fast', reasoningEffort: 'low' })
  await mockAgent(page, [old, target])
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let requests = 0
  let replied = false
  await page.route(/\/api\/agent\/sessions\/[^/]+$/, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    requests++
    const settings = route.request().postDataJSON() as AgentSettings
    await gate
    await route.fulfill({ json: { ...old, settings } })
    replied = true
  })
  await newProject(page)
  const panel = await openAssistant(page)
  await selectModel(page, 'Codex Deep')
  await expect.poll(() => requests).toBe(1)
  await expect(panel.getByRole('combobox', { name: '对话模型', exact: true })).toBeDisabled()
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
  await selectHistory(page, '目标历史')
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await input.fill('属于目标历史的草稿')
  await expect(panel.getByText('目标历史 的回复', { exact: true })).toBeVisible()
  release()
  await expect.poll(() => replied).toBe(true)
  await expect(panel.getByRole('combobox', { name: '对话模型', exact: true })).toContainText(
    'Codex Fast',
  )
  await expect(panel.getByRole('combobox', { name: '推理强度', exact: true })).toContainText(
    /low|低/,
  )
  await expect(panel.getByText('等待保存的历史 的回复', { exact: true })).toHaveCount(0)
  await expect(input).toHaveValue('属于目标历史的草稿')
})

for (const phase of ['running', 'sending'] as const) {
  test(`${phase === 'running' ? '智能体运行' : '发送等待'}期间不能切换模型或重置上下文`, async ({
    page,
  }) => {
    const current = session('配置锁定')
    if (phase === 'running') current.status = 'running'
    const mock = await mockAgent(page, [current])
    let release!: () => void
    let requests = 0
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    if (phase === 'sending') {
      await page.route('**/api/agent/sessions/*/messages', async (route) => {
        requests++
        await gate
        await route.fulfill({ status: 204 })
      })
    }
    await newProject(page)
    const panel = await openAssistant(page)
    if (phase === 'sending') {
      await panel.getByPlaceholder('让小满帮你做点什么…').fill('等待消息发送')
      await panel.getByRole('button', { name: '发送', exact: true }).click()
      await expect.poll(() => requests).toBe(1)
    }
    await expect(panel.getByRole('combobox', { name: '对话模型', exact: true })).toBeDisabled()
    await expect(panel.getByRole('combobox', { name: '推理强度', exact: true })).toBeDisabled()
    await panel.getByRole('button', { name: '上下文管理', exact: true }).click()
    const context = page.getByRole('dialog', { name: '上下文管理', exact: true })
    await expect(context.getByRole('button', { name: '重置上下文', exact: true })).toBeDisabled()
    expect(mock.patched).toEqual([])
    expect(mock.resets).toEqual([])
    if (phase === 'sending') release()
  })
}

test('上下文显示提供方预算，重置失败保留历史，成功重置保留画布和草稿', async ({ page }) => {
  const original = session('保留历史', undefined, {
    source: 'provider',
    tokens: 12000,
    limit: 100000,
    messages: 2,
    model: 'codex-fast',
  })
  const mock = await mockAgent(page, [original])
  let failures = 0
  await page.route('**/api/agent/sessions/*/context/reset', (route) => {
    if (failures++) return route.fallback()
    return route.fulfill({ status: 503, json: { message: '上下文暂时无法重置' } })
  })
  await newProject(page)
  await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/text',
      name: '上下文重置应保留的画布内容',
      params: { text: '仍然存在' },
      x: 200,
      y: 200,
    }),
  )
  const before = await elements(page)
  const panel = await openAssistant(page)
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await input.fill('重置期间保留的草稿')
  await panel.getByRole('button', { name: '上下文管理', exact: true }).click()
  const context = page.getByRole('dialog', { name: '上下文管理', exact: true })
  await expect(context).toContainText('CLI 报告 · 最近一次请求')
  await expect(context).toContainText('历史对话')
  await expect(context).toContainText('由本机 CLI 维护')
  await expect(context).toContainText('Plein 指令及 CLI 自身配置')
  await expect(context.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '12')
  await expect(panel.getByRole('button', { name: '上下文管理', exact: true })).toContainText('12%')
  await page.screenshot({
    path: test.info().outputPath('agent-context-provider-desktop.png'),
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect
    .poll(
      async () => {
        const bounds = await context.boundingBox()
        return !!bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390
      },
      { message: '缩窄视口后上下文弹层应重新定位到视口内' },
    )
    .toBe(true)
  await page.screenshot({
    path: test.info().outputPath('agent-context-provider-mobile.png'),
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  const reset = context.getByRole('button', { name: '重置上下文', exact: true })
  await reset.click()
  await expect(page.getByRole('alert')).toContainText('上下文暂时无法重置')
  await expect(panel.getByText('保留历史 的回复', { exact: true })).toBeVisible()
  await expect(input).toHaveValue('重置期间保留的草稿')
  expect(await elements(page)).toEqual(before)
  await reset.click()
  await expect.poll(() => mock.resets).toEqual([original.id])
  await expect(context.getByRole('status')).toContainText('重新建立上下文')
  await expect(panel.getByText('保留历史 的问题', { exact: true })).toBeVisible()
  await expect(panel.getByText('保留历史 的回复', { exact: true })).toBeVisible()
  await expect(input).toHaveValue('重置期间保留的草稿')
  expect(await elements(page)).toEqual(before)
  expect(original.items).toHaveLength(2)
  await page.screenshot({
    path: test.info().outputPath('agent-context-reset.png'),
    animations: 'disabled',
  })
})

for (const source of ['estimate', 'unavailable'] as const) {
  test(`上下文来源 ${source} 不把未知模型预算显示成已知百分比`, async ({ page }) => {
    const context: AgentContext =
      source === 'estimate'
        ? { source, tokens: 8000, bytes: 24000, messages: 2, omittedRounds: 3 }
        : { source, messages: 2 }
    await mockAgent(page, [session('预算来源', undefined, context)])
    await newProject(page)
    const panel = await openAssistant(page)
    await panel.getByRole('button', { name: '上下文管理', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '上下文管理', exact: true })
    await expect(dialog).toContainText(source === 'estimate' ? /估算/ : '尚无可用的用量报告')
    expect(await dialog.innerText()).not.toMatch(/\d+(?:\.\d+)?\s*%/)
    await expect(dialog.getByRole('progressbar')).toHaveCount(0)
    if (source === 'estimate') {
      await expect(dialog).toContainText('较早的 3 组历史未发送')
      await expect(dialog).toContainText('24,000 bytes')
    }
  })
}

test('模型目录读取失败保留当前模型和草稿，重试恢复目录而不改写会话', async ({ page }) => {
  const current = session('模型目录恢复', { model: 'codex-deep', reasoningEffort: 'high' })
  const mock = await mockAgent(page, [current])
  let requests = 0
  await page.route(/\/api\/agent\/models\/codex(?:\?.*)?$/, (route) => {
    if (requests++) return route.fallback()
    return route.fulfill({ status: 503, json: { message: '模型服务暂时离线' } })
  })
  await newProject(page)
  const panel = await openAssistant(page)
  const model = panel.getByRole('combobox', { name: '对话模型', exact: true })
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await expect(panel.getByRole('alert')).toContainText('模型目录读取失败')
  await expect(model).toContainText('codex-deep')
  await input.fill('读取目录时保留的草稿')
  await panel.getByRole('button', { name: '重新读取模型', exact: true }).click()
  await expect(model).toContainText('Codex Deep')
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await expect(input).toHaveValue('读取目录时保留的草稿')
  expect(requests).toBe(2)
  expect(mock.modelRequests).toHaveLength(1)
  expect(mock.modelRequests[0]).toBe('/api/agent/models/codex?refresh=1')
  expect(mock.patched).toEqual([])
  expect(mock.sent).toEqual([])
})

test('SSE 配置事件更新模型和上下文用量，不重新创建或发送会话', async ({ page }) => {
  const current = session('实时上下文')
  const mock = await mockAgent(page, [current])
  const settings = { model: 'codex-deep', reasoningEffort: 'high' }
  const context = { source: 'provider', tokens: 40000, limit: 100000, messages: 2 }
  await page.route('**/api/agent/sessions/*/events', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `retry: 60000\ndata: ${JSON.stringify({ type: 'session', session: current })}\n\ndata: ${JSON.stringify({ type: 'configuration', settings, context })}\n\n`,
    }),
  )
  await newProject(page)
  const panel = await openAssistant(page)
  await expect(panel.getByRole('combobox', { name: '对话模型', exact: true })).toContainText(
    'Codex Deep',
  )
  await expect(panel.getByRole('combobox', { name: '推理强度', exact: true })).toContainText('高')
  await expect(panel.getByRole('button', { name: '上下文管理', exact: true })).toContainText('40%')
  await panel.getByRole('button', { name: '上下文管理', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '上下文管理', exact: true })
  await expect(dialog.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
  await expect(panel.getByText('实时上下文 的回复', { exact: true })).toBeVisible()
  expect(mock.created).toEqual([])
  expect(mock.patched).toEqual([])
  expect(mock.sent).toEqual([])
})

test('迟到的上下文重置结果不清空已切换历史的配置、用量或草稿', async ({ page }) => {
  const original = session('等待重置的历史')
  const target = session(
    '重置期间切换的历史',
    { model: 'codex-deep', reasoningEffort: 'high' },
    {
      source: 'provider',
      tokens: 25000,
      limit: 100000,
      messages: 2,
    },
  )
  await mockAgent(page, [original, target])
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let requests = 0
  let replied = false
  await page.route('**/api/agent/sessions/*/context/reset', async (route) => {
    requests++
    await gate
    await route.fulfill({
      json: { ...original, context: { source: 'unavailable', messages: 0, resetAt: Date.now() } },
    })
    replied = true
  })
  await newProject(page)
  const panel = await openAssistant(page)
  await panel.getByRole('button', { name: '上下文管理', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '上下文管理', exact: true })
  await dialog.getByRole('button', { name: '重置上下文', exact: true }).click()
  await expect.poll(() => requests).toBe(1)
  await expect(dialog.getByRole('button', { name: '重置上下文', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await selectHistory(page, '重置期间切换的历史')
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await input.fill('仍属于目标历史的草稿')
  release()
  await expect.poll(() => replied).toBe(true)
  await expect(panel.getByText('重置期间切换的历史 的回复', { exact: true })).toBeVisible()
  await expect(panel.getByRole('combobox', { name: '对话模型', exact: true })).toContainText(
    'Codex Deep',
  )
  await expect(panel.getByRole('button', { name: '上下文管理', exact: true })).toContainText('25%')
  await expect(input).toHaveValue('仍属于目标历史的草稿')
})

test('恢复 CLI 默认提交空配置并清除原推理强度，保留历史和草稿', async ({ page }) => {
  const current = session('恢复默认配置', { model: 'codex-deep', reasoningEffort: 'high' })
  const mock = await mockAgent(page, [current])
  await page.route(/\/api\/agent\/sessions\/[^/]+$/, (route) => {
    if (route.request().method() === 'PATCH') {
      expect(route.request().postDataJSON()).toEqual({})
      current.context = { source: 'unavailable', messages: 0, resetAt: Date.now() }
    }
    return route.fallback()
  })
  await newProject(page)
  const panel = await openAssistant(page)
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await expect(panel.getByRole('combobox', { name: '对话模型', exact: true })).toContainText(
    'Codex Deep',
  )
  await input.fill('恢复默认仍保留的草稿')
  await panel.getByRole('combobox', { name: '对话模型', exact: true }).click()
  await page.getByRole('option', { name: '跟随 CLI 配置', exact: true }).click()
  await expect.poll(() => mock.patched).toEqual([{ id: current.id, settings: {} }])
  await expect(panel.getByRole('combobox', { name: '对话模型', exact: true })).toHaveText(
    '跟随 CLI 配置',
  )
  await expect(panel.getByRole('combobox', { name: '推理强度', exact: true })).toHaveCount(0)
  await expect(panel.getByText('恢复默认配置 的回复', { exact: true })).toBeVisible()
  await expect(input).toHaveValue('恢复默认仍保留的草稿')
  await panel.getByRole('button', { name: '上下文管理', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '上下文管理', exact: true })).toContainText(
    '重新建立上下文',
  )
  expect(mock.created).toEqual([])
  expect(mock.sent).toEqual([])
})
