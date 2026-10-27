import { expect, test } from './fixtures'
import { createMediaFixture, seedMediaCanvas } from './perf/fixtures'
import { readMediaStats, type PerfPageWindow, waitEngine } from './perf/probe'

type Engine = import('../packages/canvas-core/src/engine').Engine

/** Fixture construction uses the engine; selection, grouping and dragging use actual input. */
test('千媒体画布框选、双层分组、拖动撤销重做及连续进出释放资源', async ({ page, baseURL }) => {
  // 一千个媒体元素，铺画布和分组本身就要几十秒
  test.slow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const fixture = await createMediaFixture(baseURL!, { elements: 1000, imageAssets: 32 })
  const canvas = await seedMediaCanvas(page, baseURL!, fixture)
  const read = () =>
    page.evaluate(() => {
      const e = window.__plein.engine as unknown as Engine
      return {
        elements: [...e.doc.elements()]
          .map((el) => ({ ...el, world: e.doc.worldRect(el.id) }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        edges: [...e.doc.edges()],
      }
    })
  await expect.poll(async () => (await readMediaStats(page)).previews.ready).toBe(1000)
  const initial = await read()
  const ids = await page.evaluate(() => {
    const e = window.__plein.engine as unknown as Engine
    const ids = [...e.doc.elements()].slice(0, 12).map((el) => el.id)
    e.zoomToFit(ids)
    e.doc.undo.stopCapturing()
    return ids
  })
  const marquee = await page.evaluate((ids) => {
    const e = window.__plein.engine as unknown as Engine
    const first = e.doc.worldRect(ids[0]!)!
    const last = e.doc.worldRect(ids.at(-1)!)!
    return {
      from: e.worldToClient(first.x - 24, first.y - 24),
      to: e.worldToClient(last.x + last.w + 24, last.y + last.h + 24),
    }
  }, ids)
  await page.mouse.move(marquee.from.x, marquee.from.y)
  await page.mouse.down()
  await page.mouse.move(marquee.to.x, marquee.to.y, { steps: 12 })
  await page.mouse.up()
  await expect
    .poll(() => page.evaluate(() => window.__plein.engine.selection.values().slice().sort()))
    .toEqual(ids.slice().sort())
  const focusCanvas = () =>
    page.locator('canvas').evaluate((canvas) => (canvas.parentElement as HTMLElement).focus())
  await focusCanvas()
  await page.keyboard.press('ControlOrMeta+g')
  await expect.poll(async () => (await read()).elements.length).toBe(1001)
  await focusCanvas()
  await page.keyboard.press('ControlOrMeta+g')
  await expect.poll(async () => (await read()).elements.length).toBe(1002)
  const grouped = await read()
  for (const original of initial.elements) {
    expect(grouped.elements.find((el) => el.id === original.id)!.world).toEqual(original.world)
  }
  const group = await page.evaluate(() => window.__plein.engine.selection.values()[0]!)
  const point = await page.evaluate((id) => {
    const e = window.__plein.engine as unknown as Engine
    e.zoomToFit([id])
    const r = e.doc.worldRect(id)!
    return e.worldToClient(r.x + 72, r.y + 12)
  }, group)
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x + 80, point.y + 45, { steps: 12 })
  await page.mouse.up()
  await expect
    .poll(async () => (await read()).elements.find((el) => el.id === ids[0])!.world!.x)
    .not.toBe(initial.elements.find((el) => el.id === ids[0])!.world!.x)
  const moved = await read()
  const firstBefore = initial.elements.find((el) => el.id === ids[0])!.world!
  const firstAfter = moved.elements.find((el) => el.id === ids[0])!.world!
  for (const id of ids) {
    const before = initial.elements.find((el) => el.id === id)!
    const after = moved.elements.find((el) => el.id === id)!
    expect(after.world!.x - before.world!.x).toBeCloseTo(firstAfter.x - firstBefore.x, 5)
    expect(after.world!.y - before.world!.y).toBeCloseTo(firstAfter.y - firstBefore.y, 5)
    expect(after.world!.w).toBe(before.world!.w)
    expect(after.world!.h).toBe(before.world!.h)
    expect(after.assetId).toBe(before.assetId)
  }
  for (const original of initial.elements.filter((el) => !ids.includes(el.id))) {
    expect(moved.elements.find((el) => el.id === original.id)).toEqual(original)
  }
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(read).toEqual(grouped)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect.poll(read).toEqual(moved)
  await page.screenshot({ path: test.info().outputPath('dense-nested-group.png') })

  // Real wheel input changes the view without mutating elements or media references.
  await page.mouse.move(point.x + 200, point.y + 100)
  const viewBefore = await page.evaluate(() => {
    const e = window.__plein.engine as unknown as Engine
    return { x: e.camera.x, zoom: e.camera.zoom }
  })
  await page.mouse.wheel(180, 100)
  await expect
    .poll(() => page.evaluate(() => (window.__plein.engine as unknown as Engine).camera.x))
    .not.toBe(viewBefore.x)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -160)
  await page.keyboard.up('Control')
  await expect
    .poll(() => page.evaluate(() => (window.__plein.engine as unknown as Engine).camera.zoom))
    .not.toBe(viewBefore.zoom)
  expect(await read()).toEqual(moved)

  for (let cycle = 0; cycle < 5; cycle++) {
    await page.evaluate(() => {
      const e = window.__plein.engine as unknown as Engine
      e.camera.lookAt(100, 100, 1)
    })
    await expect.poll(async () => (await readMediaStats(page)).offscreenBodies).toBe(0)
    const stats = await readMediaStats(page)
    expect(stats.textures.idleTextures).toBeLessThanOrEqual(128)
    expect(stats.textures.activeLeases).toBeLessThanOrEqual(stats.visibleBodies * 2)
    expect(stats.textures.unloadErrors).toBe(0)
    await page.evaluate(() => {
      const state = window as unknown as PerfPageWindow
      const engine = state.__plein!.engine
      state.__retiredMediaStats = () => engine.stats
      location.hash = '#/'
    })
    await page.waitForFunction(() => !window.__plein)
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as PerfPageWindow).__retiredMediaStats!().textures),
      )
      .toMatchObject({
        owners: 0,
        activeLeases: 0,
        queuedLoads: 0,
        inFlightLoads: 0,
        readyTextures: 0,
        unloadingTextures: 0,
      })
    await page.evaluate((id) => {
      location.hash = `#/c/${id}`
    }, canvas)
    await waitEngine(page)
    await expect.poll(read).toEqual(moved)
    await page.evaluate(() => (window.__plein.engine as unknown as Engine).zoomToFit())
    await expect.poll(async () => (await readMediaStats(page)).previews.ready).toBe(1000)
  }
  await page.screenshot({ path: test.info().outputPath('dense-reopened.png') })
  expect(errors).toEqual([])
})

