import { expect, type Page, type Route, test } from '@playwright/test'
import type { ImpactReport } from '../packages/protocol/src/impact'
import { newProject } from './canvas'

async function fixture(page: Page, kept = true) {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({ type: 'plein/image', name: '过期镜头', params: {}, x: 300, y: 200 }),
  )
  const canvas = decodeURIComponent(page.url().split('#/c/')[1]!)
  const state = { kept, reads: 0, mutations: [] as Route[] }
  const decision = {
    id: 'decision',
    nodeId: id,
    resultId: 'result',
    inputHash: 'current',
    causes: [{ kind: 'prompt' as const, label: '提示词变化' }],
    createdAt: 1,
  }
  const report = (): ImpactReport => ({
    nodes: [
      {
        nodeId: id,
        name: '过期镜头',
        nodeType: 'plein/image',
        impact: 'direct',
        suggest: 'rerun',
        causes: decision.causes,
        inputHash: 'current',
        kept: state.kept ? decision : undefined,
      },
    ],
    decisions: state.kept ? [decision] : [],
    plan: [],
    sequence: [],
    summary: {
      direct: 1,
      indirect: 0,
      cached: 0,
      pending: state.kept ? 0 : 1,
      kept: state.kept ? 1 : 0,
      cost: { amount: 0, unknown: 1 },
    },
  })
  await page.route(`**/api/canvases/${canvas}/impact`, async (route) => {
    state.reads++
    await route.fulfill({ json: report() })
  })
  await page.route(`**/api/canvases/${canvas}/impact/keep**`, (route) => {
    state.mutations.push(route)
  })
  await page.getByRole('button', { name: '查看影响', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '查看影响', exact: true })
  const row = panel
    .getByRole('listitem')
    .filter({ has: page.getByRole('checkbox', { name: '重做过期镜头', exact: true }) })
  await expect(
    row.getByRole('button', { name: kept ? '撤销保留' : '保留', exact: true }),
  ).toBeVisible()
  return { id, canvas, state, panel, row, decision }
}

async function settled(page: Page) {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  )
  await page.waitForLoadState('networkidle')
}

test('撤销保留等待响应时禁用操作，失败后可重试且只提交一次', async ({ page }) => {
  const f = await fixture(page)
  const button = f.row.getByRole('button', { name: '撤销保留', exact: true })
  await button.dblclick()
  await expect.poll(() => f.state.mutations.length).toBeGreaterThan(0)
  expect(f.state.mutations).toHaveLength(1)
  await expect(button).toBeDisabled()
  await expect(f.panel.getByRole('status').filter({ hasText: '正在更新保留决定' })).toBeVisible()
  await page.screenshot({
    path: test.info().outputPath('impact-pending.png'),
    animations: 'disabled',
  })
  await expect(f.row.getByRole('checkbox')).toBeDisabled()
  await f.state.mutations[0]!.fulfill({ status: 503, json: { message: '撤销暂时失败' } })
  await expect(page.locator('.ui-toast')).toContainText('撤销暂时失败')
  await expect(button).toBeEnabled()
  await button.click()
  await expect.poll(() => f.state.mutations.length).toBe(2)
  f.state.kept = false
  await f.state.mutations[1]!.fulfill({ status: 204 })
  await expect(f.row.getByRole('button', { name: '保留', exact: true })).toBeEnabled()
  expect(f.state.mutations).toHaveLength(2)
})

test('关闭并重开面板后，旧保留请求失败不打断新面板勾选或重新查询', async ({ page }) => {
  const f = await fixture(page, false)
  await f.row.getByRole('button', { name: '保留', exact: true }).click()
  await expect.poll(() => f.state.mutations.length).toBe(1)
  await page.keyboard.press('Escape')
  await expect(f.panel).toHaveCount(0)
  await page.getByRole('button', { name: '查看影响', exact: true }).click()
  const checkbox = f.row.getByRole('checkbox')
  await expect(checkbox).toBeEnabled()
  await checkbox.uncheck()
  const reads = f.state.reads
  const response = page.waitForResponse((r) => r.request() === f.state.mutations[0]!.request())
  await f.state.mutations[0]!.fulfill({ status: 503, json: { message: '旧面板保留失败' } })
  await (await response).finished()
  await settled(page)
  await expect(checkbox).not.toBeChecked()
  expect(await page.getByText('旧面板保留失败', { exact: true }).count()).toBe(0)
  expect(f.state.reads).toBe(reads)
})

for (const fail of [false, true]) {
  test(`切换画布后旧保留${fail ? '失败' : '成功'}不向新画布提示或重新分析旧画布`, async ({
    page,
  }) => {
    const f = await fixture(page, false)
    await f.row.getByRole('button', { name: '保留', exact: true }).click()
    await expect.poll(() => f.state.mutations.length).toBe(1)
    const canvas = await (await page.request.get(`/api/canvases/${f.canvas}`)).json()
    const other = await (
      await page.request.post('/api/canvases', {
        data: { projectId: canvas.projectId, title: '新的画布' },
      })
    ).json()
    await page.evaluate((id) => {
      location.hash = `#/c/${id}`
    }, other.id)
    await page.waitForFunction((id) => !!window.__plein && !window.__plein.engine.doc.get(id), f.id)
    const reads = f.state.reads
    const response = page.waitForResponse((r) => r.request() === f.state.mutations[0]!.request())
    await f.state.mutations[0]!.fulfill(
      fail
        ? { status: 503, json: { message: '旧画布保留失败' } }
        : { status: 201, json: [f.decision] },
    )
    await (await response).finished()
    await settled(page)
    expect(
      await page
        .getByText(fail ? '旧画布保留失败' : '已保留 1 个结果，记录在「保留记录」里', {
          exact: true,
        })
        .count(),
    ).toBe(0)
    expect(f.state.reads).toBe(reads)
  })
}

test('同一画布重开面板后，旧请求成功会刷新真实决定，但不弹旧面板提示', async ({ page }) => {
  const f = await fixture(page, false)
  await f.row.getByRole('button', { name: '保留', exact: true }).click()
  await expect.poll(() => f.state.mutations.length).toBe(1)
  await page.keyboard.press('Escape')
  await expect(f.panel).toHaveCount(0)
  await page.getByRole('button', { name: '查看影响', exact: true }).click()
  await expect(f.row.getByRole('button', { name: '保留', exact: true })).toBeEnabled()
  const reads = f.state.reads
  f.state.kept = true
  await f.state.mutations[0]!.fulfill({ status: 201, json: [f.decision] })
  await expect(f.row.getByRole('button', { name: '撤销保留', exact: true })).toBeVisible()
  await settled(page)
  expect(f.state.reads).toBe(reads + 1)
  expect(
    await page.getByText('已保留 1 个结果，记录在「保留记录」里', { exact: true }).count(),
  ).toBe(0)
})
