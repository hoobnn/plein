import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { edgesInto, elements, newProject, waitEngine, waitNode, zoomTo } from './canvas'

let dir = ''
const files = () => ['still.png', 'clip.mp4', 'voice.wav', 'notes.md'].map((f) => join(dir, f))

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-e2e-media-'))
  const ff = (...args: string[]) =>
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])
  ff('-f', 'lavfi', '-i', 'color=c=orange:s=64x48', '-frames:v', '1', join(dir, 'still.png'))
  ff('-f', 'lavfi', '-i', 'color=c=blue:s=64x48', '-frames:v', '1', join(dir, 'reference.png'))
  ff('-f', 'lavfi', '-i', 'testsrc=s=96x160:d=1:r=10', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4'))
  ff('-f', 'lavfi', '-i', 'sine=f=440:d=1', join(dir, 'voice.wav'))
  writeFileSync(join(dir, 'notes.md'), '# 角色小传\n\n林晚，二十岁。\n')
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('导入图片、视频、音频、Markdown，刷新后都还在', async ({ page }) => {
  await newProject(page)

  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传' }).click()
  await (await chooser).setFiles(files())

  const kinds = async () =>
    (await elements(page))
      .filter((e) => ['image', 'video', 'audio', 'markdown'].includes(e.kind))
      .map((e) => e.kind)
      .sort()
  await expect.poll(kinds).toEqual(['audio', 'image', 'markdown', 'video'])
  // 媒体都已入库：元素指向的资产能读到元信息
  const assetIds = await page.evaluate(() => {
    const { engine } = window.__plein
    return [...engine.doc.elements()].filter((e) => e.assetId).map((e) => e.assetId)
  })
  expect(assetIds).toHaveLength(3)
  for (const id of assetIds)
    expect((await page.request.get(`/api/assets/${id}/meta`)).ok()).toBe(true)

  await page.reload()
  await waitEngine(page)
  await expect.poll(kinds).toEqual(['audio', 'image', 'markdown', 'video'])
})

test('重复批量导入避让原有内容和前一批，一次撤销只移除本批文件', async ({ page }) => {
  await newProject(page)
  const blocker = await page.evaluate(() => {
    const e = window.__plein.engine as typeof window.__plein.engine & {
      camera: { viewRect: { x: number; y: number; w: number; h: number } }
    }
    const v = e.camera.viewRect
    return window.__plein.addNode({
      type: 'plein/text',
      name: '导入前的原有卡片',
      params: { text: '保留此内容' },
      x: v.x + v.w / 2,
      y: v.y + v.h / 2 - 100,
    })
  })
  const batches: string[][] = []
  for (let n = 0; n < 2; n++) {
    const before = new Set((await elements(page)).map((el) => el.id))
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传', exact: true }).click()
    await (await chooser).setFiles([join(dir, 'still.png'), join(dir, 'notes.md')])
    await expect.poll(async () => (await elements(page)).length).toBe(3 + n * 2)
    const added = (await elements(page)).filter((el) => !before.has(el.id)).map((el) => el.id)
    batches.push(added)
    const overlaps = await page.evaluate(() => {
      const e = window.__plein.engine
      const all = [...e.doc.elements()].map((el) => e.doc.worldRect(el.id))
      return all.some((a, i) =>
        all
          .slice(i + 1)
          .some((b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y),
      )
    })
    expect(overlaps, '导入文件不得遮住原有卡片或前一批导入').toBe(false)
  }
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  expect((await elements(page)).map((el) => el.id).sort()).toEqual([blocker, ...batches[0]!].sort())
  await page.getByRole('button', { name: '重做', exact: true }).click()
  expect((await elements(page)).map((el) => el.id).sort()).toEqual(
    [blocker, ...batches.flat()].sort(),
  )
})

test('导入落在分组内时保留父级，撤销不移除分组', async ({ page }) => {
  await newProject(page)
  const frame = await page.evaluate(() => {
    const e = window.__plein.engine as typeof window.__plein.engine & { paste(data: unknown): void }
    e.paste({
      plein: 1,
      elements: [
        {
          id: 'import-frame',
          kind: 'frame',
          name: '导入素材分组',
          parentId: null,
          x: 0,
          y: 0,
          w: 1600,
          h: 1000,
          rotation: 0,
          locked: false,
        },
      ],
      edges: [],
    })
    return [...e.doc.elements()].find((el) => el.kind === 'frame')!.id
  })
  await zoomTo(page, [frame])
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (await chooser).setFiles(join(dir, 'still.png'))
  await expect.poll(async () => (await elements(page)).length).toBe(2)
  const imported = (await elements(page)).find((el) => el.kind === 'image')!
  expect(imported.parentId).toBe(frame)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  expect((await elements(page)).map((el) => el.id)).toEqual([frame])
})

test('部分上传失败保留成功文件并提示原因，重新导入失败文件可恢复', async ({ page }) => {
  await newProject(page)
  let attempts = 0
  await page.route('**/api/assets', async (route) => {
    if (route.request().method() !== 'POST' || ++attempts > 1) return route.continue()
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: '上传暂不可用' }),
    })
  })
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (await chooser).setFiles([join(dir, 'still.png'), join(dir, 'notes.md')])
  await expect.poll(async () => (await elements(page)).map((el) => el.kind)).toEqual(['markdown'])
  await expect(page.getByRole('status')).toContainText('still.png（上传暂不可用）')
  const retry = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (await retry).setFiles(join(dir, 'still.png'))
  await expect
    .poll(async () => (await elements(page)).map((el) => el.kind).sort())
    .toEqual(['image', 'markdown'])
  expect(attempts).toBe(2)
})

