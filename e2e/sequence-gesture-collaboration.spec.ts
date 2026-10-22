import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { centerOf, clickElement, newProject } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-gesture-collaboration-'))
  for (const color of ['red', 'blue'])
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=96x64:d=2:r=10`,
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      join(dir, `${color}.webm`),
    ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function open(page: Page, id: string) {
  await clickElement(page, id)
  const at = await centerOf(page, id)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  await expect(editor).toHaveCSS('opacity', '1')
  return editor
}

async function videoFixture(page: Page) {
  await newProject(page)
  const assets: string[] = []
  for (const color of ['red', 'blue']) {
    const response = await page.request.post('/api/assets', {
      headers: { 'content-type': 'video/webm', 'x-file-name': `${color}.webm` },
      data: readFileSync(join(dir, `${color}.webm`)),
    })
    expect(response.status()).toBe(201)
    assets.push((await response.json()).id)
  }
  const { id, source } = await page.evaluate((assetId) => {
    const source = window.__plein.addNode({
      type: 'plein/video',
      name: '可替换镜头',
      x: -400,
      y: 200,
      params: {},
    })
    const node = window.__plein.engine.doc.mutable(source)! as unknown as {
      set(k: string, v: unknown): void
    }
    node.set('results', [
      { id: 'ready', runId: 'fixture', port: 'video', at: 1, value: { type: 'video', assetId } },
    ])
    const id = window.__plein.addNode({
      type: 'plein/sequence',
      name: '手势协作',
      x: 400,
      y: 200,
      params: {
        subtitles: false,
        aspectRatio: '16:9',
        resolution: '720p',
        clips: [{ source, in: 0, out: 1.8, subtitle: '原字幕' }],
      },
    })
    window.__plein.connect([source, 'video'], [id, 'clips'])
    return { id, source }
  }, assets[0]!)
  const editor = await open(page, id)
  await expect(editor.locator('.seq-filmstrip > span').first()).toBeVisible()
  const saved = () =>
    page.evaluate(
      (id) =>
        (window.__plein.engine.doc.get(id)!.params!.clips as Array<Record<string, unknown>>)[0]!,
      id,
    )
  return { id, source, assets, editor, saved }
}

for (const mode of ['rendered', 'same-frame'] as const) {
  // 素材变化只在 rendered 下验证：同帧取消路径与 trim 相同，由 trim same-frame 覆盖
  for (const change of mode === 'rendered'
    ? (['trim', 'asset', 'subtitle'] as const)
    : (['trim', 'subtitle'] as const)) {
    test(`修剪中 ${change} 外部变化 ${mode} 不被旧松手覆盖`, async ({ page }) => {
      const f = await videoFixture(page)
      const clip = f.editor.locator('.seq-clip').first()
      await clip.hover()
      const box = (await clip.boundingBox())!
      const handle = (await clip.locator('.seq-trim-out').boundingBox())!
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
      await page.mouse.down()
      await page.mouse.move(handle.x - box.width * 0.25, handle.y + handle.height / 2, { steps: 4 })
      await expect(
        f.editor.getByRole('spinbutton', { name: '出点（秒）', exact: true }),
      ).not.toHaveValue('1.8')
      expect((await f.saved()).out).toBe(1.8)
      await page.evaluate(
        ({ id, source, assetId, change, mode }) => {
          const doc = window.__plein.engine
            .doc as unknown as import('../packages/doc/src/doc').PleinDoc
          doc.ydoc.transact(() => {
            if (change === 'asset')
              doc.mutable(source)!.set('results', [
                {
                  id: 'new',
                  runId: 'fixture',
                  port: 'video',
                  at: 2,
                  value: { type: 'video', assetId },
                },
              ])
            else {
              const params = doc.mutable(id)!.get('params') as { set(k: string, v: unknown): void }
              const clips = doc.get(id)!.params!.clips as Array<Record<string, unknown>>
              params.set(
                'clips',
                clips.map((clip) => ({
                  ...clip,
                  ...(change === 'trim' ? { out: 0.8 } : {}),
                  subtitle: '外部字幕',
                })),
              )
            }
          }, 'simulated-peer')
          doc.flush()
          if (mode === 'same-frame')
            window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
        },
        { id: f.id, source: f.source, assetId: f.assets[1]!, change, mode },
      )
      if (mode === 'rendered')
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        )
      await page.mouse.up()
      const saved = await f.saved()
      if (change === 'subtitle') {
        expect(Number(saved.out)).toBeLessThan(1.8)
        expect(saved.subtitle).toBe('外部字幕')
      } else expect(saved.out).toBe(change === 'trim' ? 0.8 : 1.8)
      await expect(f.editor.locator('.seq-clip[data-trimming]')).toHaveCount(0)
      const notice = f.editor.getByRole('status', { name: '时间线操作已取消' })
      if (change === 'subtitle') await expect(notice).toHaveCount(0)
      else {
        await expect(notice).toContainText('已取消本次拖动')
        await clip.hover()
        const currentBox = (await clip.boundingBox())!
        const edge = clip.locator('.seq-trim-out')
        await expect(edge).toBeVisible()
        const nextHandle = (await edge.boundingBox())!
        await page.mouse.move(
          nextHandle.x + nextHandle.width / 2,
          nextHandle.y + nextHandle.height / 2,
        )
        await page.mouse.down()
        await page.mouse.move(
          nextHandle.x - currentBox.width * 0.15,
          nextHandle.y + nextHandle.height / 2,
          { steps: 4 },
        )
        await page.mouse.up()
        const fresh = await f.saved()
        expect(Number(fresh.out)).toBeLessThan(Number(saved.out))
        expect(fresh.subtitle).toBe(saved.subtitle)
        await expect(notice).toHaveCount(0)
        await f.editor.getByRole('button', { name: '重新加载预览', exact: true }).focus()
        await page.keyboard.press('ControlOrMeta+z')
        expect((await f.saved()).out).toBe(saved.out)
        await page.keyboard.press('ControlOrMeta+Shift+z')
        expect((await f.saved()).out).toBe(fresh.out)
        if (mode === 'rendered' && change === 'asset') {
          await f.editor.getByRole('button', { name: '导出 MP4', exact: true }).click()
          const video = f.editor.getByLabel('实际导出 MP4', { exact: true })
          await expect(video).toBeVisible({ timeout: 60000 })
          await expect
            .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
            .toBeGreaterThanOrEqual(2)
          const duration = await video.evaluate((v: HTMLVideoElement) => v.duration)
          expect(Math.abs(duration - Number(fresh.out))).toBeLessThan(0.1)
          const pixel = await video.evaluate((v: HTMLVideoElement) => {
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = 1
            const ctx = canvas.getContext('2d')!
            ctx.drawImage(v, 0, 0, 1, 1)
            return Array.from(ctx.getImageData(0, 0, 1, 1).data)
          })
          expect(pixel[2]).toBeGreaterThan(180)
          expect(pixel[0]).toBeLessThan(90)
        }
      }
    })
  }
}

for (const mode of ['rendered', 'same-frame'] as const) {
  for (const change of ['delete', 'order'] as const) {
    test(`重排中 ${change} 外部变化 ${mode} 保留最新镜头且可重新操作`, async ({ page }) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await newProject(page)
      const id = await page.evaluate(() =>
        window.__plein.addNode({
          type: 'plein/animatic',
          name: '重排协作',
          x: 400,
          y: 200,
          params: {
            subtitles: false,
            shots: ['a', 'b', 'c'].map((shotId) => ({ shotId, duration: 5, dialogue: [] })),
          },
        }),
      )
      const editor = await open(page, id)
      const clips = editor.locator('.seq-clip')
      const first = (await clips.first().boundingBox())!
      const last = (await clips.nth(2).boundingBox())!
      await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2)
      await page.mouse.down()
      await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2, { steps: 6 })
      await expect(editor.locator('.seq-clip[data-moving]')).toHaveCount(1)
      await page.evaluate(
        ({ id, mode, change }) => {
          const doc = window.__plein.engine
            .doc as unknown as import('../packages/doc/src/doc').PleinDoc
          const shots = doc.get(id)!.params!.shots as Array<Record<string, unknown>>
          const params = doc.mutable(id)!.get('params') as { set(k: string, v: unknown): void }
          doc.ydoc.transact(
            () =>
              params.set('shots', change === 'delete' ? shots.slice(0, 2) : [...shots].reverse()),
            'simulated-peer',
          )
          doc.flush()
          if (mode === 'same-frame')
            window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
        },
        { id, mode, change },
      )
      if (mode === 'rendered')
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        )
      await page.mouse.up()
      const order = () =>
        page.evaluate(
          (id) =>
            (window.__plein.engine.doc.get(id)!.params!.shots as Array<{ shotId: string }>).map(
              (s) => s.shotId,
            ),
          id,
        )
      const peer = change === 'delete' ? ['a', 'b'] : ['c', 'b', 'a']
      await expect.poll(order).toEqual(peer)
      await expect(clips).toHaveCount(peer.length)
      await expect(editor.locator('.seq-clip[data-moving]')).toHaveCount(0)
      const notice = editor.getByRole('status', { name: '时间线操作已取消' })
      await expect(notice).toBeVisible()
      if (mode === 'rendered' && change === 'order')
        await editor.screenshot({
          path: test.info().outputPath('gesture-canceled-current-layout.png'),
        })
      const nextFirst = (await clips.first().boundingBox())!
      const nextLast = (await clips.last().boundingBox())!
      await page.mouse.move(nextFirst.x + nextFirst.width / 2, nextFirst.y + nextFirst.height / 2)
      await page.mouse.down()
      await page.mouse.move(nextLast.x + nextLast.width - 4, nextLast.y + nextLast.height / 2, {
        steps: 6,
      })
      await expect(editor.locator('.seq-clip[data-moving]')).toHaveCount(1)
      await expect(notice).toHaveCount(0)
      await page.mouse.up()
      const expected = [...peer.slice(1), peer[0]!]
      await expect.poll(order).toEqual(expected)
      await expect(notice).toHaveCount(0)
      await editor.getByRole('button', { name: '重新加载预览', exact: true }).focus()
      await page.keyboard.press('ControlOrMeta+z')
      await expect.poll(order).toEqual(peer)
      await page.keyboard.press('ControlOrMeta+Shift+z')
      await expect.poll(order).toEqual(expected)
      expect(errors).toEqual([])
    })
  }
}

for (const change of [
  'wheel',
  'resize',
  'same-frame-wheel',
  'same-frame-width',
  'noop-wheel',
] as const) {
  test(`修剪中视图变化 ${change} 不提交旧坐标且可以重新操作`, async ({ page }) => {
    const f = await videoFixture(page)
    const clip = f.editor.locator('.seq-clip').first()
    await clip.hover()
    const box = (await clip.boundingBox())!
    const edge = (await clip.locator('.seq-trim-out').boundingBox())!
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2)
    await page.mouse.down()
    await page.mouse.move(edge.x - box.width * 0.25, edge.y + edge.height / 2, { steps: 4 })
    expect((await f.saved()).out).toBe(1.8)
    if (change === 'wheel') {
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, -50)
      await page.keyboard.up('Control')
      await expect(f.editor.getByRole('status', { name: '时间线操作已取消' })).toBeVisible()
    } else if (change === 'resize') await page.setViewportSize({ width: 1000, height: 800 })
    else
      await f.editor.locator('.seq-scroll').evaluate((el, change) => {
        if (change === 'same-frame-width') el.style.width = '700px'
        else
          el.dispatchEvent(
            new WheelEvent('wheel', {
              ctrlKey: true,
              deltaY: change === 'noop-wheel' ? 0 : -50,
              clientX: el.getBoundingClientRect().left + 200,
              bubbles: true,
              cancelable: true,
            }),
          )
        if (change.startsWith('same-frame'))
          window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
      }, change)
    await page.mouse.up()
    const notice = f.editor.getByRole('status', { name: '时间线操作已取消' })
    if (change === 'noop-wheel') {
      expect(Number((await f.saved()).out)).toBeLessThan(1.8)
      await expect(notice).toHaveCount(0)
      return
    }
    expect((await f.saved()).out).toBe(1.8)
    await expect(notice).toContainText('已取消本次拖动')
    await expect(f.editor.locator('.seq-clip[data-trimming]')).toHaveCount(0)
    if (change === 'wheel')
      await f.editor.screenshot({ path: test.info().outputPath('zoom-cancelled.png') })
    const fit = f.editor.getByRole('button', { name: '铺满', exact: true })
    if (await fit.isEnabled()) await fit.click()
    await clip.hover()
    const nextBox = (await clip.boundingBox())!
    const nextEdge = (await clip.locator('.seq-trim-out').boundingBox())!
    await page.mouse.move(nextEdge.x + nextEdge.width / 2, nextEdge.y + nextEdge.height / 2)
    await page.mouse.down()
    await page.mouse.move(nextEdge.x - nextBox.width * 0.15, nextEdge.y + nextEdge.height / 2, {
      steps: 4,
    })
    await page.mouse.up()
    expect(Number((await f.saved()).out)).toBeLessThan(1.8)
    await expect(notice).toHaveCount(0)
  })
}

for (const change of ['wheel', 'resize', 'same-frame-wheel', 'noop-wheel'] as const) {
  test(`重排中视图变化 ${change} 保留顺序且可以重新操作`, async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/animatic',
        name: '视图重排',
        x: 400,
        y: 200,
        params: {
          subtitles: false,
          shots: ['a', 'b', 'c'].map((shotId) => ({ shotId, duration: 5, dialogue: [] })),
        },
      }),
    )
    const editor = await open(page, id)
    const clips = editor.locator('.seq-clip')
    const dragLast = async () => {
      const first = (await clips.first().boundingBox())!
      const last = (await clips.last().boundingBox())!
      await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2)
      await page.mouse.down()
      await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2, { steps: 6 })
      await expect(editor.locator('.seq-clip[data-moving]')).toHaveCount(1)
    }
    const order = () =>
      page.evaluate(
        (id) =>
          (window.__plein.engine.doc.get(id)!.params!.shots as Array<{ shotId: string }>).map(
            (s) => s.shotId,
          ),
        id,
      )
    await dragLast()
    if (change === 'resize') await page.setViewportSize({ width: 1000, height: 800 })
    else
      await editor.locator('.seq-scroll').evaluate((el, change) => {
        el.dispatchEvent(
          new WheelEvent('wheel', {
            ctrlKey: true,
            deltaY: change === 'noop-wheel' ? 0 : -50,
            clientX: el.getBoundingClientRect().left + 200,
            bubbles: true,
            cancelable: true,
          }),
        )
        if (change === 'same-frame-wheel')
          window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
      }, change)
    await page.mouse.up()
    const notice = editor.getByRole('status', { name: '时间线操作已取消' })
    if (change === 'noop-wheel') {
      await expect.poll(order).toEqual(['c', 'a', 'b'])
      await expect(notice).toHaveCount(0)
      return
    }
    await expect.poll(order).toEqual(['a', 'b', 'c'])
    await expect(notice).toBeVisible()
    await expect(editor.locator('.seq-clip[data-moving]')).toHaveCount(0)
    const fit = editor.getByRole('button', { name: '铺满', exact: true })
    if (await fit.isEnabled()) await fit.click()
    await dragLast()
    await page.mouse.up()
    await expect.poll(order).toEqual(['c', 'a', 'b'])
    await expect(notice).toHaveCount(0)
    await editor.getByRole('button', { name: '重新加载预览', exact: true }).focus()
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(order).toEqual(['a', 'b', 'c'])
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(order).toEqual(['c', 'a', 'b'])
  })
}

for (const mode of ['native', 'same-frame', 'noop'] as const) {
  test(`修剪中横向滚动 ${mode} 不保存旧坐标`, async ({ page }) => {
    const f = await videoFixture(page)
    await f.editor.getByRole('button', { name: '放大', exact: true }).click()
    const scroller = f.editor.locator('.seq-scroll')
    await scroller.evaluate((el) => {
      el.scrollLeft = el.scrollWidth
    })
    const clip = f.editor.locator('.seq-clip').first()
    await clip.hover({ position: { x: 1000, y: 30 } })
    const edge = clip.locator('.seq-trim-out')
    await edge.scrollIntoViewIfNeeded()
    const handle = (await edge.boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    const previewScroll = await scroller.evaluate((el) => el.scrollLeft)
    await page.mouse.move(handle.x - 40, handle.y + handle.height / 2, { steps: 4 })
    await expect(f.editor.locator('.seq-clip[data-trimming]')).toHaveCount(1)
    expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(previewScroll)
    expect((await f.saved()).out).toBe(1.8)
    const before = await scroller.evaluate((el) => el.scrollLeft)
    if (mode === 'native') {
      await page.mouse.wheel(-120, 0)
      await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeLessThan(before)
    } else
      await scroller.evaluate((el, mode) => {
        if (mode !== 'noop') el.scrollLeft -= 120
        window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
      }, mode)
    await page.mouse.up()
    const notice = f.editor.getByRole('status', { name: '时间线操作已取消' })
    if (mode === 'noop') {
      expect(Number((await f.saved()).out)).toBeLessThan(1.8)
      await expect(notice).toHaveCount(0)
    } else {
      expect((await f.saved()).out).toBe(1.8)
      await expect(notice).toBeVisible()
      await expect(f.editor.locator('.seq-clip[data-trimming]')).toHaveCount(0)
      await edge.scrollIntoViewIfNeeded()
      const next = (await edge.boundingBox())!
      await page.mouse.move(next.x + next.width / 2, next.y + next.height / 2)
      await page.mouse.down()
      await page.mouse.move(next.x - 50, next.y + next.height / 2, { steps: 4 })
      await page.mouse.up()
      expect(Number((await f.saved()).out)).toBeLessThan(1.8)
      await expect(notice).toHaveCount(0)
    }
  })
}

for (const mode of ['native', 'same-frame', 'noop'] as const) {
  test(`重排中横向滚动 ${mode} 保留顺序并恢复操作`, async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/animatic',
        name: '滚动重排',
        x: 400,
        y: 200,
        params: {
          subtitles: false,
          shots: ['a', 'b', 'c'].map((shotId) => ({ shotId, duration: 5, dialogue: [] })),
        },
      }),
    )
    const editor = await open(page, id)
    await editor.getByRole('button', { name: '放大', exact: true }).click()
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    const scroller = editor.locator('.seq-scroll')
    await scroller.evaluate((el) => {
      el.scrollLeft = 0
    })
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBe(0)
    const clips = editor.locator('.seq-clip')
    const drag = async () => {
      const first = (await clips.first().boundingBox())!
      const second = (await clips.nth(1).boundingBox())!
      await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2)
      await page.mouse.down()
      await page.mouse.move(second.x + second.width / 2 + 20, second.y + second.height / 2, {
        steps: 6,
      })
      await expect(editor.locator('.seq-clip[data-moving]')).toHaveCount(1)
    }
    const order = () =>
      page.evaluate(
        (id) =>
          (window.__plein.engine.doc.get(id)!.params!.shots as Array<{ shotId: string }>).map(
            (s) => s.shotId,
          ),
        id,
      )
    if (mode === 'noop') {
      await editor.getByRole('button', { name: '播放', exact: true }).click()
      await expect(editor.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
    }
    await drag()
    await expect(editor.getByRole('button', { name: '播放', exact: true })).toBeVisible()
    if (mode === 'native') {
      await page.mouse.wheel(120, 0)
      await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
    } else
      await scroller.evaluate((el, mode) => {
        if (mode !== 'noop') el.scrollLeft += 120
        window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
      }, mode)
    await page.mouse.up()
    const notice = editor.getByRole('status', { name: '时间线操作已取消' })
    if (mode === 'noop') {
      await expect.poll(order).toEqual(['b', 'a', 'c'])
      await expect(notice).toHaveCount(0)
      return
    }
    await expect.poll(order).toEqual(['a', 'b', 'c'])
    await expect(notice).toBeVisible()
    await expect(editor.locator('.seq-clip[data-moving]')).toHaveCount(0)
    if (mode === 'native') {
      const labelOnTop = await editor.locator('.seq-row-clips').evaluate((row) => {
        const name = row.querySelector<HTMLElement>('.seq-clip-name')!
        const label = row.querySelector<HTMLElement>('.seq-label')!
        name.style.pointerEvents = 'auto'
        const bounds = name.getBoundingClientRect()
        const at = label.getBoundingClientRect()
        const hit = document.elementFromPoint(at.left + 30, bounds.top + 8)
        name.style.pointerEvents = ''
        return label.contains(hit)
      })
      expect(labelOnTop).toBe(true)
      await editor.screenshot({ path: test.info().outputPath('scroll-cancelled.png') })
    }
    await scroller.evaluate((el) => {
      el.scrollLeft = 0
    })
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBe(0)
    await drag()
    await page.mouse.up()
    await expect.poll(order).toEqual(['b', 'a', 'c'])
    await expect(notice).toHaveCount(0)
    await editor.getByRole('button', { name: '重新加载预览', exact: true }).focus()
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(order).toEqual(['a', 'b', 'c'])
  })
}
