import { expect, type Locator, type Page, test } from '@playwright/test'
import { solidPng } from '../packages/providers/src/mock/media'
import { newProject, revealGenerator, waitNode, zoomTo } from './canvas'

async function fixture(page: Page, edit = false) {
  await newProject(page)
  const assets: string[] = []
  for (const [width, height] of [
    [96, 64],
    [160, 90],
  ]) {
    const response = await page.request.post('/api/assets', {
      headers: { 'Content-Type': 'image/png' },
      data: Buffer.from(solidPng(width!, height!, [width!, 100, 180])),
    })
    expect(response.status()).toBe(201)
    assets.push((await response.json()).id)
  }
  const ids = await page.evaluate(
    ({ assets, edit }) => {
      const engine = window.__plein.engine as typeof window.__plein.engine & {
        paste(data: unknown): void
      }
      engine.paste({
        plein: 1,
        edges: [],
        elements: [
          {
            id: 'source',
            kind: 'image',
            name: '局部重绘原图',
            assetId: assets[0],
            x: 300,
            y: 200,
            w: 240,
            h: 160,
            rotation: 0,
            locked: false,
            parentId: null,
          },
        ],
      })
      const source = [...engine.doc.elements()][0]!.id
      let target = source
      if (edit) {
        target = window.__plein.addNode({
          type: 'plein/image-edit',
          name: '编辑原区域',
          params: {},
          x: 800,
          y: 200,
        })
        window.__plein.connect([source, 'image'], [target, 'image'])
      }
      engine.selection.set([target])
      return { source, target }
    },
    { assets, edit },
  )
  await zoomTo(page, [ids.target])
  await page.getByRole('button', { name: edit ? '画区域' : '局部重绘', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '画重绘区域', exact: true })
  await draw(page, dialog)
  return { ...ids, assets, dialog }
}

async function draw(page: Page, dialog: Locator, start = 0.2, end = 0.5) {
  const canvas = dialog.getByTestId('mask-canvas')
  await expect(canvas).toBeVisible()
  await dialog.getByRole('button', { name: '框选', exact: true }).click()
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + box.width * start, box.y + box.height * 0.2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * end, box.y + box.height * 0.6, { steps: 4 })
  await page.mouse.up()
  await expect(dialog.getByRole('button', { name: '完成', exact: true })).toBeEnabled()
}

for (const edit of [false, true]) {
  test(`${edit ? '已有重绘节点' : '新建重绘'} 保存等待时关闭不会迟到写入，重新打开可以保存`, async ({
    page,
  }) => {
    const f = await fixture(page, edit)
    let held = false
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    let finished = false
    await page.route('**/api/assets', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      if (held) return route.continue()
      held = true
      const response = await route.fetch()
      await waiting
      await route.fulfill({ response }).catch(() => {})
      finished = true
    })
    try {
      await f.dialog.getByRole('button', { name: '完成', exact: true }).click()
      await expect.poll(() => held).toBe(true)
      await expect(f.dialog.getByRole('button', { name: '保存中…', exact: true })).toBeDisabled()
      await expect(f.dialog.getByRole('button', { name: '清空', exact: true })).toBeDisabled()
      await expect(f.dialog.getByRole('button', { name: '撤销', exact: true })).toBeDisabled()
      await expect(f.dialog.getByRole('button', { name: '框选', exact: true })).toBeDisabled()
      if (!edit)
        await f.dialog.screenshot({
          path: test.info().outputPath('mask-saving.png'),
          animations: 'disabled',
        })
      const canvas = f.dialog.getByTestId('mask-canvas')
      const pixels = await canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL())
      await page.keyboard.press('ControlOrMeta+z')
      expect(await canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL())).toBe(pixels)
      await f.dialog.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(f.dialog).toHaveCount(0)
      release()
      await expect.poll(() => finished).toBe(true)
      // 在旧回调有机会返回后检查，再走一次真实新保存。
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              [...window.__plein.engine.doc.elements()].filter(
                (el) => el.nodeType === 'plein/image-edit',
              ).length,
          ),
        )
        .toBe(edit ? 1 : 0)
      if (edit)
        expect(
          await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.mask, f.target),
        ).toBeNull()
      await page.getByRole('button', { name: edit ? '画区域' : '局部重绘', exact: true }).click()
      await expect(f.dialog.getByRole('button', { name: '完成', exact: true })).toBeDisabled()
      await draw(page, f.dialog, 0.55, 0.8)
      await f.dialog.getByRole('button', { name: '完成', exact: true }).click()
      await expect(f.dialog).toHaveCount(0)
      const nodes = await page.evaluate(() =>
        [...window.__plein.engine.doc.elements()].filter(
          (el) => el.nodeType === 'plein/image-edit',
        ),
      )
      expect(nodes).toHaveLength(1)
      expect(nodes[0]?.params?.mask).toMatchObject({
        sourceAssetId: f.assets[0],
        width: 96,
        height: 64,
      })
    } finally {
      release()
    }
  })
}