test('千媒体与六十节点连线画布实际连接、撤销及整图整理还原', async ({ page, baseURL }) => {
  // 一千个媒体元素，铺画布本身就要几十秒
  test.slow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const fixture = await createMediaFixture(baseURL!, { elements: 1000, imageAssets: 32 })
  await seedMediaCanvas(page, baseURL!, fixture)
  const nodes = await page.evaluate(() => {
    const e = window.__plein.engine as unknown as Engine
    const ids = Array.from({ length: 60 }, (_, i) =>
      window.__plein.addNode({
        type: 'plein/image-edit',
        name: `密集连线 ${i + 1}`,
        params: {},
        x: 13500 + (i % 10) * 480,
        y: Math.floor(i / 10) * 360,
      }),
    )
    for (let i = 0; i < 59; i++) {
      if (i === 2) continue // 留下一个真实鼠标连接的目标。
      if (!window.__plein.connect([ids[i]!, 'images'], [ids[i + 1]!, 'image']))
        throw new Error(`Fixture connection ${i} failed`)
    }
    e.selection.clear()
    e.doc.flush()
    e.doc.undo.stopCapturing()
    e.zoomToFit(ids.slice(0, 4))
    return ids
  })
  const read = () =>
    page.evaluate(() => {
      const e = window.__plein.engine as unknown as Engine
      return { elements: [...e.doc.elements()], edges: [...e.doc.edges()] }
    })
  const before = await read()
  expect(before.elements).toHaveLength(1060)
  expect(before.edges).toHaveLength(58)
  const ports = await page.evaluate((nodes) => {
    const e = window.__plein.engine as unknown as Engine
    const source = e.doc.worldRect(nodes[0]!)!
    const target = e.doc.worldRect(nodes[3]!)!
    return {
      from: e.worldToClient(source.x + source.w, source.y + source.h / 2),
      to: e.worldToClient(target.x, target.y + target.h / 2),
    }
  }, nodes)
  await page.mouse.move(ports.from.x, ports.from.y)
  await page.mouse.down()
  await page.mouse.move(ports.to.x, ports.to.y, { steps: 20 })
  await page.mouse.up()
  await expect.poll(async () => (await read()).edges.length).toBe(59)
  const connected = await read()
  expect(connected.elements).toEqual(before.elements)
  expect(connected.edges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ from: [nodes[0], 'images'], to: [nodes[3], 'image'] }),
    ]),
  )
  await page.screenshot({ path: test.info().outputPath('dense-connected.png') })
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(read).toEqual(before)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect.poll(read).toEqual(connected)

  await page.getByRole('button', { name: '整理画布', exact: true }).click()
  await expect(page.getByRole('button', { name: '还原', exact: true })).toBeVisible()
  await expect.poll(read).not.toEqual(connected)
  const arranged = await read()
  expect(arranged.edges).toEqual(connected.edges)
  // 全图整理可以移动位置，但不能改素材、参数、采用结果或其他业务字段。
  const content = (elements: typeof arranged.elements) =>
    elements.map(({ x: _x, y: _y, ...rest }) => rest)
  expect(content(arranged.elements)).toEqual(content(connected.elements))
  const fitted = await page.evaluate(() => {
    const e = window.__plein.engine as unknown as Engine
    const safe = e.camera.insets
    return {
      zoom: e.camera.zoom,
      safe: {
        left: safe.left,
        top: safe.top,
        right: e.camera.width - safe.right,
        bottom: e.camera.height - safe.bottom,
      },
      boxes: [...e.doc.elements()].map((el) => {
        const r = e.doc.worldRect(el.id)!
        return {
          from: e.camera.worldToScreen(r.x, r.y),
          to: e.camera.worldToScreen(r.x + r.w, r.y + r.h),
        }
      }),
    }
  })
  for (const box of fitted.boxes) {
    expect(box.from.x).toBeGreaterThanOrEqual(fitted.safe.left)
    expect(box.from.y).toBeGreaterThanOrEqual(fitted.safe.top)
    expect(box.to.x).toBeLessThanOrEqual(fitted.safe.right)
    expect(box.to.y).toBeLessThanOrEqual(fitted.safe.bottom)
  }
  await page.screenshot({ path: test.info().outputPath('dense-arranged.png') })
  await page.getByRole('button', { name: '还原', exact: true }).click()
  await expect.poll(read).toEqual(connected)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect.poll(read).toEqual(arranged)
  // 极远的节点仍能适配；不到 1% 的缩放需要可读、可编辑，不能显示成 0%。
  await page.evaluate((id) => {
    const e = window.__plein.engine as unknown as Engine
    e.doc.mutable(id)!.set('x', 5_000_000)
    e.doc.flush()
    e.zoomToFit()
  }, nodes.at(-1)!)
  const zoomButton = page.getByRole('button', { name: '缩放选项', exact: true })
  await expect(zoomButton).toHaveText(/^0\.\d+%$/)
  await zoomButton.click()
  const zoomField = page.getByRole('textbox', { name: '缩放百分比', exact: true })
  const percent = Number(await zoomField.inputValue())
  expect(percent).toBeGreaterThan(0)
  expect(percent).toBeLessThan(1)
  await zoomField.fill(String(percent * 2))
  await zoomField.press('Enter')
  await expect
    .poll(() => page.evaluate(() => (window.__plein.engine as unknown as Engine).camera.zoom))
    .toBeCloseTo((percent * 2) / 100, 8)
  const flightZoom = await page.evaluate(() => {
    const e = window.__plein.engine as unknown as Engine
    const ids = [...e.doc.elements()].map((el) => el.id)
    const boxes = ids.map((id) => e.doc.worldRect(id)!)
    const x = Math.min(...boxes.map((r) => r.x))
    const y = Math.min(...boxes.map((r) => r.y))
    const w = Math.max(...boxes.map((r) => r.x + r.w)) - x
    const h = Math.max(...boxes.map((r) => r.y + r.h)) - y
    const target = e.camera.fitTarget({ x, y, w, h }, 96)
    e.zoomTo(1)
    e.flyTo(ids)
    return target.zoom
  })
  await expect
    .poll(() => page.evaluate(() => (window.__plein.engine as unknown as Engine).camera.zoom))
    .toBeCloseTo(flightZoom, 8)
  expect(errors).toEqual([])
})
