import { expect, test } from '@playwright/test'
import type { JobList } from '../packages/protocol/src/runs'
import { clickElement, newProject, waitEngine } from './canvas'

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

test('重试应答失败前切换画布，不把旧错误通知新画布，返回后仍可重试', async ({ page }) => {
  await newProject(page)
  const original = page.url()
  const canvas = new URL(original).hash.split('/').at(-1)!
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '跨画布重试目标',
      params: { prompt: '水杯', model: 'not-installed:missing' },
      x: 300,
      y: 200,
    }),
  )
  await expect
    .poll(async () =>
      (await page.request.get(`/api/canvases/${canvas}/nodes/${id}/input`)).status(),
    )
    .toBe(200)
  const first = await page.request.post(`/api/canvases/${canvas}/nodes/${id}/run`, { data: {} })
  expect(first.status()).toBe(202)
  const jobs = async () =>
    (await (await page.request.get(`/api/canvases/${canvas}/jobs`)).json()) as JobList
  await expect.poll(async () => (await jobs()).jobs[0]?.status).toBe('failed')
  await page.getByRole('button', { name: '任务', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '任务', exact: true })
  const retry = panel.getByRole('button', { name: '重试', exact: true })
  await expect(retry).toBeEnabled()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let requested = false
  await page.route(
    `**/api/canvases/${canvas}/nodes/${id}/run`,
    async (route) => {
      requested = true
      await gate
      await route.fulfill({
        status: 503,
        json: { error: 'retry_test', message: '旧画布重试迟到失败' },
      })
    },
    { times: 1 },
  )
  const next = await (
    await page.request.post('/api/projects', { data: { title: '继续工作的画布' } })
  ).json()
  try {
    await retry.click()
    await expect.poll(() => requested).toBe(true)
    await page.evaluate((id) => {
      location.hash = `#/c/${id}`
    }, next.lastCanvasId)
    await expect
      .poll(() =>
        page.evaluate(
          (id) => location.hash === `#/c/${id}` && !!window.__plein?.engine,
          next.lastCanvasId,
        ),
      )
      .toBe(true)
    await waitEngine(page)
    await expect
      .poll(() => page.evaluate(() => [...window.__plein.engine.doc.elements()].length))
      .toBe(0)
    const settled = page.waitForResponse(
      (res) => res.url().endsWith(`/nodes/${id}/run`) && res.status() === 503,
    )
    await page.evaluate(() => {
      const notices: string[] = []
      const observer = new MutationObserver(() => {
        for (const el of document.querySelectorAll('.ui-toast'))
          if (el.textContent?.includes('旧画布重试迟到失败')) notices.push(el.textContent)
      })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      ;(window as unknown as { retryNotices(): string[] }).retryNotices = () => {
        observer.disconnect()
        return notices
      }
    })
    release()
    await settled
    await page.waitForLoadState('networkidle')
    expect(
      await page.evaluate(() => (window as unknown as { retryNotices(): string[] }).retryNotices()),
    ).toEqual([])
    await expect(page.locator('.ui-toast').filter({ hasText: '旧画布重试迟到失败' })).toHaveCount(0)
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()].length)).toBe(0)
    await page.evaluate((url) => {
      location.hash = new URL(url).hash
    }, original)
    await waitEngine(page)
    await page.getByRole('button', { name: '任务', exact: true }).click()
    await expect(panel.getByRole('button', { name: '跨画布重试目标', exact: true })).toBeVisible()
    const response = page.waitForResponse(
      (res) => res.url().endsWith(`/nodes/${id}/run`) && res.request().method() === 'POST',
    )
    await retry.click()
    expect((await response).status()).toBe(202)
    await expect.poll(async () => (await jobs()).jobs.length).toBe(2)
  } finally {
    release()
  }
})

test('重试等待期间阻止重复请求，重开面板仍显示等待，失败后可再次提交', async ({ page }) => {
  await newProject(page)
  const canvas = new URL(page.url()).hash.split('/').at(-1)!
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '重试等待目标',
      params: { model: 'not-installed:missing' },
      x: 300,
      y: 200,
    }),
  )
  await expect
    .poll(async () =>
      (await page.request.get(`/api/canvases/${canvas}/nodes/${id}/input`)).status(),
    )
    .toBe(200)
  expect(
    (await page.request.post(`/api/canvases/${canvas}/nodes/${id}/run`, { data: {} })).status(),
  ).toBe(202)
  const jobs = async () =>
    (await (await page.request.get(`/api/canvases/${canvas}/jobs`)).json()) as JobList
  await expect.poll(async () => (await jobs()).jobs[0]?.status).toBe('failed')
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  await page.route(`**/api/canvases/${canvas}/nodes/${id}/run`, async (route) => {
    if (++calls === 1) {
      await gate
      return route.fulfill({
        status: 503,
        json: { error: 'retry_wait', message: '重试请求暂不可用' },
      })
    }
    await route.continue()
  })
  await page.getByRole('button', { name: '任务', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '任务', exact: true })
  const retry = panel.getByRole('button', { name: '重试', exact: true })
  try {
    await retry.evaluate((button) => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })
    await expect.poll(() => calls).toBe(1)
    await expect(retry).toBeDisabled()
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
    await clickElement(page, id)
    const card = page.locator('.plein-node')
    await expect(card.getByRole('button', { name: '重试', exact: true })).toBeDisabled()
    await expect(card.getByRole('status').filter({ hasText: '正在提交重试…' })).toBeVisible()
    await card.screenshot({
      path: test.info().outputPath('card-retry-pending.png'),
      animations: 'disabled',
    })
    await page.getByRole('button', { name: '任务', exact: true }).click()
    await expect(retry).toBeDisabled()
    await expect(panel.getByRole('status').filter({ hasText: '正在提交重试…' })).toBeVisible()
    await panel.screenshot({
      path: test.info().outputPath('retry-pending.png'),
      animations: 'disabled',
    })
    release()
    await expect(page.getByText('重试请求暂不可用', { exact: true })).toBeVisible()
    await expect(retry).toBeEnabled()
    await expect(
      page.locator('.plein-node').getByRole('button', { name: '重试', exact: true }),
    ).toBeEnabled()
    const response = page.waitForResponse(
      (res) => res.url().endsWith(`/nodes/${id}/run`) && res.request().method() === 'POST',
    )
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
    await clickElement(page, id)
    await page.locator('.plein-node').getByRole('button', { name: '重试', exact: true }).click()
    expect((await response).status()).toBe(202)
    expect(calls).toBe(2)
    await expect.poll(async () => (await jobs()).jobs.length).toBe(2)
  } finally {
    release()
  }
})
