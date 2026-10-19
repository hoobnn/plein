import { expect, test } from '@playwright/test'
import { newProject, zoomTo } from './canvas'
import { solidPng } from '../packages/providers/src/mock/media'

test('分组移动尚未通知场景时套用预设，卡片归组且不跳位，连线与撤销重做保留', async ({ page }) => {
  await newProject(page)
  const uploaded = await page.request.post('/api/assets', {
    headers: { 'Content-Type': 'image/png' },
    data: Buffer.from(solidPng(180, 320, [30, 140, 180])),
  })
  expect(uploaded.status()).toBe(201)
  const assetId = (await uploaded.json()).id as string
  const ids = await page.evaluate((assetId) => {
    const engine = window.__plein.engine as typeof window.__plein.engine & {
      paste(data: unknown): void
    }
    engine.paste({
      plein: 1,
      edges: [],
      elements: [
        {
          id: 'frame',
          kind: 'frame',
          name: '归组边界',
          x: 0,
          y: 0,
          w: 1400,
          h: 900,
          parentId: null,
        },
        {
          id: 'source',
          kind: 'image',
          name: '分组参考图',
          assetId,
          x: 100,
          y: 200,
          w: 180,
          h: 320,
          parentId: 'frame',
        },
      ],
    })
    const els = [...engine.doc.elements()]
    return {
      frame: els.find((el) => el.kind === 'frame')!.id,
      source: els.find((el) => el.kind === 'image')!.id,
    }
  }, assetId)
  await zoomTo(page, [ids.frame])
  await page.getByRole('treeitem', { name: '分组参考图 定位到画布', exact: true }).click()
  await page
    .getByRole('toolbar', { name: '结果操作', exact: true })
    .getByRole('button', { name: '预设', exact: true })
    .click()
  const target = await page.evaluate(({ frame, source }) => {
    const engine = window.__plein.engine as typeof window.__plein.engine & {
      scene: { rect(id: string): { x: number } }
    }
    const doc = engine.doc as unknown as {
      schedule(flush: () => void): void
      flush(): void
      restoreFrameTest?(): void
      mutable(id: string): { get(key: string): unknown; set(key: string, value: unknown): void }
      undo: { stopCapturing(): void }
    }
    doc.flush()
    const schedule = doc.schedule
    doc.schedule = () => {}
    doc.restoreFrameTest = () => {
      doc.schedule = schedule
      doc.flush()
      delete doc.restoreFrameTest
    }
    doc.undo.stopCapturing()
    const oldX = engine.scene.rect(frame).x
    doc.mutable(frame)!.set('x', oldX + 4000)
    doc.undo.stopCapturing()
    doc.schedule = schedule
    const r = engine.doc.worldRect(source)
    return { oldX, x: r.x + r.w + 80, cy: r.y + r.h / 2, indexedX: engine.scene.rect(frame).x }
  }, ids)
  expect(target.indexedX).toBe(target.oldX)
  try {
    await page
      .getByRole('dialog', { name: '预设', exact: true })
      .getByRole('button', { name: /^角色三视图/ })
      .click()
    await expect(
      page.getByTestId('generator').getByRole('textbox', { name: '提示词', exact: true }),
    ).toBeFocused()
    const next = await page.evaluate(() =>
      [...window.__plein.engine.doc.elements()].find((el) => el.name === '角色三视图')!,
    )
    expect(next.parentId).toBe(ids.frame)
    const rect = await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), next.id)
    expect(rect.x).toBe(target.x)
    expect(Math.abs(rect.y + rect.h / 2 - target.cy)).toBeLessThanOrEqual(1)
    expect(await page.evaluate(() => [...window.__plein.engine.doc.edges()])).toContainEqual(
      expect.objectContaining({ from: [ids.source, 'image'], to: [next.id, 'references'] }),
    )
    await page.evaluate(() =>
      (window.__plein.engine.doc as unknown as { restoreFrameTest(): void }).restoreFrameTest(),
    )
    await zoomTo(page, [ids.frame])
    await page.evaluate(() => window.__plein.engine.selection.set([]))
    await page.screenshot({
      path: test.info().outputPath('moved-frame-preset.png'),
      animations: 'disabled',
    })
    await page.keyboard.press('ControlOrMeta+z')
    await expect
      .poll(() => page.evaluate((id) => !!window.__plein.engine.doc.get(id), next.id))
      .toBe(false)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect
      .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.parentId, next.id))
      .toBe(ids.frame)
    expect(await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), next.id)).toEqual(
      rect,
    )
    // 再移动父分组，确认新卡片真正属于它，而非仅在视觉上落在框内。
    await page.evaluate(
      ({ frame, oldX }) => {
        const doc = window.__plein.engine.doc as unknown as {
          mutable(id: string): { set(key: string, value: unknown): void }
          flush(): void
        }
        doc.mutable(frame).set('x', oldX + 4200)
        doc.flush()
      },
      { frame: ids.frame, oldX: target.oldX },
    )
    await expect
      .poll(() => page.evaluate((id) => window.__plein.engine.doc.worldRect(id).x, next.id))
      .toBe(rect.x + 200)
  } finally {
    await page.evaluate(() =>
      (window.__plein.engine.doc as unknown as { restoreFrameTest?(): void }).restoreFrameTest?.(),
    )
  }
})
