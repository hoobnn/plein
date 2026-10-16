import { expect, type Route, test } from '@playwright/test'
import type { ImpactReport } from '../packages/protocol/src/impact'
import { newProject } from './canvas'

const report = (name: string): ImpactReport => ({
  nodes: [
    {
      nodeId: 'image',
      name,
      nodeType: 'plein/image',
      impact: 'direct',
      suggest: 'rerun',
      causes: [{ kind: 'prompt', label: '提示词改了' }],
      inputHash: 'v2:current',
    },
  ],
  plan: [],
  sequence: [],
  decisions: [],
  summary: {
    direct: 1,
    indirect: 0,
    cached: 0,
    pending: 1,
    kept: 0,
    cost: { amount: 0, unknown: 1 },
  },
})

/** 真界面配受控响应：分析可能比下一次文档变更更慢，必须能复现返回顺序颠倒。 */
for (const staleFailure of [false, true]) {
  test(`影响分析忽略过期${staleFailure ? '失败' : '成功'}响应，保留当前勾选`, async ({ page }) => {
    await newProject(page)
    const requests: Route[] = []
    await page.route('**/api/canvases/*/impact', (route) => {
      requests.push(route)
    })
    await page.getByRole('button', { name: '查看影响', exact: true }).click()
    await expect.poll(() => requests.length).toBe(1)
    await page.evaluate(() => {
      window.__plein.addNode({ type: 'plein/image', name: '触发重新分析', params: {}, x: 0, y: 0 })
    })
    await expect.poll(() => requests.length).toBe(2)
    await requests[1]!.fulfill({ json: report('新的分析') })
    const dialog = page.getByRole('dialog', { name: '查看影响' })
    const picked = dialog.getByRole('checkbox', { name: '重做新的分析' })
    await expect(picked).toBeChecked()
    await picked.uncheck()
    const oldResponse = page.waitForResponse((r) => r.request() === requests[0]!.request())
    await requests[0]!.fulfill(
      staleFailure
        ? { status: 503, json: { message: '过期请求失败' } }
        : { json: report('旧的分析') },
    )
    await (await oldResponse).finished()
    // 等响应后的 React 更新落地，不能在旧响应仍未处理时提前通过。
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    )
    await expect(picked).toBeVisible()
    await expect(picked).not.toBeChecked()
    await expect(dialog.getByText('旧的分析', { exact: true })).toHaveCount(0)
    await expect(dialog.getByRole('alert')).toHaveCount(0)
  })
}

test('影响分析刷新失败时显示恢复入口，禁止按旧报告执行', async ({ page }) => {
  await newProject(page)
  let requests = 0
  await page.route('**/api/canvases/*/impact', async (route) => {
    requests++
    if (requests === 2)
      await route.fulfill({ status: 503, json: { message: '分析服务暂时不可用' } })
    else await route.fulfill({ json: report('镜头图') })
  })
  await page.getByRole('button', { name: '查看影响', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '查看影响' })
  await expect(dialog.getByRole('checkbox', { name: '重做镜头图' })).toBeChecked()
  await page.evaluate(() => {
    window.__plein.addNode({ type: 'plein/image', name: '触发刷新', params: {}, x: 0, y: 0 })
  })
  await expect(dialog.getByRole('alert')).toContainText('分析服务暂时不可用')
  await expect(dialog.getByRole('button', { name: '重做选中的 1 个' })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '保留', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '重新分析', exact: true }).click()
  await expect.poll(() => requests).toBe(3)
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: '重做选中的 1 个' })).toBeEnabled()
})
