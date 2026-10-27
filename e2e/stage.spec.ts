import { expect, test, type Page } from './fixtures'
import { StageScene } from '../packages/nodes/src/stage'
import { addNode, centerOf, elements, newProject, waitEngine, zoomTo } from './canvas'

// 只保留 WebGL 像素、原生滑杆及手柄命中；状态与恢复分支在相邻快速测试中验证。
test.beforeEach(() => test.slow())

async function openStage(page: Page) {
  await newProject(page)
  await addNode(page, '3D 构图')
  const stage = (await elements(page)).find((e) => e.nodeType === 'plein/stage')!
  await page.keyboard.press('Escape')
  await zoomTo(page, [stage.id])
  const at = await centerOf(page, stage.id)
  await page.mouse.dblclick(at.x, at.y)
  const dialog = page.getByRole('dialog', { name: '3D 构图' })
  await expect(dialog.locator('canvas.stage-canvas')).toBeVisible()
  return { stage, dialog }
}

async function figureBounds(page: Page, png: Buffer) {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(image, 0, 0)
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let left = canvas.width,
      right = 0,
      top = canvas.height,
      bottom = 0,
      count = 0
    for (let y = 0; y < canvas.height; y++)
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4
        if (data[i]! < 190 && data[i + 2]! > data[i]! + 40 && data[i + 2]! > data[i + 1]! + 20) {
          left = Math.min(left, x)
          right = Math.max(right, x)
          top = Math.min(top, y)
          bottom = Math.max(bottom, y)
          count++
        }
      }
    image.close()
    if (!count) throw new Error('取景图中没有找到蓝色人物')
    return [left / canvas.width, right / canvas.width, top / canvas.height, bottom / canvas.height]
  }, png.toString('base64'))
}

async function handlePoint(page: Page, png: Buffer, color: 'red' | 'green') {
  return page.evaluate(
    async ({ base64, color }) => {
      const image = await createImageBitmap(
        new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'image/png' }),
      )
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(image, 0, 0)
      image.close()
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const points: { x: number; y: number }[] = []
      let right = 0
      for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4
          const match =
            color === 'red'
              ? data[i]! > 180 && data[i + 1]! < 140 && data[i + 2]! < 140
              : data[i + 1]! > 180 && data[i]! < 140 && data[i + 2]! < 140
          if (match) {
            points.push({ x, y })
            right = Math.max(right, x)
          }
        }
      const edge = points.filter((p) => p.x >= right - 1)
      if (!edge.length) throw new Error(`未找到 ${color} 操纵手柄`)
      return {
        x: edge.reduce((sum, p) => sum + p.x, 0) / edge.length / canvas.width,
        y: edge.reduce((sum, p) => sum + p.y, 0) / edge.length / canvas.height,
      }
    },
    { base64: png.toString('base64'), color },
  )
}

