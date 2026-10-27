// @vitest-environment happy-dom
import type { AgentSkill, AgentSkillCatalog, AgentSession, AgentStatus } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, resetStoreAfterEach, screen, waitFor, within } from '../../testing/render'
import { AgentSkillsButton } from './AgentSkills'
import { useAgent } from './store'

resetStoreAfterEach(useAgent)

const workflow: AgentSkill = {
  id: 'plein:workflow',
  name: 'workflow',
  title: '整理工作流',
  description: '核对连线、参考素材顺序与布局。',
  source: 'plein',
  enabled: true,
  selection: 'optional',
  prompt: '请整理当前工作流',
  capabilities: ['inspect_node_input'],
  canToggle: true,
}
const audit: AgentSkill = {
  ...workflow,
  id: 'plein:canvas-audit',
  name: 'canvas-audit',
  title: '检查画布',
  description: '检查输入、依赖与陈旧结果。',
  capabilities: [],
}
const capabilities: AgentSkillCatalog['capabilities'] = [
  {
    name: 'inspect_node_input',
    title: '检查节点实际输入',
    description: '检查节点运行时实际输入、来源和顺序。',
    group: '输入与连线',
    effect: 'read',
    where: 'server',
  },
]
const status: AgentStatus = {
  enabled: true,
  agents: [{ id: 'builtin', name: '内置智能体', available: true }],
}
const session: AgentSession = {
  id: 's1',
  canvasId: 'c1',
  agent: 'builtin',
  title: '技能对话',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  items: [],
  settings: {},
}

function catalog(skills = [workflow, audit]): AgentSkillCatalog {
  return { skills, capabilities }
}

function prime() {
  useAgent.setState({
    canvasId: 'c1',
    session,
    status,
    agent: 'builtin',
    drafts: { c1: { text: '保留我的创作需求' } },
  })
}

async function openSkills(user: ReturnType<typeof renderApp>['user']) {
  await user.click(screen.getByRole('button', { name: '技能与画布能力' }))
  const dialog = await screen.findByRole('dialog', { name: '技能与画布能力' })
  await within(dialog).findByRole('article', { name: '技能：整理工作流' })
  return dialog
}

it('选择技能保留草稿，成功才关闭窗口且不自动发送', async () => {
  prime()
  const sent: string[] = []
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/agent/skills/builtin')
      return Response.json(catalog())
    if (request.method === 'POST') sent.push(path)
  })
  const { user } = renderApp(
    <AgentSkillsButton canvasId="c1" selectionCount={0} disabled={false} />,
  )
  const dialog = await openSkills(user)
  const card = within(dialog).getByRole('article', { name: '技能：整理工作流' })
  await user.click(within(card).getByRole('button', { name: '使用此技能' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '技能与画布能力' })).toBeNull())
  expect(useAgent.getState().selectedSkills.c1?.id).toBe('plein:workflow')
  expect(useAgent.getState().drafts.c1?.text).toBe('保留我的创作需求')
  expect(sent).toEqual([])
})

it('store 拒绝选用时保留窗口并说明原因，不污染草稿或本轮技能', async () => {
  prime()
  mockFetch((request) => {
    if (request.method === 'GET' && new URL(request.url).pathname === '/api/agent/skills/builtin')
      return Response.json(catalog())
  })
  const { user } = renderApp(
    <AgentSkillsButton canvasId="c1" selectionCount={0} disabled={false} />,
  )
  const dialog = await openSkills(user)
  act(() => useAgent.setState({ historyError: '连接已断开' }))
  const card = within(dialog).getByRole('article', { name: '技能：整理工作流' })
  await user.click(within(card).getByRole('button', { name: '使用此技能' }))
  expect(screen.getByRole('dialog', { name: '技能与画布能力' })).toBe(dialog)
  expect(within(dialog).getByRole('alert').textContent).toContain('技能未选用')
  expect(useAgent.getState().selectedSkills.c1).toBeUndefined()
  expect(useAgent.getState().drafts.c1?.text).toBe('保留我的创作需求')
})

it('技能开关失败保持真实状态，重试成功后才停用', async () => {
  prime()
  const patches: unknown[] = []
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/agent/skills/builtin')
      return Response.json(catalog())
    if (request.method === 'PATCH' && path === '/api/agent/skills/builtin/plein%3Acanvas-audit') {
      return request.json().then((body) => {
        patches.push(body)
        return patches.length === 1
          ? Response.json(
              { error: 'save_failed', message: '技能配置暂时无法保存' },
              { status: 503 },
            )
          : Response.json({ ...audit, enabled: false })
      })
    }
  })
  const { user } = renderApp(
    <AgentSkillsButton canvasId="c1" selectionCount={0} disabled={false} />,
  )
  const dialog = await openSkills(user)
  const card = within(dialog).getByRole('article', { name: '技能：检查画布' })
  const toggle = within(card).getByRole('switch', { name: '启用技能：检查画布' })
  await user.click(toggle)
  expect((await within(dialog).findByRole('alert')).textContent).toContain('技能配置暂时无法保存')
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  await user.click(toggle)
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
  expect(within(card).getByRole<HTMLButtonElement>('button', { name: '启用并使用' }).disabled).toBe(
    false,
  )
  expect(patches).toEqual([{ enabled: false }, { enabled: false }])
})

