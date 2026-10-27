import { expect, type Page, test } from './fixtures'
import { centerOf, elements, newProject, settle, waitEngine, zoomTo } from './canvas'

/**
 * 便签的真浏览器核心旅程。
 *
 * 这里的每条用例都只能在真实浏览器里成立：跨窗口的持久化与协作、真实的链接导航、
 * 真实的焦点顺序与滚动语义。其余行为（撤销范围、权限守卫、滚轮路由、快捷键边界）
 * 已经下沉到快速测试层，见 apps/web/src/canvas/markdown*.test.ts。
 */

/** 新建项目并贴上一张便签。 */
async function note(page: Page, text: string) {
  await newProject(page)
  await page
    .locator('canvas')
    .first()
    .evaluate((canvas, body) => {
      const data = new DataTransfer()
      data.setData('text/plain', body)
      canvas.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
      )
    }, text)
  await expect
    .poll(async () => (await elements(page)).filter((el) => el.kind === 'markdown').length)
    .toBe(1)
  const id = (await elements(page)).find((el) => el.kind === 'markdown')!.id
  await settle(page, id)
  return {
    id,
    read: () => page.evaluate((id) => window.__plein.engine.doc.getText(id)?.toString(), id),
  }
}

/** 双击便签打开正文编辑器。 */
async function open(page: Page, id: string) {
  await zoomTo(page, [id])
  const at = await centerOf(page, id)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.locator('.plein-md-editor .cm-content')
  await expect(editor).toBeFocused()
  return editor
}

/** 预览区里的正文容器。 */
const preview = (page: Page) => page.locator('.plein-md-preview:not([aria-hidden])')

test(
  '便签链接在新标签打开且不带上原窗口，正文和节点不变',
  { tag: '@core' },
  async ({ page, context }) => {
    await context.route('https://reference.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<meta charset="utf-8"><title>参考资料</title><p>受控参考页面</p>',
      }),
    )
    const text = '查看 [参考资料](https://reference.test/guide)\n\n正文应保持完整。'
    const f = await note(page, text)
    await zoomTo(page, [f.id])
    const link = preview(page).getByRole('link', { name: '参考资料' })
    const popupPromise = page.waitForEvent('popup')
    await link.click()
    const popup = await popupPromise
    await expect(popup).toHaveURL('https://reference.test/guide')
    expect(await popup.evaluate(() => window.opener)).toBe(null)
    await popup.close()
    expect(await f.read()).toBe(text)
    expect((await elements(page)).map((el) => el.id)).toEqual([f.id])
  },
)

test('便签正文退出编辑后刷新仍然保留', { tag: '@core' }, async ({ page }) => {
  const f = await note(page, '便签原始正文')
  const editor = await open(page, f.id)
  await editor.press('End')
  await page.keyboard.insertText('，追加文字')
  await expect.poll(f.read).toBe('便签原始正文，追加文字')
  await editor.press('Escape')
  await expect(page.locator('.plein-md-editor')).toHaveCount(0)
  await page.reload()
  await waitEngine(page)
  await expect.poll(f.read).toBe('便签原始正文，追加文字')
})

test('同伴追加正文后本机撤销只移除本机编辑', { tag: '@core' }, async ({ page, browser }) => {
  const f = await note(page, '便签原始正文')
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const peer = await context.newPage()
    await peer.goto(page.url())
    await waitEngine(peer)
    await expect
      .poll(() => peer.evaluate((id) => !!window.__plein.engine.doc.get(id), f.id))
      .toBe(true)
    await peer.evaluate((id) => window.__plein.engine.zoomToFit([id]), f.id)
    const at = await centerOf(peer, f.id)
    await peer.mouse.dblclick(at.x, at.y)
    const other = peer.locator('.plein-md-editor .cm-content')
    await expect(other).toBeFocused()
    const readPeer = () =>
      peer.evaluate((id) => window.__plein.engine.doc.getText(id)?.toString(), f.id)
    const editor = await open(page, f.id)
    await editor.press('End')
    await page.keyboard.insertText('，本机追加')
    await expect.poll(readPeer).toBe('便签原始正文，本机追加')
    await other.press('End')
    await peer.keyboard.insertText('，同伴追加')
    await expect.poll(f.read).toBe('便签原始正文，本机追加，同伴追加')
    await editor.press('ControlOrMeta+z')
    await expect.poll(f.read).toBe('便签原始正文，同伴追加')
    await expect.poll(readPeer).toBe('便签原始正文，同伴追加')
    await editor.press('ControlOrMeta+Shift+z')
    await expect.poll(f.read).toBe('便签原始正文，本机追加，同伴追加')
    await expect.poll(readPeer).toBe('便签原始正文，本机追加，同伴追加')
  } finally {
    await context.close()
  }
})