test('3D 构图：摆人物、截图成为节点结果', { tag: '@core' }, async ({ page }) => {
  await newProject(page)
  await addNode(page, '3D 构图')
  await expect
    .poll(async () => (await elements(page)).some((e) => e.nodeType === 'plein/stage'))
    .toBe(true)
  const stage = (await elements(page)).find((e) => e.nodeType === 'plein/stage')!
  await page.keyboard.press('Escape')
  await zoomTo(page, [stage.id])
  const at = await centerOf(page, stage.id)
  // 添加菜单正在退场时，透明定位容器也不能挡住紧接着的画布双击。
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, at)).toBe(
    'CANVAS',
  )
  await page.mouse.dblclick(at.x, at.y)

  const dialog = page.getByRole('dialog', { name: '3D 构图' })
  await expect(dialog.locator('canvas.stage-canvas')).toBeVisible()
  await dialog.getByRole('button', { name: '添加人物' }).click()
  await expect(dialog.getByRole('button', { name: /人物 2/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await dialog.getByRole('button', { name: '指向' }).click()
  await expect(dialog.getByRole('button', { name: /人物 2\s*指向/ })).toBeVisible()

  const results = async () => (await elements(page)).find((e) => e.id === stage.id)!.results
  expect(await results()).toBe(0)
  await dialog.getByRole('button', { name: '截图', exact: true }).click()
  await expect.poll(results).toBe(1)
  await expect(dialog.getByRole('img', { name: /截图/ })).toHaveCount(1)

  // 来源记在节点上：截图时的场景（两个人物，第二个在指）和版本
  const source = await page.evaluate((id) => {
    const el = window.__plein.engine.doc.get(id)!
    const shots = el.params?.snapshots as Array<{
      rev: number
      scene: { figures: Array<{ pose: string }> }
    }>
    return { rev: shots[0]!.rev, poses: shots[0]!.scene.figures.map((f) => f.pose) }
  }, stage.id)
  expect(source.poses).toEqual(['stand', 'point'])

  // 继续改场景：已有截图不变；再截一张是新结果
  await dialog.getByRole('button', { name: '坐' }).click()
  expect(await results()).toBe(1)
  await dialog.getByRole('button', { name: '截图', exact: true }).click()
  await expect.poll(results).toBe(2)
  await expect(dialog.getByRole('img', { name: /截图/ })).toHaveCount(2)
  // 原生数字输入与窄屏触达不能用 DOM 的零尺寸代替验收。
  await page.setViewportSize({ width: 390, height: 700 })
  const x = dialog.getByRole('spinbutton', { name: '左右', exact: true })
  await x.scrollIntoViewIfNeeded()
  await x.fill('-1.25')
  await x.press('Enter')
  await expect(x).toHaveValue('-1.25')
  await expect
    .poll(async () => (await dialog.locator('canvas.stage-canvas').boundingBox())!.width)
    .toBeGreaterThan(250)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.reload()
  await waitEngine(page)
  await expect.poll(results).toBe(2)
})

test('3D 缓动中立即截图，来源机位与重新打开的画面一致', { tag: '@core' }, async ({ page }) => {
  const { stage, dialog } = await openStage(page)
  await dialog.locator('.stage-outline .stage-item').filter({ hasText: '35mm' }).click()
  const canvas = dialog.locator('canvas.stage-canvas')
  const rect = (await canvas.boundingBox())!
  await page.mouse.move(rect.x + rect.width * 0.2, rect.y + rect.height * 0.3)
  await page.mouse.down()
  await page.mouse.move(rect.x + rect.width * 0.4, rect.y + rect.height * 0.2, { steps: 3 })
  await page.mouse.up()
  await dialog.getByRole('button', { name: '截图', exact: true }).click()
  await expect(dialog.locator('.stage-shot')).toHaveCount(1)
  const shot = await page.evaluate((id) => {
    return (
      window.__plein.engine.doc.get(id)!.params!.snapshots as {
        assetId: string
        scene: { camera: unknown }
      }[]
    )[0]!
  }, stage.id)
  const current = await page.evaluate(
    (id) => window.__plein.engine.doc.get(id)!.params!.scene,
    stage.id,
  )
  expect(shot.scene.camera).toEqual(StageScene.parse(current).camera)
  const response = await page.request.get(`/api/assets/${shot.assetId}`)
  expect(response.ok()).toBe(true)
  const captured = await figureBounds(page, await response.body())
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const at = await centerOf(page, stage.id)
  await page.mouse.dblclick(at.x, at.y)
  await expect(canvas).toBeVisible()
  await dialog.locator('.stage-outline .stage-item').filter({ hasText: '35mm' }).click()
  const reopened = await figureBounds(page, await canvas.screenshot())
  for (let i = 0; i < captured.length; i++)
    expect(Math.abs(captured[i]! - reopened[i]!)).toBeLessThan(0.015)
})

test('3D 用真实手柄移动和旋转人物，不误动机位', { tag: '@core' }, async ({ page }) => {
  const { stage, dialog } = await openStage(page)
  const canvas = dialog.locator('canvas.stage-canvas')
  const read = async () =>
    StageScene.parse(
      await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.scene, stage.id),
    )
  const before = await read()
  const drag = async (color: 'red' | 'green', dx: number, dy: number) => {
    const at = await handlePoint(page, await canvas.screenshot(), color)
    const rect = (await canvas.boundingBox())!
    const x = rect.x + at.x * rect.width
    const y = rect.y + at.y * rect.height
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + dx, y + dy, { steps: 10 })
    await page.mouse.up()
  }
  await drag('red', 80, 0)
  await expect.poll(async () => (await read()).figures[0]!.x).toBeGreaterThan(0.1)
  const moved = await read()
  expect(moved.camera).toEqual(before.camera)
  expect(moved.figures[0]!.z).toBeCloseTo(before.figures[0]!.z, 2)
  await dialog.getByRole('button', { name: '旋转（E）', exact: true }).click()
  await drag('green', -20, -35)
  await expect.poll(async () => (await read()).figures[0]!.facing).not.toBe(0)
  const rotated = await read()
  expect(rotated.camera).toEqual(before.camera)
  expect(rotated.figures[0]!.x).toBeCloseTo(moved.figures[0]!.x, 2)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const at = await centerOf(page, stage.id)
  await page.mouse.dblclick(at.x, at.y)
  await expect(canvas).toBeVisible()
  expect((await read()).figures).toEqual(rotated.figures)
})

