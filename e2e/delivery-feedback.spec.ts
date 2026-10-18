import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import type { DeliveryRecord } from '../packages/doc/src/delivery'
import { centerOf, newProject, zoomTo } from './canvas'

let dir = ''

test('实际 MP4 加载失败可连续重试，恢复播放保留版本草稿和交付记录', async ({ page }) => {
  let fail = true
  let requests = 0
  const f = await fixture(page, async (assets) => {
    await page.route(`**/api/assets/${assets[0]}`, (route) => {
      requests++
      return fail ? route.fulfill({ status: 503, body: 'unavailable' }) : route.continue()
    })
  })
  const original = await f.read()
  await f.field.fill('加载恢复后继续检查')
  const alert = f.panel.getByRole('alert').filter({ hasText: '实际 MP4 加载失败' })
  await expect(alert).toBeVisible()
  const retry = alert.getByRole('button', { name: '重新加载实际 MP4', exact: true })
  const firstRequests = requests
  await retry.focus()
  await retry.press('Space')
  await expect.poll(() => requests).toBeGreaterThan(firstRequests)
  await expect(alert).toBeVisible()
  await f.editor.screenshot({ path: test.info().outputPath('delivery-video-failed.png') })
  fail = false
  await retry.click()
  await expect(alert).toHaveCount(0)
  await expect
    .poll(() => f.video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2)
  await f.video.evaluate(async (v: HTMLVideoElement) => {
    await v.play()
  })
  await expect
    .poll(() => f.video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(0)
  await f.video.evaluate((v: HTMLVideoElement) => v.pause())
  await expect(f.field).toHaveValue('加载恢复后继续检查')
  await expect(f.versions).toHaveValue('r1')
  expect(await f.read()).toEqual(original)
})

test('失败版本切换到可播放版本后清理错误，返回仍可重试且分版保留草稿', async ({ page }) => {
  const f = await fixture(page, async (assets) => {
    await page.route(`**/api/assets/${assets[0]}`, (route) =>
      route.fulfill({ status: 503, body: 'unavailable' }),
    )
  })
  const original = await f.read()
  await page.setViewportSize({ width: 390, height: 700 })
  await expect(f.panel.getByRole('alert')).toContainText('实际 MP4 加载失败')
  await expect(
    f.panel.getByRole('button', { name: '重新加载实际 MP4', exact: true }),
  ).toBeInViewport()
  await f.editor.screenshot({ path: test.info().outputPath('delivery-video-narrow-failed.png') })
  await f.field.fill('失败版草稿')
  await f.versions.selectOption('r2')
  await expect(f.panel.getByRole('alert')).toHaveCount(0)
  await expect
    .poll(() => f.video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2)
  await f.video.evaluate(async (v: HTMLVideoElement) => {
    await v.play()
  })
  await expect
    .poll(() => f.video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(0)
  await f.field.fill('可播放版草稿')
  await f.versions.selectOption('r1')
  await expect(f.panel.getByRole('alert')).toContainText('实际 MP4 加载失败')
  await expect(f.field).toHaveValue('失败版草稿')
  await f.versions.selectOption('r2')
  await expect(f.field).toHaveValue('可播放版草稿')
  await expect(f.panel.getByRole('alert')).toHaveCount(0)
  expect(await f.read()).toEqual(original)
})

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-delivery-feedback-'))
  for (const [name, color, duration] of [
    ['old', 'blue', '2'],
    ['new', 'green', '4'],
  ])
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=160x90:d=${duration}:r=10`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      join(dir, `${name}.mp4`),
    ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('交付新增意见可从按钮独立撤销重做，不撤回紧邻的改名或丢失草稿', async ({ page }) => {
  const f = await fixture(page)
  const before = await f.read()
  await f.field.fill('新增意见的撤销边界')
  await f.add.evaluate((button, id) => {
    const { doc } = window.__plein.engine as typeof window.__plein.engine & {
      doc: { origin: unknown; ydoc: { transact(fn: () => void, origin: unknown): void } }
    }
    doc.ydoc.transact(() => {
      ;(doc.mutable(id)! as unknown as { set(key: string, value: unknown): void }).set(
        'name',
        '保留的交付改名',
      )
    }, doc.origin)
    ;(button as HTMLButtonElement).click()
  }, f.ids.id)
  await expect.poll(async () => (await f.read())[1]!.notes.length).toBe(3)
  const added = await f.read()
  await f.field.fill('撤销期间保留的草稿')
  const versionDownload = f.panel.getByRole('button', { name: '下载此版 MP4', exact: true })
  await versionDownload.focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(f.read).toEqual(before)
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)!.name, f.ids.id)).toBe(
    '保留的交付改名',
  )
  await expect(f.field).toHaveValue('撤销期间保留的草稿')
  await f.editor.getByRole('button', { name: '剪辑预览', exact: true }).click()
  await f.editor.getByRole('button', { name: '剪辑预览', exact: true }).focus()
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(f.read).toEqual(added)
  await f.editor.getByRole('button', { name: '实际 MP4 回看 / 交付', exact: true }).click()
  await f.versions.selectOption('r1')
  await expect(f.panel.getByText('新增意见的撤销边界', { exact: true })).toBeVisible()
})

test('已解决复选框和删除按钮聚焦时撤销重做对应意见操作', async ({ page }) => {
  const f = await fixture(page)
  const before = await f.read()
  const resolved = f.panel.getByRole('checkbox', { name: '已解决', exact: true }).first()
  await resolved.check()
  const checked = await f.read()
  await resolved.focus()
  await page.keyboard.press('Control+z')
  await expect.poll(f.read).toEqual(before)
  await expect(resolved).not.toBeChecked()
  await page.keyboard.press('Control+y')
  await expect.poll(f.read).toEqual(checked)
  await expect(resolved).toBeChecked()
  await f.panel.getByRole('button', { name: '删除', exact: true }).first().click()
  await expect.poll(async () => (await f.read())[1]!.notes.length).toBe(1)
  const removed = await f.read()
  await f.panel.getByRole('button', { name: '删除', exact: true }).first().focus()
  await page.keyboard.press('Meta+z')
  await expect.poll(f.read).toEqual(checked)
  await page.keyboard.press('Meta+Shift+z')
  await expect.poll(f.read).toEqual(removed)
})

test('交付确认撤销重做遵循实际操作顺序，切换版本不把确认写到当前版', async ({ page }) => {
  const f = await fixture(page)
  for (const box of await f.panel.getByRole('checkbox', { name: '已解决', exact: true }).all())
    await box.check()
  const unconfirmed = await f.read()
  await f.panel.getByRole('button', { name: '确认此版本可交付', exact: true }).click()
  const firstConfirmed = await f.read()
  await f.versions.selectOption('r2')
  await f.panel.getByRole('button', { name: '确认此版本可交付', exact: true }).click()
  const bothConfirmed = await f.read()
  await f.field.fill('当前新版的未提交意见')
  await f.panel.getByRole('button', { name: '撤回此版确认', exact: true }).focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(f.read).toEqual(firstConfirmed)
  await expect(f.panel.getByText('待人工确认', { exact: false })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(f.read).toEqual(unconfirmed)
  await expect(f.versions).toHaveValue('r2')
  await expect(f.video).toHaveAttribute('src', `/api/assets/${f.assets[1]}`)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(f.read).toEqual(firstConfirmed)
  await page.keyboard.press('Control+y')
  await expect.poll(f.read).toEqual(bothConfirmed)
  await expect(f.panel.getByText('已人工确认此版本', { exact: false })).toBeVisible()
  await expect(f.field).toHaveValue('当前新版的未提交意见')
})

test('草稿保留原生撤销，实时只读阻止按钮撤销且恢复后可继续', async ({ page }) => {
  const f = await fixture(page)
  const before = await f.read()
  await f.field.fill('用于只读检查的已保存意见')
  await f.add.click()
  const saved = await f.read()
  await f.field.fill('草稿')
  await f.field.press('End')
  await f.field.pressSequentially('B')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(f.field).toHaveValue('草稿')
  expect(await f.read()).toEqual(saved)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(f.field).toHaveValue('草稿B')
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await f.add.focus()
  await page.evaluate(() => {
    ;(
      window.__plein.engine.doc as typeof window.__plein.engine.doc & { readOnly: boolean }
    ).readOnly = true
  })
  await page.keyboard.press('ControlOrMeta+z')
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  expect(await f.read()).toEqual(saved)
  await expect(f.field).toHaveValue('草稿B')
  await page.evaluate(() => {
    ;(
      window.__plein.engine.doc as typeof window.__plein.engine.doc & { readOnly: boolean }
    ).readOnly = false
  })
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(f.read).toEqual(before)
  await expect(f.field).toHaveValue('草稿B')
  expect(errors).toEqual([])
})

async function fixture(page: Page, beforeOpen?: (assets: string[]) => Promise<void>) {
  await newProject(page)
  const assets: string[] = []
  for (const name of ['old', 'new']) {
    const response = await page.request.post('/api/assets', {
      headers: { 'content-type': 'video/mp4', 'x-file-name': `${name}.mp4` },
      data: readFileSync(join(dir, `${name}.mp4`)),
    })
    expect(response.status()).toBe(201)
    assets.push((await response.json()).id)
  }
  const ids = await page.evaluate((assets) => {
    const boards = [1, 2].map((n) =>
      window.__plein.addNode({
        type: 'plein/storyboard',
        name: `交付来源${n}`,
        x: n * 500,
        y: 0,
        params: { shots: [{ id: `shot-${n}`, no: n, duration: n * 2 }] },
      }),
    )
    const id = window.__plein.addNode({
      type: 'plein/sequence',
      name: '交付反馈测试',
      x: 300,
      y: 700,
      params: {},
    })
    const records: DeliveryRecord[] = [2, 1].map((n) => ({
      id: `r${n}`,
      resultId: `result-${n}`,
      runId: `run-${n}`,
      assetId: assets[n - 1]!,
      kind: 'film',
      version: `v${n}`,
      createdAt: n * 1000,
      width: 160,
      height: 90,
      duration: n * 2,
      sources: [{ source: boards[n - 1]!, shotId: `shot-${n}`, start: 0, end: n * 2 }],
      notes:
        n === 1
          ? [
              {
                id: 'first',
                time: 0.5,
                text: '第一条原始意见',
                resolved: false,
                source: boards[0],
                shotId: 'shot-1',
              },
              {
                id: 'second',
                time: 1,
                text: '第二条原始意见',
                resolved: false,
                source: boards[0],
                shotId: 'shot-1',
              },
            ]
          : [],
    }))
    ;(
      window.__plein.engine.doc.mutable(id)! as unknown as {
        set(key: string, value: unknown): void
      }
    ).set('deliveries', records)
    return { id, boards }
  }, assets)
  await beforeOpen?.(assets)
  await zoomTo(page, [ids.id])
  const at = await centerOf(page, ids.id)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  await editor.getByRole('button', { name: '实际 MP4 回看 / 交付', exact: true }).click()
  const panel = editor.locator('[aria-label="成片回看与交付"]')
  const versions = panel.getByRole('combobox', { name: '交付版本', exact: true })
  await versions.selectOption('r1')
  const video = panel.getByLabel('实际导出 MP4', { exact: true })
  if (!beforeOpen)
    await expect
      .poll(() =>
        video.evaluate(
          (el: HTMLVideoElement) => el.readyState >= 2 && Number.isFinite(el.duration),
        ),
      )
      .toBe(true)
  const field = panel.getByRole('textbox', { name: '成片时间码意见', exact: true })
  const add = panel.getByRole('button', { name: '在当前时间添加意见', exact: true })
  const read = () =>
    page.evaluate((id) => window.__plein.engine.doc.get(id)!.deliveries as DeliveryRecord[], ids.id)
  return { ids, assets, editor, panel, versions, video, field, add, read }
}

test('新导出到达时保留正在回看的旧版本与意见草稿，添加仍绑定旧版时间码', async ({ page }) => {
  const f = await fixture(page)
  await f.field.fill('正在审阅旧版的意见')
  await f.video.evaluate((video: HTMLVideoElement) => {
    video.currentTime = 0.75
  })
  await page.evaluate((id) => {
    const { doc } = window.__plein.engine
    const records = doc.get(id)!.deliveries as DeliveryRecord[]
    ;(doc.mutable(id)! as unknown as { set(key: string, value: unknown): void }).set('deliveries', [
      { ...records[0]!, id: 'r3', resultId: 'result-3', version: 'v3', createdAt: 3000, notes: [] },
      ...records,
    ])
  }, f.ids.id)
  await expect(f.versions.getByRole('option', { name: /^v3/ })).toHaveCount(1)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(f.versions).toHaveValue('r1')
  await expect(f.field).toHaveValue('正在审阅旧版的意见')
  await expect(f.video).toHaveAttribute('src', new RegExp(f.assets[0]!))
  await f.add.click()
  const records = await f.read()
  expect(records.find((r) => r.id === 'r1')!.notes.at(-1)).toMatchObject({
    text: '正在审阅旧版的意见',
    time: 0.75,
    source: f.ids.boards[0],
    shotId: 'shot-1',
  })
  expect(records.find((r) => r.id === 'r3')!.notes).toEqual([])
})

test('不同交付版本的未提交草稿互不覆盖，保存一版不清除另一版草稿', async ({ page }) => {
  const f = await fixture(page)
  await f.field.fill('旧版草稿')
  await f.versions.selectOption('r2')
  await f.field.fill('新版草稿')
  await f.versions.selectOption('r1')
  await expect(f.field).toHaveValue('旧版草稿')
  await f.add.click()
  await expect(f.field).toHaveValue('')
  await f.versions.selectOption('r2')
  await expect(f.field).toHaveValue('新版草稿')
  expect((await f.read()).find((r) => r.id === 'r2')!.notes).toEqual([])
})

for (const action of ['add', 'resolve', 'delete'] as const) {
  test(`同帧 ${action} 意见合并最新列表，保留同伴新增与其他意见修改`, async ({ page }) => {
    const f = await fixture(page)
    await f.field.fill('本地新增意见')
    const button =
      action === 'add'
        ? f.add
        : action === 'resolve'
          ? f.panel.getByRole('checkbox', { name: '已解决', exact: true }).first()
          : f.panel.getByRole('button', { name: '删除', exact: true }).first()
    await button.evaluate((button, id) => {
      const { doc } = window.__plein.engine
      const records = doc.get(id)!.deliveries as DeliveryRecord[]
      ;(doc.mutable(id)! as unknown as { set(key: string, value: unknown): void }).set(
        'deliveries',
        records.map((r) =>
          r.id === 'r1'
            ? {
                ...r,
                notes: [
                  ...r.notes.map((note) =>
                    note.id === 'second' ? { ...note, text: '同伴修改的第二条' } : note,
                  ),
                  { id: 'remote', time: 1.5, text: '同伴新增意见', resolved: false },
                ],
              }
            : r,
        ),
      )
      ;(button as HTMLElement).click()
    }, f.ids.id)
    const notes = (await f.read()).find((r) => r.id === 'r1')!.notes
    expect(notes.find((note) => note.id === 'remote')?.text).toBe('同伴新增意见')
    expect(notes.find((note) => note.id === 'second')?.text).toBe('同伴修改的第二条')
    if (action === 'add') expect(notes.at(-1)?.text).toBe('本地新增意见')
    else if (action === 'resolve')
      expect(notes.find((note) => note.id === 'first')?.resolved).toBe(true)
    else expect(notes.some((note) => note.id === 'first')).toBe(false)
  })
}

test('同帧修改目标意见后不盲目标记解决，核对更新内容后可重试', async ({ page }) => {
  const f = await fixture(page)
  const before = await f.panel
    .getByRole('checkbox', { name: '已解决', exact: true })
    .first()
    .evaluate((checkbox, id) => {
      const { doc } = window.__plein.engine
      const records = (doc.get(id)!.deliveries as DeliveryRecord[]).map((r) =>
        r.id === 'r1'
          ? {
              ...r,
              notes: r.notes.map((note) =>
                note.id === 'first' ? { ...note, text: '目标意见刚被改写' } : note,
              ),
            }
          : r,
      )
      ;(doc.mutable(id)! as unknown as { set(key: string, value: unknown): void }).set(
        'deliveries',
        records,
      )
      ;(checkbox as HTMLInputElement).click()
      return records
    }, f.ids.id)
  expect(await f.read()).toEqual(before)
  await expect(f.panel.getByRole('alert')).toContainText('意见已变化')
  await f.panel.getByRole('checkbox', { name: '已解决', exact: true }).first().check()
  expect((await f.read()).find((r) => r.id === 'r1')!.notes[0]).toMatchObject({
    text: '目标意见刚被改写',
    resolved: true,
  })
})

test('交付操作变为只读后保留草稿并说明原因，恢复后可保存', async ({ page }) => {
  const f = await fixture(page)
  await f.field.fill('只读拒绝后保留的草稿')
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await f.add.evaluate((button) => {
    ;(
      window.__plein.engine.doc as typeof window.__plein.engine.doc & { readOnly: boolean }
    ).readOnly = true
    ;(button as HTMLButtonElement).click()
  })
  expect(errors).toEqual([])
  await expect(f.panel.getByRole('alert')).toContainText('只读')
  await expect(f.field).toHaveValue('只读拒绝后保留的草稿')
  await page.evaluate((id) => {
    ;(
      window.__plein.engine.doc as typeof window.__plein.engine.doc & { readOnly: boolean }
    ).readOnly = false
    ;(
      window.__plein.engine.doc.mutable(id)! as unknown as {
        set(key: string, value: unknown): void
      }
    ).set('name', '恢复写入的交付')
  }, f.ids.id)
  await f.add.click()
  expect((await f.read()).find((r) => r.id === 'r1')!.notes.at(-1)?.text).toBe(
    '只读拒绝后保留的草稿',
  )
})

test('同 ID 导出内容替换时拒绝旧添加并保留草稿，新画面就绪后按新来源保存', async ({ page }) => {
  const f = await fixture(page)
  await f.field.fill('核对新版内容后保存')
  const before = await f.add.evaluate((button, id) => {
    const { doc } = window.__plein.engine
    const records = doc.get(id)!.deliveries as DeliveryRecord[]
    const next = records.map((r) =>
      r.id === 'r1'
        ? { ...r, assetId: records[0]!.assetId, duration: 4, sources: records[0]!.sources }
        : r,
    )
    ;(doc.mutable(id)! as unknown as { set(key: string, value: unknown): void }).set(
      'deliveries',
      next,
    )
    ;(button as HTMLButtonElement).click()
    return next
  }, f.ids.id)
  expect(await f.read()).toEqual(before)
  await expect(f.panel.getByRole('alert')).toContainText('版本内容已变化')
  await expect(f.field).toHaveValue('核对新版内容后保存')
  await expect(f.video).toHaveAttribute('src', new RegExp(f.assets[1]!))
  await expect
    .poll(() => f.video.evaluate((video: HTMLVideoElement) => video.readyState >= 2))
    .toBe(true)
  await f.add.click()
  expect((await f.read()).find((r) => r.id === 'r1')!.notes.at(-1)).toMatchObject({
    text: '核对新版内容后保存',
    source: f.ids.boards[1],
    shotId: 'shot-2',
  })
})

test('窄窗口实际 MP4 与版本意见均可查看和操作', async ({ page }) => {
  const f = await fixture(page)
  await page.setViewportSize({ width: 390, height: 700 })
  await expect.poll(async () => (await f.video.boundingBox())?.width ?? 0).toBeGreaterThan(240)
  await f.video.evaluate(async (video: HTMLVideoElement) => {
    await video.play()
    await new Promise<void>((resolve) => video.requestVideoFrameCallback(() => resolve()))
    video.pause()
  })
  await f.editor.screenshot({
    path: test.info().outputPath('delivery-narrow-video.png'),
    animations: 'disabled',
  })
  await f.field.scrollIntoViewIfNeeded()
  const text = '窄窗口意见 https://example.com/' + 'a'.repeat(200)
  await f.field.fill(text)
  await f.add.click()
  const note = f.panel.getByText(text, { exact: true })
  await note.scrollIntoViewIfNeeded()
  await expect(note).toBeInViewport()
  await expect(f.editor.getByRole('button', { name: '关闭', exact: true })).toBeInViewport()
  expect(await f.panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await f.editor.screenshot({
    path: test.info().outputPath('delivery-narrow-feedback.png'),
    animations: 'disabled',
  })
})

test('时间码跳转和来源删除提示可恢复，定位返工打开正确历史来源', async ({ page }) => {
  const f = await fixture(page)
  await f.panel.getByRole('button', { name: '00:00.5', exact: true }).click()
  await expect
    .poll(() => f.video.evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBe(0.5)
  await page.evaluate((id) => {
    const engine = window.__plein.engine as typeof window.__plein.engine & {
      deleteSelection(): void
      doc: { undo: { stopCapturing(): void } }
    }
    engine.doc.undo.stopCapturing()
    engine.selection.set([id])
    engine.deleteSelection()
    engine.doc.undo.stopCapturing()
  }, f.ids.boards[0]!)
  await f.panel.getByRole('button', { name: '定位镜头返工', exact: true }).first().click()
  await expect(f.panel.getByRole('alert')).toContainText('已不在画布')
  await page.evaluate(() =>
    (window.__plein.engine as typeof window.__plein.engine & { undo(): void }).undo(),
  )
  await f.panel.getByRole('button', { name: '定位镜头返工', exact: true }).first().click()
  await expect(
    page
      .getByRole('dialog', { name: '分镜表', exact: true })
      .getByRole('heading', { name: '交付来源1', exact: true }),
  ).toBeVisible()
})

test('切换剪辑再回看保留版本、草稿和时间码，离开的实际视频立即暂停', async ({ page }) => {
  const f = await fixture(page)
  await f.field.fill('对照剪辑后继续记录旧版意见')
  await f.video.evaluate(async (video: HTMLVideoElement) => {
    ;(
      window as typeof window & { previousDeliveryVideo?: HTMLVideoElement }
    ).previousDeliveryVideo = video
    video.currentTime = 0.5
    await video.play()
  })
  await f.editor.getByRole('button', { name: '剪辑预览', exact: true }).click()
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { previousDeliveryVideo?: HTMLVideoElement })
          .previousDeliveryVideo!.paused,
    ),
  ).toBe(true)
  const stoppedAt = await page.evaluate(
    () =>
      (window as typeof window & { previousDeliveryVideo?: HTMLVideoElement })
        .previousDeliveryVideo!.currentTime,
  )
  await f.editor.getByRole('button', { name: '实际 MP4 回看 / 交付', exact: true }).click()
  await expect(f.versions).toHaveValue('r1')
  await expect(f.field).toHaveValue('对照剪辑后继续记录旧版意见')
  await expect
    .poll(() => f.video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2)
  await expect
    .poll(async () =>
      Math.abs((await f.video.evaluate((v: HTMLVideoElement) => v.currentTime)) - stoppedAt),
    )
    .toBeLessThan(0.1)
  expect(await f.video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
  await f.add.click()
  const note = (await f.read())[1]!.notes.at(-1)!
  expect(note.text).toBe('对照剪辑后继续记录旧版意见')
  expect(note.time).toBeCloseTo(stoppedAt, 1)
  expect(note.source).toBe(f.ids.boards[0])
})

test('分版草稿和播放位置跨剪辑视图保留，重复切换不串版', async ({ page }) => {
  const f = await fixture(page)
  const original = await f.read()
  await f.field.fill('旧版待补充')
  await f.video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 0.5
  })
  await f.versions.selectOption('r2')
  await expect
    .poll(() => f.video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2)
  await f.field.fill('新版待补充')
  await f.video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 2
  })
  for (let i = 0; i < 2; i++) {
    await f.editor.getByRole('button', { name: '剪辑预览', exact: true }).click()
    await f.editor.getByRole('button', { name: '实际 MP4 回看 / 交付', exact: true }).click()
    await expect(f.versions).toHaveValue('r2')
    await expect(f.field).toHaveValue('新版待补充')
    await expect
      .poll(() => f.video.evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeCloseTo(2, 1)
    await f.versions.selectOption('r1')
    await expect(f.field).toHaveValue('旧版待补充')
    await expect
      .poll(() => f.video.evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeCloseTo(0.5, 1)
    await f.versions.selectOption('r2')
  }
  expect(await f.read()).toEqual(original)
})

test('编辑期间全部交付版本移除后显示空态，原版本恢复仍保留本次草稿', async ({ page }) => {
  const f = await fixture(page)
  const original = await f.read()
  await f.field.fill('暂时移除的历史版草稿')
  await f.editor.getByRole('button', { name: '剪辑预览', exact: true }).click()
  await page.evaluate((id) => {
    ;(
      window.__plein.engine.doc.mutable(id)! as unknown as {
        set(key: string, value: unknown): void
      }
    ).set('deliveries', [])
  }, f.ids.id)
  await f.editor.getByRole('button', { name: '实际 MP4 回看 / 交付', exact: true }).click()
  await expect(
    f.editor.getByText('导出成功后，这里回看实际 MP4 并记录交付意见。', { exact: true }),
  ).toBeVisible()
  await page.evaluate(
    ({ id, records }) => {
      ;(
        window.__plein.engine.doc.mutable(id)! as unknown as {
          set(key: string, value: unknown): void
        }
      ).set('deliveries', records)
    },
    { id: f.ids.id, records: original },
  )
  await expect(f.versions).toHaveValue('r1')
  await expect(f.field).toHaveValue('暂时移除的历史版草稿')
  expect(await f.read()).toEqual(original)
})

test('离开回看期间同 ID 视频内容替换时保留草稿并提示核对，不沿用旧播放位置', async ({ page }) => {
  const f = await fixture(page)
  await f.field.fill('需要核对旧视频的草稿')
  await f.video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 0.75
  })
  await f.editor.getByRole('button', { name: '剪辑预览', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 700 })
  await page.evaluate((id) => {
    const { doc } = window.__plein.engine
    const records = doc.get(id)!.deliveries!
    ;(doc.mutable(id)! as unknown as { set(key: string, value: unknown): void }).set(
      'deliveries',
      records.map((r) =>
        r.id === 'r1'
          ? { ...r, assetId: records[0]!.assetId, duration: 4, sources: records[0]!.sources }
          : r,
      ),
    )
  }, f.ids.id)
  await f.editor.getByRole('button', { name: '实际 MP4 回看 / 交付', exact: true }).click()
  await expect(f.versions).toHaveValue('r1')
  await expect(f.field).toHaveValue('需要核对旧视频的草稿')
  await expect(f.panel.getByRole('alert')).toContainText('版本内容已变化')
  await expect(f.panel.getByRole('alert')).toBeInViewport()
  await f.editor.screenshot({ path: test.info().outputPath('delivery-replaced-session.png') })
  await expect(f.video).toHaveAttribute('src', `/api/assets/${f.assets[1]}`)
  await expect
    .poll(() => f.video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2)
  expect(await f.video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(0)
  expect(await f.video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
  await f.video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 1.25
  })
  await f.add.click()
  await expect(f.panel.getByRole('alert')).toHaveCount(0)
  const note = (await f.read())[1]!.notes.at(-1)!
  expect(note.time).toBeCloseTo(1.25, 1)
  expect(note.source).toBe(f.ids.boards[1])
})

test('关闭重开隔离旧草稿与位置，首次回看前新导出到达时打开最新版本', async ({ page }) => {
  const f = await fixture(page)
  await f.field.fill('仅属于上次窗口的草稿')
  await f.video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 0.75
  })
  await f.editor.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('.seq-editor')).toHaveCount(0)
  await zoomTo(page, [f.ids.id])
  const point = await centerOf(page, f.ids.id)
  await page.mouse.dblclick(point.x, point.y)
  await expect(f.editor.getByRole('button', { name: '剪辑预览', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.evaluate((id) => {
    const { doc } = window.__plein.engine
    const records = doc.get(id)!.deliveries!
    ;(doc.mutable(id)! as unknown as { set(key: string, value: unknown): void }).set('deliveries', [
      { ...records[0]!, id: 'r3', resultId: 'result-3', version: 'v3', createdAt: 3000, notes: [] },
      ...records,
    ])
  }, f.ids.id)
  await expect(f.versions.getByRole('option', { name: /^v3/ })).toHaveCount(1)
  await expect(f.versions).toHaveValue('r3')
  await expect(f.field).toHaveValue('')
  await f.versions.selectOption('r1')
  await expect(f.field).toHaveValue('')
  await expect
    .poll(() => f.video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2)
  expect(await f.video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(0)
})
