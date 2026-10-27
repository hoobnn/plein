import { execFileSync } from 'node:child_process'
import { expect, test, type Page, type Locator } from './fixtures'
import {
  addNode,
  clickElement,
  deselect,
  elements,
  newProject,
  revealGenerator,
  waitNode,
  zoomTo,
} from './canvas'
import { solidPng } from '../packages/providers/src/mock/media'

type Engine = import('../packages/canvas-core/src/engine').Engine

test.describe('画布实际渲染与输入关键旅程', { tag: '@core' }, () => {
  test('放大提示词立即可编辑，中文确认不误选候选或触发生成', async ({ page }) => {
    await newProject(page)
    await addNode(page, '生成图片')
    let runs = 0
    await page.route('**/api/canvases/*/nodes/*/run', (route) => {
      runs++
      return route.fulfill({ status: 503, json: { message: '测试拦截生成' } })
    })
    const generator = page.getByTestId('generator')
    const inline = generator.getByRole('textbox', { name: '提示词', exact: true })
    await inline.fill('/')
    const preset = generator.getByRole('listbox', { name: '提示词预设' })
    await expect(preset).toBeVisible()
    await inline.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
    await expect(inline).toHaveValue('/')
    const composingDefault = await inline.evaluate((el) =>
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          ctrlKey: true,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    )
    expect(composingDefault).toBe(true)
    expect(runs).toBe(0)
    await generator.getByRole('button', { name: '放大编辑提示词' }).click()
    const editor = page.getByRole('dialog', { name: '编辑提示词', exact: true })
    const expanded = editor.getByRole('textbox', { name: '提示词', exact: true })
    await expect(expanded).toBeFocused()
    await expanded.fill('放大编辑后的内容')
    await page.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)
    await expect(inline).toHaveValue('放大编辑后的内容')
    await inline.press('ControlOrMeta+Enter')
    await expect.poll(() => runs).toBe(1)
  })

  test('生成器打开时，底部添加菜单保持在前面并可点击', async ({ page }) => {
    await newProject(page)
    await addNode(page, '生成图片')
    const menu = page.getByRole('dialog', { name: '添加节点', exact: true })
    await expect(menu).toHaveCount(0)
    await expect(page.getByTestId('generator')).toBeVisible()
    await page.getByRole('button', { name: '添加节点', exact: true }).click()
    const search = menu.getByRole('textbox', { name: '搜索节点' })
    await search.click()
    await search.fill('文本')
    await menu.getByRole('option', { name: '文本', exact: true }).click()
    await expect(menu).toHaveCount(0)
    await expect.poll(async () => (await elements(page)).length).toBe(2)
  })
  for (const zoom of [0.5]) {
    for (const depth of [2]) {
      test(`${zoom * 100}% ${depth} 层分组中被遮住的端口不抢占邻近可见卡片拖动`, async ({
        page,
      }) => {
        await newProject(page)
        const upload = await page.request.post('/api/assets', {
          headers: { 'content-type': 'image/png' },
          data: Buffer.from(solidPng(64, 48, [110, 150, 180])),
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
                  name: '端口被遮挡的图片',
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
            const source = engine.selection.values()[0]!
            for (let i = 0; i < depth; i++) engine.groupSelection()
            const rect = engine.doc.worldRect(source)!
            const target = window.__plein.addNode({
              type: 'plein/image-edit',
              name: '连线恢复目标',
              params: {},
              x: rect.x + rect.w + 360,
              y: rect.y,
            })
            const cover = window.__plein.addNode({
              type: 'plein/text',
              name: '遮挡端口中心的上层卡片',
              params: { text: '' },
              x: rect.x + rect.w - 4,
              y: rect.y + rect.h / 2 - 20,
            })
            const m = engine.doc.mutable(cover)!
            m.set('w', 80)
            m.set('h', 40)
            engine.selection.clear()
            engine.doc.flush()
            engine.doc.undo.stopCapturing()
            engine.zoomToFit([source, target])
            engine.camera.zoomTo(zoom)
            return { source, target, cover }
          },
          { assetId: (await upload.json()).id as string, zoom, depth },
        )
        const read = () =>
          page.evaluate(() => {
            const e = window.__plein.engine as unknown as Engine
            return {
              nodes: [...e.doc.elements()]
                .map((el) => ({ id: el.id, parent: el.parentId, rect: e.doc.worldRect(el.id)! }))
                .sort((a, b) => a.id.localeCompare(b.id)),
              edges: [...e.doc.edges()],
            }
          })
        const before = await read()
        const start = await page.evaluate(({ source, cover }) => {
          const e = window.__plein.engine as unknown as Engine
          const r = e.doc.worldRect(source)!
          const center = { x: r.x + r.w, y: r.y + r.h / 2 }
          return {
            point: e.worldToClient(center.x - 8 / e.camera.zoom, center.y),
            covering: e.scene.hitTest(
              center.x,
              center.y,
              (id) => e.scene.get(id)?.kind !== 'frame',
            ),
            cover,
          }
        }, ids)
        expect(start.covering).toBe(ids.cover)
        await page.mouse.move(start.point.x, start.point.y)
        await page.screenshot({ path: test.info().outputPath('hidden-port-hover.png') })
        await page.mouse.down()
        await page.mouse.move(start.point.x - 80, start.point.y + 32, { steps: 8 })
        await page.mouse.up()
        await expect
          .poll(async () => (await read()).nodes.find((n) => n.id === ids.source)!.rect.x)
          .not.toBe(before.nodes.find((n) => n.id === ids.source)!.rect.x)
        expect((await read()).edges).toEqual([])
        await expect(page.getByRole('dialog', { name: '添加节点', exact: true })).toHaveCount(0)
        await page.getByRole('button', { name: '撤销', exact: true }).click()
        await expect.poll(read).toEqual(before)

        // 实际拖走遮挡，再从同一个输出端口连线；不能只把隐藏端口永久禁掉。
        const coverAt = await page.evaluate((id) => {
          const e = window.__plein.engine as unknown as Engine
          const r = e.doc.worldRect(id)!
          return e.worldToClient(r.x + r.w / 2, r.y + r.h / 2)
        }, ids.cover)
        await page.mouse.move(coverAt.x, coverAt.y)
        await page.mouse.down()
        await page.mouse.move(coverAt.x, coverAt.y - 120, { steps: 8 })
        await page.mouse.up()
        await expect
          .poll(async () => (await read()).nodes.find((n) => n.id === ids.cover)!.rect.y)
          .not.toBe(before.nodes.find((n) => n.id === ids.cover)!.rect.y)
        const uncovered = await read()
        await deselect(page)
        await expect(page.getByTestId('generator')).toHaveCount(0)
        const ports = await page.evaluate(({ source, target }) => {
          const e = window.__plein.engine as unknown as Engine
          const a = e.doc.worldRect(source)!
          const b = e.doc.worldRect(target)!
          return {
            from: e.worldToClient(a.x + a.w, a.y + a.h / 2),
            to: e.worldToClient(b.x, b.y + b.h / 2),
          }
        }, ids)
        await page.mouse.move(ports.from.x, ports.from.y)
        await page.mouse.down()
        await page.mouse.move(ports.to.x, ports.to.y, { steps: 8 })
        await page.mouse.up()
        await expect
          .poll(async () => (await read()).edges)
          .toMatchObject([{ from: [ids.source, 'image'], to: [ids.target, 'image'] }])
        expect((await read()).nodes).toEqual(uncovered.nodes)
        const connected = await read()
        await page.screenshot({ path: test.info().outputPath('uncovered-port-connected.png') })
        await page.getByRole('button', { name: '撤销', exact: true }).click()
        await expect.poll(read).toEqual(uncovered)
        await page.getByRole('button', { name: '重做', exact: true }).click()
        await expect.poll(read).toEqual(connected)
      })
    }
  }
  async function source(page: Page, size: string) {
    await newProject(page)
    const png = execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `gradients=s=${size}:c0=red:c1=blue:x0=0:y0=0:x1=5:y1=3:d=1:r=1`,
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      'pipe:1',
    ])
    const response = await page.request.post('/api/assets', {
      headers: { 'content-type': 'image/png' },
      data: png,
    })
    expect(response.status()).toBe(201)
    const asset = (await response.json()).id as string
    const id = await page.evaluate((asset) => {
      const e = window.__plein.engine as typeof window.__plein.engine & {
        paste(data: unknown): void
      }
      // 用正常卡片尺寸查看极小素材，切图仍应根据文件实际像素判断。
      e.paste({
        plein: 1,
        elements: [
          {
            id: 'tiny-source',
            kind: 'image',
            name: '像素边界图片',
            assetId: asset,
            x: 0,
            y: 0,
            w: 320,
            h: 192,
            rotation: 0,
            locked: false,
            parentId: null,
          },
        ],
        edges: [],
      })
      return [...e.doc.elements()][0]!.id
    }, asset)
    return { id, asset }
  }

  async function split(page: Page) {
    // 极小图片显示尺寸由元数据自适应，通过侧栏正常定位，专门验证切图边界。
    await page.getByRole('treeitem', { name: '像素边界图片 定位到画布', exact: true }).click()
    await page
      .getByRole('toolbar', { name: '结果操作' })
      .getByRole('button', { name: '宫格切分' })
      .click()
    await page.getByRole('button', { name: /4 宫格/ }).click()
  }

  test('奇数像素切分保留右侧和底部所有像素，切片可逐像素重组原图', async ({ page }) => {
    const { asset } = await source(page, '5x3')
    await split(page)
    await expect
      .poll(async () => (await elements(page)).filter((el) => el.kind === 'frame').length)
      .toBe(1)
    const assets = await page.evaluate(() => {
      const e = window.__plein.engine
      const frame = [...e.doc.elements()].find((el) => el.kind === 'frame')!
      return (frame.params!.shotGroup as { order: string[] }).order.map(
        (id) => e.doc.get(id)!.assetId!,
      )
    })
    const dimensions = await Promise.all(
      assets.map(async (id) => {
        const meta = await (await page.request.get(`/api/assets/${id}/meta`)).json()
        return [meta.width, meta.height]
      }),
    )
    expect(dimensions).toEqual([
      [2, 1],
      [3, 1],
      [2, 2],
      [3, 2],
    ])
    const same = await page.evaluate(
      async ({ asset, assets }) => {
        const load = async (id: string) =>
          createImageBitmap(await (await fetch(`/api/assets/${id}`)).blob())
        const original = await load(asset)
        const canvas = document.createElement('canvas')
        canvas.width = 5
        canvas.height = 3
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(original, 0, 0)
        const before = ctx.getImageData(0, 0, 5, 3).data
        ctx.clearRect(0, 0, 5, 3)
        for (const [n, id] of assets.entries()) {
          const tile = await load(id)
          ctx.drawImage(tile, n % 2 ? 2 : 0, n >= 2 ? 1 : 0)
          tile.close()
        }
        original.close()
        return before.every((v, i) => v === ctx.getImageData(0, 0, 5, 3).data[i])
      },
      { asset, assets },
    )
    expect(same).toBe(true)
  })
  async function hiddenMakesNoDifference(
    page: Page,
    overlay: Locator,
    clip: { x: number; y: number; width: number; height: number },
  ) {
    const before = await page.screenshot({ clip, animations: 'disabled' })
    await overlay.evaluate((el) => {
      el.style.visibility = 'hidden'
    })
    const after = await page.screenshot({ clip, animations: 'disabled' })
    await overlay.evaluate((el) => {
      el.style.visibility = ''
    })
    return before.equals(after)
  }

  test('被上层节点覆盖的分镜角标不会穿透，并随拖动恢复', async ({ page }) => {
    await newProject(page)
    const uploaded = await page.request.post('/api/assets', {
      headers: { 'content-type': 'image/png' },
      data: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAYklEQVR4nO3PUQkAIBTAwBfFqDbXEH4cwmABbnP2+rrhgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACx67GbZ1HuLZqnQAAAAASUVORK5CYII=',
        'base64',
      ),
    })
    expect(uploaded.status()).toBe(201)
    const asset = (await uploaded.json()).id as string
    const ids = await page.evaluate((asset) => {
      const e = window.__plein.engine as unknown as {
        paste(data: unknown): void
        doc: { elements(): Iterable<{ id: string; name?: string }> }
        selection: { set(ids: string[]): void }
      }
      const base = { rotation: 0, locked: false, parentId: null, x: 0, y: 0, w: 400, h: 400 }
      e.paste({
        plein: 1,
        elements: [
          {
            ...base,
            id: 'frame',
            kind: 'frame',
            name: '分镜角标组',
            params: { shotGroup: { order: ['shot'] } },
          },
          {
            ...base,
            id: 'shot',
            kind: 'image',
            name: '被挡的镜头',
            parentId: 'frame',
            x: 40,
            y: 40,
            w: 200,
            h: 200,
            assetId: asset,
          },
        ],
        edges: [],
      })
      const all = [...e.doc.elements()]
      const shot = all.find((el) => el.name === '被挡的镜头')!.id
      const cover = window.__plein.addNode({
        type: 'plein/text',
        name: '上层遮挡卡片',
        params: { text: '' },
        x: 40 + 24,
        y: 40 + 24,
      })
      e.selection.set([])
      return { shot, cover }
    }, asset)
    await page.waitForFunction(
      (id) =>
        (window.__plein.engine as unknown as { scene: { rect(id: string): unknown } }).scene.rect(
          id,
        ),
      ids.cover,
    )
    await zoomTo(page, Object.values(ids))
    const badge = page.locator(`[data-shot-badge="${ids.shot}"]`)
    await expect(badge).toBeAttached()
    const box = (await badge.boundingBox())!
    expect(
      await hiddenMakesNoDifference(page, badge, box),
      '上层卡片覆盖镜头时，角标也应被遮挡',
    ).toBe(true)
    await page.evaluate((id) => {
      const m = window.__plein.engine.doc.mutable(id) as unknown as {
        set(k: string, v: number): void
      }
      m.set('x', 600)
    }, ids.cover)
    await expect.poll(() => badge.evaluate((el) => el.style.clipPath)).toBe('')
    expect(await hiddenMakesNoDifference(page, badge, box)).toBe(false)
  })

  test('画布内播放器全屏时不保留节点的遮挡裁剪，退出后恢复', async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/video',
        name: '全屏裁剪回归',
        params: { model: 'plein/mock:video', prompt: '测试播放器', duration: 2 },
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
    await clickElement(page, id)
    await deselect(page)
    const at = await page.evaluate((id) => {
      const e = window.__plein.engine
      const r = e.doc.worldRect(id)
      return e.worldToClient(r.x + r.w / 2, r.y + r.h / 2)
    }, id)
    await page.mouse.dblclick(at.x, at.y)
    const player = page.locator('.plein-player')
    await expect(player).toBeVisible()
    await page.evaluate((id) => {
      const r = window.__plein.engine.doc.worldRect(id)
      const cover = window.__plein.addNode({
        type: 'plein/text',
        name: '局部覆盖播放器',
        params: { text: '' },
        x: r.x,
        y: r.y + r.h - 52,
      })
      const m = window.__plein.engine.doc.mutable(cover) as unknown as {
        set(k: string, v: number): void
      }
      m.set('w', 60)
      m.set('h', 52)
    }, id)
    await expect.poll(() => player.evaluate((el) => el.style.clipPath)).not.toBe('')
    const play = player.locator('.plein-player-btn').first()
    await expect.poll(() => play.evaluate((el: HTMLElement) => el.inert)).toBe(true)
    await player.getByRole('button', { name: '全屏', exact: true }).click()
    await expect(player).toHaveClass(/is-fullscreen/)
    await expect.poll(() => play.evaluate((el: HTMLElement) => el.inert)).toBe(false)
    await expect.poll(() => player.evaluate((el) => getComputedStyle(el).clipPath)).toBe('none')
    await player.getByRole('button', { name: '退出全屏', exact: true }).click()
    await expect.poll(() => player.evaluate((el) => getComputedStyle(el).clipPath)).not.toBe('none')
    await expect.poll(() => play.evaluate((el: HTMLElement) => el.inert)).toBe(true)
  })

  test('窗口缩窄后生成器仍贴在卡片下方，不被窗口和侧栏裁掉', async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/text',
        name: '窗口适配',
        params: { text: '可编辑内容' },
        x: 0,
        y: 0,
      }),
    )
    await page.waitForFunction(
      (id) =>
        (window.__plein.engine as unknown as { scene: { rect(id: string): unknown } }).scene.rect(
          id,
        ),
      id,
    )
    await clickElement(page, id)
    await expect(page.getByTestId('generator')).toBeVisible()
    await page.setViewportSize({ width: 800, height: 900 })
    // 编辑器固定在卡片下方；窗口不够宽时按可用宽度收，整块留在可见画布里，
    // 右边的关闭按钮和底部的生成按钮都够得着。
    const editor = page.getByTestId('node-editor')
    await expect
      .poll(
        async () => {
          const box = (await editor.boundingBox())!
          const inset = await page.evaluate(() => window.__plein.engine.camera.insets.left)
          return Math.round(box.width) === Math.max(320, Math.min(840, 800 - inset))
        },
        { timeout: 3000 },
      )
      .toBe(true)
    await expect
      .poll(
        async () => {
          const box = (await editor.boundingBox())!
          const visible = await page.evaluate(() => {
            const engine = window.__plein.engine
            return {
              left: engine.camera.insets.left,
              right: innerWidth - engine.camera.insets.right,
            }
          })
          return box.x >= visible.left - 1 && box.x + box.width <= visible.right + 1
        },
        { timeout: 3000 },
      )
      .toBe(true)
  })

  test('创作引导不会盖住所选节点的生成器和按钮', async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(() => {
      window.__plein.addNode({
        type: 'plein/storyboard',
        name: '引导的分镜',
        params: { shots: [] },
        x: -700,
        y: 0,
      })
      return window.__plein.addNode({
        type: 'plein/image',
        name: '被编辑的镜头图',
        params: {},
        x: 0,
        y: 0,
      })
    })
    await page.waitForFunction(
      (id) =>
        (window.__plein.engine as unknown as { scene: { rect(id: string): unknown } }).scene.rect(
          id,
        ),
      id,
    )
    await clickElement(page, id)
    await expect(page.getByTestId('creation-guide')).toBeVisible()
    await page.evaluate(() =>
      (
        window.__plein.engine as unknown as { camera: { panBy(x: number, y: number): void } }
      ).camera.panBy(0, -250),
    )
    await expect
      .poll(
        async () => {
          const box = (await page.getByTestId('generator').boundingBox())!
          const guide = (await page.getByTestId('creation-guide').boundingBox())!
          const left = Math.max(box.x, guide.x)
          const top = Math.max(box.y, guide.y)
          const right = Math.min(box.x + box.width, guide.x + guide.width)
          const bottom = Math.min(box.y + box.height, guide.y + guide.height)
          if (right - left < 8 || bottom - top < 8) return true
          return page.evaluate(
            ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-testid="generator"]'),
            { x: (left + right) / 2, y: (top + bottom) / 2 },
          )
        },
        { timeout: 3000 },
      )
      .toBe(true)
    const reference = page
      .getByTestId('generator')
      .getByRole('button', { name: '上传参考', exact: true })
    await expect(reference).toBeVisible()
    expect(
      await reference.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
      }),
    ).toBe(true)
  })

  for (const width of [320]) {
    test(`${width}px 底栏所有按钮留在窗口内且不被助手遮挡`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await newProject(page)
      await page.setViewportSize({ width, height: 700 })
      if (width === 800 || width === 1440) {
        const resize = page.getByRole('separator', { name: '调整侧栏宽度', exact: true })
        await resize.focus()
        for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+ArrowRight')
      }
      const footer = page.getByRole('contentinfo')
      await expect
        .poll(
          () =>
            footer.locator('button:visible').evaluateAll(
              (buttons) =>
                buttons.length > 0 &&
                buttons.every((button) => {
                  const r = button.getBoundingClientRect()
                  return (
                    r.left >= 0 &&
                    r.right <= window.innerWidth &&
                    r.top >= 64 &&
                    r.bottom <= window.innerHeight &&
                    ((button instanceof HTMLButtonElement && button.disabled) ||
                      document
                        .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
                        ?.closest('button') === button)
                  )
                }),
            ),
          { timeout: 2500 },
        )
        .toBe(true)
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true)
      const trigger = page.getByRole('button', { name: '快捷键', exact: true })
      await trigger.click()
      await expect(page.getByRole('dialog', { name: '快捷键', exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: '快捷键', exact: true })).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await page.screenshot({ path: testInfo.outputPath('footer-fit.png'), animations: 'disabled' })
      expect(errors).toEqual([])
    })
  }

  test('分行底栏下文本生成器仍完整可编辑，正文保留', async ({ page }, testInfo) => {
    await newProject(page)
    // 编辑器固定 840×440，窗口要放得下它：顶栏之下、底栏之上都要留出位置
    await page.setViewportSize({ width: 700, height: 700 })
    await expect
      .poll(() => page.evaluate(() => (window.__plein.engine as unknown as Engine).camera.width))
      .toBe(700)
    const id = await page.evaluate(() => {
      const id = window.__plein.addNode({
        type: 'plein/text',
        name: '底栏避让编辑',
        params: { text: '保留正文' },
        x: 500,
        y: 200,
      })
      const engine = window.__plein.engine as unknown as Engine
      engine.doc.flush()
      engine.zoomToFit([id])
      return id
    })
    await clickElement(page, id)
    const panel = page.getByTestId('generator')
    await expect(panel).toBeVisible()
    // 编辑器固定在卡片下方，窄窗口里先把它移进窗口再操作
    await revealGenerator(page)
    const prompt = panel.getByRole('textbox', { name: '提示词', exact: true })
    await expect(prompt).toBeVisible()
    await expect
      .poll(() =>
        panel.evaluate((el) => {
          const r = el.getBoundingClientRect()
          return r.top >= 64 && r.bottom <= window.innerHeight
        }),
      )
      .toBe(true)
    await prompt.fill('底栏分行后仍能编辑 🌧️')
    await prompt.press('Tab')
    await expect
      .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, id))
      .toBe('底栏分行后仍能编辑 🌧️')
    await page.screenshot({
      path: testInfo.outputPath('footer-generator.png'),
      animations: 'disabled',
    })
  })
})
