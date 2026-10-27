import { expect, test } from './fixtures'
import { handleOf, newProject } from './canvas'

type Engine = import('../packages/canvas-core/src/engine').Engine

for (const navigation of [
  { mode: 0, modifier: '' },
  { mode: 0, modifier: 'ctrl' },
]) {
  const { mode, modifier } = navigation
  for (const picked of [false, true]) {
    test(`滚轮单位 ${mode} ${modifier || '平移'} 接管${picked ? '已有' : '新'}连线后保留文档并可恢复`, async ({
      page,
    }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await newProject(page)
      const ids = await page.evaluate((picked) => {
        const source = window.__plein.addNode({
          type: 'plein/image',
          name: '滚轮来源',
          params: {},
          x: 400,
          y: 300,
        })
        const target = window.__plein.addNode({
          type: 'plein/image-process',
          name: '滚轮目标',
          params: {},
          x: 1000,
          y: 300,
        })
        if (picked && !window.__plein.connect([source, 'images'], [target, 'image']))
          throw new Error('连接失败')
        const engine = window.__plein.engine as unknown as Engine
        engine.selection.clear()
        engine.doc.flush()
        engine.doc.undo.stopCapturing()
        engine.zoomToFit()
        return { source, target }
      }, picked)
      const read = () =>
        page.evaluate(() => {
          const engine = window.__plein.engine as unknown as Engine
          const { x, y, zoom, width, height } = engine.camera
          return {
            camera: { x, y, zoom, width, height },
            nodes: [...engine.doc.elements()],
            edges: [...engine.doc.edges()],
            preview: (engine as unknown as { edges: { preview: unknown } }).edges.preview,
          }
        })
      const before = await read()
      const start = await handleOf(page, picked ? ids.target : ids.source, picked ? 'in' : 'out')
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      await page.mouse.move(start.x + 35, start.y + 45, { steps: 4 })
      await expect.poll(async () => (await read()).preview).not.toBeNull()
      const wheel = await page.evaluate(({ mode, modifier }) => {
        const surface = document.querySelector('canvas')!.parentElement!
        const rect = surface.getBoundingClientRect()
        const prevented = !surface.dispatchEvent(
          new WheelEvent('wheel', {
            deltaMode: mode,
            deltaX: 2,
            deltaY: -3,
            ctrlKey: modifier === 'ctrl',
            metaKey: false,
            clientX: 900,
            clientY: 600,
            bubbles: true,
            cancelable: true,
          }),
        )
        return { prevented, x: 900 - rect.left, y: 600 - rect.top }
      }, navigation)
      expect(wheel.prevented).toBe(true)
      const after = await read()
      if (modifier) {
        expect(after.camera.zoom).toBeCloseTo(before.camera.zoom * Math.exp(3 * 0.01))
        for (const axis of ['x', 'y'] as const) {
          expect((wheel[axis] - after.camera[axis]) / after.camera.zoom).toBeCloseTo(
            (wheel[axis] - before.camera[axis]) / before.camera.zoom,
          )
        }
      } else {
        expect(after.camera.x).toBeCloseTo(before.camera.x - 2)
        expect(after.camera.y).toBeCloseTo(before.camera.y + 3)
        expect(after.camera.zoom).toBe(before.camera.zoom)
      }
      expect(after.preview).toBeNull()
      expect(after.nodes).toEqual(before.nodes)
      expect(after.edges).toEqual(before.edges)
      await page.mouse.move(1300, 700)
      await page.mouse.up()
      expect(await read()).toEqual(after)
      await expect(page.getByRole('dialog', { name: '添加节点', exact: true })).toHaveCount(0)
      // 外部导航后能够重新建立连接，不沿用已取消的指针或预览。
      await page.evaluate(() => window.__plein.engine.zoomToFit())
      const from = await handleOf(page, ids.source, 'out')
      const to = await handleOf(page, ids.target, 'in')
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 5 })
      await page.mouse.up()
      await expect
        .poll(async () => (await read()).edges)
        .toMatchObject([{ from: [ids.source, 'images'], to: [ids.target, 'image'] }])
      expect((await read()).nodes).toEqual(before.nodes)
      await page.screenshot({ path: testInfo.outputPath('wheel-recovered.png') })
      expect(errors).toEqual([])
    })
  }
}
