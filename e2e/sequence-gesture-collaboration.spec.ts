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
  for (const change of ['trim', 'asset', 'subtitle'] as const) {
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