test('连续粘贴普通文本避让已有内容，每次粘贴独立撤销', async ({ page }) => {
  await newProject(page)
  for (const text of ['第一段粘贴正文', '第二段粘贴正文']) {
    await page
      .locator('canvas')
      .first()
      .evaluate((canvas, text) => {
        const data = new DataTransfer()
        data.setData('text/plain', text)
        canvas.dispatchEvent(
          new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
        )
      }, text)
  }
  await expect.poll(async () => (await elements(page)).length).toBe(2)
  const content = () =>
    page.evaluate(() => [...window.__plein.engine.doc.elements()].map((el) => el.text))
  expect(await content()).toEqual(['第一段粘贴正文', '第二段粘贴正文'])
  expect(
    await page.evaluate(() => {
      const e = window.__plein.engine
      const [a, b] = [...e.doc.elements()].map((el) => e.doc.worldRect(el.id))
      return a!.x < b!.x + b!.w && a!.x + a!.w > b!.x && a!.y < b!.y + b!.h && a!.y + a!.h > b!.y
    }),
  ).toBe(false)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  expect(await content()).toEqual(['第一段粘贴正文'])
  await page.getByRole('button', { name: '重做', exact: true }).click()
  expect(await content()).toEqual(['第一段粘贴正文', '第二段粘贴正文'])
})

test('上传期间切换画布不会把迟到结果写入已关闭文档或清掉新画布进度', async ({ page }) => {
  await newProject(page)
  const oldDoc = await page.evaluateHandle(() => window.__plein.engine.doc)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const releases: Array<() => void> = []
  let completed = 0
  await page.route('**/api/assets', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const response = await route.fetch()
    await new Promise<void>((resolve) => releases.push(resolve))
    await route.fulfill({ response })
    completed++
  })
  const upload = async () => {
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传', exact: true }).click()
    await (await chooser).setFiles(join(dir, 'still.png'))
  }
  await upload()
  await expect.poll(() => releases.length).toBe(1)
  await page.getByRole('button', { name: '切换画布' }).click()
  await page.getByRole('button', { name: '新建画布' }).click()
  await page.getByRole('dialog').getByRole('textbox').fill('上传切换边界')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '切换画布' })).toHaveText('上传切换边界')
  await waitEngine(page)
  await upload()
  await expect.poll(() => releases.length).toBe(2)
  releases[0]!()
  await expect.poll(() => completed).toBe(1)
  await expect(page.getByRole('status')).toContainText('正在导入 0/1')
  expect(await oldDoc.evaluate((doc) => [...doc.elements()].length)).toBe(0)
  expect(await elements(page)).toEqual([])
  releases[1]!()
  await expect.poll(async () => (await elements(page)).length).toBe(1)
  expect(errors).toEqual([])
  await oldDoc.dispose()
})

test('并发导入合并进度，先失败的批次提示不会在另一批完成前过期', async ({ page }) => {
  await newProject(page)
  await page.clock.install()
  const releases: Array<() => void> = []
  await page.route('**/api/assets', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const index = releases.length
    await new Promise<void>((resolve) => releases.push(resolve))
    if (index === 0)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: '第一批上传失败' }),
      })
    else await route.continue()
  })
  for (let n = 0; n < 2; n++) {
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传', exact: true }).click()
    await (await chooser).setFiles(join(dir, 'still.png'))
    await expect.poll(() => releases.length).toBe(n + 1)
  }
  await expect(page.getByRole('status')).toContainText('正在导入 0/2')
  releases[0]!()
  await expect(page.getByRole('status')).toContainText('正在导入 1/2')
  await page.clock.fastForward(5000)
  await expect(page.getByRole('status')).toContainText('正在导入 1/2')
  releases[1]!()
  await expect.poll(async () => (await elements(page)).length).toBe(1)
  await expect(page.getByRole('status')).toContainText('第一批上传失败')
})

