import { expect, test } from '@playwright/test'
import type { AgentItem, AgentSession, StoryboardBatchPlan } from '../packages/protocol/src'
import { newProject } from './canvas'

test('Agent 批量确认可完整审阅冻结清单，失败可重试，历史快照不包含执行令牌', async ({ page }) => {
  // UI 合同夹具；提交与异步重算故障由真实 server 集成测试验证。
  const plan: Omit<StoryboardBatchPlan, 'token'> = {
    expiresAt: Date.now() + 600_000,
    sourceId: 'board',
    request: { shotIds: ['s1', 's2', 's3', 's4'], role: 'image', reuseExisting: true },
    rows: [
      {
        key: 'one',
        nodeId: 'one',
        shotNo: 1,
        name: '天台近景',
        prerequisite: false,
        action: 'run',
        reason: '按这份实际输入生成新候选',
        calls: 1,
        input: {
          v: 1,
          nodeId: 'one',
          nodeType: 'plein/image',
          preparedAt: 1,
          status: 'ready',
          model: { ref: 'mock:image', provider: 'mock', title: 'Mock 图片' },
          prompt: '冻结输入：天台逆光近景',
          params: { aspectRatio: '9:16' },
          inputs: {},
          refs: [],
          notices: [],
          blocked: [],
        },
      },
      {
        key: 'two',
        shotNo: 2,
        name: '原有远景',
        prerequisite: false,
        action: 'reuse',
        reason: '沿用当前采用结果',
        calls: 0,
      },
      {
        key: 'three',
        shotNo: 3,
        name: '待取回镜头',
        prerequisite: false,
        action: 'blocked',
        reason: '请先核查或取回原任务',
        calls: 0,
      },
      {
        key: 'four',
        shotNo: 4,
        name: '空对白',
        prerequisite: false,
        action: 'skip',
        reason: '没有台词',
        calls: 0,
      },
    ],
    summary: { run: 1, reuse: 1, blocked: 1, skip: 1, calls: 1, prices: [], unknownCalls: 1 },
  }
  const approval: Extract<AgentItem, { type: 'approval' }> = {
    id: 'batch-approval',
    type: 'approval',
    tool: 'run_storyboard',
    reason: '批量生成分镜图',
    ids: [],
    status: 'pending',
    storyboardBatch: plan,
    at: Date.now(),
  }
  const session: AgentSession = {
    id: 'batch-review',
    canvasId: '',
    agent: 'builtin',
    title: '批量清单审阅',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    items: [approval],
  }
  await page.route('**/api/canvases/*/agent/sessions', async (route) => {
    session.canvasId = new URL(route.request().url()).pathname.split('/')[3]!
    await route.fulfill({ json: [{ ...session, items: undefined }] })
  })
  await page.route('**/api/agent/sessions/batch-review', (route) =>
    route.fulfill({ json: session }),
  )
  await page.route('**/api/agent/sessions/batch-review/events', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ type: 'session', session })}\n\n`,
    }),
  )
  let decisions = 0
  await page.route('**/api/agent/sessions/batch-review/approvals/batch-approval', async (route) => {
    decisions++
    expect(route.request().postDataJSON()).toEqual({ allow: true })
    if (decisions === 1)
      return route.fulfill({ status: 503, json: { error: 'failed', message: '确认暂时失败' } })
    approval.status = 'approved'
    await route.fulfill({ status: 204 })
  })
  await newProject(page)
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const card = panel.locator('.plein-agent-approval')
  await card.getByText('审阅本次批量清单', { exact: true }).click()
  await expect(card.getByLabel('清单汇总')).toContainText(
    '生成 1 项 · 沿用 1 项 · 阻塞 1 项 · 跳过 1 项',
  )
  await expect(card).toContainText('1 次价格未知')
  await expect(card.getByRole('table')).toContainText('待取回镜头')
  await card.getByText('查看实际输入', { exact: true }).click()
  await expect(card).toContainText('冻结输入：天台逆光近景')
  await expect(card).toContainText('Mock 图片')
  await card.getByText('生效参数与参考顺序', { exact: true }).click()
  await expect(card).toContainText('9:16')
  await card.getByRole('button', { name: '允许', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('确认暂时失败')
  await expect(card.getByRole('button', { name: '允许', exact: true })).toBeEnabled()
  await page.screenshot({
    path: test.info().outputPath('batch-review-pending.png'),
    animations: 'disabled',
  })
  await card.getByRole('button', { name: '允许', exact: true }).click()
  expect(decisions).toBe(2)
  await page.reload()
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  await expect(card).toHaveAttribute('data-status', 'approved')
  await expect(card.getByRole('button', { name: '允许', exact: true })).toHaveCount(0)
  await card.getByText('审阅本次批量清单', { exact: true }).click()
  await expect(card.getByLabel('清单汇总')).toContainText('生成 1 项')
  expect(JSON.stringify(session)).not.toContain('"token"')
  await page.screenshot({
    path: test.info().outputPath('batch-review-history.png'),
    animations: 'disabled',
  })
})
