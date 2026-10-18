import { expect, test } from '@playwright/test'
import type { JobList } from '../packages/protocol/src/runs'
import { newProject } from './canvas'

for (const stale of [false, true]) {
  test(`${stale ? '旧失败历史' : '当前失败任务'}重试核对运行身份并保留已有结果`, async ({
    page,
  }) => {
    await newProject(page)
    const canvas = new URL(page.url()).hash.split('/').at(-1)!
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/image',
        name: '重试身份测试',
        params: { prompt: '透明水杯', model: 'not-installed:missing' },
        x: 300,
        y: 200,
      }),
    )
    const peer = await page.context().newPage()
    try {
      await peer.goto(page.url())
      const model = () =>
        peer.evaluate((id) => window.__plein?.engine.doc.get(id)?.params?.model, id)
      await expect.poll(model).toBe('not-installed:missing')
      const run = () => page.request.post(`/api/canvases/${canvas}/nodes/${id}/run`, { data: {} })
      const jobs = async () =>
        (await (await page.request.get(`/api/canvases/${canvas}/jobs`)).json()) as JobList
      const first = await run()
      expect(first.status()).toBe(202)
      const { runId: failedId } = (await first.json()) as { runId: string }
      await expect
        .poll(async () => (await jobs()).jobs.find((j) => j.id === failedId)?.status)
        .toBe('failed')
      const failedList = await jobs()
      await page.evaluate((id) => {
        const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
          set(key: string, value: unknown): void
        }
        params.set('model', 'plein/mock:image')
      }, id)
      await expect.poll(model).toBe('plein/mock:image')
      if (stale) {
        const next = await run()
        expect(next.status()).toBe(202)
        await expect.poll(async () => (await jobs()).jobs[0]?.status).toBe('succeeded')
        await page.route(`**/api/canvases/${canvas}/jobs`, (route) =>
          route.fulfill({ json: failedList }),
        )
      }
      await page.getByRole('button', { name: '任务', exact: true }).click()
      const panel = page.getByRole('complementary', { name: '任务', exact: true })
      await expect(
        panel.getByRole('button', { name: '重试身份测试', exact: true }).first(),
      ).toBeVisible()
      const retry = panel.getByRole('button', { name: '重试', exact: true })
      if (stale) {
        await expect(retry).toHaveCount(0)
        const before = await jobs()
        const response = await page.request.post(`/api/canvases/${canvas}/nodes/${id}/run`, {
          data: { retryOf: failedId },
        })
        expect(response.status()).toBe(409)
        expect((await jobs()).jobs.map((j) => j.id)).toEqual(before.jobs.map((j) => j.id))
        expect(
          await page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length, id),
        ).toBe(1)
      } else {
        await expect(retry).toBeEnabled()
        const sent = page.waitForResponse(
          (r) => r.url().endsWith(`/nodes/${id}/run`) && r.request().method() === 'POST',
        )
        await retry.click()
        const response = await sent
        expect(response.status()).toBe(202)
        expect(response.request().postDataJSON()).toMatchObject({ retryOf: failedId })
        await expect.poll(async () => (await jobs()).jobs[0]?.status).toBe('succeeded')
        expect((await jobs()).jobs).toHaveLength(2)
        await expect
          .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length, id))
          .toBe(1)
        await expect(panel.getByText('已完成', { exact: true })).toBeVisible()
      }
      await page.screenshot({
        path: test.info().outputPath('retry-identity.png'),
        animations: 'disabled',
      })
    } finally {
      await peer.close()
    }
  })
}
