import { expect, test } from './fixtures'
import type { JobInfo } from '../packages/protocol/src/runs'
import { newProject } from './canvas'

test('过期任务行停止不影响节点新任务，刷新后停止明确的新任务', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() => {
    const id = window.__plein.addNode({
      type: 'plein/image',
      name: '任务身份测试',
      x: 300,
      y: 200,
      params: {},
    })
    const node = window.__plein.engine.doc.mutable(id) as unknown as {
      set(key: string, value: unknown): void
    }
    node.set('run', { id: 'new-job', status: 'running', at: Date.now() })
    return id
  })
  const peer = await page.context().newPage()
  try {
    await peer.goto(page.url())
    await expect
      .poll(() =>
        peer.evaluate((id) => {
          const node = window.__plein?.engine.doc.get(id) as { run?: { id: string } } | undefined
          return node?.run?.id
        }, id),
      )
      .toBe('new-job')
    const job: JobInfo = {
      id: 'old-job',
      nodeId: id,
      nodeType: 'plein/image',
      status: 'running',
      attempts: 1,
      createdAt: Date.now(),
    }
    await page.route('**/api/canvases/*/jobs', (route) =>
      route.fulfill({ json: { jobs: [job], groups: [] } }),
    )
    const requests: unknown[] = []
    page.on('request', (request) => {
      if (request.url().endsWith(`/nodes/${id}/cancel`))
        requests.push(request.postData() ? request.postDataJSON() : null)
    })
    await page.getByRole('button', { name: '任务', exact: true }).click()
    const panel = page.getByRole('complementary', { name: '任务', exact: true })
    const stop = panel.getByRole('button', { name: '停止', exact: true })
    const stale = page.waitForResponse((response) => response.url().endsWith(`/nodes/${id}/cancel`))
    await stop.click()
    expect((await stale).status()).toBe(409)
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.run?.status, id)).toBe(
      'running',
    )
    expect(requests).toEqual([{ runId: 'old-job' }])
    await expect(
      page.getByText('此节点已开始其他任务，旧停止请求未执行', { exact: true }),
    ).toBeVisible()
    job.id = 'new-job'
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '任务', exact: true }).click()
    await expect(panel.locator('[data-job-id="new-job"]')).toBeVisible()
    const current = page.waitForResponse((response) =>
      response.url().endsWith(`/nodes/${id}/cancel`),
    )
    await stop.click()
    expect((await current).status()).toBe(204)
    await expect
      .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.run?.status, id))
      .toBe('canceled')
    expect(requests).toEqual([{ runId: 'old-job' }, { runId: 'new-job' }])
    job.status = 'canceled'
    await expect(panel.getByText('已取消', { exact: true })).toBeVisible()
    await expect(stop).toHaveCount(0)
    await page.screenshot({
      path: test.info().outputPath('task-cancel-identity.png'),
      animations: 'disabled',
    })
  } finally {
    await peer.close()
  }
})
