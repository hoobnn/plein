import { expect, type Page, test } from '@playwright/test'
import { elements, newProject, settle, waitNode, zoomTo } from './canvas'

async function panElement(page: Page, id: string, top: number, left = 950) {
  await page.evaluate(
    ({ id, top, left }) => {
      const e = window.__plein.engine as Window['__plein']['engine'] & {
        camera: { panBy(x: number, y: number): void }
      }
      const r = e.doc.worldRect(id)
      const p = e.worldToClient(r.x, r.y)
      e.camera.panBy(left - p.x, top - p.y)
    },
    { id, top, left },
  )
  await settle(page, id)
}

test('部分移出视口的便签跳过屏幕外控件，不触发容器自动滚动，移回后恢复', async ({ page }) => {
  await newProject(page)
  await page
    .locator('canvas')
    .first()
    .evaluate((canvas) => {
      const data = new DataTransfer()
      data.setData(
        'text/plain',
        '[可见入口](https://reference.test/visible)\n\n' +
          Array(8).fill('便签占位正文。').join('\n\n') +
          '\n\n[屏幕外引用](https://reference.test/outside)\n\n```text\n屏幕外代码区\n```',
      )
      canvas.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
      )
    })
  await expect
    .poll(async () => (await elements(page)).filter((e) => e.kind === 'markdown').length)
    .toBe(1)
  const id = (await elements(page)).find((e) => e.kind === 'markdown')!.id
  await zoomTo(page, [id])
  await panElement(page, id, 780)
  const preview = page.locator('.plein-md-preview:not([aria-hidden])')
  const first = preview.locator('a[href$="/visible"]')
  const outside = preview.locator('a[href$="/outside"]')
  const code = preview.locator('[data-plein-scroll]')
  expect((await first.boundingBox())!.y).toBeLessThan(850)
  expect((await outside.boundingBox())!.y).toBeGreaterThan(900)
  const state = () =>
    page.evaluate(() => {
      const e = window.__plein.engine as Window['__plein']['engine'] & {
        camera: { x: number; y: number; zoom: number }
      }
      const root = document.querySelector('.plein-overlay')!.parentElement!
      const stage = document.querySelector('canvas')!.getBoundingClientRect()
      return {
        scrollTop: root.scrollTop,
        scrollLeft: root.scrollLeft,
        page: { x: window.scrollX, y: window.scrollY },
        stage: { x: stage.x, y: stage.y, w: stage.width, h: stage.height },
        camera: { x: e.camera.x, y: e.camera.y, zoom: e.camera.zoom },
      }
    })
  const before = await state()
  await first.focus()
  await page.keyboard.press('Tab')
  await expect(outside).not.toBeFocused()
  await expect(code).not.toBeFocused()
  expect(await state()).toEqual(before)
  await outside.focus()
  await expect(outside).not.toBeFocused()
  expect(await state()).toEqual(before)
  await panElement(page, id, 180)
  await first.focus()
  await page.keyboard.press('Tab')
  await expect(outside).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(code).toBeFocused()
  const currentTop = (await preview.boundingBox())!.y
  const currentLink = (await outside.boundingBox())!.y
  await panElement(page, id, currentTop + 895 - currentLink, 1080)
  const edge = (await outside.boundingBox())!
  expect(edge.y).toBeLessThan(900)
  expect(edge.y + edge.height).toBeGreaterThan(900)
  const edgeState = await state()
  await first.focus()
  await page.keyboard.press('Tab')
  await expect(outside).toBeFocused()
  expect(await state()).toEqual(edgeState)
  await page.screenshot({ path: test.info().outputPath('markdown-viewport-restored.png') })
})

test('节点正文仍可见但标题移出视口时，候选按钮不可聚焦，移回后可键盘审片', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '视口候选',
      params: { model: 'plein/mock:image', prompt: '两个本地候选', count: 2 },
      x: 0,
      y: 0,
    }),
  )
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
  await expect
    .poll(async () =>
      (await page.request.get(`/api/canvases/${canvas}/nodes/${id}/input`)).status(),
    )
    .toBe(200)
  expect(
    (await page.request.post(`/api/canvases/${canvas}/nodes/${id}/run`, { data: {} })).status(),
  ).toBe(202)
  await waitNode(page, id)
  await zoomTo(page, [id])
  const next = page
    .locator('.plein-node')
    .getByRole('button', { name: '下一个结果', exact: true, includeHidden: true })
  await expect(next).toBeEnabled()
  await panElement(page, id, -10)
  expect((await next.boundingBox())!.y + (await next.boundingBox())!.height).toBeLessThan(0)
  await next.focus()
  await expect(next).not.toBeFocused()
  await panElement(page, id, 180)
  await next.focus()
  await expect(next).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: '查看「视口候选」', exact: true })).toBeVisible()
})
