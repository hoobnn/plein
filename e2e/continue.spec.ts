import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import {
  addNode,
  edgesInto,
  elements,
  newProject,
  revealGenerator,
  waitNode,
  zoomTo,
} from './canvas'

/** 设了就把界面截图存到这个目录（亮色、暗色各一张） */
const shotDir = process.env.PLEIN_E2E_SHOTS

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-e2e-continue-'))
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'smptebars=s=320x180:d=1:r=10',
    '-c:v',
    'libvpx-vp9',
    join(dir, 'retake.webm'),
  ])
})

test.afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const params = (page: Page, id: string) =>
  page.evaluate((id) => window.__plein.engine.doc.get(id)?.params ?? {}, id)

test(
  '取帧续镜：从尾帧接出下一个镜头，记下父视频；父镜头重生成后一键换新首帧',
  { tag: '@core' },
  async ({ page, request }) => {
    await newProject(page)
    await addNode(page, '生成视频')
    const generator = page.getByTestId('generator')
    // 编辑器固定在卡片下方，先把它移进窗口再点里面的控件
    await revealGenerator(page)
    await generator.locator('textarea').first().fill('雨夜天台，她走到栏杆边')
    await generator.getByRole('button', { name: '生成', exact: true }).click()
    const [parent] = (await elements(page)).filter((e) => e.kind === 'node')
    await waitNode(page, parent!.id)

    await generator.getByRole('button', { name: '续镜' }).click()
    await expect(page.getByRole('button', { name: /从尾帧续/ })).toBeVisible()
    if (shotDir) {
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme })
        await page.waitForTimeout(300)
        await page.screenshot({ path: join(shotDir, `1-menu-${scheme}.png`) })
      }
      await page.emulateMedia({ colorScheme: null })
    }
    await page.getByRole('button', { name: /从尾帧续/ }).click()
    await expect(page.locator('.ui-toast')).toContainText('接出下一个镜头')

    const next = (await elements(page)).find((e) => e.name?.endsWith('· 续镜'))!
    expect(next).toBeTruthy()
    const p = await params(page, next.id)
    expect(p.mode).toBe('image')
    expect(p.continuesFrom).toMatchObject({ elementId: parent!.id, last: true })
    // 首帧是抽出来的那张图，连在「图片」输入上
    const [edge] = await edgesInto(page, next.id)
    expect(edge?.[2]).toBe('images')
    const frame = (await elements(page)).find((e) => e.id === edge![0])!
    expect(frame.kind).toBe('image')

    const continued = page.getByTestId('continued-from')
    // 编辑器固定在卡片下方，先把它移进窗口再点里面的控件
    await revealGenerator(page)
    await expect(continued).toContainText('续自')
    await expect(continued).toContainText('尾帧')
    await zoomTo(page, [parent!.id, frame.id, next.id])
    if (shotDir) {
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme })
        await page.waitForTimeout(300)
        await page.screenshot({ path: join(shotDir, `2-continued-${scheme}.png`) })
      }
      await page.emulateMedia({ colorScheme: null })
    }

    // 点「续自」回到上一个镜头
    await continued.getByRole('button').first().click()
    await expect
      .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
      .toEqual([parent!.id])

    // 上一个镜头重新生成出了不同的画面（mock 每次给同一段视频，这里换成另一段并采用它）
    const clip = join(dir, 'retake.webm')
    const uploaded = await request.post('/api/assets', {
      headers: { 'content-type': 'video/webm', 'x-file-name': 'retake.webm' },
      data: readFileSync(clip),
    })
    const retake = ((await uploaded.json()) as { id: string }).id
    await page.evaluate(
      ({ id, assetId }) => {
        const m = window.__plein.engine.doc.mutable(id) as unknown as {
          get(k: string): unknown
          set(k: string, v: unknown): void
          doc: { transact(fn: () => void): void }
        }
        const old = (m.get('results') as unknown[]) ?? []
        const r = {
          id: 'retake',
          port: 'video',
          runId: 'retake',
          at: Date.now(),
          value: { type: 'video', assetId, mime: 'video/webm' },
        }
        m.doc.transact(() => {
          m.set('results', [r, ...old])
          m.set('adopted', 'retake')
        })
      },
      { id: parent!.id, assetId: retake },
    )
    const oldFrame = await page.evaluate(
      (id) => window.__plein.engine.doc.get(id)?.assetId,
      frame.id,
    )
    await page.evaluate((id) => {
      const { engine } = window.__plein as unknown as {
        engine: { selection: { set(ids: string[]): void } }
      }
      engine.selection.set([id])
    }, next.id)
    await expect(continued).toContainText('首帧已旧')
    await page.mouse.move(700, 120)
    if (shotDir) {
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme })
        await page.waitForTimeout(300)
        await page.screenshot({ path: join(shotDir, `3-stale-${scheme}.png`) })
      }
      await page.emulateMedia({ colorScheme: null })
    }
    // 编辑器固定在卡片下方，先把它移进窗口再点里面的控件
    await revealGenerator(page)
    await continued.getByRole('button', { name: '换成新画面' }).click()
    await expect(page.locator('.ui-toast')).toContainText('已换成上一个镜头的新画面')
    await expect(continued).not.toContainText('首帧已旧')
    const refreshed = await page.evaluate(
      (id) => window.__plein.engine.doc.get(id)?.assetId,
      frame.id,
    )
    expect(refreshed).not.toBe(oldFrame)
    expect((await params(page, next.id)).continuesFrom).toMatchObject({ assetId: retake })

    // 取帧已在服务端完成、响应尚未到达时手动换图，迟到的响应不能覆盖它。
    await page.evaluate((id) => {
      const doc = window.__plein.engine.doc
      const m = doc.mutable(id) as unknown as { set(k: string, v: unknown): void }
      m.set('adopted', undefined)
      // 最早的视频不是刚采用的 retake。
      const el = doc.get(id)!
      const first = el.results!.find((r) => r.id !== 'retake')!
      m.set('adopted', first.id)
    }, parent!.id)
    await expect(continued).toContainText('首帧已旧')
    let release!: () => void
    let captured!: () => void
    const ready = new Promise<void>((done) => {
      captured = done
    })
    const gate = new Promise<void>((done) => {
      release = done
    })
    await page.route('**/api/media/derive', async (route) => {
      const response = await route.fetch()
      captured()
      await gate
      await route.fulfill({ response })
    })
    await continued.getByRole('button', { name: '换成新画面' }).click()
    await ready
    const before = await params(page, next.id)
    await page.evaluate(
      ({ id, assetId }) => {
        const m = window.__plein.engine.doc.mutable(id) as unknown as {
          set(k: string, v: unknown): void
        }
        m.set('assetId', assetId)
      },
      { id: frame.id, assetId: oldFrame! },
    )
    release()
    await expect(page.locator('.ui-toast')).toContainText('续镜内容已经改变')
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.assetId, frame.id)).toBe(
      oldFrame,
    )
    expect(await params(page, next.id)).toEqual(before)
    await page.unroute('**/api/media/derive')
  },
)
