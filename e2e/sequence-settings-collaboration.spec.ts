import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { centerOf, clickElement, elements, newProject, waitEngine } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-seconds-collaboration-'))
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=96x64:d=2:r=8',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    join(dir, 'shot.webm'),
  ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function fixture(page: Page, subtitles = false) {
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (await chooser).setFiles(join(dir, 'shot.webm'))
  await expect
    .poll(async () => (await elements(page)).filter((e) => e.kind === 'video').length)
    .toBe(1)
  const video = (await elements(page)).find((e) => e.kind === 'video')!
  const id = await page.evaluate(
    ({ source, subtitles }) => {
      const id = window.__plein.addNode({
        type: 'plein/sequence',
        name: '秒数并发校验',
        x: 3000,
        y: 1000,
        params: { subtitles, clips: [{ source, in: 0, out: 1.8, subtitle: '初始字幕' }] },
      })
      window.__plein.connect([source, 'video'], [id, 'clips'])
      return id
    },
    { source: video.id, subtitles },
  )
  await clickElement(page, id)
  const at = await centerOf(page, id)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  const input = editor.getByRole('spinbutton', { name: '入点（秒）', exact: true })
  await expect(input).toHaveValue('0')
  await expect(editor.locator('.seq-filmstrip > span').first()).toBeVisible()
  await expect(editor.getByText('缩略图加载失败', { exact: true })).toHaveCount(0)
  const saved = () =>
    page.evaluate(
      (id) =>
        (
          window.__plein.engine.doc.get(id)!.params!.clips as Array<{
            in: number
            out?: number
            subtitle?: string
          }>
        )[0]!,
      id,
    )
  return { id, source: video.id, editor, input, saved }
}

for (const kind of ['conflict', 'other-field', 'cross-in', 'cross-out'] as const) {
  test(`视频秒数同任务更新后失焦 ${kind} 保留最新剪辑并按当前边界校验`, async ({ page }) => {
    const f = await fixture(page)
    const field =
      kind === 'cross-out'
        ? f.editor.getByRole('spinbutton', { name: '出点（秒）', exact: true })
        : f.input
    await field.fill(kind === 'cross-out' ? '0.8' : '0.4')
    await field.evaluate(
      (input: HTMLInputElement, { id, kind }) => {
        const doc = window.__plein.engine.doc
        const clips = doc.get(id)!.params!.clips as Array<Record<string, unknown>>
        const params = doc.mutable(id)!.get('params') as { set(key: string, value: unknown): void }
        const patch =
          kind === 'conflict'
            ? { in: 0.2, out: 1.4 }
            : kind === 'other-field'
              ? { out: 1.4 }
              : kind === 'cross-in'
                ? { out: 0.2 }
                : { in: 1 }
        params.set(
          'clips',
          clips.map((clip) => ({ ...clip, ...patch })),
        )
        input.blur()
      },
      { id: f.id, kind },
    )
    if (kind === 'conflict') {
      await f.editor
        .locator('.seq-clip')
        .first()
        .screenshot({ path: test.info().outputPath('sparse-filmstrip.png') })
      expect(await f.saved()).toMatchObject({ in: 0.2, out: 1.4 })
      await expect(f.input).toHaveValue('0.4')
      await f.editor.getByRole('button', { name: '保留当前数值', exact: true }).click()
      expect(await f.saved()).toMatchObject({ in: 0.4, out: 1.4 })
    } else if (kind === 'other-field') {
      expect(await f.saved()).toMatchObject({ in: 0.4, out: 1.4 })
    } else {
      expect(await f.saved()).toMatchObject(
        kind === 'cross-in' ? { in: 0, out: 0.2 } : { in: 1, out: 1.8 },
      )
      await expect(f.editor.getByRole('alert')).toContainText(
        kind === 'cross-in' ? '入点需要早于出点' : '出点需要晚于入点',
      )
    }
  })
}

