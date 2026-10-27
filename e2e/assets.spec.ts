import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from './fixtures'
import { solidPng } from '../packages/providers/src/mock/media'
import {
  addNode,
  byName,
  centerOf,
  revealGenerator,
  edgesInto,
  elements,
  newProject,
  waitNode,
} from './canvas'
import { openLibraryPanel } from './library-ui'

let dir = ''

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-e2e-assets-'))
  const ff = (...args: string[]) =>
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])
  ff('-f', 'lavfi', '-i', 'color=c=orange:s=64x48', '-frames:v', '1', join(dir, 'still.png'))
  ff('-f', 'lavfi', '-i', 'color=c=teal:s=64x48', '-frames:v', '1', join(dir, 'side.png'))
  ff('-f', 'lavfi', '-i', 'testsrc=s=96x160:d=2:r=10', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4'))
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** 画布上指向资产的元素：[元素 id, 资产 id] */
const assetElements = (page: Page, kind: string) =>
  page.evaluate(
    (kind) =>
      [...window.__plein.engine.doc.elements()]
        .filter((e) => e.kind === kind && e.assetId)
        .map((e) => [e.id, e.assetId!] as const),
    kind,
  )

const meta = async (page: Page, assetId: string) =>
  (await (await page.request.get(`/api/assets/${assetId}/meta`)).json()) as {
    width?: number
    height?: number
    duration?: number
  }

/** 生成器里上传一张参考图，等它连进卡片；参考图换几次都要走这条路。 */
async function uploadReference(page: Page, cardId: string, file: string, expected: number) {
  const chooser = page.waitForEvent('filechooser')
  // 编辑器固定 840px 宽，这个按钮可能在侧栏下面：先把它平移进窗口
  const upload = page
    .getByTestId('generator')
    .getByRole('button', { name: '上传参考', exact: true })
  await revealGenerator(page, upload)
  await upload.click()
  await page
    .getByRole('dialog', { name: '上传参考', exact: true })
    .getByRole('button', { name: '参考图', exact: true })
    .click()
  await (await chooser).setFiles(file)
  await expect.poll(() => edgesInto(page, cardId)).toHaveLength(expected)
}

/** 资产卡：生成器里上传参考图连进卡片；下游 @ 引用它生成后，卡片的参考图变了，结果随之过期 */
test('角色卡上传参考图，@ 引用后换参考图，镜头图标为过期', { tag: '@core' }, async ({ page }) => {
  await newProject(page)
  await addNode(page, '角色')
  const card = await byName(page, '角色')
  await revealGenerator(page)

  await uploadReference(page, card.id, join(dir, 'still.png'), 1)
  const [imageId] = (await assetElements(page, 'image'))[0]!
  expect((await edgesInto(page, card.id))[0]).toEqual([imageId, 'image', 'references'])

  await page.keyboard.press('Escape')
  await addNode(page, '图片', { x: 1200, y: 200 })
  const node = await byName(page, '生成图片')
  await revealGenerator(page)
  const prompt = page.getByRole('textbox', { name: '提示词' })
  await prompt.click()
  await page.keyboard.type('@角色')
  // 候选里选中角色卡
  await page.keyboard.press('Enter')
  await page.keyboard.type('站在天台边')
  // 生成前看实际输入：角色卡的参考图会送进去，可以设为必需参考
  const preview = page.getByTestId('input-preview')
  await preview.getByRole('button', { name: /实际输入/ }).click()
  await expect(preview).toContainText('角色 · 角色')
  await expect(preview).toContainText('送入 1 张')
  await preview.getByRole('button', { name: '可选' }).click()
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.requiredRefs, node.id),
  ).toEqual([card.id])
  await page.getByRole('button', { name: '生成', exact: true }).click()
  await waitNode(page, node.id)

  const canvas = page.url().split('#/c/')[1]!.split(/[/?]/)[0]
  const stale = async () =>
    JSON.stringify(await (await page.request.get(`/api/canvases/${canvas}/stale`)).json())
  expect(await stale()).not.toContain(node.id)

  // 给角色卡再加一张参考图：引用它的镜头图随之过期
  await page.keyboard.press('Escape')
  const p = await centerOf(page, card.id)
  await page.mouse.click(p.x, p.y)
  await uploadReference(page, card.id, join(dir, 'side.png'), 2)
  await expect.poll(stale).toContain(node.id)
})

