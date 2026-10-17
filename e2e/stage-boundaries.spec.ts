import { expect, test, type Page } from '@playwright/test'
import { StageScene } from '../packages/nodes/src/stage'
import { addNode, centerOf, elements, newProject, zoomTo } from './canvas'

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

test('3D 坐标允许负数草稿，清空与取消不移动对象', async ({ page }) => {
  const { stage, dialog } = await openStage(page)
  const x = dialog.getByRole('spinbutton', { name: '左右', exact: true })
  const position = () =>
    page.evaluate((id) => {
      const scene = window.__plein.engine.doc.get(id)!.params!.scene as { figures: { x: number }[] }
      return scene.figures[0]!.x
    }, stage.id)
  await x.fill('2')
  await x.press('Enter')
  await expect.poll(position).toBe(2)
  await expect(x).toHaveValue('2')
  await x.fill('')
  await expect(x).toHaveValue('')
  await x.pressSequentially('-1.25')
  await expect(x).toHaveValue('-1.25')
  await x.press('Enter')
  await expect.poll(position).toBe(-1.25)
  await x.fill('')
  await x.press('Tab')
  await expect(x).toHaveValue('-1.25')
  await expect.poll(position).toBe(-1.25)
  await x.fill('9')
  await x.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(x).toHaveValue('-1.25')
  await x.fill('100')
  await x.press('Enter')
  await expect.poll(position).toBe(50)
})

test('3D 截图上传失败后可重试且来源不丢失', async ({ page }) => {
  const { stage, dialog } = await openStage(page)
  let fail = true
  await page.route('**/api/assets', async (route) => {
    if (route.request().method() === 'POST' && fail) {
      fail = false
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: '测试上传失败' }),
      })
    } else await route.continue()
  })
  const shoot = dialog.getByRole('button', { name: '截图', exact: true })
  await shoot.click()
  await expect(page.locator('.ui-toast')).toContainText('截图没有成功')
  await expect(shoot).toBeEnabled()
  expect((await elements(page)).find((e) => e.id === stage.id)!.results).toBe(0)
  await shoot.click()
  await expect(dialog.getByRole('img', { name: /截图/ })).toHaveCount(1)
  await expect
    .poll(async () => (await elements(page)).find((e) => e.id === stage.id)!.results)
    .toBe(1)
  await expect
    .poll(() =>
      dialog
        .getByRole('img', { name: /截图/ })
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0)
})

test('3D 小窗口保留可用取景区及属性控件', async ({ page }) => {
  const { dialog } = await openStage(page)
  await page.setViewportSize({ width: 800, height: 600 })
  await expect
    .poll(async () => {
      const bounds = (await dialog.locator('canvas.stage-canvas').boundingBox())!
      const viewport = (await dialog.locator('.stage-viewport').boundingBox())!
      return bounds.x >= viewport.x && bounds.x + bounds.width <= viewport.x + viewport.width
    })
    .toBe(true)
  await expect
    .poll(async () => (await dialog.locator('canvas.stage-canvas').boundingBox())!.width)
    .toBeGreaterThan(250)
  await expect
    .poll(async () => (await dialog.locator('canvas.stage-canvas').boundingBox())!.height)
    .toBeGreaterThan(140)
  await expect(dialog.getByRole('spinbutton', { name: '左右', exact: true })).toBeInViewport()
  await expect(dialog.getByRole('button', { name: '截图', exact: true })).toBeInViewport()
  await page.setViewportSize({ width: 390, height: 700 })
  await expect
    .poll(async () => (await dialog.locator('canvas.stage-canvas').boundingBox())!.width)
    .toBeGreaterThan(250)
  const x = dialog.getByRole('spinbutton', { name: '左右', exact: true })
  await x.scrollIntoViewIfNeeded()
  await x.fill('-2')
  await x.press('Enter')
  await expect(x).toHaveValue('-2')
})

test('3D 添加菜单中的按键不删除背后的对象', async ({ page }) => {
  const { stage, dialog } = await openStage(page)
  await dialog.getByRole('button', { name: '添加场景件', exact: true }).click()
  await expect(page.getByRole('menu', { name: '添加场景件' })).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Delete')
  expect(
    await page.evaluate((id) => {
      return (window.__plein.engine.doc.get(id)!.params!.scene as { figures: unknown[] }).figures
        .length
    }, stage.id),
  ).toBe(1)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /人物 1/ }).focus()
  await page.keyboard.press('Delete')
  await expect(dialog.getByRole('button', { name: /人物 1/ })).toHaveCount(0)
})