test(
  '完全遮挡的便签撤下不可见焦点，恢复后链接和滚动区重新可用',
  { tag: '@core' },
  async ({ page }) => {
    const f = await note(
      page,
      '[可见入口](https://reference.test/visible)\n\n```text\n可见代码区\n```',
    )
    await zoomTo(page, [f.id])
    const hidden = preview(page).locator('a[href$="/visible"]')
    const code = preview(page).locator('[data-plein-scroll]')
    await code.focus()
    await expect(code).toBeFocused()
    const cover = await page.evaluate((id) => {
      const { engine } = window.__plein
      const r = engine.doc.worldRect(id)
      const created = window.__plein.addNode({
        type: 'plein/text',
        name: '完整遮挡',
        params: { text: '' },
        x: r.x - 20,
        y: r.y - 20,
      })
      const m = engine.doc.mutable(created) as unknown as { set(k: string, v: unknown): void }
      m.set('w', r.w + 40)
      m.set('h', r.h + 40)
      return created
    }, f.id)
    await expect
      .poll(() => preview(page).evaluate((el) => el.style.clipPath))
      .toMatch(/M[ ,]*0[ ,]*0[ ,]*Z/)
    await expect(code).not.toBeFocused()
    expect(await preview(page).evaluate((el: HTMLElement) => el.inert)).toBe(true)
    await hidden.focus()
    await expect(hidden).not.toBeFocused()
    await page.evaluate((id) => {
      ;(
        window.__plein.engine.doc.mutable(id) as unknown as { set(k: string, v: unknown): void }
      ).set('x', 2000)
    }, cover)
    await expect.poll(() => preview(page).evaluate((el) => el.style.clipPath)).toBe('')
    await code.focus()
    await expect(code).toBeFocused()
    expect((await elements(page)).map((el) => el.id).sort()).toEqual([cover, f.id].sort())
  },
)

