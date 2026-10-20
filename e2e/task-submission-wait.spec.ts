import { expect, test } from '@playwright/test'
import type { JobInfo } from '../packages/protocol/src/runs'
import { newProject } from './canvas'

for (const narrow of [false, true]) {
  test(`${narrow ? '窄窗口' : '普通窗口'}长时间等待提交响应明确说明，阶段更新和提交未知不自动重试`, async ({
    page,
  }) => {
    if (narrow) await page.setViewportSize({ width: 800, height: 560 })
    await page.clock.install({ time: new Date() })
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/speech',
        name: '长时间等待响应',
        x: 400,
        y: 200,
        params: { model: 'plein/mock:audio', text: '测试等待响应的说明。' },
      }),
    )
    const start = await page.evaluate(() => Date.now())
    const job: JobInfo = {
      id: 'slow-submit-fixture',
      nodeId: id,
      nodeType: 'plein/speech',
      status: 'running',
      attempts: 1,
      createdAt: start - 90_000,
      startedAt: start - 90_000,
    }
    await page.route('**/api/canvases/*/jobs', (route) =>
      route.fulfill({ json: { jobs: [job], groups: [] } }),
    )
    let submits = 0
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/nodes\/[^/]+\/run$/.test(request.url())) submits++
    })
    const phase = (phase: string, failed = false) =>
      page.evaluate(
        ({ id, phase, start, failed }) => {
          const node = window.__plein.engine.doc.mutable(id) as unknown as {
            set(key: string, value: unknown): void
          }
          node.set('run', {
            id: 'slow-submit-fixture',
            status: failed ? 'failed' : 'running',
            startedAt: start - 90_000,
            phase,
            via: '测试平台 · 配音模型',
            at: Date.now(),
            ...(failed
              ? { errorCode: 'submit_unknown', error: '模拟：响应网关返回 504，提交结果未知' }
              : {}),
          })
        },
        { id, phase, start, failed },
      )
    await phase('waiting')
    await page.getByRole('button', { name: '任务', exact: true }).click()
    const panel = page.getByRole('complementary', { name: '任务', exact: true })
    await expect(panel).toContainText('等待调用空位')
    await expect(panel).toContainText('Plein 本地的测试平台并发已满')
    await page.clock.fastForward(31_000)
    await expect(panel).not.toContainText('请求可能已受理')
    await phase('submitting')
    await page.clock.fastForward(29_000)
    await expect(panel).toContainText('等待响应')
    await expect(panel).not.toContainText('请求可能已受理')
    await page.clock.fastForward(2_000)
    await expect(panel).toContainText('响应较慢')
    const notice = panel.getByRole('status').filter({ hasText: '请求可能已受理' })
    await expect(notice).toBeVisible()
    expect(await notice.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await expect(page.locator('.plein-node-run-detail')).toHaveAttribute('title', /请勿重复生成/)
    expect(submits).toBe(0)
    await panel.screenshot({ path: test.info().outputPath('submission-wait-notice.png') })
    await phase('accepted')
    await expect(panel).toContainText('平台已受理')
    await expect(panel).toContainText('等待任务状态')
    await expect(panel).not.toContainText('等待响应')
    await expect(panel).not.toContainText('请求可能已受理')
    await expect(panel.getByRole('list', { name: '进度' })).toHaveCount(0)
    await phase('generating')
    await expect(panel).not.toContainText('请求可能已受理')
    await phase('submitting')
    await expect(panel).not.toContainText('请求可能已受理')
    job.status = 'failed'
    job.error = '模拟：响应网关返回 504，提交结果未知'
    job.finishedAt = start + 62_000
    await phase('submitting', true)
    await page.clock.fastForward(6_000)
    await expect(panel).toContainText('提交结果未知')
    await expect(panel).not.toContainText('请求可能已受理')
    expect(submits).toBe(0)
    expect(job.attempts).toBe(1)
  })
}