it('技能详情失败可原地重试，不改变开关或发送内容', async () => {
  prime()
  let details = 0
  const patches: string[] = []
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/agent/skills/builtin')
      return Response.json(catalog())
    if (request.method === 'GET' && path === '/api/agent/skills/builtin/plein%3Aworkflow') {
      details++
      return details === 1
        ? Response.json(
            { error: 'detail_failed', message: '技能指引暂时不可读取' },
            { status: 503 },
          )
        : Response.json({ ...workflow, instructions: '先检查真实输入与来源 ID' })
    }
    if (request.method === 'PATCH' || request.method === 'POST') patches.push(path)
  })
  const { user } = renderApp(
    <AgentSkillsButton canvasId="c1" selectionCount={0} disabled={false} />,
  )
  const dialog = await openSkills(user)
  const card = within(dialog).getByRole('article', { name: '技能：整理工作流' })
  await user.click(within(card).getByRole('button', { name: '查看技能：整理工作流' }))
  expect((await within(card).findByRole('alert')).textContent).toContain('技能指引暂时不可读取')
  expect(within(card).getByRole('switch').getAttribute('aria-checked')).toBe('true')
  await user.click(within(card).getByRole('button', { name: '重试读取指引' }))
  expect(await within(card).findByText('先检查真实输入与来源 ID')).toBeTruthy()
  expect(details).toBe(2)
  expect(patches).toEqual([])
  expect(useAgent.getState().drafts.c1?.text).toBe('保留我的创作需求')
})

it('启用并使用失败不选用，保存成功后才关闭窗口', async () => {
  prime()
  const disabled = { ...workflow, enabled: false }
  let patches = 0
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/agent/skills/builtin')
      return Response.json(catalog([disabled, audit]))
    if (request.method === 'PATCH' && path === '/api/agent/skills/builtin/plein%3Aworkflow') {
      patches++
      return patches === 1
        ? Response.json({ error: 'save_failed', message: '无法启用工作流技能' }, { status: 503 })
        : Response.json(workflow)
    }
  })
  const { user } = renderApp(
    <AgentSkillsButton canvasId="c1" selectionCount={0} disabled={false} />,
  )
  const dialog = await openSkills(user)
  const use = within(dialog).getByRole('button', { name: '启用并使用' })
  await user.click(use)
  expect((await within(dialog).findByRole('alert')).textContent).toContain('无法启用工作流技能')
  expect(useAgent.getState().selectedSkills.c1).toBeUndefined()
  expect(screen.getByRole('dialog', { name: '技能与画布能力' })).toBe(dialog)
  await user.click(use)
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '技能与画布能力' })).toBeNull())
  expect(useAgent.getState().selectedSkills.c1?.id).toBe('plein:workflow')
  expect(useAgent.getState().drafts.c1?.text).toBe('保留我的创作需求')
})

it('能力按工具元数据搜索，目录刷新失败保留已有内容并可恢复', async () => {
  prime()
  let refreshes = 0
  mockFetch((request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/api/agent/skills/builtin') {
      if (url.searchParams.get('refresh') === '1') {
        refreshes++
        if (refreshes === 1)
          return Response.json({ error: 'offline', message: '技能目录暂不可用' }, { status: 503 })
      }
      return Response.json(catalog())
    }
  })
  const { user } = renderApp(
    <AgentSkillsButton canvasId="c1" selectionCount={0} disabled={false} />,
  )
  const dialog = await openSkills(user)
  await user.click(within(dialog).getByRole('button', { name: '画布能力' }))
  await user.type(
    within(dialog).getByRole('textbox', { name: '搜索技能与画布能力' }),
    'inspect_node_input',
  )
  expect(within(dialog).getByRole('article').textContent).toContain('检查节点实际输入')
  expect(within(dialog).getByRole('article').textContent).toContain('只读')
  await user.clear(within(dialog).getByRole('textbox', { name: '搜索技能与画布能力' }))
  await user.click(within(dialog).getByRole('button', { name: '技能' }))
  await user.click(within(dialog).getByRole('button', { name: '刷新技能' }))
  expect((await within(dialog).findByRole('alert')).textContent).toContain('技能目录暂不可用')
  expect(within(dialog).getByRole('article', { name: '技能：整理工作流' })).toBeTruthy()
  await user.click(within(dialog).getByRole('button', { name: '刷新技能' }))
  await waitFor(() => expect(within(dialog).queryByRole('alert')).toBeNull())
  expect(refreshes).toBe(2)
})

