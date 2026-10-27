import { expect, type Locator, type Page, test } from './fixtures'
import type {
  AgentCanvasCapability,
  AgentKind,
  AgentSession,
  AgentSkill,
  AgentSkillCatalog,
} from '../packages/protocol/src/agent'
import { centerOf, elements, newProject, settle, waitEngine } from './canvas'
import { openCanvasSettings } from './settings-ui'

const nativeId = 'codex:0823b00f826fa7d4'
const nativeTitle = '品牌视觉指南'
const skillRows = [
  ['canvas-audit', '检查画布', '检查输入、依赖与陈旧结果。', 'optional'],
  ['workflow', '整理工作流', '核对连线、参考素材顺序与布局。', 'optional'],
  ['shot-revise', '优化选中镜头', '结合选中镜头提出可批准的优化方案。', 'required'],
  ['storyboard', '分镜规划与生成', '从完整故事规划分镜，复用已有角色和场景。', 'optional'],
  ['media-edit', '素材加工', '查看选中素材，保留原素材和处理依据。', 'required'],
] as const

const capabilities: AgentCanvasCapability[] = [
  {
    name: 'get_canvas_page',
    title: '读取画布',
    description: '分页查看当前画布的真实元素与连线。',
    group: '画布',
    effect: 'read',
    where: 'doc',
  },
  {
    name: 'inspect_node_input',
    title: '检查节点实际输入',
    description: '检查节点运行时实际输入、来源和顺序。',
    group: '输入与连线',
    effect: 'read',
    where: 'server',
  },
  {
    name: 'reorder_inputs',
    title: '调整参考顺序',
    description: '按来源元素 ID 调整目标端口的参考输入顺序。',
    group: '输入与连线',
    effect: 'edit',
    where: 'doc',
  },
  {
    name: 'replace_input',
    title: '替换参考输入',
    description: '用指定素材替换一个参考，保留其他输入和顺序。',
    group: '输入与连线',
    effect: 'edit',
    where: 'doc',
  },
]

function builtinSkills(): AgentSkill[] {
  return skillRows.map(([name, title, description, selection]) => ({
    id: `plein:${name}`,
    name,
    title,
    description,
    selection,
    source: 'plein',
    enabled: true,
    canToggle: true,
    prompt: `请使用「${title}」处理本轮明确要求的范围。`,
    capabilities:
      name === 'workflow'
        ? ['get_canvas_page', 'inspect_node_input', 'reorder_inputs', 'replace_input']
        : ['get_canvas_page', 'inspect_node_input'],
  }))
}

function nativeSkill(): AgentSkill {
  return {
    id: nativeId,
    name: 'brand-visual',
    title: nativeTitle,
    description: '沿用项目品牌字体、色彩和参考素材。',
    source: 'codex',
    enabled: true,
    selection: 'optional',
    canToggle: true,
    prompt: '按照品牌视觉指南继续完善当前作品。',
    capabilities: [],
    scope: 'user',
    path: '/mock-user/skills/brand-visual/SKILL.md',
  }
}

