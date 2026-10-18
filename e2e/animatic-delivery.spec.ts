import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { centerOf, elements, newProject, waitNode, zoomTo } from './canvas'

const canvasId = (url: string) => decodeURIComponent(url.split('#/c/')[1]!.split('?')[0]!)
test('分镜图片与已有配音预演，零视频生成导出样片并按实际MP4记录交付意见', async ({ page }) => {
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
  await page.getByRole('button', { name: '节奏样片', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  await expect(editor.getByText('样片 / 草稿', { exact: true }).first()).toBeVisible()
  await expect(editor.getByText('缺少分镜图', { exact: false }).first()).toBeVisible()
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
  await editor.getByRole('textbox', { name: '成片时间码意见' }).fill('第一镜停顿需要复查')
  await editor.getByRole('button', { name: '在当前时间添加意见', exact: true }).click()
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
  for (const checkbox of await editor.getByRole('checkbox', { name: '已解决', exact: true }).all())
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
  await expect(page.getByText('第一镜停顿需要复查', { exact: true })).toBeVisible()
  await expect(page.getByText('片尾镜头需要复查', { exact: true })).toBeVisible()
})