it('必需选区的技能先阻止选用，有选区后填入建议且移除技能保留需求', async () => {
  prime()
  useAgent.getState().setDraft('c1', '')
  const required = { ...workflow, selection: 'required' as const }
  mockFetch((request) => {
    if (request.method === 'GET' && new URL(request.url).pathname === '/api/agent/skills/builtin')
      return Response.json(catalog([required]))
  })
  const view = renderApp(<AgentSkillsButton canvasId="c1" selectionCount={0} disabled={false} />)
  const dialog = await openSkills(view.user)
  expect(
    within(dialog).getByRole<HTMLButtonElement>('button', { name: '先选择画布元素' }).disabled,
  ).toBe(true)
  view.rerender(<AgentSkillsButton canvasId="c1" selectionCount={1} disabled={false} />)
  await view.user.click(within(dialog).getByRole('button', { name: '使用此技能' }))
  expect(useAgent.getState().drafts.c1?.text).toBe(workflow.prompt)
  expect(useAgent.getState().selectedSkills.c1?.id).toBe(workflow.id)
  act(() => useAgent.getState().clearSkill('c1'))
  expect(useAgent.getState().selectedSkills.c1).toBeUndefined()
  expect(useAgent.getState().drafts.c1?.text).toBe(workflow.prompt)
})

it('关闭技能窗口后迟到启用只能更新目录，不污染另一画布的草稿或技能', async () => {
  prime()
  let release!: (response: Response) => void
  const pending = new Promise<Response>((resolve) => {
    release = resolve
  })
  let patches = 0
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/agent/skills/builtin')
      return Response.json(catalog([{ ...workflow, enabled: false }]))
    if (request.method === 'PATCH' && path === '/api/agent/skills/builtin/plein%3Aworkflow') {
      patches++
      return pending
    }
  })
  const view = renderApp(<AgentSkillsButton canvasId="c1" selectionCount={0} disabled={false} />)
  const dialog = await openSkills(view.user)
  const enable = within(dialog).getByRole<HTMLButtonElement>('button', { name: '启用并使用' })
  await view.user.click(enable)
  expect(enable.disabled).toBe(true)
  await view.user.click(within(dialog).getByRole('button', { name: '关闭' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  act(() =>
    useAgent.setState({
      canvasId: 'c2',
      session: null,
      drafts: { c1: { text: '保留我的创作需求' }, c2: { text: '第二块画布的需求' } },
    }),
  )
  view.rerender(<AgentSkillsButton canvasId="c2" selectionCount={0} disabled={false} />)
  await act(async () => release(Response.json(workflow)))
  await waitFor(() =>
    expect(
      view.queryClient.getQueryData<AgentSkillCatalog>(['agent', 'skills', 'builtin'])?.skills[0]
        ?.enabled,
    ).toBe(true),
  )
  expect(patches).toBe(1)
  expect(useAgent.getState().selectedSkills).toEqual({})
  expect(useAgent.getState().drafts).toEqual({
    c1: { text: '保留我的创作需求' },
    c2: { text: '第二块画布的需求' },
  })
})

it('本机技能按来源筛选并保留 opaque ID，其他智能体目录不混入原生技能', async () => {
  prime()
  const native: AgentSkill = {
    ...workflow,
    id: 'codex:0823b00f826fa7d4',
    source: 'codex',
    title: '品牌视觉指南',
    name: 'brand-visual',
  }
  useAgent.setState({ session: { ...session, agent: 'codex' } })
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/agent/skills/codex')
      return Response.json(catalog([workflow, native]))
    if (request.method === 'GET' && path === '/api/agent/skills/claude')
      return Response.json({ ...catalog(), warnings: ['本机技能由 CLI 管理'] })
  })
  const { user } = renderApp(
    <AgentSkillsButton canvasId="c1" selectionCount={0} disabled={false} />,
  )
  let dialog = await openSkills(user)
  await user.click(within(dialog).getByRole('combobox', { name: '技能来源' }))
  await user.click(screen.getByRole('option', { name: 'Codex' }))
  expect(within(dialog).getAllByRole('article')).toHaveLength(1)
  await user.click(within(dialog).getByRole('button', { name: '使用此技能' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(useAgent.getState().selectedSkills.c1?.id).toBe(native.id)
  act(() => {
    useAgent.getState().setAgent('claude')
    useAgent.getState().reset()
  })
  dialog = await openSkills(user)
  expect(within(dialog).queryByRole('article', { name: '技能：品牌视觉指南' })).toBeNull()
  expect(within(dialog).getByText('本机技能由 CLI 管理')).toBeTruthy()
  expect(useAgent.getState().selectedSkills.c1?.id).toBe(native.id)
})