/** 媒体工具条：裁剪图片、截取视频，产出新素材放在右边，原素材不变 */
test('媒体工具条裁剪图片、截取视频', { tag: '@core' }, async ({ page }) => {
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传' }).click()
  await (await chooser).setFiles([join(dir, 'still.png'), join(dir, 'clip.mp4')])
  await expect
    .poll(async () => (await elements(page)).filter((e) => e.kind !== 'node').length)
    .toBe(2)

  const openTools = async (elId: string) => {
    await page.keyboard.press('Escape')
    const p = await centerOf(page, elId)
    await page.mouse.click(p.x, p.y)
    await page
      .getByRole('toolbar', { name: '结果操作' })
      .getByRole('button', { name: '媒体工具' })
      .click()
  }

  const [stillId, stillAsset] = (await assetElements(page, 'image'))[0]!
  await openTools(stillId)
  await page.getByRole('button', { name: '裁剪', exact: true }).click()
  await page.getByLabel('宽', { exact: true }).fill('32')
  await page.getByRole('button', { name: '开始加工' }).click()
  await expect(page.locator('.ui-toast')).toContainText('新素材放在右边')
  await expect.poll(async () => (await assetElements(page, 'image')).length).toBe(2)
  const cropped = (await assetElements(page, 'image')).find(([id]) => id !== stillId)!
  expect(await meta(page, cropped[1])).toMatchObject({ width: 32, height: 48 })
  expect(await meta(page, stillAsset)).toMatchObject({ width: 64, height: 48 })

  const [clipId, clipAsset] = (await assetElements(page, 'video'))[0]!
  await openTools(clipId)
  await page.getByRole('button', { name: '截取一段' }).click()
  await page.getByLabel('出点', { exact: true }).fill('1')
  await page.getByRole('button', { name: '开始加工' }).click()
  await expect(page.locator('.ui-toast')).toContainText('新素材放在右边')
  await expect.poll(async () => (await assetElements(page, 'video')).length).toBe(2)
  const trimmed = (await assetElements(page, 'video')).find(([id]) => id !== clipId)!
  expect((await meta(page, trimmed[1])).duration).toBeCloseTo(1, 0)
  expect((await meta(page, clipAsset)).duration).toBeCloseTo(2, 0)
})

/**
 * 低矮窗口与放大预览的可达性：这两处都只有真实布局才能证明，
 * DOM 组件测试看不出内容是否被裁掉、末项是否点得到。
 */
