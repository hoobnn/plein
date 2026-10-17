import { expect, test } from '@playwright/test'
import type { JobInfo } from '../packages/protocol/src/runs'
import { addNode, elements, newProject } from './canvas'

for (const navigation of ['switch', 'close', 'return'] as const) {
  test(`恢复请求迟到失败时 ${navigation} 不混淆画布，返回原任务可重试`, async ({ page }) => {
    await newProject(page)
    await addNode(page, '生成图片')
    const node = (await elements(page)).find((el) => el.kind === 'node')!
    const originalUrl = page.url()
    const canvas = /#\/c\/([^/?]+)/.exec(originalUrl)![1]!
    const job: JobInfo = {
      id: 'navigation-recovery',
      nodeId: node.id,
      nodeType: node.nodeType!,
      status: 'failed',
      attempts: 1,
      createdAt: Date.now(),
      recovery: { state: 'fetch_failed', refetchable: true, remoteId: 'remote-original' },
    }
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const requests: Array<{ url: string; body: unknown }> = []
    let generated = 0
    await page.route(`**/api/canvases/${canvas}/jobs`, (route) =>
      route.fulfill({ json: { jobs: [job], groups: [] } }),
    )
    await page.route('**/api/canvases/*/nodes/*/run', (route) => {
      generated++
      return route.abort()
    })
    await page.route('**/api/canvases/*/jobs/navigation-recovery/recover', async (route) => {
      requests.push({ url: route.request().url(), body: route.request().postDataJSON() })
      if (requests.length === 1) {
        await pending
        return route.fulfill({ status: 503, json: { message: '原画布恢复服务暂不可用' } })
      }
      job.recovery = { state: 'remote_pending', refetchable: true, remoteId: 'remote-original' }
      await route.fulfill({ json: job })
    })
    await page.evaluate(() => {
      const fetch = window.fetch.bind(window)
      window.fetch = async (...args) => {
        const response = await fetch(...args)
        if (response.url.endsWith('/jobs/navigation-recovery/recover')) {
          const json = response.json.bind(response)
          response.json = async () => {
            const body = await json()
            setTimeout(() => {
              document.body.dataset.recoveryBodyRead = 'true'
            }, 0)
            return body
          }
        }
        return response
      }
    })
    await page.getByRole('button', { name: '任务', exact: true }).click()
    const panel = page.getByRole('complementary', { name: '任务', exact: true })
    await panel.getByRole('button', { name: '重新获取', exact: true }).click()
    await expect.poll(() => requests.length).toBe(1)
    const completed = page
      .waitForResponse((response) => response.url().endsWith('/jobs/navigation-recovery/recover'))
      .then((response) => response.finished())
    let before: unknown
    try {
      await panel.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(panel).toHaveCount(0)
      if (navigation !== 'close') {
        await page.getByRole('button', { name: '切换画布', exact: true }).click()
        await page.getByRole('button', { name: '新建画布', exact: true }).click()
        await page
          .getByRole('dialog', { name: '新建画布', exact: true })
          .getByRole('textbox')
          .fill('不接收旧恢复错误')
        await page.keyboard.press('Enter')
        await expect(page.getByRole('button', { name: '切换画布', exact: true })).toHaveText(
          '不接收旧恢复错误',
        )
        await page.waitForFunction(
          (id) => window.__plein && !window.__plein.engine.doc.get(id),
          node.id,
        )
        await expect(page.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected')
        await page.waitForFunction(
          () => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.tagName === 'CANVAS',
        )
      }
      if (navigation === 'return') {
        await page.goBack()
        await expect(page).toHaveURL(originalUrl)
        await page.waitForFunction(
          (id) => window.__plein && !!window.__plein.engine.doc.get(id),
          node.id,
        )
        await expect(page.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected')
      }
      before = await page.evaluate(() => [...window.__plein.engine.doc.elements()])
    } finally {
      release()
    }
    await completed
    await page.waitForFunction(() => document.body.dataset.recoveryBodyRead === 'true')
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    if (navigation === 'switch') {
      expect(await page.getByText('原画布恢复服务暂不可用', { exact: true }).count()).toBe(0)
      expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(before)
      await page.screenshot({ path: 'test-results/recovery-current-canvas.png' })
      await page.goBack()
      await expect(page).toHaveURL(originalUrl)
      await page.waitForFunction(
        (id) => window.__plein && !!window.__plein.engine.doc.get(id),
        node.id,
      )
    } else await expect(page.getByText('原画布恢复服务暂不可用', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '任务', exact: true }).click()
    await panel.getByRole('button', { name: '重新获取', exact: true }).click()
    await expect(panel.getByText('平台已受理，结果尚未取回', { exact: true })).toBeVisible()
    expect(requests).toHaveLength(2)
    expect(
      requests.every(
        (request) =>
          request.url.includes(`/canvases/${canvas}/jobs/navigation-recovery/recover`) &&
          JSON.stringify(request.body) === JSON.stringify({ action: 'refetch' }),
      ),
    ).toBe(true)
    expect(generated).toBe(0)
  })
}
