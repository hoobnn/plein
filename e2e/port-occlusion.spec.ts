import { expect, test } from '@playwright/test'
import { solidPng } from '../packages/providers/src/mock/media'
import { deselect, newProject } from './canvas'

type Engine = import('../packages/canvas-core/src/engine').Engine

for (const zoom of [0.5, 1]) {
  for (const depth of [0, 2]) {
    test(`${zoom * 100}% ${depth} 层分组中被遮住的端口不抢占邻近可见卡片拖动`, async ({ page }) => {
      await newProject(page)
      const upload = await page.request.post('/api/assets', {
        headers: { 'content-type': 'image/png' },
        data: Buffer.from(solidPng(64, 48, [110, 150, 180])),
      })
      expect(upload.status()).toBe(201)
      const ids = await page.evaluate(
        ({ assetId, zoom, depth }) => {
          const engine = window.__plein.engine as unknown as Engine
          engine.paste({
            plein: 1,
            edges: [],
            elements: [
              {
                id: 'source',
                kind: 'image',
                name: '端口被遮挡的图片',
                assetId,
                x: 400,
                y: 400,
                w: 320,
                h: 240,
                z: 'a0',
                rotation: 0,
                locked: false,
                parentId: null,
              },
            ],
          })
          const source = engine.selection.values()[0]!
          for (let i = 0; i < depth; i++) engine.groupSelection()
          const rect = engine.doc.worldRect(source)!
          const target = window.__plein.addNode({
            type: 'plein/image-edit',
            name: '连线恢复目标',
            params: {},
            x: rect.x + rect.w + 360,
            y: rect.y,
          })
          const cover = window.__plein.addNode({
            type: 'plein/text',
            name: '遮挡端口中心的上层卡片',
            params: { text: '' },
            x: rect.x + rect.w - 4,
            y: rect.y + rect.h / 2 - 20,
          })
          const m = engine.doc.mutable(cover)!
          m.set('w', 80)
          m.set('h', 40)
          engine.selection.clear()
          engine.doc.flush()
          engine.doc.undo.stopCapturing()
          engine.zoomToFit([source, target])
          engine.camera.zoomTo(zoom)
          return { source, target, cover }
        },
        { assetId: (await upload.json()).id as string, zoom, depth },
      )
      const read = () =>
        page.evaluate(() => {
          const e = window.__plein.engine as unknown as Engine
          return {
            nodes: [...e.doc.elements()]
              .map((el) => ({ id: el.id, parent: el.parentId, rect: e.doc.worldRect(el.id)! }))
              .sort((a, b) => a.id.localeCompare(b.id)),
            edges: [...e.doc.edges()],
          }
        })
      const before = await read()
      const start = await page.evaluate(({ source, cover }) => {
        const e = window.__plein.engine as unknown as Engine
        const r = e.doc.worldRect(source)!
        const center = { x: r.x + r.w, y: r.y + r.h / 2 }
        return {
          point: e.worldToClient(center.x - 8 / e.camera.zoom, center.y),
          covering: e.scene.hitTest(center.x, center.y, (id) => e.scene.get(id)?.kind !== 'frame'),
          cover,
        }
      }, ids)
      expect(start.covering).toBe(ids.cover)
      await page.mouse.move(start.point.x, start.point.y)
      await page.screenshot({ path: test.info().outputPath('hidden-port-hover.png') })
      await page.mouse.down()
      await page.mouse.move(start.point.x - 80, start.point.y + 32, { steps: 8 })
      await page.mouse.up()
      await expect
        .poll(async () => (await read()).nodes.find((n) => n.id === ids.source)!.rect.x)
        .not.toBe(before.nodes.find((n) => n.id === ids.source)!.rect.x)
      expect((await read()).edges).toEqual([])
      await expect(page.getByRole('dialog', { name: '添加节点', exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: '撤销', exact: true }).click()
      await expect.poll(read).toEqual(before)

      // 实际拖走遮挡，再从同一个输出端口连线；不能只把隐藏端口永久禁掉。
      const coverAt = await page.evaluate((id) => {
        const e = window.__plein.engine as unknown as Engine
        const r = e.doc.worldRect(id)!
        return e.worldToClient(r.x + r.w / 2, r.y + r.h / 2)
      }, ids.cover)
      await page.mouse.move(coverAt.x, coverAt.y)
      await page.mouse.down()
      await page.mouse.move(coverAt.x, coverAt.y - 120, { steps: 8 })
      await page.mouse.up()
      await expect
        .poll(async () => (await read()).nodes.find((n) => n.id === ids.cover)!.rect.y)
        .not.toBe(before.nodes.find((n) => n.id === ids.cover)!.rect.y)
      const uncovered = await read()
      await deselect(page)
      await expect(page.getByTestId('generator')).toHaveCount(0)
      const ports = await page.evaluate(({ source, target }) => {
        const e = window.__plein.engine as unknown as Engine
        const a = e.doc.worldRect(source)!
        const b = e.doc.worldRect(target)!
        return {
          from: e.worldToClient(a.x + a.w, a.y + a.h / 2),
          to: e.worldToClient(b.x, b.y + b.h / 2),
        }
      }, ids)
      await page.mouse.move(ports.from.x, ports.from.y)
      await page.mouse.down()
      await page.mouse.move(ports.to.x, ports.to.y, { steps: 8 })
      await page.mouse.up()
      await expect
        .poll(async () => (await read()).edges)
        .toMatchObject([{ from: [ids.source, 'image'], to: [ids.target, 'image'] }])
      expect((await read()).nodes).toEqual(uncovered.nodes)
      const connected = await read()
      await page.screenshot({ path: test.info().outputPath('uncovered-port-connected.png') })
      await page.getByRole('button', { name: '撤销', exact: true }).click()
      await expect.poll(read).toEqual(uncovered)
      await page.getByRole('button', { name: '重做', exact: true }).click()
      await expect.poll(read).toEqual(connected)
    })
  }
}