test(
  '3D 场景件尺寸拖动中停顿仍只需一步撤销，重建后手柄可用',
  { tag: '@core' },
  async ({ page }) => {
    const { stage, dialog } = await openStage(page)
    await dialog.getByRole('button', { name: '添加场景件', exact: true }).click()
    await page.getByRole('menuitem', { name: '桌子', exact: true }).click()
    const read = async () =>
      StageScene.parse(
        await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.scene, stage.id),
      )
    const initial = (await read()).blocks[0]!
    const slider = dialog.getByRole('slider', { name: '宽', exact: true })
    const rect = (await slider.boundingBox())!
    const min = Number(await slider.getAttribute('min'))
    const max = Number(await slider.getAttribute('max'))
    const thumbX = rect.x + 8 + (rect.width - 16) * ((initial.w - min) / (max - min))
    const y = rect.y + rect.height / 2
    await page.mouse.move(thumbX, y)
    await page.mouse.down()
    await page.mouse.move(rect.x + rect.width * 0.35, y, { steps: 4 })
    // 同一手势里停顿超过文档 300ms 归并窗口，仍应按整次拖动撤销。
    await page.waitForTimeout(450)
    await page.mouse.move(rect.x + rect.width * 0.65, y, { steps: 4 })
    await page.mouse.up()
    expect((await read()).blocks[0]!.w).toBeGreaterThan(initial.w)
    const undo = dialog.getByRole('button', { name: '撤销构图操作', exact: true })
    await undo.click()
    expect((await read()).blocks[0]!.w).toBe(initial.w)
    await slider.focus()
    await slider.press('ArrowRight')
    const keyed = (await read()).blocks[0]!.w
    await page.waitForTimeout(450)
    await slider.press('ArrowRight')
    await undo.click()
    expect((await read()).blocks[0]!.w).toBe(keyed)
    await undo.click()
    expect((await read()).blocks[0]!.w).toBe(initial.w)
    const canvas = dialog.locator('canvas.stage-canvas')
    const handle = await handlePoint(page, await canvas.screenshot(), 'red')
    const viewport = (await canvas.boundingBox())!
    const x = viewport.x + handle.x * viewport.width
    const hy = viewport.y + handle.y * viewport.height
    const camera = (await read()).camera
    await page.mouse.move(x, hy)
    await page.mouse.down()
    await page.mouse.move(x + 45, hy, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => (await read()).blocks[0]!.x).not.toBe(initial.x)
    expect((await read()).camera).toEqual(camera)
  },
)
