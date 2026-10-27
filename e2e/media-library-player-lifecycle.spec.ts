import { execFileSync } from 'node:child_process'
import { expect, test, type ElementHandle } from './fixtures'
import { newProject } from './canvas'

/** 用 ffmpeg 现场生成一段可解码的音视频，播放行为必须走真实解码。 */
function makeMedia(kind: 'video' | 'audio', freq = 440) {
  return execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    kind === 'video' ? 'color=c=blue:s=160x96:d=8:r=10' : `sine=f=${freq}:d=8`,
    ...(kind === 'video'
      ? ['-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4']
      : ['-f', 'wav']),
    'pipe:1',
  ])
}

for (const kind of ['video', 'audio'] as const) {
  test(`素材库 ${kind} 播放中关闭与失败重试释放旧来源`, { tag: '@core' }, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)

    const upload = async (name: string, freq: number) => {
      const response = await page.request.post('/api/assets', {
        headers: {
          'content-type': kind === 'video' ? 'video/mp4' : 'audio/wav',
          'x-file-name': encodeURIComponent(name),
        },
        data: makeMedia(kind, freq),
      })
      expect(response.status()).toBe(201)
      return ((await response.json()) as { id: string }).id
    }

    const name = `播放器清理-${kind}.${kind === 'video' ? 'mp4' : 'wav'}`
    const id = await upload(name, 440)
    // 音频还要第二个素材，用来验证换素材时旧播放器也会释放
    const otherName = '播放器清理-audio-替代.wav'
    const otherId = kind === 'audio' ? await upload(otherName, 880) : ''

    const panel = page.getByRole('dialog', { name: '素材', exact: true })
    const preview = page.getByRole('dialog', { name: '素材预览', exact: true })
    const open = async () => {
      if (!(await panel.isVisible())) {
        await page.getByRole('button', { name: '素材', exact: true }).click()
        await panel.getByRole('combobox', { name: '关联项目' }).click()
        await page.getByRole('option', { name: '全部项目', exact: true }).click()
        await panel.getByRole('searchbox', { name: '搜索素材', exact: true }).fill('播放器清理')
        await panel.getByRole('button', { name: `查看素材 ${name}`, exact: true }).click()
      }
      if (kind === 'video') await panel.getByRole('button', { name: '放大查看素材' }).click()
    }
    const surface = kind === 'video' ? preview : panel
    const player = surface.locator(kind)
    const play = async () => {
      await expect
        .poll(() => player.evaluate((el: HTMLMediaElement) => el.readyState))
        .toBeGreaterThanOrEqual(1)
      await player.evaluate((el: HTMLMediaElement) => el.play())
      await expect
        .poll(() => player.evaluate((el: HTMLMediaElement) => el.currentTime))
        .toBeGreaterThan(0)
    }
    /** 播放器必须停下来并清掉来源，否则会继续出声或占着连接。 */
    const released = (handle: ElementHandle<Element>) =>
      expect
        .poll(() =>
          handle.evaluate((el: HTMLMediaElement) => ({
            paused: el.paused,
            src: el.getAttribute('src'),
          })),
        )
        .toEqual({ paused: true, src: null })
    /**
     * 点关闭后只看下一帧：退出动画期间还在播、或来源还挂着，都算没释放干净。
     * 面板消失之后再断言会漏掉这两类问题。
     */
    const closeAndCheckFirstFrame = async () => {
      const atClose = await surface
        .getByRole('button', { name: '关闭', exact: true })
        .evaluate((button, mediaKind) => {
          const media = button
            .closest('[role="dialog"]')!
            .querySelector<HTMLMediaElement>(mediaKind)!
          ;(button as HTMLButtonElement).click()
          return new Promise<{ paused: boolean; src: string | null }>((resolve) =>
            requestAnimationFrame(() =>
              resolve({ paused: media.paused, src: media.getAttribute('src') }),
            ),
          )
        }, kind)
      expect(atClose).toEqual({ paused: true, src: null })
    }

    const handles: Array<ElementHandle<Element>> = []
    await open()
    await play()
    const playing = await player.elementHandle()
    handles.push(playing!)
    // 关闭预览：旧播放器下一帧就要停播并断开来源
    await closeAndCheckFirstFrame()
    await expect(surface).toHaveCount(0)
    await released(playing!)

    // 重新打开后注入加载失败：报错的同时旧播放器也要释放
    await open()
    await play()
    const failing = await player.elementHandle()
    handles.push(failing!)
    await page.route(`**/api/assets/${id}?failed=1`, (route) => route.fulfill({ status: 503 }))
    await player.evaluate((el: HTMLMediaElement) => {
      el.src += '?failed=1'
      el.load()
    })
    await expect(surface.getByRole('alert')).toContainText(
      kind === 'video' ? '视频加载失败' : '音频加载失败',
    )
    await released(failing!)
    // 重试后要能真的播起来
    await surface.getByRole('button', { name: '重试加载', exact: true }).click()
    await play()
    await expect(player).toHaveAttribute('src', `/api/assets/${id}`)

    if (kind === 'audio') {
      // 换素材：上一段播放必须先停下来
      const recovered = await player.elementHandle()
      handles.push(recovered!)
      await panel.getByRole('button', { name: `查看素材 ${otherName}`, exact: true }).click()
      await released(recovered!)
      await play()
      await expect(player).toHaveAttribute('src', `/api/assets/${otherId}`)
    }

    // 最后这段播放器也要释放：关掉面板不能让它留在后台出声
    const last = await player.elementHandle()
    handles.push(last!)
    await closeAndCheckFirstFrame()
    await expect(surface).toHaveCount(0)
    await released(last!)
    expect(errors).toEqual([])
    for (const handle of handles) await handle.dispose()
  })
}
