import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
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

/** 资产卡：生成器里上传参考图连进卡片；下游 @ 引用它生成后，卡片的参考图变了，结果随之过期 */
test('角色卡上传参考图，@ 引用后换参考图，镜头图标为过期', { tag: '@core' }, async ({ page }) => {
  await newProject(page)
  await addNode(page, '角色')
  const card = await byName(page, '角色')
  await revealGenerator(page)

  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('generator').getByRole('button', { name: '上传参考', exact: true }).click()
  await page
    .getByRole('dialog', { name: '上传参考', exact: true })
    .getByRole('button', { name: '参考图', exact: true })
    .click()
  await (await chooser).setFiles(join(dir, 'still.png'))
  await expect.poll(() => edgesInto(page, card.id)).toHaveLength(1)
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
  await expect(preview).toContainText('1 张参考图')
  await preview.getByRole('button', { name: /实际输入/ }).click()
  await expect(preview).toContainText('角色 · 角色')
  await expect(preview).toContainText('送入 1 张')
  await preview.getByRole('button', { name: '可选' }).click()
  await expect(preview.getByRole('button', { name: '必需' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
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
  await revealGenerator(page)
  const again = page.waitForEvent('filechooser')
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
  await (await again).setFiles(join(dir, 'side.png'))
  await expect.poll(() => edgesInto(page, card.id)).toHaveLength(2)
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