test(
  '低矮窗口下选材末项可见可点并保存正确素材；预览放大后四角可达且键盘能滚动',
  { tag: '@core' },
  async ({ page }) => {
    await newProject(page)
    await page.setViewportSize({ width: 320, height: 320 })
    const assets: string[] = []
    for (let i = 0; i < 12; i++) {
      const upload = await page.request.post('/api/assets', {
        headers: { 'Content-Type': 'image/png' },
        data: Buffer.from(solidPng(80, 60, [30 + i * 8, 100, 160])),
      })
      expect(upload.status()).toBe(201)
      assets.push(((await upload.json()) as { id: string }).id)
    }
    const names = assets.map((_, i) => `候选参考 ${i + 1}`)
    await page.evaluate(
      ({ assets, names }) => {
        const engine = window.__plein.engine as typeof window.__plein.engine & {
          paste(data: unknown): void
        }
        engine.paste({
          plein: 1,
          edges: [],
          elements: assets.map((assetId, i) => ({
            id: `ref-${i}`,
            kind: 'image',
            name: names[i],
            assetId,
            x: 300 + (i % 4) * 300,
            y: 200 + Math.floor(i / 4) * 180,
            w: 160,
            h: 120,
            parentId: null,
          })),
        })
      },
      { assets, names },
    )
    const itemName = '选材可达性'
    const created = await page.request.post('/api/library', {
      data: { kind: 'scene', name: itemName, description: '保留手写场景设定', images: [] },
    })
    expect(created.status()).toBe(201)
    const item = (await created.json()) as { id: string }

    const panel = await openLibraryPanel(page)
    await panel
      .getByRole('group', { name: '资产类别', exact: true })
      .getByRole('button', { name: '场景', exact: true })
      .click()
    await panel
      .getByRole('group', { name: '范围', exact: true })
      .getByRole('button', { name: '全部', exact: true })
      .click()
    await panel
      .getByRole('listitem')
      .filter({ hasText: itemName })
      .getByRole('button')
      .first()
      .click()
    const field = panel
      .locator('.ui-field')
      .filter({ has: page.locator('.ui-label').filter({ hasText: '主场景图' }) })
      .last()
    await field.getByRole('button', { name: '从画布选', exact: true }).click()
    const menu = page.getByRole('dialog', { name: '从画布选', exact: true })
    await expect(menu).toBeVisible()
    // 选材菜单要完整落在小窗口里
    await expect
      .poll(async () => {
        const box = await menu.boundingBox()
        const view = page.viewportSize()!
        return (
          !!box &&
          box.x >= 8 &&
          box.y >= 8 &&
          box.x + box.width <= view.width - 8 &&
          box.y + box.height <= view.height - 8
        )
      })
      .toBe(true)
    const last = menu.getByRole('button', { name: `选择图片「${names[11]}」`, exact: true })
    await last.scrollIntoViewIfNeeded()
    await expect(last).toBeInViewport({ ratio: 1 })
    await last.click()
    await expect(menu).toHaveCount(0)
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
    const saved = (await (await page.request.get(`/api/library/${item.id}`)).json()) as {
      images: Array<{ slot: string; assetId: string }>
    }
    // 选中的确实是最后一项，不是第一个
    expect(saved.images).toEqual([{ slot: 'main', assetId: assets[11] }])
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(panel).toHaveCount(0)
    // 小窗口里顶部入口会收起来，先把窗口放回常规尺寸再开素材面板
    await page.setViewportSize({ width: 1440, height: 900 })

    // 放大预览：四角都要能滚到，键盘也要能滚动
    const previewName = '预览边角.png'
    const png = execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=white:s=640x320,drawbox=x=0:y=0:w=48:h=48:color=red:t=fill,drawbox=x=iw-48:y=ih-48:w=48:h=48:color=blue:t=fill',
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      'pipe:1',
    ])
    const previewUpload = await page.request.post('/api/assets', {
      headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent(previewName) },
      data: png,
    })
    expect(previewUpload.status()).toBe(201)
    const previewId = ((await previewUpload.json()) as { id: string }).id
    await page.getByRole('button', { name: '素材', exact: true }).click()
    const media = page.getByRole('dialog', { name: '素材', exact: true })
    await media.getByRole('combobox', { name: '关联项目' }).click()
    await page.getByRole('option', { name: '全部项目', exact: true }).click()
    await page.setViewportSize({ width: 390, height: 640 })
    await media.getByRole('searchbox', { name: '搜索素材', exact: true }).fill(previewName)
    await media.getByRole('button', { name: `查看素材 ${previewName}`, exact: true }).click()
    await media.getByRole('button', { name: '放大查看素材', exact: true }).click()
    const preview = page.getByRole('dialog', { name: '素材预览', exact: true })
    const image = preview.getByRole('img', { name: previewName, exact: true })
    await expect
      .poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
      .toBe(true)
    for (let i = 0; i < 4; i++)
      await preview.getByRole('button', { name: '放大', exact: true }).click()
    await expect(preview.getByText('200%', { exact: true })).toBeVisible()
    const topLeft = await image.evaluate((img) => {
      const area = img.parentElement!
      area.scrollTo(0, 0)
      const i = img.getBoundingClientRect()
      const r = area.getBoundingClientRect()
      return {
        x: i.left - r.left - area.clientLeft,
        y: i.top - r.top - area.clientTop,
        overflow: area.scrollWidth - area.clientWidth,
      }
    })
    expect(topLeft.overflow).toBeGreaterThan(0)
    expect(topLeft.x).toBeGreaterThanOrEqual(0)
    expect(topLeft.y).toBeGreaterThanOrEqual(0)
    const bottomRight = await image.evaluate((img) => {
      const area = img.parentElement!
      area.scrollTo(area.scrollWidth, area.scrollHeight)
      const i = img.getBoundingClientRect()
      const r = area.getBoundingClientRect()
      return {
        x: i.right - r.left - area.clientLeft,
        y: i.bottom - r.top - area.clientTop,
        w: area.clientWidth,
        h: area.clientHeight,
      }
    })
    expect(bottomRight.x).toBeLessThanOrEqual(bottomRight.w + 1)
    expect(bottomRight.y).toBeLessThanOrEqual(bottomRight.h + 1)
    const area = preview.getByRole('region', { name: '素材预览区域', exact: true })
    await area.evaluate((el) => el.scrollTo(0, 0))
    await area.focus()
    await area.press('ArrowRight')
    await expect.poll(() => area.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
    await expect(image).toHaveAttribute('src', `/api/assets/${previewId}`)
  },
)

