import { expect, test } from '@playwright/test'
import type { LibraryItem } from '../packages/protocol/src/library'
import { solidPng } from '../packages/providers/src/mock/media'
import { newProject } from './canvas'

for (const change of ['unchanged', 'selection', 'adopted', 'renamed', 'immediate'] as const) {
  test(`多选入库 ${change} 绑定素材，重复图片去重且保存正确素材`, async ({ page }) => {
    await newProject(page)
    const assets: string[] = []
    for (const color of [
      [210, 20, 20],
      [20, 20, 210],
    ] as [number, number, number][]) {
      const response = await page.request.post('/api/assets', {
        headers: { 'Content-Type': 'image/png' },
        data: Buffer.from(solidPng(64, 48, color)),
      })
      expect(response.status()).toBe(201)
      assets.push(((await response.json()) as { id: string }).id)
    }
    const ids = await page.evaluate((assets) => {
      const engine = window.__plein.engine as typeof window.__plein.engine & {
        paste(data: unknown): void
      }
      engine.paste({
        plein: 1,
        edges: [],
        elements: ['红杯甲', '红杯乙', '蓝杯甲', '蓝杯乙'].map((name, i) => ({
          id: `image-${i}`,
          kind: 'image',
          name,
          assetId: assets[i < 2 ? 0 : 1],
          x: 300 + i * 240,
          y: 200,
          w: 200,
          h: 150,
          parentId: null,
          rotation: 0,
          locked: false,
        })),
      })
      const elements = [...engine.doc.elements()]
      const ids = ['红杯甲', '红杯乙', '蓝杯甲', '蓝杯乙'].map(
        (name) => elements.find((el) => el.name === name)!.id,
      )
      engine.selection.set(ids.slice(0, 2))
      engine.zoomToFit(ids.slice(0, 2))
      return ids
    }, assets)
    const title = `入库目标测试-${change}-${Date.now()}`
    const records = async () =>
      (await (await page.request.get('/api/library')).json()) as LibraryItem[]
    try {
      const trigger = page
        .getByRole('toolbar', { name: '多选操作', exact: true })
        .getByRole('button', { name: '存入资产库', exact: true })
      await trigger.click()
      const menu = page.getByRole('dialog', { name: '存入资产库', exact: true })
      await expect(menu).toBeVisible()
      if (change === 'immediate') {
        await menu.getByRole('button', { name: /^道具/ }).evaluate((button, ids) => {
          window.__plein.engine.selection.set(ids.slice(2))
          ;(button as HTMLButtonElement).click()
        }, ids)
        await expect(page.getByRole('dialog', { name: '资产库', exact: true })).toHaveCount(0)
        await expect(menu).toHaveCount(0)
        await trigger.click()
      }
      if (change === 'selection')
        await page.evaluate((ids) => window.__plein.engine.selection.set(ids.slice(2)), ids)
      if (change === 'adopted' || change === 'renamed')
        await page.evaluate(
          ({ id, asset, rename }) => {
            const node = window.__plein.engine.doc.mutable(id) as unknown as {
              set(key: string, value: unknown): void
            }
            node.set(rename ? 'name' : 'assetId', rename ? '改名后的红杯' : asset)
          },
          { id: ids[0]!, asset: assets[1]!, rename: change === 'renamed' },
        )
      if (change === 'selection' || change === 'adopted') {
        await expect(menu).toHaveCount(0, { timeout: 1500 })
        await expect(trigger).toHaveAttribute('aria-expanded', 'false')
        await trigger.click()
      }
      await menu.getByRole('button', { name: /^道具/ }).click()
      const panel = page.getByRole('dialog', { name: '资产库', exact: true })
      const name = panel.getByRole('textbox', { name: '名称', exact: true })
      await expect(name).toHaveValue(
        change === 'selection' || change === 'immediate'
          ? '蓝杯甲'
          : change === 'renamed'
            ? '改名后的红杯'
            : change === 'adopted'
              ? ''
              : '红杯甲',
      )
      await name.fill(title)
      await panel.getByRole('button', { name: '保存', exact: true }).click()
      await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
      const saved = (await records()).find((item) => item.name === title)!
      expect(saved.kind).toBe('prop')
      const expected =
        change === 'selection' || change === 'immediate'
          ? [assets[1]]
          : change === 'adopted'
            ? [assets[1], assets[0]]
            : [assets[0]]
      expect(saved.images.map((image) => image.assetId)).toEqual(expected)
      expect(new Set(saved.images.map((image) => image.assetId)).size).toBe(saved.images.length)
      await panel.screenshot({
        path: test.info().outputPath('library-selection-saved.png'),
        animations: 'disabled',
      })
    } finally {
      for (const item of await records())
        if (item.name === title) await page.request.delete(`/api/library/${item.id}`)
    }
  })
}