for (const first of ['reference', 'toolbar'] as const) {
  test(`参考图与工具栏同时上传，${first === 'reference' ? '参考图' : '工具栏'}先完成不清掉另一入口进度`, async ({
    page,
  }) => {
    await newProject(page)
    const target = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/character',
        name: '混合上传角色',
        params: {},
        x: 0,
        y: 0,
      }),
    )
    await page.getByRole('treeitem', { name: '混合上传角色 定位到画布', exact: true }).click()
    const releases: Array<() => void> = []
    await page.route('**/api/assets', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      const response = await route.fetch()
      await new Promise<void>((resolve) => releases.push(resolve))
      await route.fulfill({ response })
    })
    const reference = page.waitForEvent('filechooser')
    await page.getByTestId('generator').getByRole('button', { name: '参考图', exact: true }).click()
    await (await reference).setFiles(join(dir, 'reference.png'))
    await expect.poll(() => releases.length).toBe(1)
    const toolbar = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传', exact: true }).click()
    await (await toolbar).setFiles(join(dir, 'still.png'))
    await expect.poll(() => releases.length).toBe(2)
    await expect(page.getByRole('status')).toContainText('正在导入 0/2')
    releases[first === 'reference' ? 0 : 1]!()
    await expect(page.getByRole('status')).toContainText('正在导入 1/2')
    releases[first === 'reference' ? 1 : 0]!()
    await expect
      .poll(async () => (await elements(page)).filter((el) => el.kind === 'image').length)
      .toBe(2)
    await expect.poll(() => edgesInto(page, target)).toHaveLength(1)
    const id = (await edgesInto(page, target))[0]![0]
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, id!)).toBe(
      'reference.png',
    )
  })
}

test('生成历史重复放入避让已有内容，每批独立撤销且不重新生成', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '历史放置检查',
      params: { model: 'plein/mock:image', prompt: '海鸟' },
      x: 0,
      y: 0,
    }),
  )
  const canvas = decodeURIComponent(page.url().split('#/c/')[1]!)
  await expect
    .poll(async () =>
      (await page.request.get(`/api/canvases/${canvas}/nodes/${id}/input`)).status(),
    )
    .toBe(200)
  expect(
    (await page.request.post(`/api/canvases/${canvas}/nodes/${id}/run`, { data: {} })).status(),
  ).toBe(202)
  await waitNode(page, id)
  const blocker = await page.evaluate(() => {
    const e = window.__plein.engine as typeof window.__plein.engine & {
      camera: { viewRect: { x: number; y: number; w: number; h: number } }
    }
    const v = e.camera.viewRect
    return window.__plein.addNode({
      type: 'plein/text',
      name: '历史放置前的卡片',
      params: { text: '不能被历史素材覆盖或撤销' },
      x: v.x + v.w / 2 - 100,
      y: v.y + v.h / 2 - 100,
    })
  })
  let submitted = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/run')) submitted++
  })
  const imported: string[] = []
  for (let n = 0; n < 2; n++) {
    await page.getByRole('button', { name: '生成历史', exact: true }).click()
    const history = page.getByRole('dialog', { name: '生成历史', exact: true })
    await history.getByRole('checkbox').first().check()
    await history.getByRole('button', { name: '放到画布上', exact: true }).click()
    await expect(history).toBeHidden()
    await expect
      .poll(async () => (await elements(page)).filter((el) => el.kind === 'image').length)
      .toBe(n + 1)
    imported.push(
      (await elements(page)).find((el) => el.kind === 'image' && !imported.includes(el.id))!.id,
    )
    expect(
      await page.evaluate(() => {
        const e = window.__plein.engine
        const rects = [...e.doc.elements()].map((el) => e.doc.worldRect(el.id))
        return rects.some((a, i) =>
          rects
            .slice(i + 1)
            .some((b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y),
        )
      }),
    ).toBe(false)
  }
  await expect(page.getByRole('status')).toContainText('已放到画布上：1 个素材')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  expect((await elements(page)).map((el) => el.id).sort()).toEqual(
    [id, blocker, imported[0]!].sort(),
  )
  await page.getByRole('button', { name: '重做', exact: true }).click()
  expect((await elements(page)).map((el) => el.id).sort()).toEqual(
    [id, blocker, ...imported].sort(),
  )
  expect(submitted).toBe(0)
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length, id)).toBe(
    1,
  )
})

test('参考图上传期间选中其他卡片，完成后保持当前选择并连回原目标', async ({ page }) => {
  await newProject(page)
  const ids = await page.evaluate(() => ({
    target: window.__plein.addNode({
      type: 'plein/character',
      name: '上传参考的角色',
      params: {},
      x: 0,
      y: 0,
    }),
    other: window.__plein.addNode({
      type: 'plein/text',
      name: '继续编辑的文本',
      params: { text: '不应跳回原角色' },
      x: 500,
      y: 0,
    }),
  }))
  await page.getByRole('treeitem', { name: '上传参考的角色 定位到画布', exact: true }).click()
  let held = false
  let release = () => {}
  await page.route('**/api/assets', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const response = await route.fetch()
    await new Promise<void>((resolve) => {
      release = resolve
      held = true
    })
    await route.fulfill({ response })
  })
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('generator').getByRole('button', { name: '参考图', exact: true }).click()
  await (await chooser).setFiles(join(dir, 'reference.png'))
  await expect.poll(() => held).toBe(true)
  await page.getByRole('treeitem', { name: '继续编辑的文本 定位到画布', exact: true }).click()
  release()
  await expect.poll(() => edgesInto(page, ids.target)).toHaveLength(1)
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([ids.other])
  await expect(
    page.getByTestId('generator').getByRole('textbox', { name: '提示词', exact: true }),
  ).toHaveValue('不应跳回原角色')
})