/**
 * 角色资产的完整接线：制作草稿 → 生成 → 采用候选 → 归档到角色 → 重开。
 * 这一串跨了库、画布与生成器，只有真浏览器能证明。
 */
test(
  '角色槽位制作草稿、生成采用后归档回角色，重开后封面与槽位都在',
  { tag: '@core' },
  async ({ page }) => {
    await newProject(page)
    const canvasId = /#\/c\/([^/?]+)/.exec(page.url())![1]!
    const canvas = (await (await page.request.get(`/api/canvases/${canvasId}`)).json()) as {
      projectId: string
    }
    const upload = async (name: string, file: string) => {
      const response = await page.request.post('/api/assets', {
        headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent(name) },
        data: readFileSync(join(dir, file)),
      })
      expect(response.status()).toBe(201)
      return ((await response.json()) as { id: string }).id
    }
    const body = await upload('角色全身.png', 'still.png')
    const portrait = await upload('角色肖像.png', 'side.png')

    const created = await page.request.post('/api/library', {
      data: {
        kind: 'character',
        name: '归档接线角色',
        projectId: canvas.projectId,
        description: '归档前的原始设定',
        images: [
          { slot: 'full_body', assetId: body },
          { slot: 'portrait', assetId: portrait },
        ],
      },
    })
    expect(created.status()).toBe(201)
    const item = (await created.json()) as { id: string }
    const readItem = async () =>
      (await (await page.request.get(`/api/library/${item.id}`)).json()) as {
        coverAssetId: string | null
        images: Array<{ slot: string; assetId: string }>
      }

    const panel = await openLibraryPanel(page)
    await panel
      .getByRole('listitem')
      .filter({ hasText: '归档接线角色' })
      .getByRole('button')
      .first()
      .click()
    await panel
      .getByRole('group', { name: '档案分页', exact: true })
      .getByRole('button', { name: '角色资产', exact: true })
      .click()
    await panel
      .locator('[data-character-slot="portrait"]')
      .getByRole('button', { name: '制作这类图片', exact: true })
      .click()
    await expect(panel).toBeHidden()

    // 制作只建草稿，不发生成请求
    const draftName = '归档接线角色 · 肖像／半身图'
    const draft = (await elements(page)).find((element) => element.name === draftName)
    expect(draft?.nodeType).toBe('plein/image')
    const draftId = draft!.id
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.get(id)?.run, draftId),
    ).toBeUndefined()

    const generator = page.getByTestId('generator')
    await revealGenerator(page)
    const runs: string[] = []
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        /\/nodes\/[^/]+\/run$/.test(new URL(request.url()).pathname)
      )
        runs.push(request.url())
    })
    await generator.getByRole('button', { name: '生成', exact: true }).click()
    await waitNode(page, draftId)
    expect(runs).toHaveLength(1)
    await expect
      .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.run?.status, draftId))
      .toBe('succeeded')
    // 再生成一次，才有第二个候选可以采用
    await generator.getByRole('button', { name: '重新生成', exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length, draftId),
      )
      .toBe(2)

    await generator.getByRole('button', { name: '全屏查看', exact: true }).click()
    const viewer = page.getByRole('dialog', { name: `查看「${draftName}」`, exact: true })
    // 第一个候选已经是采用状态，翻到第二个再采用，才能验证归档的是被采用的那张
    await viewer.getByRole('button', { name: '预览下一个候选', exact: true }).click()
    await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
    const adopted = await page.evaluate((id) => window.__plein.engine.doc.get(id)?.adopted, draftId)
    expect(typeof adopted).toBe('string')
    await viewer.getByRole('button', { name: '关闭', exact: true }).click()
    const candidate = await page.evaluate(
      ({ id, resultId }) =>
        window.__plein.engine.doc.get(id)?.results?.find((entry) => entry.id === resultId)?.value
          .assetId as string,
      { id: draftId, resultId: adopted! },
    )

    // 归档：请求体带上最新 revision、目标槽位与封面参数
    await generator.getByRole('button', { name: '归档到角色', exact: true }).click()
    const archive = page.getByRole('dialog', { name: '归档到角色', exact: true })
    await expect(archive.locator(`[data-library-id="${item.id}"]`)).toHaveText('归档接线角色')
    await archive.getByRole('combobox', { name: '目标槽位', exact: true }).click()
    await page.getByRole('option', { name: '情绪九宫格', exact: true }).click()
    await archive.getByRole('checkbox', { name: /设为独立封面/ }).check()
    const requestPromise = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === `/api/library/${item.id}/character-image`,
    )
    await archive.getByRole('button', { name: '确认归档', exact: true }).click()
    const archiveRequest = await requestPromise
    expect(archiveRequest.postDataJSON()).toMatchObject({
      canvasId,
      nodeId: draftId,
      resultId: adopted,
      assetId: candidate,
      sourceSlot: 'portrait',
      slot: 'face_grid',
      cover: true,
    })
    expect(archiveRequest.postDataJSON().expected).toEqual(expect.any(String))
    await expect(archive).toBeHidden()

    // 归档结果写回角色，重开后封面与槽位都在
    const saved = await readItem()
    expect(saved.coverAssetId).toBe(candidate)
    expect(saved.images).toContainEqual({ slot: 'full_body', assetId: body })
    expect(saved.images).toContainEqual({ slot: 'portrait', assetId: portrait })
    expect(saved.images).toContainEqual({ slot: 'face_grid', assetId: candidate })
    const reopened = await openLibraryPanel(page)
    await expect(reopened.locator(`[data-lib-cover="${item.id}"] img`)).toHaveAttribute(
      'src',
      new RegExp(candidate),
    )
    await reopened
      .getByRole('listitem')
      .filter({ hasText: '归档接线角色' })
      .getByRole('button')
      .first()
      .click()
    await reopened
      .getByRole('group', { name: '档案分页', exact: true })
      .getByRole('button', { name: '角色资产', exact: true })
      .click()
    await expect(
      reopened.locator('[data-character-slot="face_grid"]').locator('img'),
    ).toHaveAttribute('src', new RegExp(candidate))
    await expect(
      reopened.locator('[data-character-slot="full_body"]').locator('img'),
    ).toHaveAttribute('src', new RegExp(body))
  },
)