function history(id: string, agent: AgentKind = 'builtin'): AgentSession {
  return {
    id,
    canvasId: '',
    agent,
    title: id,
    status: 'idle',
    settings: {},
    context: { source: 'unavailable', messages: 1 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    items: [{ id: `${id}-answer`, type: 'text', text: `${id} 的既有讨论`, at: Date.now() }],
  }
}

/** CLI、技能、模型和对话均在浏览器 API 边界模拟，绝不发现或运行用户的本机 CLI。 */
async function mockAgent(
  page: Page,
  options: { agent?: AgentKind; histories?: AgentSession[] } = {},
) {
  const state = {
    sessions: options.histories ?? [],
    skills: {
      builtin: builtinSkills(),
      claude: builtinSkills(),
      codex: [...builtinSkills(), nativeSkill()],
    },
    created: [] as Array<{ agent: AgentKind }>,
    sent: [] as Array<{ sessionId: string; text: string; skill?: string; selection?: string[] }>,
    patches: [] as Array<{ agent: AgentKind; id: string; enabled: boolean }>,
    catalogs: [] as string[],
    details: [] as string[],
    patchError: null as string | null,
    detailError: null as string | null,
    catalogError: null as string | null,
    catalogFailure: null as string | null,
  }
  await page.addInitScript(
    (agent) => localStorage.setItem('plein:agent', agent),
    options.agent ?? 'builtin',
  )
  await page.route(/\/api\/agent(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        enabled: true,
        agents: [
          { id: 'builtin', name: '内置测试智能体', available: true },
          { id: 'codex', name: 'Codex', available: true },
          { id: 'claude', name: 'Claude Code', available: true },
        ],
      },
    }),
  )
  await page.route(/\/api\/agent\/models\/[^/]+(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { models: [] } }),
  )
  await page.route(/\/api\/agent\/skills\/[^/]+(?:\/[^/?]+)?(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url())
    const [, agent, rawId] = url.pathname.match(/\/api\/agent\/skills\/([^/]+)(?:\/([^/]+))?$/)!
    const kind = agent as AgentKind
    if (!rawId) {
      state.catalogs.push(url.pathname + url.search)
      if (state.catalogFailure)
        return route.fulfill({ status: 503, json: { message: state.catalogFailure } })
      const catalog: AgentSkillCatalog = {
        skills: state.skills[kind],
        capabilities,
        ...(state.catalogError ? { error: state.catalogError } : {}),
        ...(kind === 'claude'
          ? { warnings: ['Claude Code 自带 skill 由 CLI 管理；当前仅展示 Plein 技能'] }
          : {}),
      }
      return route.fulfill({ json: catalog })
    }
    const id = decodeURIComponent(rawId)
    const skill = state.skills[kind].find((item) => item.id === id)
    if (!skill) return route.fulfill({ status: 404, json: { message: '测试技能不存在' } })
    if (route.request().method() === 'PATCH') {
      const { enabled } = route.request().postDataJSON() as { enabled: boolean }
      state.patches.push({ agent: kind, id, enabled })
      if (state.patchError)
        return route.fulfill({ status: 503, json: { message: state.patchError } })
      skill.enabled = enabled
      return route.fulfill({ json: skill })
    }
    state.details.push(id)
    return state.detailError
      ? route.fulfill({ status: 503, json: { message: state.detailError } })
      : route.fulfill({
          json: {
            ...skill,
            instructions: `# ${skill.title}\n先检查真实输入与来源 ID，再按用户的明确目标处理。`,
          },
        })
  })
  await page.route('**/api/canvases/*/agent/sessions', (route) => {
    const canvasId = route.request().url().split('/').at(-3)!
    for (const old of state.sessions) if (!old.canvasId) old.canvasId = canvasId
    if (route.request().method() === 'GET')
      return route.fulfill({ json: state.sessions.filter((item) => item.canvasId === canvasId) })
    const body = route.request().postDataJSON() as { agent: AgentKind }
    state.created.push(body)
    const created = history(`技能测试对话 ${state.created.length}`, body.agent)
    created.canvasId = canvasId
    created.items = []
    state.sessions.unshift(created)
    return route.fulfill({ json: created })
  })
  await page.route(/\/api\/agent\/sessions\/[^/]+$/, (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!)
    const current = state.sessions.find((item) => item.id === id)
    return current
      ? route.fulfill({ json: current })
      : route.fulfill({ status: 404, json: { message: '测试会话不存在' } })
  })
  await page.route('**/api/agent/sessions/*/events', (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!)
    return route.fulfill({
      contentType: 'text/event-stream',
      body: `retry: 60000\ndata: ${JSON.stringify({ type: 'session', session: state.sessions.find((item) => item.id === id) })}\n\n`,
    })
  })
  await page.route('**/api/agent/sessions/*/messages', (route) => {
    const sessionId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!)
    state.sent.push({ sessionId, ...route.request().postDataJSON() })
    return route.fulfill({ status: 204 })
  })
  return state
}