test('移出视口的便签跳过屏幕外控件，不触发容器自动滚动', { tag: '@core' }, async ({ page }) => {
  const f = await note(
    page,
    '[可见入口](https://reference.test/visible)\n\n' +
      Array(8).fill('便签占位正文。').join('\n\n') +
      '\n\n[屏幕外引用](https://reference.test/outside)\n\n```text\n屏幕外代码区\n```',
  )
  await zoomTo(page, [f.id])
  const pan = async (top: number) => {
    await page.evaluate(
      ({ id, top }) => {
        const e = window.__plein.engine as Window['__plein']['engine'] & {
          camera: { panBy(x: number, y: number): void }
        }
        const r = e.doc.worldRect(id)
        const p = e.worldToClient(r.x, r.y)
        e.camera.panBy(950 - p.x, top - p.y)
      },
      { id: f.id, top },
    )
    await settle(page, f.id)
  }
  await pan(780)
  const first = preview(page).locator('a[href$="/visible"]')
  const outside = preview(page).locator('a[href$="/outside"]')
  const code = preview(page).locator('[data-plein-scroll]')
  const state = () =>
    page.evaluate(() => {
      const root = document.querySelector('.plein-overlay')!.parentElement!
      return { scrollTop: root.scrollTop, scrollLeft: root.scrollLeft }
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
  await pan(180)
  await first.focus()
  await page.keyboard.press('Tab')
  await expect(outside).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(code).toBeFocused()
})

test('便签的超宽代码块可用滚轮横向查看，不移动画布或节点', { tag: '@core' }, async ({ page }) => {
  const text = `# 代码示例\n\n\`\`\`text\n${'long_value_'.repeat(35)}代码末尾\n第二行\n\`\`\`\n\n结尾正文。`
  const f = await note(page, text)
  await zoomTo(page, [f.id])
  const region = preview(page).getByRole('region', { name: '代码块', exact: true })
  const before = await page.evaluate((id) => {
    const e = window.__plein.engine
    return {
      geometry: e.doc.worldRect(id),
      at: e.worldToClient(0, 0),
      selected: e.selection.values(),
    }
  }, f.id)
  await region.focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
  await region.evaluate((el) => {
    el.scrollLeft = 0
  })
  const box = (await region.boundingBox())!
  await page.mouse.move(box.x + 20, box.y + 10)
  await page.mouse.wheel(220, 0)
  await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100)
  expect(
    await page.evaluate((id) => {
      const e = window.__plein.engine
      return {
        geometry: e.doc.worldRect(id),
        at: e.worldToClient(0, 0),
        selected: e.selection.values(),
      }
    }, f.id),
  ).toEqual(before)
  await page.keyboard.press('Escape')
  await expect(region).not.toBeFocused()
  expect(await f.read()).toBe(text)
})

test('长便签首尾光标保持可见，滚动不移动相机', { tag: '@core' }, async ({ page }) => {
  const text = [
    '长便签首行',
    ...Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行：保留原始正文。`),
    '长便签结尾',
  ].join('\n')
  const f = await note(page, text)
  await page.evaluate(
    ({ id }) => {
      const e = window.__plein.engine as Window['__plein']['engine'] & {
        zoomTo(level: number): void
        camera: { panBy(x: number, y: number): void }
      }
      e.zoomTo(1)
      const r = e.doc.worldRect(id)
      const p = e.worldToClient(r.x, r.y)
      e.camera.panBy(500 - p.x, 120 - p.y)
    },
    { id: f.id },
  )
  await settle(page, f.id)
  await page.mouse.dblclick(550, 145)
  const editor = page.locator('.plein-md-editor .cm-content')
  const caret = page.locator('.plein-md-editor .cm-cursor')
  await expect(editor).toBeFocused()
  const camera = () =>
    page.evaluate(() => {
      const c = (
        window.__plein.engine as unknown as { camera: { x: number; y: number; zoom: number } }
      ).camera
      return { x: c.x, y: c.y, zoom: c.zoom }
    })
  const before = await camera()
  await editor.press('ControlOrMeta+End')
  await page.keyboard.insertText('，末尾追加')
  await expect.poll(f.read).toContain('长便签结尾，末尾追加')
  await expect(caret).toBeInViewport({ ratio: 0.999 })
  await editor.press('ControlOrMeta+Home')
  await expect(caret).toBeInViewport({ ratio: 0.999 })
  const scroller = page.locator('.plein-md-editor .cm-scroller')
  const box = (await scroller.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, 320)
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  expect(await camera()).toEqual(before)
  expect(
    await page.evaluate(() => document.querySelector('.plein-overlay')!.parentElement!.scrollTop),
  ).toBe(0)
})

/**
 * 图片迟到与加载失败：真实图片加载与真实排版，happy-dom 证明不了。
 * 只测必要的一种情形：图片没到位时正文不被裁掉，改成有效地址后能恢复排版。
 */
test(
  '图片加载失败仍显示替代文字和后文，改成有效地址后恢复排版',
  { tag: '@core' },
  async ({ page }) => {
    await page.route('**/markdown-missing.svg', (route) =>
      route.fulfill({ status: 503, body: 'fixture offline' }),
    )
    await page.route('**/markdown-recovered.svg', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="orange"/></svg>',
      }),
    )
    const { id } = await note(
      page,
      '# 图文便签\n\n![参考图](/markdown-missing.svg)\n\n图片之后的结尾正文。',
    )
    const previewBox = preview(page).first()
    await expect(previewBox).toBeVisible()

    // 图片失败时仍能看到替代文字与后文，正文没有被裁掉
    await expect(previewBox.getByRole('img', { name: '参考图' })).toBeVisible()
    await expect(previewBox).toContainText('图片之后的结尾正文。')
    const heightWhenFailed = await page.evaluate(
      (id) => window.__plein.engine.doc.worldRect(id).h,
      id,
    )
    expect(heightWhenFailed).toBeGreaterThan(0)

    // 编辑成有效地址后图片加载成功，排版跟着恢复
    const editor = await open(page, id)
    await editor.press('ControlOrMeta+a')
    await page.keyboard.insertText(
      '# 图文便签\n\n![参考图](/markdown-recovered.svg)\n\n图片之后的结尾正文。',
    )
    await editor.press('Escape')
    await expect(editor).toHaveCount(0)
    const image = preview(page).first().getByRole('img', { name: '参考图' })
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(800)
    // 刷新后仍是改正后的正文
    await page.reload()
    await waitEngine(page)
    await expect
      .poll(() => page.evaluate((id) => window.__plein.engine.doc.getText(id)?.toString(), id))
      .toContain('markdown-recovered.svg')
  },
)