for (const keepDraft of [false, true]) {
  test(`镜头字幕协作更新不被旧草稿覆盖，可${keepDraft ? '保留当前字幕' : '使用最新字幕'}`, async ({
    page,
    context,
  }) => {
    const f = await fixture(page, true)
    const input = f.editor.getByRole('textbox', { name: '字幕', exact: true })
    const peerContext = await context.browser()!.newContext()
    try {
      const peer = await peerContext.newPage()
      await peer.goto(page.url())
      await waitEngine(peer)
      await expect
        .poll(() => peer.evaluate((id) => !!window.__plein.engine.doc.get(id), f.id))
        .toBe(true)
      await clickElement(peer, f.id)
      const at = await centerOf(peer, f.id)
      await peer.mouse.dblclick(at.x, at.y)
      const other = peer
        .getByRole('dialog', { name: '序列', exact: true })
        .getByRole('textbox', { name: '字幕', exact: true })
      await input.fill('本机未保存字幕')
      for (const key of ['Enter', 'Escape']) {
        await input.dispatchEvent('keydown', { key, isComposing: true })
        await expect(input).toBeFocused()
        await expect(f.editor).toBeVisible()
        expect((await f.saved()).subtitle).toBe('初始字幕')
      }
      await other.fill('同伴更新的字幕')
      await other.press('Enter')
      await expect.poll(async () => (await f.saved()).subtitle).toBe('同伴更新的字幕')
      await input.press('Tab')
      expect((await f.saved()).subtitle).toBe('同伴更新的字幕')
      await expect(input).toHaveValue('本机未保存字幕')
      await expect(f.editor.getByRole('status')).toContainText('字幕已更新')
      if (!keepDraft) {
        await f.editor.getByRole('status').scrollIntoViewIfNeeded()
        await f.editor
          .locator('.seq-inspector')
          .screenshot({ path: test.info().outputPath('clip-subtitle-conflict.png') })
      }
      await f.editor
        .getByRole('button', { name: keepDraft ? '保留当前字幕' : '使用最新字幕', exact: true })
        .click()
      const expected = keepDraft ? '本机未保存字幕' : '同伴更新的字幕'
      await expect(input).toHaveValue(expected)
      await expect(input).toBeFocused()
      expect((await f.saved()).subtitle).toBe(expected)
      await expect(f.editor.getByRole('status')).toHaveCount(0)
    } finally {
      await peerContext.close()
    }
  })
}

test('镜头字幕在同任务更新后失焦仍保留最新值，明确覆盖不丢其他剪辑字段', async ({ page }) => {
  const f = await fixture(page, true)
  const input = f.editor.getByRole('textbox', { name: '字幕', exact: true })
  await input.fill('本机字幕草稿')
  await input.evaluate((input: HTMLInputElement, id) => {
    const doc = window.__plein.engine.doc
    const clips = doc.get(id)!.params!.clips as Array<Record<string, unknown>>
    const params = doc.mutable(id)!.get('params') as { set(key: string, value: unknown): void }
    params.set(
      'clips',
      clips.map((clip) => ({ ...clip, subtitle: '刚更新的字幕', out: 1.4 })),
    )
    input.blur()
  }, f.id)
  expect(await f.saved()).toMatchObject({ subtitle: '刚更新的字幕', out: 1.4 })
  await expect(input).toHaveValue('本机字幕草稿')
  await f.editor.getByRole('button', { name: '保留当前字幕', exact: true }).click()
  expect(await f.saved()).toMatchObject({ subtitle: '本机字幕草稿', out: 1.4 })
})

test('镜头字幕正常提交可撤销重做，主动清空恢复自动台词并保持到重开', async ({ page }) => {
  const f = await fixture(page, true)
  const input = f.editor.getByRole('textbox', { name: '字幕', exact: true })
  await page.evaluate(() =>
    (
      window.__plein.engine.doc as unknown as { undo: { stopCapturing(): void } }
    ).undo.stopCapturing(),
  )
  await input.fill('手改字幕')
  await input.press('Enter')
  expect((await f.saved()).subtitle).toBe('手改字幕')
  await f.editor.getByRole('button', { name: '关闭', exact: true }).focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(input).toHaveValue('初始字幕')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(input).toHaveValue('手改字幕')
  await input.fill('  ')
  await input.press('Enter')
  expect((await f.saved()).subtitle).toBeUndefined()
  await expect(input).toHaveValue('')
  await f.editor.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(f.editor).toHaveCount(0)
  await clickElement(page, f.id)
  const at = await centerOf(page, f.id)
  await page.mouse.dblclick(at.x, at.y)
  await expect(input).toHaveValue('')
})

