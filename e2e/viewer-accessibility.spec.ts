import { expect, test } from './fixtures'
import { execFileSync } from 'node:child_process'
import { clickElement, clickRun, newProject, revealGenerator, waitNode } from './canvas'

for (const format of ['audio', 'video', 'h264'] as const) {
  const kind = format === 'h264' ? 'video' : format
  test(`${format} 正常播放器使用素材名称，候选切换、改名和失败恢复不误报不可播放`, async ({
    page,
    context,
  }) => {
    await newProject(page)
    const name = `${kind}命名回归`
    const id = await page.evaluate(
      ({ kind, name }) =>
        window.__plein.addNode({
          type: kind === 'audio' ? 'plein/speech' : 'plein/video',
          name,
          x: 400,
          y: 200,
          params: {
            model: `plein/mock:${kind}`,
            prompt: '播放器命名检查',
            text: '这是正常播放的音频。',
          },
        }),
      { kind, name },
    )
    await clickElement(page, id)
    // 编辑器固定在卡片下方，先把它移进窗口再点里面的控件
    await revealGenerator(page)
    const generator = page.getByTestId('generator')
    await clickRun(page)
    await waitNode(page, id)
    await generator.getByRole('button', { name: '重新生成', exact: true }).click()
    await expect
      .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length, id))
      .toBe(2)
    await waitNode(page, id)
    if (format === 'h264') {
      // 真实 2K 无音轨 MP4；Mock 默认 WebM 不能代表付费平台返回的编码。
      const assets: string[] = []
      for (const color of ['blue', 'green']) {
        const data = execFileSync('ffmpeg', [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          `color=c=${color}:s=2560x1440:r=24:d=2`,
          '-an',
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
        const response = await page.request.post('/api/assets', {
          headers: { 'content-type': 'video/mp4', 'x-file-name': `2k-${color}.mp4` },
          data,
        })
        expect(response.status()).toBe(201)
        assets.push((await response.json()).id)
      }
      await page.evaluate(
        ({ id, assets }) => {
          const node = window.__plein.engine.doc.mutable(id) as unknown as {
            get(key: string): unknown
            set(key: string, value: unknown): void
          }
          const results = node.get('results') as Array<{ value: Record<string, unknown> }>
          node.set(
            'results',
            results.map((r, i) => ({ ...r, value: { ...r.value, assetId: assets[i] } })),
          )
        },
        { id, assets },
      )
    }
    const before = await page.evaluate((id) => window.__plein.engine.doc.get(id)!.adopted, id)
    const open = () => generator.getByRole('button', { name: '全屏查看', exact: true }).click()
    await open()
    const viewer = page.getByRole('dialog', { name: `查看「${name}」`, exact: true })
    const media = viewer.locator(kind)
    const label = `${name} ${kind === 'audio' ? '音频' : '视频'}播放器`
    await expect
      .poll(() => media.evaluate((el) => (el as HTMLMediaElement).readyState))
      .toBeGreaterThanOrEqual(2)
    if (format === 'h264')
      expect(
        await media.evaluate((el) => {
          const video = el as HTMLVideoElement
          return [video.videoWidth, video.videoHeight, video.error]
        }),
      ).toEqual([2560, 1440, null])
    await expect(media).toHaveAccessibleName(label)
    if (kind === 'video')
      await expect.poll(async () => (await media.boundingBox())?.width ?? 0).toBeGreaterThan(320)
    const cdp = await context.newCDPSession(page)
    const tree = (await cdp.send('Accessibility.getFullAXTree')) as {
      nodes: Array<{ ignored?: boolean; role?: { value?: string }; name?: { value?: string } }>
    }
    expect(
      tree.nodes.find((node) => node.role?.value === (kind === 'audio' ? 'Audio' : 'Video'))?.name
        ?.value,
    ).toBe(label)
    expect(
      tree.nodes.filter(
        (node) => !node.ignored && /无法播放媒体|unable to play media/i.test(JSON.stringify(node)),
      ),
    ).toEqual([])
    await test.info().attach('native-media-accessibility.json', {
      body: JSON.stringify(
        tree.nodes.filter((node) => ['Audio', 'Video'].includes(node.role?.value ?? '')),
        null,
        2,
      ),
      contentType: 'application/json',
    })
    await cdp.detach()
    await media.evaluate(async (el) => {
      const player = el as HTMLMediaElement
      await player.play()
      player.currentTime = 0
    })
    await expect
      .poll(() => media.evaluate((el) => (el as HTMLMediaElement).currentTime))
      .toBeGreaterThan(0)
    await expect(viewer.getByRole('alert')).toHaveCount(0)
    await viewer.getByRole('button', { name: '预览下一个候选', exact: true }).click()
    await expect(media).toHaveAccessibleName(label)
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)!.adopted, id)).toBe(before)
    await page.evaluate((id) => {
      const node = window.__plein.engine.doc.mutable(id) as unknown as {
        set(key: string, value: unknown): void
      }
      node.set('name', '协作改名后的播放器')
    }, id)
    const renamed = page.getByRole('dialog', { name: '查看「协作改名后的播放器」', exact: true })
    await expect(renamed.locator(kind)).toHaveAccessibleName(
      `协作改名后的播放器 ${kind === 'audio' ? '音频' : '视频'}播放器`,
    )
    // 重开审片会回到采用项；故障应拦截它，而不是刚才浏览但未采用的另一个候选。
    await renamed.getByRole('button', { name: '预览上一个候选', exact: true }).click()
    await expect
      .poll(() => renamed.locator(kind).evaluate((el) => (el as HTMLMediaElement).readyState))
      .toBeGreaterThanOrEqual(2)
    const asset = await renamed.locator(kind).getAttribute('src')
    await renamed.getByRole('button', { name: '关闭', exact: true }).click()
    let failing = true
    await page.route(asset!, (route) =>
      failing ? route.fulfill({ status: 503, body: 'temporary media failure' }) : route.continue(),
    )
    await open()
    await expect(renamed.getByRole('alert')).toHaveText(
      kind === 'audio' ? '音频加载失败' : '视频加载失败',
    )
    await expect(renamed.locator(kind)).toHaveCount(0)
    failing = false
    await renamed.getByRole('button', { name: '重新加载媒体', exact: true }).click()
    await expect
      .poll(() => renamed.locator(kind).evaluate((el) => (el as HTMLMediaElement).readyState))
      .toBeGreaterThanOrEqual(2)
    await expect(renamed.locator(kind)).toHaveAccessibleName(
      `协作改名后的播放器 ${kind === 'audio' ? '音频' : '视频'}播放器`,
    )
    await expect(renamed.getByRole('alert')).toHaveCount(0)
    await renamed.screenshot({ path: test.info().outputPath('named-media-recovered.png') })
    await renamed.getByRole('button', { name: '关闭', exact: true }).click()
    const meta = await (await page.request.get(`${asset}/meta`)).json()
    await page.getByRole('button', { name: '素材', exact: true }).click()
    const library = page.getByRole('dialog', { name: '素材', exact: true })
    await library.getByRole('button', { name: `查看素材 ${meta.name}`, exact: true }).click()
    let surface = library
    if (kind === 'video') {
      await library.getByRole('button', { name: '放大查看素材', exact: true }).click()
      surface = page.getByRole('dialog', { name: '素材预览', exact: true })
    }
    await expect
      .poll(() => surface.locator(kind).evaluate((el) => (el as HTMLMediaElement).readyState))
      .toBeGreaterThanOrEqual(2)
    await expect(surface.locator(kind)).toHaveAccessibleName(
      `${meta.name} ${kind === 'audio' ? '音频' : '视频'}播放器`,
    )
    if (kind === 'video') {
      await expect
        .poll(async () => (await surface.locator(kind).boundingBox())?.width ?? 0)
        .toBeGreaterThan(320)
      await page.setViewportSize({ width: 800, height: 560 })
      const box = (await surface.locator(kind).boundingBox())!
      expect(box.width).toBeGreaterThan(320)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(800)
      expect(box.y + box.height).toBeLessThanOrEqual(560)
      await surface.screenshot({ path: test.info().outputPath('small-video-fitted.png') })
      await page.setViewportSize({ width: 1440, height: 900 })
    }
    if (kind === 'video') await surface.getByRole('button', { name: '关闭', exact: true }).click()
    await library.getByRole('button', { name: '关闭', exact: true }).click()
  })
}
