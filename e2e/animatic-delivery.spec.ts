import { readFileSync } from 'node:fs'
import { expect, test } from './fixtures'
import {
  addNode,
  centerOf,
  clickStoryboardAction,
  elements,
  newProject,
  waitNode,
  zoomTo,
} from './canvas'
import { slowFile } from './slow-file'

const canvasId = (url: string) => decodeURIComponent(url.split('#/c/')[1]!.split('?')[0]!)
test(
  '分镜图片与已有配音预演，零视频生成导出样片并按实际MP4记录交付意见',
  { tag: '@core' },
  async ({ page }) => {
    await newProject(page)
    const ids = await page.evaluate(() => {
      const board = window.__plein.addNode({
        type: 'plein/storyboard',
        name: '样片分镜',
        x: 0,
        y: 0,
        params: {
          aspectRatio: '16:9',
          shots: [
            {
              id: 'one',
              no: 1,
              duration: 2,
              dialogue: [{ id: 'line1', character: '角色', line: '你好' }],
            },
            { id: 'missing', no: 2, duration: 1 },
          ],
        },
      })
      const image = window.__plein.addNode({
        type: 'plein/image',
        name: '已有分镜图',
        x: 400,
        y: 0,
        params: {
          model: 'plein/mock:image',
          prompt: '测试样片',
          source: { storyboard: board, shot: 'one', role: 'image' },
        },
      })
      const speech = window.__plein.addNode({
        type: 'plein/speech',
        name: '已有配音',
        x: 800,
        y: 0,
        params: {
          model: 'plein/mock:audio',
          text: '你好',
          source: { storyboard: board, shot: 'one', role: 'speech', dialogueId: 'line1' },
        },
      })
      return { board, image, speech }
    })
    for (const id of [ids.image, ids.speech]) {
      await expect
        .poll(async () =>
          (
            await page.request.get(`/api/canvases/${canvasId(page.url())}/nodes/${id}/input`)
          ).status(),
        )
        .toBe(200)
      expect(
        (
          await page.request.post(`/api/canvases/${canvasId(page.url())}/nodes/${id}/run`, {
            data: {},
          })
        ).status(),
      ).toBe(202)
      await waitNode(page, id)
    }
    const submitted: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/nodes\/[^/]+\/run$/.test(r.url())) submitted.push(r.url())
    })
    await zoomTo(page, [ids.board])
    const point = await centerOf(page, ids.board)
    await page.mouse.dblclick(point.x, point.y)
    await clickStoryboardAction(
      page.getByRole('dialog', { name: '分镜表', exact: true }),
      '节奏样片',
    )
    const editor = page.getByRole('dialog', { name: '序列', exact: true })
    await expect(editor.getByText('样片 / 草稿', { exact: true }).first()).toBeVisible()
    await expect(editor.getByText('缺少分镜图', { exact: false }).first()).toBeVisible()
    const viewport = page.viewportSize()!
    await page.setViewportSize({ width: 390, height: 700 })
    await expect(editor.getByRole('button', { name: '关闭', exact: true })).toBeInViewport()
    const play = editor.getByRole('button', { name: '播放', exact: true })
    await play.scrollIntoViewIfNeeded()
    await expect(play).toBeInViewport()
    await editor.getByRole('spinbutton', { name: '样片镜头时长（秒）' }).fill('2.5')
    await editor.getByRole('spinbutton', { name: '对白起始延迟（秒）' }).fill('0.2')
    await editor.getByRole('spinbutton', { name: '对白句间停顿（秒）' }).fill('0.4')
    const draftId = (await elements(page)).find((e) => e.nodeType === 'plein/animatic')!.id
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            (
              window.__plein.engine.doc.get(id)?.params?.shots as
                | Array<{ duration: number }>
                | undefined
            )?.[0]?.duration,
          draftId,
        ),
      )
      .toBe(2.5)
    await expect(editor.locator('.seq-clip').first().locator('img')).toBeVisible()
    await editor.locator('.seq-clip').first().scrollIntoViewIfNeeded()
    await expect(editor.locator('.seq-clip').first()).toBeInViewport()
    await expect(editor.getByRole('button', { name: '关闭', exact: true })).toBeInViewport()
    expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    )
    await page.setViewportSize(viewport)
    // 此用例验证本地合成与交付；字幕字库的烧录在字幕专项验证，避免宿主 libass 差异。
    await editor.getByRole('button', { name: '成片', exact: true }).click()
    const subtitles = editor.getByRole('switch', { name: '开启字幕', exact: true })
    if ((await subtitles.count()) && (await subtitles.getAttribute('aria-checked')) === 'true')
      await subtitles.click()
    await editor.getByRole('button', { name: '导出样片 MP4', exact: true }).click()
    await expect(editor.getByLabel('实际导出 MP4')).toBeVisible({ timeout: 60_000 })
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toContain(`/nodes/${draftId}/run`)
    const video = editor.getByLabel('实际导出 MP4')
    const assetUrl = await video.getAttribute('src')
    expect(assetUrl).toMatch(/\/api\/assets\/[a-f0-9]{64}/)
    expect((await page.request.get(assetUrl!)).headers()['content-type']).toContain('video/mp4')
    const expectedFile = await (await page.request.get(assetUrl!)).body()
    let failDownload = true
    await page.route(`**${assetUrl}`, (route) =>
      route.request().resourceType() === 'fetch' && failDownload
        ? route.fulfill({ status: 503, body: 'temporarily unavailable' })
        : route.continue(),
    )
    await editor.getByRole('button', { name: '下载此版 MP4', exact: true }).click()
    await expect(editor.getByRole('status').filter({ hasText: '原文件读取失败' })).toBeVisible()
    await editor.screenshot({
      path: test.info().outputPath('delivery-download-failed.png'),
      animations: 'disabled',
    })
    failDownload = false
    const downloaded = page.waitForEvent('download')
    await editor.getByRole('button', { name: '重试下载', exact: true }).click()
    const file = await downloaded
    expect(await file.failure()).toBeNull()
    expect(readFileSync((await file.path())!)).toEqual(expectedFile)
    await expect(editor.getByRole('button', { name: '下载此版 MP4', exact: true })).toBeEnabled()
    await editor.getByRole('button', { name: '样片编辑预览', exact: true }).click()
    const currentDownload = page.waitForEvent('download')
    await editor.getByRole('button', { name: '下载成片', exact: true }).click()
    const currentFile = await currentDownload
    expect(await currentFile.failure()).toBeNull()
    expect(readFileSync((await currentFile.path())!)).toEqual(expectedFile)
    await editor.getByRole('button', { name: '实际 MP4 回看 / 交付', exact: true }).click()
    // 播放器读到元数据前添加意见只会保留草稿，先等实际 MP4 就绪
    await expect
      .poll(() =>
        video.evaluate((v: HTMLVideoElement) => v.readyState >= HTMLMediaElement.HAVE_METADATA),
      )
      .toBe(true)
    await page.setViewportSize({ width: 390, height: 700 })
    await expect.poll(async () => (await video.boundingBox())?.width ?? 0).toBeGreaterThan(240)
    await video.evaluate(async (element: HTMLVideoElement) => {
      element.muted = true
      await element.play()
      await new Promise<void>((resolve) => element.requestVideoFrameCallback(() => resolve()))
      element.pause()
      element.currentTime = 0
    })
    const feedback = editor.getByLabel('成片回看与交付', { exact: true })
    const note = '第一镜停顿需要复查 https://example.com/' + 'a'.repeat(200)
    await editor.getByRole('textbox', { name: '成片时间码意见' }).fill(note)
    await editor.getByRole('button', { name: '在当前时间添加意见', exact: true }).click()
    const savedNote = feedback.getByText(note, { exact: true })
    await savedNote.scrollIntoViewIfNeeded()
    await expect(savedNote).toBeInViewport()
    expect(await feedback.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    )
    await expect(editor.getByRole('button', { name: '关闭', exact: true })).toBeInViewport()
    await editor.screenshot({
      path: test.info().outputPath('delivery-narrow-feedback.png'),
      animations: 'disabled',
    })
    await expect(
      editor.getByRole('button', { name: '确认此版草稿已审阅', exact: true }),
    ).toBeDisabled()
    await expect(editor.getByRole('button', { name: '定位镜头返工', exact: true })).toBeVisible()
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => Number.isFinite(v.duration)))
      .toBe(true)
    await video.evaluate((v: HTMLVideoElement) => {
      v.currentTime = v.duration
    })
    await editor.getByRole('textbox', { name: '成片时间码意见' }).fill('片尾镜头需要复查')
    await editor.getByRole('button', { name: '在当前时间添加意见', exact: true }).click()
    await expect(editor.getByRole('button', { name: '定位镜头返工', exact: true })).toHaveCount(2)
    for (const checkbox of await editor
      .getByRole('checkbox', { name: '已解决', exact: true })
      .all())
      await checkbox.check()
    await editor.getByRole('button', { name: '确认此版草稿已审阅', exact: true }).click()
    await expect(editor.getByText('已人工确认此版本', { exact: false })).toBeVisible()
    await page.reload()
    await page.waitForFunction(() => !!window.__plein)
    await zoomTo(page, [draftId])
    const draftPoint = await centerOf(page, draftId)
    await page.mouse.dblclick(draftPoint.x, draftPoint.y)
    await page.getByRole('button', { name: '实际 MP4 回看 / 交付', exact: true }).click()
    await expect(page.getByText('已人工确认此版本', { exact: false })).toBeVisible()
    await expect(page.getByText(note, { exact: true })).toBeVisible()
    await expect(editor.getByRole('button', { name: '关闭', exact: true })).toBeInViewport()
    expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    )
    await expect(page.getByText('片尾镜头需要复查', { exact: true })).toBeVisible()
  },
)