test('3D 删除后再添加人物仍能按名字区分且不重叠', async ({ page }) => {
  const { stage, dialog } = await openStage(page)
  await dialog.getByRole('button', { name: '添加人物', exact: true }).click()
  await dialog.getByRole('button', { name: '添加人物', exact: true }).click()
  await dialog.getByRole('button', { name: /人物 2/ }).click()
  await dialog.getByRole('button', { name: '删除', exact: true }).click()
  await dialog.getByRole('button', { name: '添加人物', exact: true }).click()
  const labels = await dialog.locator('.stage-outline .stage-item').allTextContents()
  const people = labels.filter((label) => label.includes('人物'))
  expect(new Set(people).size).toBe(3)
  const positions = await page.evaluate((id) => {
    return (
      window.__plein.engine.doc.get(id)!.params!.scene as { figures: { x: number; z: number }[] }
    ).figures.map((f) => `${f.x},${f.z}`)
  }, stage.id)
  expect(new Set(positions).size).toBe(3)
})

test('3D 连续添加场景件可区分名称且不堆在同一位置', async ({ page }) => {
  const { stage, dialog } = await openStage(page)
  for (let i = 0; i < 2; i++) {
    await dialog.getByRole('button', { name: '添加场景件', exact: true }).click()
    await page.getByRole('menuitem', { name: '桌子', exact: true }).click()
  }
  const data = await page.evaluate((id) => {
    return (
      window.__plein.engine.doc.get(id)!.params!.scene as {
        blocks: { name?: string; x: number; z: number; w: number; d: number }[]
      }
    ).blocks
  }, stage.id)
  expect(new Set(data.map((b) => b.name)).size).toBe(2)
  const [a, b] = data
  expect(
    Math.abs(a!.x - b!.x) >= (a!.w + b!.w) / 2 || Math.abs(a!.z - b!.z) >= (a!.d + b!.d) / 2,
  ).toBe(true)
})

test('3D 截图等待时关闭重开，新截图的采用不被旧请求覆盖', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const { stage, dialog } = await openStage(page)
  let release!: () => void
  const delayed = new Promise<void>((resolve) => {
    release = resolve
  })
  let waiting = false
  let first = true
  await page.route('**/api/assets', async (route) => {
    if (route.request().method() !== 'POST' || !first) return route.continue()
    first = false
    const response = await route.fetch()
    waiting = true
    await delayed
    await route.fulfill({ response })
  })
  await dialog.getByRole('button', { name: '截图', exact: true }).click()
  await expect.poll(() => waiting).toBe(true)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const at = await centerOf(page, stage.id)
  await page.mouse.dblclick(at.x, at.y)
  await expect(dialog.locator('canvas.stage-canvas')).toBeVisible()
  await dialog.getByRole('button', { name: '坐', exact: true }).click()
  await dialog.getByRole('button', { name: '截图', exact: true }).click()
  await expect(dialog.locator('.stage-shot')).toHaveCount(1)
  const adopted = await page.evaluate(
    (id) => window.__plein.engine.doc.mutable(id)?.get('adopted'),
    stage.id,
  )
  release()
  await expect(dialog.locator('.stage-shot')).toHaveCount(2)
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), stage.id),
  ).toBe(adopted)
  await expect(dialog.getByRole('button', { name: /人物 1\s*坐/ })).toBeVisible()
  expect(errors).toEqual([])
})