async function openAssistant(page: Page) {
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  // 技能 Modal 打开时 Base UI 会把背景助手移出可访问树；仍需只读核对其未发送草稿。
  const panel = page.getByRole('complementary', { name: '助手', exact: true, includeHidden: true })
  await expect(panel.getByPlaceholder('让小满帮你做点什么…')).toBeVisible()
  await expect(panel.getByRole('combobox', { name: '对话模型', exact: true })).toBeEnabled()
  return panel
}

async function openSkills(page: Page) {
  await page.getByRole('button', { name: '技能与画布能力', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '技能与画布能力', exact: true })
  await expect(dialog.getByRole('article', { name: '技能：检查画布', exact: true })).toBeVisible()
  return dialog
}

function skillCard(dialog: Locator, title: string) {
  return dialog.getByRole('article', { name: `技能：${title}`, exact: true })
}

async function selectOption(page: Page, owner: Locator, label: string, option: string) {
  await owner.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

async function addTargets(page: Page) {
  return page.evaluate(() =>
    ['目标甲', '目标乙', '目标丙'].map((name, i) =>
      window.__plein.addNode({
        type: 'plein/text',
        name,
        params: { text: name },
        x: i * 650,
        y: 0,
      }),
    ),
  )
}

test('选择技能保留草稿且不自动发送，发送只传真实技能 ID', async ({ page }) => {
  const mock = await mockAgent(page)
  await newProject(page)
  const panel = await openAssistant(page)
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await input.fill('保留我的创作目标和原有顺序')
  const dialog = await openSkills(page)
  await skillCard(dialog, '整理工作流')
    .getByRole('button', { name: '使用此技能', exact: true })
    .click()
  await expect(dialog).toHaveCount(0)
  await expect(panel.getByText('技能：整理工作流', { exact: true })).toBeVisible()
  await expect(input).toHaveValue('保留我的创作目标和原有顺序')
  expect(mock.created).toEqual([])
  expect(mock.sent).toEqual([])
  expect(mock.patches).toEqual([])
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => mock.sent.length).toBe(1)
  expect(mock.sent[0]).toMatchObject({
    text: '保留我的创作目标和原有顺序',
    skill: 'plein:workflow',
  })
  expect(mock.sent[0]).not.toHaveProperty('instructions')
  expect(mock.sent[0]).not.toHaveProperty('path')
  await expect(input).toHaveValue('')
  await expect(panel.getByRole('button', { name: '移除本轮技能', exact: true })).toHaveCount(0)
})

test('需要选区的技能在无选区时不可用，选用填入建议且移除技能不丢需求', async ({ page }) => {
  const mock = await mockAgent(page)
  await newProject(page)
  const ids = await addTargets(page)
  const panel = await openAssistant(page)
  let dialog = await openSkills(page)
  await expect(
    skillCard(dialog, '优化选中镜头').getByRole('button', { name: '先选择画布元素', exact: true }),
  ).toBeDisabled()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.evaluate((id) => window.__plein.engine.selection.set([id]), ids[1]!)
  dialog = await openSkills(page)
  await skillCard(dialog, '优化选中镜头')
    .getByRole('button', { name: '使用此技能', exact: true })
    .click()
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await expect(input).toHaveValue(mock.skills.builtin.find((s) => s.name === 'shot-revise')!.prompt)
  await expect(panel.getByText('带上选中的 1 个元素', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '移除本轮技能', exact: true }).click()
  await expect(panel.getByText('技能：优化选中镜头', { exact: true })).toHaveCount(0)
  await expect(input).toHaveValue(mock.skills.builtin.find((s) => s.name === 'shot-revise')!.prompt)
  expect(mock.sent).toEqual([])
})