test(
  '动态合成隔离预览：真实桥接播放寻址，编辑后重载并恢复位置',
  { tag: '@core' },
  async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    await addNode(page, '动态合成')
    await expect
      .poll(
        async () => (await elements(page)).filter((el) => el.nodeType === 'plein/motion').length,
      )
      .toBe(1)
    const node = (await elements(page)).find((el) => el.nodeType === 'plein/motion')!
    await page.keyboard.press('Escape')
    await zoomTo(page, [node.id])
    const at = await centerOf(page, node.id)
    await page.mouse.dblclick(at.x, at.y)
    const panel = page.getByRole('dialog', { name: '动态合成', exact: true })
    await expect(panel.locator('.motion-preview')).toHaveAttribute('data-state', 'ready')
    const firstUrl = await panel.locator('iframe').getAttribute('src')
    expect(new URL(firstUrl!).origin).not.toBe(new URL(page.url()).origin)
    expect(new URL(firstUrl!).hostname).toBe('localhost')
    await panel.getByRole('button', { name: '播放预览', exact: true }).click()
    await expect(panel.getByRole('button', { name: '暂停预览', exact: true })).toBeVisible()
    await panel.getByRole('button', { name: '暂停预览', exact: true }).click()
    const seek = panel.getByRole('slider', { name: '预览时间' })
    await seek.focus()
    await seek.press('End')
    await expect(panel.getByLabel('当前预览时间')).toContainText(/0:0[56]\./)
    const title = panel.getByRole('textbox', { name: '标题文案', exact: true })
    await title.fill('在 Plein 中继续创作')
    await title.press('Tab')
    await expect.poll(() => panel.locator('iframe').getAttribute('src')).not.toBe(firstUrl)
    await expect(panel.locator('.motion-preview')).toHaveAttribute('data-state', 'ready')
    await expect(panel.getByLabel('当前预览时间')).toContainText(/0:0[56]\./)
    const bar = await seek.boundingBox()
    await page.mouse.click(bar!.x + bar!.width * 0.4, bar!.y + bar!.height / 2)
    await expect(panel.getByLabel('当前预览时间')).toContainText('0:02.')
    expect((await elements(page)).find((el) => el.id === node.id)?.results).toBe(0)
    expect(errors).toEqual([])
  },
)

// 这批用例要跑真实渲染、编码或很大的工程，单条本来就慢
slowFile(test)
