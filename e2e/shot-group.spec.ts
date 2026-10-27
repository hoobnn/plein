import { execFileSync } from 'node:child_process'
import { expect, type Page, test } from './fixtures'
import { solidPng } from '../packages/providers/src/mock/media'
import { centerOf, clickElement, elements, newProject, waitEngine, zoomTo } from './canvas'

async function uploadImage(page: Page, width: number, height: number) {
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (
    await chooser
  ).setFiles({
    name: '分镜原图.png',
    mimeType: 'image/png',
    buffer: Buffer.from(solidPng(width, height, [40, 120, 180])),
  })
  await expect.poll(async () => (await elements(page)).length).toBe(1)
  return (await elements(page))[0]!
}

async function metadata(page: Page, id: string) {
  const assetId = await page.evaluate((id) => window.__plein.engine.doc.get(id)?.assetId, id)
  expect(assetId).toBeTruthy()
  const response = await page.request.get(`/api/assets/${assetId}/meta`)
  expect(response.status()).toBe(200)
  return response.json()
}

const resultBar = (page: Page) => page.getByRole('toolbar', { name: '结果操作', exact: true })

test.describe('镜头素材浏览器冒烟', { tag: '@core' }, () => {
  test('真实图片切分、编号重排与服务端拼图保持实际像素', async ({ page }) => {
    const source = await uploadImage(page, 960, 540)
    await clickElement(page, source.id)
    await resultBar(page).getByRole('button', { name: '宫格切分', exact: true }).click()
    await page.getByRole('button', { name: /4 宫格/ }).click()
    await expect
      .poll(async () => (await elements(page)).filter((el) => el.kind === 'frame').length)
      .toBe(1)
    const frame = (await elements(page)).find((el) => el.kind === 'frame')!
    const group = () =>
      page.evaluate(
        (id) => window.__plein.engine.doc.get(id)?.params?.shotGroup as { order: string[] },
        frame.id,
      )
    const tiles = (await group()).order
    expect(tiles).toHaveLength(4)
    await zoomTo(page, [frame.id])
    await expect(page.locator('.plein-shot-badge')).toHaveCount(4)
    await page.evaluate((id) => window.__plein.engine.selection.set([id]), frame.id)
    const bar = page.getByRole('toolbar', { name: 'Frame 操作', exact: true })
    await bar.getByRole('button', { name: '分镜组', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '分镜组', exact: true })
    await panel.getByRole('button', { name: '宫格 4上移', exact: true }).click()
    expect((await group()).order).toEqual([tiles[0], tiles[1], tiles[3], tiles[2]])
    await panel.getByRole('button', { name: '4 列', exact: true }).click()
    await panel.getByRole('button', { name: '拼成大图', exact: true }).click()
    await expect(page.getByText(/拼好了：\d+×\d+ 像素/)).toBeVisible()
    const collage = (await elements(page)).find(
      (el) => el.kind === 'image' && /拼图/.test(el.name ?? ''),
    )!
    expect(collage.name).toMatch(/2000×302$/)
    const meta = await metadata(page, collage.id)
    expect(meta).toMatchObject({ width: 2000, height: 302 })
    await page.evaluate((id) => window.__plein.engine.selection.set([id]), frame.id)
    await bar.getByRole('button', { name: '分镜组', exact: true }).click()
    await panel.getByRole('button', { name: '定位原图', exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
      .toEqual([source.id])
  })

  test('本地拉片经真实处理生成素材，刷新后清单与画布一致', async ({ page }) => {
    await newProject(page)
    const bytes = execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=green:s=96x64:r=10:d=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      'frag_keyframe+empty_moov',
      '-f',
      'mp4',
      'pipe:1',
    ])
    const uploaded = await page.request.post('/api/assets', {
      headers: { 'Content-Type': 'video/mp4' },
      data: bytes,
    })
    expect(uploaded.status()).toBe(201)
    const assetId = (await uploaded.json()).id as string
    const source = await page.evaluate((assetId) => {
      const engine = window.__plein.engine as typeof window.__plein.engine & {
        paste(value: unknown): void
      }
      engine.paste({
        plein: 1,
        edges: [],
        elements: [
          {
            id: 'source',
            kind: 'video',
            name: '原视频',
            assetId,
            x: 300,
            y: 200,
            w: 300,
            h: 200,
            parentId: null,
          },
        ],
      })
      return [...engine.doc.elements()][0]!.id
    }, assetId)
    await zoomTo(page, [source])
    const at = await centerOf(page, source)
    await page.mouse.click(at.x, at.y)
    await resultBar(page).getByRole('button', { name: '媒体工具', exact: true }).click()
    await page
      .getByRole('dialog', { name: '媒体工具', exact: true })
      .getByRole('button', { name: '本地拉片', exact: true })
      .click()
    const panel = page.getByRole('dialog', { name: '本地拉片', exact: true })
    await panel.getByRole('button', { name: '检测切点', exact: true }).click()
    await expect(panel.getByLabel('选择镜头 1', { exact: true })).toBeVisible()
    await panel.getByLabel('切点（秒数或时间码，逗号分隔；留空表示整段）').fill('1')
    await panel.getByLabel('提取视频片段', { exact: true }).check()
    await panel.getByRole('button', { name: '按这些切点处理', exact: true }).click()
    await expect(panel.getByLabel('选择镜头 2', { exact: true })).toBeVisible()
    await expect(panel.locator('video')).toHaveCount(2)
    expect(
      await panel
        .locator('video')
        .evaluateAll((videos) =>
          videos.every(
            (video) => (video as HTMLVideoElement).muted && (video as HTMLVideoElement).paused,
          ),
        ),
    ).toBe(true)
    await panel.getByRole('button', { name: '全选镜头', exact: true }).click()
    await panel.getByRole('button', { name: '放入关键帧', exact: true }).click()
    await panel.getByRole('button', { name: '放入视频片段', exact: true }).click()
    const node = (await elements(page)).find((el) => el.nodeType === 'plein/shot-analysis')!
    const snapshot = await page.evaluate(
      (id) => ({
        adopted: window.__plein.engine.doc.get(id)?.adopted,
        media: [...window.__plein.engine.doc.elements()]
          .filter((el) => el.params?.shotAnalysisOrigin)
          .map((el) => el.id)
          .sort(),
      }),
      node.id,
    )
    expect(snapshot.media).toHaveLength(4)
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
    await page.reload()
    await waitEngine(page)
    await expect
      .poll(() =>
        page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length, node.id),
      )
      .toBe(2)
    expect(
      await page.evaluate(
        (id) => ({
          adopted: window.__plein.engine.doc.get(id)?.adopted,
          media: [...window.__plein.engine.doc.elements()]
            .filter((el) => el.params?.shotAnalysisOrigin)
            .map((el) => el.id)
            .sort(),
        }),
        node.id,
      ),
    ).toEqual(snapshot)
  })

  test('窄窗口边缘工具条真实可点击，焦点恢复且裁剪不改变原图', async ({ page }) => {
    const source = await uploadImage(page, 160, 90)
    const before = await page.evaluate((id) => window.__plein.engine.doc.get(id), source.id)
    await page.setViewportSize({ width: 320, height: 320 })
    await zoomTo(page, [source.id])
    await page.evaluate((id) => window.__plein.engine.selection.set([id]), source.id)
    const bar = resultBar(page)
    for (const y of [460, 20]) {
      await page.evaluate(
        ({ id, y }) => {
          const engine = window.__plein.engine as typeof window.__plein.engine & {
            camera: { panBy(x: number, y: number): void }
          }
          const r = engine.doc.worldRect(id)
          const at = engine.worldToClient(r.x + r.w / 2, r.y + r.h)
          engine.camera.panBy(0, y - at.y)
        },
        { id: source.id, y },
      )
      await expect
        .poll(() =>
          bar.locator('button:enabled').evaluateAll((buttons) =>
            buttons.every((button) => {
              const r = button.getBoundingClientRect()
              return (
                document
                  .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
                  ?.closest('button') === button
              )
            }),
          ),
        )
        .toBe(true)
    }
    const trigger = bar.getByRole('button', { name: '媒体工具', exact: true })
    await trigger.click()
    const tools = page.getByRole('dialog', { name: '媒体工具', exact: true })
    await tools.getByRole('button', { name: '上下翻转', exact: true }).scrollIntoViewIfNeeded()
    await expect
      .poll(async () => {
        const r = (await tools.boundingBox())!
        return r.x >= 0 && r.y >= 0 && r.x + r.width <= 320 && r.y + r.height <= 320
      })
      .toBe(true)
    await page.keyboard.press('Escape')
    await expect(tools).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await page.setViewportSize({ width: 390, height: 700 })
    await zoomTo(page, [source.id])
    await bar.getByRole('button', { name: '全屏查看', exact: true }).click()
    const viewer = page.getByRole('dialog', { name: /^查看「分镜原图/ })
    await expect(viewer.getByRole('img')).toHaveAttribute('src', `/api/assets/${before!.assetId}`)
    await viewer.getByRole('button', { name: '关闭', exact: true }).click()
    await trigger.click()
    await tools.getByRole('button', { name: '裁剪', exact: true }).click()
    await tools.getByLabel('宽', { exact: true }).fill('80')
    await tools.getByRole('button', { name: '开始加工', exact: true }).click()
    await expect
      .poll(async () => (await elements(page)).filter((el) => el.kind === 'image').length)
      .toBe(2)
    const cropped = (await elements(page)).find((el) => el.kind === 'image' && el.id !== source.id)!
    const meta = await metadata(page, cropped.id)
    expect(meta).toMatchObject({ width: 80, height: 90 })
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id), source.id)).toEqual(
      before,
    )
    await page.evaluate((id) => window.__plein.engine.selection.set([id]), source.id)
    await zoomTo(page, [source.id])
    await bar.getByRole('button', { name: '生成视频', exact: true }).click()
    const derived = await page.evaluate(() =>
      [...window.__plein.engine.doc.elements()].find((el) => el.nodeType === 'plein/video'),
    )
    expect(derived?.params?.mode).toBe('image')
    expect(await page.evaluate(() => [...window.__plein.engine.doc.edges()])).toContainEqual(
      expect.objectContaining({ from: [source.id, 'image'], to: [derived!.id, 'images'] }),
    )
  })

  test('结果操作条在宽窄视口避让侧栏与任务面板，所有操作真实命中', async ({ page }) => {
    const source = await uploadImage(page, 160, 90)
    await page.evaluate((id) => window.__plein.engine.selection.set([id]), source.id)
    const bar = resultBar(page)
    const fits = async () => {
      await expect
        .poll(() =>
          bar.evaluate((el) => {
            const r = el.getBoundingClientRect()
            const sidebar = document.querySelector('[aria-label="侧栏"]')
            const left =
              sidebar?.getAttribute('aria-hidden') === 'true'
                ? 0
                : (sidebar?.getBoundingClientRect().right ?? 0)
            const right =
              document.querySelector('aside[aria-label="任务"]')?.getBoundingClientRect().left ??
              innerWidth
            return {
              inside:
                r.left >= left + 4 &&
                r.right <= right - 4 &&
                r.top >= 64 &&
                r.bottom <= innerHeight - 64 &&
                el.scrollWidth <= el.clientWidth,
              hit: [...el.querySelectorAll('button:enabled')].every((button) => {
                const box = button.getBoundingClientRect()
                return (
                  document
                    .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
                    ?.closest('button') === button
                )
              }),
            }
          }),
        )
        .toEqual({ inside: true, hit: true })
    }
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await zoomTo(page, [source.id])
      await fits()
      if (width === 1440) {
        const tasks = page.getByRole('complementary', { name: '任务', exact: true })
        if (!(await tasks.isVisible()))
          await page.getByRole('button', { name: '任务', exact: true }).click()
        await expect(tasks).toBeVisible()
        await fits()
        await tasks.getByRole('button', { name: '关闭', exact: true }).click()
        await expect(tasks).toBeHidden()
        await fits()
      }
    }
  })

  test('镜头工作台宽屏两栏并排，窄屏弹窗与导航操作不溢出且可点击', async ({ page }) => {
    await newProject(page)
    const board = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/storyboard',
        name: '布局验收分镜',
        x: 100,
        y: 100,
        params: {
          shots: [1, 2].map((no) => ({
            id: `layout-${no}`,
            no,
            duration: 5,
            description: `镜头 ${no} 的画面`,
            characters: [],
            dialogue: [],
            imagePrompt: '雨夜街道',
            motionPrompt: '缓慢推进',
          })),
        },
      }),
    )
    await zoomTo(page, [board])
    const point = await centerOf(page, board)
    await page.mouse.dblclick(point.x, point.y)
    const editor = page.getByRole('dialog', { name: '分镜表', exact: true })
    await editor.getByRole('button', { name: '详细卡片', exact: true }).click()
    await editor.getByRole('button', { name: '镜头 1 工作台', exact: true }).click()
    const workspace = page.getByRole('dialog', { name: '镜头工作台', exact: true })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 763 })
      await expect
        .poll(() =>
          workspace.evaluate((el) => {
            const box = el.getBoundingClientRect()
            const nav = el.querySelector('[aria-label="镜头导航"]')!
            const close = el.querySelector('button[aria-label="关闭"]')!
            const within = (r: DOMRect) =>
              r.left >= box.left &&
              r.right <= box.right &&
              r.top >= box.top &&
              r.bottom <= box.bottom
            const buttons = [
              ...nav.querySelectorAll(
                'button[aria-label="上一镜"]:enabled, button[aria-label="下一镜"]:enabled',
              ),
              close,
            ]
            return {
              inside:
                box.left >= 0 &&
                box.top >= 0 &&
                box.right <= innerWidth &&
                box.bottom <= innerHeight &&
                el.scrollWidth <= el.clientWidth &&
                within(nav.getBoundingClientRect()) &&
                within(close.getBoundingClientRect()),
              hit: buttons.every((button) => {
                const r = button.getBoundingClientRect()
                return (
                  within(r) &&
                  document
                    .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
                    ?.closest('button') === button
                )
              }),
            }
          }),
        )
        .toEqual({ inside: true, hit: true })
      if (width === 1440) {
        await expect
          .poll(() =>
            workspace.evaluate((el) => {
              const plan = el.querySelector('[aria-label="当前镜头计划"]')!.getBoundingClientRect()
              const preview = el
                .querySelector('[aria-label="本镜候选与执行依据"]')!
                .getBoundingClientRect()
              return plan.right <= preview.left + 1 && Math.abs(plan.y - preview.y) < 2
            }),
          )
          .toBe(true)
      }
      await workspace.getByRole('button', { name: '下一镜', exact: true }).click()
      await expect(
        workspace.getByRole('textbox', { name: '工作台画面描述', exact: true }),
      ).toHaveValue('镜头 2 的画面')
      await workspace.getByRole('button', { name: '上一镜', exact: true }).click()
      // 镜头缩略条允许横向滚动，逐个滚入可见区后验证真实命中。
      for (const no of [2, 1]) {
        const thumbnail = workspace.getByRole('button', { name: `切换到镜头 ${no}`, exact: true })
        await thumbnail.scrollIntoViewIfNeeded()
        await expect
          .poll(() =>
            thumbnail.evaluate((button) => {
              const r = button.getBoundingClientRect()
              return (
                document
                  .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
                  ?.closest('button') === button
              )
            }),
          )
          .toBe(true)
        await thumbnail.click()
        await expect(
          workspace.getByRole('textbox', { name: '工作台画面描述', exact: true }),
        ).toHaveValue(`镜头 ${no} 的画面`)
      }
    }
    await workspace.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(workspace).toBeHidden()
    await expect(editor).toBeHidden()
  })
})
