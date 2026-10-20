import { expect, test } from '@playwright/test'
import { solidPng } from '../packages/providers/src/mock/media'
import { newProject } from './canvas'

type Engine = import('../packages/canvas-core/src/engine').Engine
for (const zoom of [0.2, 0.249, 0.25, 0.5]) {
  for (const depth of [0, 2]) {
    test(`${zoom * 100}% 缩放 ${depth} 层分组的端口显示与拖动一致，可撤销重做`, async ({
      page,
    }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await newProject(page)
      const upload = await page.request.post('/api/assets', {
        headers: { 'content-type': 'image/png' },
        data: Buffer.from(solidPng(64, 48, [140, 100, 180])),
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
                name: '缩放来源图片',
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
          const source = [...engine.doc.elements()][0]!.id
          engine.selection.set([source])
          for (let i = 0; i < depth; i++) engine.groupSelection()
          const target = window.__plein.addNode({
            type: 'plein/image-edit',
            name: '缩放重绘目标',
            params: {},
            x: 1150,
            y: 400,
          })
          engine.selection.clear()
          engine.doc.flush()
          engine.doc.undo.stopCapturing()
          engine.zoomToFit()
          engine.camera.zoomTo(zoom)
          return { source, target, actualZoom: engine.camera.zoom }
        },
        { assetId: (await upload.json()).id as string, zoom, depth },
      )
      expect(ids.actualZoom).toBe(zoom)
      const read = () =>
        page.evaluate(() => {
          const engine = window.__plein.engine as unknown as Engine
          return {
            nodes: [...engine.doc.elements()]
              .map((el) => ({ id: el.id, parent: el.parentId, rect: engine.doc.worldRect(el.id)! }))
              .sort((a, b) => a.id.localeCompare(b.id)),
            edges: [...engine.doc.edges()],
          }
        })
      const before = await read()
      const points = await page.evaluate(({ source, target }) => {
        const engine = window.__plein.engine as unknown as Engine
        const a = engine.doc.worldRect(source)!
        const b = engine.doc.worldRect(target)!
        return {
          from: engine.worldToClient(a.x + a.w, a.y + a.h / 2),
          to: engine.worldToClient(b.x, b.y + b.h / 2),
        }
      }, ids)
      await page.mouse.move(points.from.x - 1, points.from.y)
      await page.screenshot({ path: testInfo.outputPath('ports-hover.png') })
      await page.mouse.down()
      if (zoom < 0.25) {
        await page.mouse.move(points.from.x + 15, points.from.y, { steps: 5 })
        await page.mouse.up()
        await expect
          .poll(async () => (await read()).nodes.find((node) => node.id === ids.source)!.rect.x)
          .not.toBe(before.nodes.find((node) => node.id === ids.source)!.rect.x)
        expect((await read()).edges).toEqual([])
        await expect(page.getByRole('dialog', { name: '添加节点', exact: true })).toHaveCount(0)
      } else {
        await page.mouse.move(points.to.x + 1, points.to.y, { steps: 8 })
        await page.mouse.up()
        await expect
          .poll(async () => (await read()).edges)
          .toMatchObject([{ from: [ids.source, 'image'], to: [ids.target, 'image'] }])
        expect((await read()).nodes).toEqual(before.nodes)
      }
      const after = await read()
      await page.screenshot({ path: testInfo.outputPath('ports-after-drag.png') })
      await page.getByRole('button', { name: '撤销', exact: true }).click()
      await expect.poll(read).toEqual(before)
      await page.getByRole('button', { name: '重做', exact: true }).click()
      await expect.poll(read).toEqual(after)
      expect(errors).toEqual([])
    })
  }
}
