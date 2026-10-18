import { expect, test } from '@playwright/test'
import type { JobInfo } from '../packages/protocol/src/runs'
import { newProject, waitEngine } from './canvas'

for (const change of ['rename', 'delete'] as const) {
  test(`任务目标${change === 'rename' ? '协作改名' : '删除与撤销重做'}立即同步名称和操作入口`, async ({
    page,
  }) => {
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/image',
        name: '任务目标原名',
        params: {},
        x: 300,
        y: 200,
      }),
    )
    const job: JobInfo = {
      id: 'target-fixture',
      nodeId: id,
      nodeType: 'plein/image',
      status: 'failed',
      attempts: 1,
      createdAt: Date.now(),
      error: '测试失败历史',
    }
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let frozen = false
    await page.route('**/api/canvases/*/jobs', async (route) => {
      if (frozen) await gate
      await route.fulfill({ json: { jobs: [job], groups: [] } })
    })
    const peer = await page.context().newPage()
    try {
      await peer.goto(page.url())
      await waitEngine(peer)
      await expect
        .poll(() => peer.evaluate((id) => window.__plein.engine.doc.get(id)?.name, id))
        .toBe('任务目标原名')
      await page.getByRole('button', { name: '任务', exact: true }).click()
      const panel = page.getByRole('complementary', { name: '任务', exact: true })
      const row = panel.locator('[data-job-id="target-fixture"]')
      const locate = row.getByRole('button', { name: '任务目标原名', exact: true })
      await expect(locate).toBeEnabled()
      await expect(row.getByRole('button', { name: '重试', exact: true })).toBeEnabled()
      frozen = true
      if (change === 'rename') {
        await peer.evaluate((id) => {
          const node = window.__plein.engine.doc.mutable(id) as unknown as {
            set(key: string, value: unknown): void
          }
          node.set('name', '协作后的新名字')
        }, id)
        await expect
          .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, id))
          .toBe('协作后的新名字')
        const renamed = row.getByRole('button', { name: '协作后的新名字', exact: true })
        await expect(renamed).toBeEnabled({ timeout: 1500 })
        await renamed.click()
        expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([id])
        await expect(locate).toHaveCount(0)
      } else {
        await page.evaluate((id) => {
          const engine = window.__plein.engine as typeof window.__plein.engine & {
            deleteSelection(): void
            doc: { undo: { stopCapturing(): void } }
          }
          engine.doc.undo.stopCapturing()
          engine.selection.set([id])
          engine.deleteSelection()
        }, id)
        const deleted = row.getByRole('button', { name: '生成图片', exact: true })
        await expect(deleted).toBeDisabled({ timeout: 1500 })
        await expect(deleted).toHaveAttribute('title', '节点已删除')
        await expect(row.getByRole('button', { name: '重试', exact: true })).toHaveCount(0)
        await page.evaluate(() => (window.__plein.engine as unknown as { undo(): void }).undo())
        await expect(locate).toBeEnabled()
        await expect(row.getByRole('button', { name: '重试', exact: true })).toBeEnabled()
        await locate.click()
        expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([id])
        await page.evaluate(() => (window.__plein.engine as unknown as { redo(): void }).redo())
        await expect(deleted).toBeDisabled()
        await expect(row.getByRole('button', { name: '重试', exact: true })).toHaveCount(0)
      }
      await page.screenshot({
        path: test.info().outputPath('task-target.png'),
        animations: 'disabled',
      })
    } finally {
      release()
      await peer.close()
    }
  })
}