for (const edit of [false, true]) {
  test(`${edit ? '已有重绘节点' : '新建重绘'} 原图替换后不保留上一张图的区域`, async ({ page }) => {
    const f = await fixture(page, edit)
    await page.evaluate(
      ({ id, assetId }) => {
        const source = window.__plein.engine.doc.mutable(id) as unknown as {
          set(key: string, value: unknown): void
        }
        source.set('assetId', assetId)
      },
      { id: f.source, assetId: f.assets[1]! },
    )
    await expect(f.dialog).toHaveCount(0)
    for (const assetId of [f.assets[0]!, f.assets[1]!]) {
      await page.evaluate(
        ({ id, assetId }) =>
          (
            window.__plein.engine.doc.mutable(id) as unknown as {
              set(key: string, value: unknown): void
            }
          ).set('assetId', assetId),
        { id: f.source, assetId },
      )
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      )
      await expect(f.dialog).toHaveCount(0)
    }
    await page.getByRole('button', { name: edit ? '画区域' : '局部重绘', exact: true }).click()
    await expect(f.dialog.getByRole('img')).toHaveAttribute('src', `/api/assets/${f.assets[1]}`)
    await expect(f.dialog.getByRole('button', { name: '完成', exact: true })).toBeDisabled()
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.mask, f.target),
    ).toBe(edit ? null : undefined)
  })
}

test('蒙版上传失败后保留区域可重试，只创建一次正确的重绘节点', async ({ page }) => {
  const f = await fixture(page)
  let uploads = 0
  await page.route('**/api/assets', (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    if (++uploads === 1) return route.fulfill({ status: 503, json: { message: '测试上传失败' } })
    return route.continue()
  })
  await f.dialog.getByRole('button', { name: '完成', exact: true }).click()
  await expect(page.locator('.ui-toast')).toContainText('测试上传失败')
  await expect(f.dialog.getByRole('button', { name: '完成', exact: true })).toBeEnabled()
  await f.dialog.getByRole('button', { name: '完成', exact: true }).click()
  await expect(f.dialog).toHaveCount(0)
  const edit = await page.evaluate(() =>
    [...window.__plein.engine.doc.elements()].find((el) => el.nodeType === 'plein/image-edit'),
  )
  expect(edit?.params?.mask).toMatchObject({ sourceAssetId: f.assets[0], width: 96, height: 64 })
  expect(uploads).toBe(2)
})

