import { expect, type Page, test } from '@playwright/test'
import { solidPng } from '../packages/providers/src/mock/media'
import { newProject, revealGenerator, waitEngine, zoomTo } from './canvas'

type Engine = import('../packages/canvas-core/src/engine').Engine

/**
 * 打开重绘区域编辑器。
 * 节点编辑器固定 840px 宽（0.6.0 契约），窄窗口里右侧的文字按钮会被裁掉，
 * 够不到；左侧的缩略图按钮做的是同一件事，就用它打开。
 */
async function openMaskEditor(page: Page, mode: 'mask' | 'instance') {
  const field = page.getByTestId('mask-field')
  const text = field.getByRole('button', {
    name: mode === 'mask' ? '画区域' : '重画区域',
    exact: true,
  })
  const box = await text.last().boundingBox()
  if (box && box.x + box.width <= (page.viewportSize()?.width ?? 0)) {
    await text.last().click()
    return
  }
  await field.locator('button[title="重画区域"]').first().click()
}

async function fixture(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await newProject(page)
  const upload = await page.request.post('/api/assets', {
    headers: { 'content-type': 'image/png' },
    data: Buffer.from(solidPng(160, 96, [100, 140, 180])),
  })
  expect(upload.status()).toBe(201)
  const assetId = (await upload.json()).id as string
  const source = await page.evaluate((assetId) => {
    const engine = window.__plein.engine as unknown as Engine
    engine.paste({
      plein: 1,
      edges: [],
      elements: [
        {
          id: 'source',
          kind: 'image',
          name: '会话原图',
          assetId,
          x: 400,
          y: 300,
          w: 240,
          h: 144,
          z: 'a0',
          rotation: 0,
          locked: false,
          parentId: null,
        },
      ],
    })
    const id = [...engine.doc.elements()][0]!.id
    engine.selection.set([id])
    return id
  }, assetId)
  await zoomTo(page, [source])
  await page.getByRole('button', { name: '局部重绘', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '画重绘区域', exact: true })
  const canvas = dialog.getByTestId('mask-canvas')
  const draw = async (start: number, finish: number) => {
    await expect(canvas).toBeVisible()
    await dialog.getByRole('button', { name: '框选', exact: true }).click()
    const box = (await canvas.boundingBox())!
    await page.mouse.move(box.x + box.width * start, box.y + box.height * 0.2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * finish, box.y + box.height * 0.65, { steps: 4 })
    await page.mouse.up()
  }
  const pixels = () =>
    canvas.evaluate(
      (el: HTMLCanvasElement) =>
        new Promise<string>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(el.toDataURL()))),
        ),
    )
  await draw(0.1, 0.35)
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const node = await page.evaluate(
    () =>
      [...window.__plein.engine.doc.elements()].find((el) => el.nodeType === 'plein/image-edit')!
        .id,
  )
  const mask = await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.mask, node)
  const peer = await page.context().newPage()
  await peer.goto(page.url())
  await waitEngine(peer)
  await expect
    .poll(() => peer.evaluate((id) => !!window.__plein.engine.doc.get(id)?.params?.mask, node))
    .toBe(true)
  // 编辑器固定在卡片下方，先把它移进窗口再点里面的控件
  await revealGenerator(page)
  await openMaskEditor(page, 'instance')
  await expect(canvas).toBeVisible()
  const original = await pixels()
  await draw(0.6, 0.85)
  const draft = await pixels()
  expect(draft).not.toBe(original)
  return { node, mask, peer, dialog, canvas, original, draft, pixels, errors }
}

test('蒙版编辑中协作重命名不重新加载旧区域或改写本地历史', async ({ page }, testInfo) => {
  const f = await fixture(page)
  try {
    await f.peer.evaluate((id) => {
      const engine = window.__plein.engine as unknown as Engine
      engine.doc.mutable(id)!.set('name', '协作改名后的重绘')
      engine.doc.flush()
    }, f.node)
    await expect
      .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, f.node))
      .toBe('协作改名后的重绘')
    expect((await f.pixels()) === f.draft).toBe(true)
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await f.pixels()) === f.original).toBe(true)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(async () => (await f.pixels()) === f.draft).toBe(true)
    await f.dialog.screenshot({ path: testInfo.outputPath('mask-renamed.png') })
    await f.dialog.getByRole('button', { name: '完成', exact: true }).click()
    await expect(f.dialog).toHaveCount(0)
    await expect(page.locator('.ui-toast').filter({ hasText: '重绘区域已更新' })).toHaveCount(0)
    await expect
      .poll(() => f.peer.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.mask, f.node))
      .not.toEqual(f.mask)
    expect(f.errors).toEqual([])
  } finally {
    await f.peer.close()
  }
})

for (const mode of ['mask', 'instance'] as const) {
  for (const saving of [false, true]) {
    test(`蒙版 ${mode} 协作变更在${saving ? '保存等待' : '编辑'}时终止旧会话，重新打开可保存`, async ({
      page,
    }, testInfo) => {
      if (mode === 'instance' && !saving) await page.setViewportSize({ width: 390, height: 800 })
      const f = await fixture(page)
      let release = () => {}
      try {
        if (saving) {
          let held = false
          const waiting = new Promise<void>((resolve) => {
            release = resolve
          })
          await page.route('**/api/assets', async (route) => {
            if (route.request().method() !== 'POST') return route.continue()
            const response = await route.fetch()
            held = true
            await waiting
            await route.fulfill({ response }).catch(() => {})
          })
          await f.dialog.getByRole('button', { name: '完成', exact: true }).click()
          await expect.poll(() => held).toBe(true)
        }
        await f.peer.evaluate(
          ({ id, mode }) => {
            const engine = window.__plein.engine as unknown as Engine
            if (mode === 'mask') {
              const raw = engine.doc.mutable(id)!.get('params') as {
                set(key: string, value: unknown): void
              }
              raw.set('mask', null)
            } else
              engine.doc.ydoc.transact(
                () => engine.doc.elementMaps.set(id, engine.doc.mutable(id)!.clone()),
                engine.doc.origin,
              )
            engine.doc.mutable(id)!.set('name', `远端更新-${mode}`)
            engine.doc.flush()
          },
          { id: f.node, mode },
        )
        await expect
          .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, f.node))
          .toBe(`远端更新-${mode}`)
        await expect(f.dialog).toHaveCount(0)
        await expect(page.locator('.ui-toast')).toContainText(
          mode === 'mask' ? '重绘区域已更新' : '重绘节点已被替换',
        )
        if (!saving)
          await page.screenshot({ path: testInfo.outputPath(`mask-${mode}-changed.png`) })
        release()
        await page.unrouteAll({ behavior: 'wait' })
        expect(
          await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.mask, f.node),
        ).toEqual(mode === 'mask' ? null : f.mask)
        // 编辑器固定在卡片下方，先把它移进窗口再点里面的控件
        await revealGenerator(page)
        await openMaskEditor(page, mode)
        await expect(f.canvas).toBeVisible()
        // 在当前实例和远端区域上重新编辑，保存应正常完成。
        const box = (await f.canvas.boundingBox())!
        await f.dialog.getByRole('button', { name: '框选', exact: true }).click()
        await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.2)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.65)
        await page.mouse.up()
        await f.dialog.getByRole('button', { name: '完成', exact: true }).click()
        await expect(f.dialog).toHaveCount(0)
        await expect
          .poll(() =>
            f.peer.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.mask, f.node),
          )
          .not.toEqual(mode === 'mask' ? null : f.mask)
        expect(f.errors).toEqual([])
      } finally {
        release()
        await f.peer.close()
      }
    })
  }
}