for (const mode of ['rendered', 'same-frame'] as const) {
  for (const field of ['in', 'out'] as const) {
    test(`镜头素材变更 ${mode} 不把旧 ${field} 草稿写入新素材`, async ({ page }) => {
      const f = await fixture(page)
      const file = join(dir, `short-${mode}-${field}.webm`)
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=96x64:d=0.2:r=10',
        '-c:v',
        'libvpx-vp9',
        '-deadline',
        'realtime',
        file,
      ])
      const uploaded = await page.request.post('/api/assets', {
        headers: { 'content-type': 'video/webm', 'x-file-name': 'short.webm' },
        data: readFileSync(file),
      })
      expect(uploaded.status()).toBe(201)
      const replacement = (await uploaded.json()).id as string
      const input =
        field === 'in'
          ? f.input
          : f.editor.getByRole('spinbutton', { name: '出点（秒）', exact: true })
      await input.fill(field === 'in' ? '0.4' : '0.5')
      await input.evaluate(
        (input: HTMLInputElement, { source, replacement, mode }) => {
          const doc = window.__plein.engine
            .doc as unknown as import('../packages/doc/src/doc').PleinDoc
          doc.undo.stopCapturing()
          doc.ydoc.transact(() => doc.mutable(source)!.set('assetId', replacement), doc.origin)
          if (mode === 'same-frame') input.blur()
        },
        { source: f.source, replacement, mode },
      )
      await expect(f.editor.locator('.ui-chip').first()).toContainText('0.2 秒')
      if (mode === 'rendered') await input.blur()
      expect((await f.saved()).in).toBe(0)
      await expect(f.input).toHaveValue('0')
      expect((await f.saved()).out).toBe(1.8)
      await f.editor.getByRole('button', { name: '重新加载预览', exact: true }).focus()
      await page.keyboard.press('ControlOrMeta+z')
      await expect(f.editor.locator('.ui-chip').first()).toContainText('1.8 秒')
      await expect(f.input).toHaveValue('0')
      await page.keyboard.press('ControlOrMeta+Shift+z')
      await expect(f.editor.locator('.ui-chip').first()).toContainText('0.2 秒')
      await expect(f.input).toHaveValue('0')
      // 已保存出点超过新素材结尾时，仍不能把入点设到有效结尾。
      await f.input.fill('0.2')
      await f.input.blur()
      expect((await f.saved()).in).toBe(0)
      const error = f.editor.getByRole('alert').filter({ hasText: '入点需要早于出点和素材结尾' })
      await expect(error).toBeVisible()
      if (mode === 'rendered' && field === 'in') {
        await page.setViewportSize({ width: 390, height: 700 })
        await error.scrollIntoViewIfNeeded()
        expect(await error.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
        await f.editor.screenshot({ path: test.info().outputPath('trim-end-error-390.png') })
        await page.setViewportSize({ width: 1440, height: 900 })
      }
      await f.editor.getByRole('button', { name: '导出 MP4', exact: true }).click()
      const exported = f.editor.getByLabel('实际导出 MP4', { exact: true })
      await expect(exported).toBeVisible({ timeout: 60_000 })
      await expect
        .poll(() => exported.evaluate((v: HTMLVideoElement) => Number.isFinite(v.duration)))
        .toBe(true)
      const duration = await exported.evaluate((v: HTMLVideoElement) => v.duration)
      expect(duration).toBeGreaterThanOrEqual(0.2)
      expect(duration).toBeLessThan(0.3)
    })
  }
}

test('更换镜头素材不清除未提交字幕，提交后可重新打开', async ({ page }) => {
  const f = await fixture(page, true)
  const input = f.editor.getByRole('textbox', { name: '字幕', exact: true })
  await input.fill('仍在编辑的字幕')
  const file = join(dir, 'short-subtitle.webm')
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=96x64:d=0.2:r=10',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    file,
  ])
  const uploaded = await page.request.post('/api/assets', {
    headers: { 'content-type': 'video/webm', 'x-file-name': 'short-subtitle.webm' },
    data: readFileSync(file),
  })
  expect(uploaded.status()).toBe(201)
  const replacement = (await uploaded.json()).id as string
  await page.evaluate(
    ({ source, replacement }) => {
      const doc = window.__plein.engine.doc as unknown as import('../packages/doc/src/doc').PleinDoc
      doc.ydoc.transact(() => doc.mutable(source)!.set('assetId', replacement), doc.origin)
    },
    { source: f.source, replacement },
  )
  await expect(f.editor.locator('.ui-chip').first()).toContainText('0.2 秒')
  await expect(input).toHaveValue('仍在编辑的字幕')
  expect((await f.saved()).subtitle).toBe('初始字幕')
  await input.blur()
  expect(await f.saved()).toMatchObject({ in: 0, out: 1.8, subtitle: '仍在编辑的字幕' })
  await f.editor.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(f.editor).toBeHidden()
  await clickElement(page, f.id)
  const at = await centerOf(page, f.id)
  await page.mouse.dblclick(at.x, at.y)
  await expect(input).toHaveValue('仍在编辑的字幕')
})