for (const edit of [false, true])
  for (const change of ['replace', 'delete', 'readonly'] as const) {
    test(`${edit ? '已有重绘节点' : '新建重绘'} 保存回包前${change}不会写入失效上下文`, async ({
      page,
    }) => {
      const f = await fixture(page, edit)
      let held = false
      let finished = false
      let release!: () => void
      const waiting = new Promise<void>((resolve) => {
        release = resolve
      })
      await page.route('**/api/assets', async (route) => {
        if (route.request().method() !== 'POST') return route.continue()
        const response = await route.fetch()
        held = true
        await waiting
        await route.fulfill({ response }).catch(() => {})
        finished = true
      })
      try {
        await f.dialog.getByRole('button', { name: '完成', exact: true }).click()
        await expect.poll(() => held).toBe(true)
        await page.evaluate(
          ({ source, target, assetId, change }) => {
            const engine = window.__plein.engine as typeof window.__plein.engine & {
              deleteSelection(): void
            }
            if (change === 'replace')
              (
                engine.doc.mutable(source) as unknown as { set(key: string, value: unknown): void }
              ).set('assetId', assetId)
            else if (change === 'delete') {
              engine.selection.set([target])
              engine.deleteSelection()
            } else (engine.doc as typeof engine.doc & { readOnly: boolean }).readOnly = true
          },
          { source: f.source, target: f.target, assetId: f.assets[1]!, change },
        )
        release()
        await expect.poll(() => finished).toBe(true)
        await expect(f.dialog).toHaveCount(0)
        const state = await page.evaluate(
          ({ target }) => ({
            nodes: [...window.__plein.engine.doc.elements()].filter(
              (el) => el.nodeType === 'plein/image-edit',
            ).length,
            mask: window.__plein.engine.doc.get(target)?.params?.mask,
          }),
          { target: f.target },
        )
        expect(state.nodes).toBe(edit && change !== 'delete' ? 1 : 0)
        expect(state.mask).toBe(edit && change !== 'delete' ? null : undefined)
        expect(await page.locator('.ui-toast').allTextContents()).not.toContain(
          '区域画好了，写一句要改成什么就能生成',
        )
      } finally {
        release()
      }
    })
  }

for (const label of ['预设', '宫格切分']) {
  test(`${label}打开时替换原图会关闭旧弹层`, async ({ page }) => {
    const f = await fixture(page)
    await f.dialog.getByRole('button', { name: '关闭', exact: true }).click()
    const trigger = page
      .getByRole('toolbar', { name: '结果操作', exact: true })
      .getByRole('button', { name: label, exact: true })
    await trigger.click()
    const popover = page.getByRole('dialog', { name: label, exact: true })
    await expect(popover).toBeVisible()
    await page.evaluate(
      ({ id, assetId }) =>
        (
          window.__plein.engine.doc.mutable(id) as unknown as {
            set(key: string, value: unknown): void
          }
        ).set('assetId', assetId),
      { id: f.source, assetId: f.assets[1]! },
    )
    await expect(popover).toHaveCount(0)
    await trigger.click()
    await expect(popover).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
  })
}

test('真实模拟生成的图片切换采用结果后关闭旧蒙版，重新画的新蒙版引用新素材', async ({ page }) => {
  await newProject(page)
  const source = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '候选重绘',
      params: { model: 'plein/mock:image', prompt: '雨后两只水杯', count: 2 },
      x: 300,
      y: 200,
    }),
  )
  await zoomTo(page, [source])
  await page.evaluate((id) => window.__plein.engine.selection.set([id]), source)
  // 编辑器固定在卡片下方，先把它移进窗口再点里面的控件
  await revealGenerator(page)
  const generator = page.getByTestId('generator')
  await generator.getByRole('button', { name: '生成', exact: true }).click()
  await waitNode(page, source)
  const results = await page.evaluate((id) => window.__plein.engine.doc.get(id)!.results!, source)
  expect(results).toHaveLength(2)
  await generator.getByRole('button', { name: '局部重绘', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '画重绘区域', exact: true })
  await draw(page, dialog)
  await page.evaluate(
    ({ id, result }) =>
      (
        window.__plein.engine.doc.mutable(id) as unknown as {
          set(key: string, value: unknown): void
        }
      ).set('adopted', result),
    { id: source, result: results[1]!.id },
  )
  await expect(dialog).toHaveCount(0)
  await generator.getByRole('button', { name: '局部重绘', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '完成', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('img')).toHaveAttribute(
    'src',
    `/api/assets/${results[1]!.value.assetId}`,
  )
  await draw(page, dialog)
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const edit = await page.evaluate(() =>
    [...window.__plein.engine.doc.elements()].find((el) => el.nodeType === 'plein/image-edit'),
  )
  expect(edit?.params?.mask).toMatchObject({ sourceAssetId: results[1]!.value.assetId })
  expect(await page.evaluate(() => [...window.__plein.engine.doc.edges()])).toContainEqual(
    expect.objectContaining({ from: [source, 'images'], to: [edit!.id, 'image'] }),
  )
})