test('3D 连续大幅缩放不写入无效机位或重置已有场景', async ({ page }) => {
  const { stage, dialog } = await openStage(page)
  await dialog.getByRole('button', { name: '坐', exact: true }).click()
  await dialog.getByRole('button', { name: '添加人物', exact: true }).click()
  const canvas = dialog.locator('canvas.stage-canvas')
  const rect = (await canvas.boundingBox())!
  await page.mouse.move(rect.x + rect.width * 0.2, rect.y + rect.height * 0.3)
  await page.mouse.wheel(0, 20000)
  const read = () =>
    page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.scene, stage.id)
  await expect
    .poll(async () => {
      const data = await read()
      const parsed = StageScene.safeParse(data)
      return parsed.success ? parsed.data.camera.z : JSON.stringify(data)
    })
    .not.toBe(4.5)
  const scene = StageScene.safeParse(await read())
  expect(scene.success, JSON.stringify(await read())).toBe(true)
  expect(scene.data!.figures).toHaveLength(2)
  expect(scene.data!.figures[0]!.pose).toBe('sit')
  await expect(dialog.getByRole('button', { name: /人物 1\s*坐/ })).toBeVisible()
  await page.mouse.wheel(0, -20000)
  await expect.poll(async () => StageScene.parse(await read()).camera.z).toBeLessThan(1)
  await dialog.getByRole('button', { name: '自由视角', exact: true }).click()
  await page.mouse.move(rect.x + rect.width * 0.2, rect.y + rect.height * 0.3)
  await page.mouse.wheel(0, 20000)
  await dialog.locator('.stage-outline .stage-item').filter({ hasText: '35mm' }).click()
  await dialog.getByRole('button', { name: '设为机位', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '机位视角', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(StageScene.safeParse(await read()).success).toBe(true)
  expect(StageScene.parse(await read()).figures).toHaveLength(2)
  const height = dialog.getByRole('slider', { name: '机位高', exact: true })
  const camera = StageScene.parse(await read()).camera
  expect(camera.y).toBeLessThanOrEqual(Number(await height.getAttribute('max')))
  expect(camera.y).toBeGreaterThanOrEqual(Number(await height.getAttribute('min')))
})

test('3D 拖动机位后截图及重新打开保持所见构图', async ({ page }) => {
  const { stage, dialog } = await openStage(page)
  await dialog.locator('.stage-outline .stage-item').filter({ hasText: '35mm' }).click()
  const canvas = dialog.locator('canvas.stage-canvas')
  const rect = (await canvas.boundingBox())!
  await page.mouse.move(rect.x + rect.width * 0.25, rect.y + rect.height * 0.3)
  await page.mouse.down()
  await page.mouse.move(rect.x + rect.width * 0.5, rect.y + rect.height * 0.15, { steps: 8 })
  await page.mouse.up()
  let previous: Buffer | undefined
  await expect
    .poll(
      async () => {
        const current = await canvas.screenshot()
        const stable = previous?.equals(current) ?? false
        previous = current
        return stable
      },
      { intervals: [100, 200, 400] },
    )
    .toBe(true)
  const visible = await figureBounds(page, previous!)
  await dialog.getByRole('button', { name: '截图', exact: true }).click()
  await expect(dialog.locator('.stage-shot')).toHaveCount(1)
  const asset = await page.evaluate((id) => {
    return (window.__plein.engine.doc.get(id)!.params!.snapshots as { assetId: string }[])[0]!
      .assetId
  }, stage.id)
  const response = await page.request.get(`/api/assets/${asset}`)
  expect(response.ok()).toBe(true)
  const captured = await figureBounds(page, await response.body())
  for (let i = 0; i < visible.length; i++)
    expect(Math.abs(visible[i]! - captured[i]!)).toBeLessThan(0.015)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const at = await centerOf(page, stage.id)
  await page.mouse.dblclick(at.x, at.y)
  await expect(canvas).toBeVisible()
  await dialog.locator('.stage-outline .stage-item').filter({ hasText: '35mm' }).click()
  const reopened = await figureBounds(page, await canvas.screenshot())
  for (let i = 0; i < visible.length; i++)
    expect(Math.abs(visible[i]! - reopened[i]!)).toBeLessThan(0.015)
})

test('3D 缓动中立即截图，来源机位与重新打开的画面一致', async ({ page }) => {
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

test('3D 平移后立即切换视角不丢失注视目标', async ({ page }) => {
  const { stage, dialog } = await openStage(page)
  await dialog.locator('.stage-outline .stage-item').filter({ hasText: '35mm' }).click()
  const rect = (await dialog.locator('canvas.stage-canvas').boundingBox())!
  await page.mouse.move(rect.x + rect.width * 0.2, rect.y + rect.height * 0.3)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(rect.x + rect.width * 0.4, rect.y + rect.height * 0.35, { steps: 3 })
  await page.mouse.up({ button: 'right' })
  await dialog.getByRole('button', { name: '自由视角', exact: true }).click()
  const readCamera = async () =>
    StageScene.parse(
      await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.scene, stage.id),
    ).camera
  const aimed = await readCamera()
  expect(Math.abs(aimed.tx)).toBeGreaterThan(0.01)
  await dialog.getByRole('button', { name: '设为机位', exact: true }).click()
  const adopted = await readCamera()
  expect(adopted.tx).toBeCloseTo(aimed.tx, 2)
  expect(adopted.ty).toBeCloseTo(aimed.ty, 2)
  expect(adopted.tz).toBeCloseTo(aimed.tz, 2)
})
