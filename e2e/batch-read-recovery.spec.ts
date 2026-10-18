import { expect, test } from '@playwright/test'
import type { BatchItem } from '../packages/protocol/src/recovery'
import type { GroupRunStarted, GroupRunState } from '../packages/protocol/src/runs'
import { newProject, waitEngine } from './canvas'

for (const cached of [false, true]) {
  test(`批次记录${cached ? '刷新失败保留旧数据' : '首次失败'}可直接恢复，收起重开共享读取`, async ({
    page,
  }) => {
    await newProject(page)
    const canvas = new URL(page.url()).hash.split('/').at(-1)!
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/image',
        name: '批次读取水杯',
        params: { prompt: '透明水杯', model: 'plein/mock:image' },
        x: 300,
        y: 200,
      }),
    )
    const peer = await page.context().newPage()
    try {
      await peer.goto(page.url())
      await waitEngine(peer)
      await expect
        .poll(() => peer.evaluate((id) => window.__plein.engine.doc.get(id)?.name, id))
        .toBe('批次读取水杯')
    } finally {
      await peer.close()
    }
    const started = await page.request.post(`/api/canvases/${canvas}/nodes/${id}/run-flow`, {
      data: { scope: 'downstream' },
    })
    expect(started.status()).toBe(202)
    const { groupId } = (await started.json()) as GroupRunStarted
    const url = `/api/runs/groups/${groupId}/items`
    await expect
      .poll(
        async () =>
          ((await (await page.request.get(`/api/runs/groups/${groupId}`)).json()) as GroupRunState)
            .status,
      )
      .toBe('done')
    const actual = (await (await page.request.get(url)).json()) as BatchItem[]
    expect(actual).toHaveLength(1)
    expect(actual[0]!.outcome).toBe('succeeded')
    let phase: 'initial' | 'fail' | 'hold' | 'okay' = cached ? 'initial' : 'fail'
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let requests = 0
    await page.route(`**${url}`, async (route) => {
      requests++
      if (phase === 'initial')
        return route.fulfill({ json: actual.map((item) => ({ ...item, outcome: 'pending' })) })
      if (phase === 'fail')
        return route.fulfill({
          status: 503,
          json: { error: 'batch_read_failed', message: '批次记录测试失败' },
        })
      if (phase === 'hold') await gate
      return route.continue()
    })
    try {
      await page.getByRole('button', { name: '任务', exact: true }).click()
      const panel = page.getByRole('complementary', { name: '任务', exact: true })
      const section = panel
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: '批量运行', exact: true }) })
      const group = section.locator(':scope > ul > li').first()
      const open = () => group.getByRole('button', { name: '批次记录', exact: true }).click()
      const close = () => group.getByRole('button', { name: '收起批次记录', exact: true }).click()
      await open()
      const records = group.getByRole('list', { name: '批次记录', exact: true })
      if (cached) {
        await expect(records.getByText('等待', { exact: true })).toBeVisible()
        phase = 'fail'
        await close()
        await open()
      }
      const alert = group.getByRole('alert')
      await expect(alert).toContainText('批次记录测试失败')
      if (cached) {
        await expect(alert).toContainText('以下仍为上次读取的批次记录')
        await expect(records.getByText('等待', { exact: true })).toBeVisible()
      }
      phase = 'hold'
      const before = requests
      const retry = group.getByRole('button', { name: '重新读取批次记录', exact: true })
      await retry.evaluate((button) => {
        ;(button as HTMLButtonElement).click()
        ;(button as HTMLButtonElement).click()
      })
      await expect.poll(() => requests).toBe(before + 1)
      const refresh = group.getByRole('button', { name: '刷新批次记录', exact: true })
      await expect(refresh).toBeDisabled()
      await expect(refresh).toHaveAttribute('aria-busy', 'true')
      if (cached) await expect(records.getByText('等待', { exact: true })).toBeVisible()
      else await expect(group.getByRole('status')).toHaveText('加载批次记录中…')
      await close()
      await open()
      await expect(refresh).toBeDisabled()
      expect(requests).toBe(before + 1)
      await page.screenshot({
        path: test.info().outputPath('batch-read-waiting.png'),
        animations: 'disabled',
      })
      phase = 'okay'
      release()
      await expect(records.getByText('已生成', { exact: true })).toBeVisible()
      await expect(alert).toHaveCount(0)
      await expect(refresh).toBeEnabled()
      const refreshed = page.waitForResponse((response) => response.url().endsWith(url))
      await refresh.click()
      expect((await refreshed).status()).toBe(200)
      await expect(refresh).toBeEnabled()
      await page.screenshot({
        path: test.info().outputPath('batch-read-recovered.png'),
        animations: 'disabled',
      })
    } finally {
      release()
    }
  })
}
