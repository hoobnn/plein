import { expect, test } from './fixtures'
import type { BatchItem } from '../packages/protocol/src/recovery'
import type { GroupRunStarted, GroupRunState } from '../packages/protocol/src/runs'
import { newProject, waitEngine } from './canvas'

for (const scope of ['frame', 'downstream', 'item'] as const) {
  test(`真实批量运行的 ${scope} 定位随改名、删除和撤销重做更新，记录可展开收起`, async ({
    page,
  }) => {
    await newProject(page)
    const canvas = new URL(page.url()).hash.split('/').at(-1)!
    const ids = await page.evaluate(() => {
      const node = window.__plein.addNode({
        type: 'plein/image',
        name: '批量定位水杯',
        params: { prompt: '透明水杯', model: 'plein/mock:image' },
        x: 300,
        y: 200,
      })
      const engine = window.__plein.engine as typeof window.__plein.engine & {
        groupSelection(): void
      }
      engine.selection.set([node])
      engine.groupSelection()
      return { node, frame: engine.selection.values()[0]! }
    })
    const peer = await page.context().newPage()
    try {
      await peer.goto(page.url())
      await waitEngine(peer)
      await expect
        .poll(() => peer.evaluate((id) => window.__plein.engine.doc.get(id)?.name, ids.node))
        .toBe('批量定位水杯')
      const response = await page.request.post(
        scope === 'downstream'
          ? `/api/canvases/${canvas}/nodes/${ids.node}/run-flow`
          : `/api/canvases/${canvas}/frames/${ids.frame}/run`,
        {
          data: scope === 'downstream' ? { scope: 'downstream' } : {},
        },
      )
      expect(response.status()).toBe(202)
      const { groupId } = (await response.json()) as GroupRunStarted
      await expect
        .poll(
          async () =>
            (
              (await (
                await page.request.get(`/api/runs/groups/${groupId}`)
              ).json()) as GroupRunState
            ).status,
        )
        .toBe('done')
      const items = (await (
        await page.request.get(`/api/runs/groups/${groupId}/items`)
      ).json()) as BatchItem[]
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ nodeId: ids.node, outcome: 'succeeded' })
      await page.getByRole('button', { name: '任务', exact: true }).click()
      const panel = page.getByRole('complementary', { name: '任务', exact: true })
      const section = panel
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: '批量运行', exact: true }) })
      const group = section.locator(':scope > ul > li').first()
      const toggle = group.getByRole('button', { name: '批次记录', exact: true })
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await toggle.click()
      const records = group.getByRole('list', { name: '批次记录', exact: true })
      await expect(records).toBeVisible()
      const target =
        scope === 'item' ? records.getByRole('button').first() : group.getByRole('button').first()
      const targetId = scope === 'frame' ? ids.frame : ids.node
      await target.click()
      expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([
        targetId,
      ])
      await peer.evaluate((id) => {
        const node = window.__plein.engine.doc.mutable(id) as unknown as {
          set(key: string, value: unknown): void
        }
        node.set('name', '批次目标新名字')
      }, targetId)
      await expect(target).toContainText('批次目标新名字')
      await page.evaluate((id) => {
        const engine = window.__plein.engine as typeof window.__plein.engine & {
          deleteSelection(): void
          doc: { undo: { stopCapturing(): void } }
        }
        engine.doc.undo.stopCapturing()
        engine.selection.set([id])
        engine.deleteSelection()
      }, targetId)
      await expect(target).toBeDisabled({ timeout: 1500 })
      await expect(target).toHaveAttribute('title', scope === 'item' ? '节点已删除' : '目标已删除')
      await page.screenshot({
        path: test.info().outputPath('deleted-batch-target.png'),
        animations: 'disabled',
      })
      await page.evaluate(() => (window.__plein.engine as unknown as { undo(): void }).undo())
      await expect(target).toBeEnabled()
      await expect(target).toContainText('批次目标新名字')
      await target.click()
      expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([
        targetId,
      ])
      await page.evaluate(() => (window.__plein.engine as unknown as { redo(): void }).redo())
      await expect(target).toBeDisabled()
      await group.getByRole('button', { name: '收起批次记录', exact: true }).click()
      await expect(records).toHaveCount(0)
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await toggle.click()
      await expect(records).toBeVisible()
      await expect(
        scope === 'item' ? records.getByRole('button').first() : group.getByRole('button').first(),
      ).toBeDisabled()
    } finally {
      await peer.close()
    }
  })
}
