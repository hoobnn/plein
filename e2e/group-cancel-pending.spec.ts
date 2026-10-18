import { expect, test } from '@playwright/test'
import type { GroupRunStarted, GroupRunState, JobList } from '../packages/protocol/src/runs'
import { newProject, waitEngine } from './canvas'

for (const entry of ['任务面板重开', 'Frame工具条'] as const) {
  test(`停止整组等待时${entry}共享禁用，失败可重试并取消运行和排队节点`, async ({ page }) => {
    await newProject(page)
    const configUrl = '/api/providers/plein/mock/config'
    const original = (await (await page.request.get(configUrl)).json()) as {
      settings: Record<string, unknown>
    }
    expect(
      (
        await page.request.put(configUrl, {
          data: { settings: { ...original.settings, latencyMs: 60_000 } },
        })
      ).ok(),
    ).toBe(true)
    let groupId: string | undefined
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      const canvas = new URL(page.url()).hash.split('/').at(-1)!
      const ids = await page.evaluate(() => {
        const nodes = Array.from({ length: 5 }, (_, i) =>
          window.__plein.addNode({
            type: 'plein/image',
            name: `整组停止水杯${i + 1}`,
            params: { prompt: `透明水杯${i + 1}`, model: 'plein/mock:image' },
            x: 300 + i * 440,
            y: 200,
          }),
        )
        const engine = window.__plein.engine as typeof window.__plein.engine & {
          groupSelection(): void
        }
        engine.selection.set(nodes)
        engine.groupSelection()
        const frame = engine.selection.values()[0]!
        engine.zoomToFit([frame])
        return { nodes, frame }
      })
      const peer = await page.context().newPage()
      try {
        await peer.goto(page.url())
        await waitEngine(peer)
        await expect
          .poll(() =>
            peer.evaluate(
              () =>
                [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'node').length,
            ),
          )
          .toBe(5)
      } finally {
        await peer.close()
      }
      const toolbar = page.getByRole('toolbar', { name: 'Frame 操作', exact: true })
      const started = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/frames/${ids.frame}/run`) &&
          response.request().method() === 'POST',
      )
      await toolbar.getByRole('button', { name: '运行整组（5）', exact: true }).click()
      const response = await started
      expect(response.status()).toBe(202)
      groupId = ((await response.json()) as GroupRunStarted).groupId
      const jobs = async () =>
        (await (await page.request.get(`/api/canvases/${canvas}/jobs`)).json()) as JobList
      await expect
        .poll(async () => (await jobs()).jobs.filter((job) => job.groupId === groupId).length)
        .toBe(5)
      const active = (await jobs()).jobs.filter((job) => job.groupId === groupId)
      expect(active.some((job) => job.status === 'running')).toBe(true)
      expect(active.some((job) => job.status === 'queued')).toBe(true)
      let calls = 0
      const cancelUrl = `/api/runs/groups/${groupId}/cancel`
      await page.route(`**${cancelUrl}`, async (route) => {
        calls++
        if (calls === 1) {
          await gate
          return route.fulfill({
            status: 503,
            json: { error: 'cancel_group_failed', message: '停止整组测试失败' },
          })
        }
        return route.continue()
      })
      const tasks = page.getByRole('button', { name: '任务', exact: true })
      await tasks.click()
      const panel = page.getByRole('complementary', { name: '任务', exact: true })
      let stop = panel.getByRole('button', { name: '停止整组', exact: true })
      await stop.evaluate((button) => {
        ;(button as HTMLButtonElement).click()
        ;(button as HTMLButtonElement).click()
      })
      await expect.poll(() => calls).toBe(1)
      await expect(stop).toBeDisabled()
      await panel.getByRole('button', { name: '关闭', exact: true }).click()
      let scope = toolbar
      stop = toolbar.getByRole('button', { name: '停止运行', exact: true })
      await expect(stop).toBeDisabled()
      await expect(stop).toHaveAttribute('aria-busy', 'true')
      if (entry === '任务面板重开') {
        await tasks.click()
        scope = panel
        stop = panel.getByRole('button', { name: '停止整组', exact: true })
      }
      await expect(stop).toBeDisabled()
      await expect(scope.getByRole('status')).toContainText('正在停止整组…')
      expect(calls).toBe(1)
      await page.screenshot({
        path: test.info().outputPath('group-cancel-waiting.png'),
        animations: 'disabled',
      })
      release()
      await expect(page.getByText('停止整组测试失败', { exact: true })).toBeVisible()
      await expect(stop).toBeEnabled()
      expect((await jobs()).groups.find((group) => group.id === groupId)?.status).toBe('running')
      const canceled = page.waitForResponse((response) => response.url().endsWith(cancelUrl))
      await stop.click()
      expect((await canceled).status()).toBe(204)
      expect(calls).toBe(2)
      await expect
        .poll(
          async () =>
            (
              (await (
                await page.request.get(`/api/runs/groups/${groupId}`)
              ).json()) as GroupRunState
            ).status,
        )
        .toBe('canceled')
      await expect
        .poll(async () =>
          (await jobs()).jobs.filter((job) => job.groupId === groupId).map((job) => job.status),
        )
        .toEqual(Array(5).fill('canceled'))
      await expect
        .poll(() =>
          page.evaluate(
            (nodes) => nodes.map((id) => window.__plein.engine.doc.get(id)?.run?.status),
            ids.nodes,
          ),
        )
        .toEqual(Array(5).fill('canceled'))
      await expect(
        toolbar.getByRole('button', { name: '运行整组（5）', exact: true }),
      ).toBeEnabled()
    } finally {
      release()
      if (groupId) await page.request.post(`/api/runs/groups/${groupId}/cancel`)
      await page.request.put(configUrl, { data: { settings: original.settings } })
    }
  })
}