test('技能开关保存失败保持真实状态并可重试，停用后不能冒充已启用', async ({ page }) => {
  const mock = await mockAgent(page)
  await newProject(page)
  await openAssistant(page)
  const dialog = await openSkills(page)
  const card = skillCard(dialog, '检查画布')
  const toggle = card.getByRole('switch', { name: '启用技能：检查画布', exact: true })
  mock.patchError = '技能配置暂时无法保存'
  await toggle.click()
  await expect(dialog.getByRole('alert')).toContainText('技能配置暂时无法保存')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(toggle).toBeEnabled()
  await expect(card.getByRole('button', { name: '使用此技能', exact: true })).toBeEnabled()
  mock.patchError = null
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(card.getByRole('button', { name: '启用并使用', exact: true })).toBeEnabled()
  expect(mock.patches).toEqual([
    { agent: 'builtin', id: 'plein:canvas-audit', enabled: false },
    { agent: 'builtin', id: 'plein:canvas-audit', enabled: false },
  ])
  expect(mock.sent).toEqual([])
})

test('启用并使用失败保留对话与草稿，成功保存后才选用且不自动发送', async ({ page }) => {
  const mock = await mockAgent(page, { histories: [history('保留的历史')] })
  mock.skills.builtin.find((s) => s.name === 'workflow')!.enabled = false
  await newProject(page)
  const panel = await openAssistant(page)
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await input.fill('只调整参考顺序，不重跑生成')
  const dialog = await openSkills(page)
  const card = skillCard(dialog, '整理工作流')
  mock.patchError = '无法启用工作流技能'
  await card.getByRole('button', { name: '启用并使用', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('无法启用工作流技能')
  await expect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  await expect(dialog).toBeVisible()
  await expect(input).toHaveValue('只调整参考顺序，不重跑生成')
  await expect(panel.getByText('保留的历史 的既有讨论', { exact: true })).toBeVisible()
  expect(mock.sent).toEqual([])
  mock.patchError = null
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let pending = false
  await page.route('**/api/agent/skills/builtin/plein%3Aworkflow', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    pending = true
    await gate
    return route.fallback()
  })
  try {
    await card.getByRole('button', { name: '启用并使用', exact: true }).click()
    await expect.poll(() => pending).toBe(true)
    await expect(dialog).toBeVisible()
    await expect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    await expect(card.getByRole('button', { name: '启用并使用', exact: true })).toBeDisabled()
    expect(mock.sent).toEqual([])
    release()
    await expect(dialog).toHaveCount(0)
    await expect(panel.getByText('技能：整理工作流', { exact: true })).toBeVisible()
    await expect(input).toHaveValue('只调整参考顺序，不重跑生成')
    expect(mock.patches.at(-1)).toEqual({ agent: 'builtin', id: 'plein:workflow', enabled: true })
    expect(mock.created).toEqual([])
    expect(mock.sent).toEqual([])
  } finally {
    release()
  }
})

test('技能详情读取失败可以原地重试，不改变技能开关或发送内容', async ({ page }) => {
  const mock = await mockAgent(page)
  mock.detailError = '技能指引暂时不可读取'
  await newProject(page)
  const panel = await openAssistant(page)
  await panel.getByPlaceholder('让小满帮你做点什么…').fill('详情读取期间保留的草稿')
  const dialog = await openSkills(page)
  const card = skillCard(dialog, '整理工作流')
  await card.getByRole('button', { name: '查看技能：整理工作流', exact: true }).click()
  await expect(card.getByRole('alert')).toContainText('技能指引暂时不可读取')
  await expect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  mock.detailError = null
  await card.getByRole('button', { name: '重试读取指引', exact: true }).click()
  await expect(card.locator('pre')).toContainText('先检查真实输入与来源 ID')
  expect(mock.details).toEqual(['plein:workflow', 'plein:workflow'])
  expect(mock.patches).toEqual([])
  expect(mock.sent).toEqual([])
  await expect(panel.getByPlaceholder('让小满帮你做点什么…')).toHaveValue('详情读取期间保留的草稿')
  await page.screenshot({
    path: test.info().outputPath('agent-skills-detail-desktop.png'),
    animations: 'disabled',
  })
})

test('本机技能仅在 Codex 展示，来源筛选、真实开关和显式选用传 opaque ID', async ({ page }) => {
  const mock = await mockAgent(page, { agent: 'codex' })
  await newProject(page)
  const panel = await openAssistant(page)
  let dialog = await openSkills(page)
  await selectOption(page, dialog, '技能来源', 'Codex')
  await expect(dialog.getByRole('article')).toHaveCount(1)
  const card = skillCard(dialog, nativeTitle)
  await expect(card).toContainText('Codex 本机 Skill')
  await page.screenshot({
    path: test.info().outputPath('agent-skills-native-desktop.png'),
    animations: 'disabled',
  })
  const toggle = card.getByRole('switch', { name: `在 Codex 中启用：${nativeTitle}`, exact: true })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await card.getByRole('button', { name: '启用并使用', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(panel.getByText(`技能：${nativeTitle}`, { exact: true })).toBeVisible()
  expect(mock.sent).toEqual([])
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => mock.sent.length).toBe(1)
  expect(mock.sent[0]?.skill).toBe(nativeId)
  expect(mock.patches).toEqual([
    { agent: 'codex', id: nativeId, enabled: false },
    { agent: 'codex', id: nativeId, enabled: true },
  ])
  await selectOption(page, panel, '使用的智能体', 'Claude Code')
  dialog = await openSkills(page)
  await expect(skillCard(dialog, nativeTitle)).toHaveCount(0)
  await expect(
    dialog.getByText('Claude Code 自带 skill 由 CLI 管理；当前仅展示 Plein 技能'),
  ).toBeVisible()
  await dialog.getByRole('combobox', { name: '技能来源', exact: true }).click()
  await expect(page.getByRole('option', { name: 'Codex', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  expect(mock.catalogs.some((url) => url.endsWith('/skills/claude'))).toBe(true)
})

test('画布能力按实际工具元数据搜索，刷新失败保留已有目录并能恢复', async ({ page }) => {
  const mock = await mockAgent(page)
  await newProject(page)
  await openAssistant(page)
  const dialog = await openSkills(page)
  const search = dialog.getByRole('textbox', { name: '搜索技能与画布能力', exact: true })
  await dialog.getByRole('button', { name: '画布能力', exact: true }).click()
  for (const [name, title, effect] of [
    ['inspect_node_input', '检查节点实际输入', '只读'],
    ['reorder_inputs', '调整参考顺序', '修改画布'],
    ['replace_input', '替换参考输入', '修改画布'],
  ]) {
    await search.fill(name!)
    await expect(dialog.getByRole('article')).toHaveCount(1)
    await expect(dialog.getByRole('article')).toContainText(title!)
    await expect(dialog.getByRole('article')).toContainText(effect!)
  }
  await search.fill('不匹配的能力名称')
  await expect(dialog.getByText('没有匹配的画布能力', { exact: true })).toBeVisible()
  await search.fill('')
  await dialog.getByRole('button', { name: '技能', exact: true }).click()
  mock.catalogFailure = '技能目录暂不可用，请稍后刷新'
  await dialog.getByRole('button', { name: '刷新技能', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('目录暂不可用')
  await expect(skillCard(dialog, '检查画布')).toBeVisible()
  expect(mock.catalogs.at(-1)).toBe('/api/agent/skills/builtin?refresh=1')
  mock.catalogFailure = null
  await dialog.getByRole('button', { name: '刷新技能', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expect(skillCard(dialog, '检查画布')).toBeVisible()
})

test('本轮目标逐个移除并可定位，发送 selection 对应保留的真实 ID', async ({ page }) => {
  const mock = await mockAgent(page)
  await newProject(page)
  const ids = await addTargets(page)
  await page.evaluate((ids) => window.__plein.engine.selection.set(ids), ids)
  const panel = await openAssistant(page)
  const targets = panel.locator('[aria-label="本轮画布目标"]')
  await expect(
    targets.getByRole('button', { name: '定位元素：目标乙', exact: true }),
  ).toHaveAttribute('title', ids[1]!)
  await targets.getByRole('button', { name: '不带元素：目标甲', exact: true }).click()
  await expect(panel.getByText('带上选中的 2 个元素', { exact: true })).toBeVisible()
  await expect(targets.getByRole('button', { name: '定位元素：目标甲', exact: true })).toHaveCount(
    0,
  )
  await page.evaluate(() =>
    (
      window.__plein.engine as unknown as { camera: { panBy(x: number, y: number): void } }
    ).camera.panBy(-3000, 0),
  )
  await targets.getByRole('button', { name: '定位元素：目标乙', exact: true }).click()
  await settle(page, ids[1]!)
  const point = await centerOf(page, ids[1]!)
  expect(point.x).toBeGreaterThan(0)
  expect(point.x).toBeLessThan((page.viewportSize()?.width ?? 1280) - 424)
  const dialog = await openSkills(page)
  await skillCard(dialog, '整理工作流')
    .getByRole('button', { name: '使用此技能', exact: true })
    .click()
  await panel.getByPlaceholder('让小满帮你做点什么…').fill('只整理这两个元素')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => mock.sent.length).toBe(1)
  expect(mock.sent[0]?.selection?.sort()).toEqual([ids[1]!, ids[2]!].sort())
  expect(mock.sent[0]?.skill).toBe('plein:workflow')
  await page.screenshot({
    path: test.info().outputPath('agent-skills-targets-desktop.png'),
    animations: 'disabled',
  })
})

test('历史消息保留技能与选区，删除目标后只显示原 ID且不误定位同名新元素', async ({ page }) => {
  const saved = history('带技能和目标的历史')
  await mockAgent(page, { histories: [saved] })
  await newProject(page)
  const ids = await addTargets(page)
  saved.items.unshift({
    id: 'historical-skill-request',
    type: 'user',
    text: '只整理当时的目标',
    at: Date.now(),
    skill: { id: 'plein:workflow', name: 'workflow', title: '整理工作流', source: 'plein' },
    selection: [ids[0]!],
  })
  const panel = await openAssistant(page)
  // 画布进入时可能已经载入历史，显式续聊重新读取加入了真实目标 ID 的消息快照。
  await panel.getByRole('button', { name: '历史对话', exact: true }).click()
  await page
    .getByRole('dialog', { name: '历史对话', exact: true })
    .getByRole('button', { name: /^带技能和目标的历史/ })
    .click()
  await expect(panel.getByText('技能：整理工作流', { exact: true })).toBeVisible()
  const historical = panel.locator('[aria-label="消息附带的画布目标"]')
  await historical.getByRole('button', { name: '定位元素：目标甲', exact: true }).click()
  await page.evaluate((id) => window.__plein.engine.selection.set([id]), ids[0]!)
  await page
    .locator('canvas')
    .first()
    .evaluate((canvas) => (canvas.parentElement as HTMLElement).focus())
  await page.keyboard.press('Delete')
  await expect
    .poll(async () => (await elements(page)).some((element) => element.id === ids[0]))
    .toBe(false)
  const deleted = historical.getByRole('button', { name: /^已删除元素：/ })
  await expect(deleted).toBeDisabled()
  await expect(deleted).toHaveAttribute('title', ids[0]!)
  const replacement = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/text',
      name: '目标甲',
      params: { text: '同名但不同 ID' },
      x: 1800,
      y: 0,
    }),
  )
  expect(replacement).not.toBe(ids[0])
  await expect(deleted).toBeDisabled()
  await expect(
    historical.getByRole('button', { name: '定位元素：目标甲', exact: true }),
  ).toHaveCount(0)
  await page.screenshot({
    path: test.info().outputPath('agent-skills-deleted-target.png'),
    animations: 'disabled',
  })
})

test('390px 技能弹层可搜索、读指引和选用，设置页复用技能管理', async ({ page }) => {
  await mockAgent(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await newProject(page)
  const panel = await openAssistant(page)
  const dialog = await openSkills(page)
  const search = dialog.getByRole('textbox', { name: '搜索技能与画布能力', exact: true })
  await search.fill('workflow')
  const card = skillCard(dialog, '整理工作流')
  await card.getByRole('button', { name: '查看技能：整理工作流', exact: true }).click()
  await expect(card.locator('pre')).toBeVisible()
  const bounds = (await dialog.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390)
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({
    path: test.info().outputPath('agent-skills-mobile-390.png'),
    animations: 'disabled',
  })
  await card.getByRole('button', { name: '使用此技能', exact: true }).click()
  await expect(panel.getByText('技能：整理工作流', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  const settings = await openCanvasSettings(page)
  await settings.getByRole('button', { name: '技能与画布能力', exact: true }).click()
  await expect(
    settings.getByRole('combobox', { name: '技能所属智能体', exact: true }),
  ).toBeVisible()
  await expect(skillCard(settings, '检查画布')).toBeVisible()
  await expect(settings.getByRole('button', { name: '使用此技能', exact: true })).toHaveCount(0)
  await settings.getByRole('textbox', { name: '搜索技能与画布能力', exact: true }).fill('检查画布')
  await expect(settings.getByRole('article')).toHaveCount(1)
  await page.screenshot({
    path: test.info().outputPath('agent-skills-settings-mobile-390.png'),
    animations: 'disabled',
  })
})

test('已关闭技能窗口的迟到启用成功不能污染另一块画布的需求', async ({ page }) => {
  const mock = await mockAgent(page)
  mock.skills.builtin.find((skill) => skill.name === 'workflow')!.enabled = false
  await newProject(page)
  const firstHash = new URL(page.url()).hash
  const canvasId = decodeURIComponent(firstHash.split('/').at(-1)!)
  const canvas = (await (await page.request.get(`/api/canvases/${canvasId}`)).json()) as {
    projectId: string
  }
  const other = (await (
    await page.request.post('/api/canvases', {
      data: { projectId: canvas.projectId, title: '技能等待期间的另一块画布' },
    })
  ).json()) as { id: string }
  const panel = await openAssistant(page)
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await input.fill('第一块画布的原草稿')
  const dialog = await openSkills(page)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let pending = false
  let replied = false
  await page.route('**/api/agent/skills/builtin/plein%3Aworkflow', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    pending = true
    await gate
    await route.fulfill({
      json: { ...mock.skills.builtin.find((skill) => skill.name === 'workflow'), enabled: true },
    })
    replied = true
  })
  try {
    await skillCard(dialog, '整理工作流')
      .getByRole('button', { name: '启用并使用', exact: true })
      .click()
    await expect.poll(() => pending).toBe(true)
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await page.evaluate((id) => {
      location.hash = `/c/${id}`
    }, other.id)
    await waitEngine(page)
    await expect(input).toHaveValue('')
    await input.fill('只属于第二块画布的需求')
    release()
    await expect.poll(() => replied).toBe(true)
    await expect(input).toHaveValue('只属于第二块画布的需求')
    await expect(panel.getByRole('button', { name: '移除本轮技能', exact: true })).toHaveCount(0)
    expect(mock.sent).toEqual([])
    await page.evaluate((hash) => {
      location.hash = hash
    }, firstHash)
    await expect(input).toHaveValue('第一块画布的原草稿')
    await expect(panel.getByRole('button', { name: '移除本轮技能', exact: true })).toHaveCount(0)
  } finally {
    release()
  }
})
