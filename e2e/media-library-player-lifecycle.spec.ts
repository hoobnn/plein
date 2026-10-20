import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

for (const kind of ['video', 'audio'] as const) {
  test(`素材库 ${kind} 播放中关闭与失败重试释放旧来源`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    const name = `播放器清理-${kind}.${kind === 'video' ? 'mp4' : 'wav'}`
    const data = execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      kind === 'video' ? 'color=c=blue:s=160x96:d=8:r=10' : 'sine=f=440:d=8',
      ...(kind === 'video'
        ? ['-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4']
        : ['-f', 'wav']),
      'pipe:1',
    ])
    const response = await page.request.post('/api/assets', {
      headers: {
        'content-type': kind === 'video' ? 'video/mp4' : 'audio/wav',
        'x-file-name': encodeURIComponent(name),
      },
      data,
    })
    expect(response.status()).toBe(201)
    const id = ((await response.json()) as { id: string }).id
    const otherName = '播放器清理-audio-替代.wav'
    let otherId = ''
    if (kind === 'audio') {
      const data = execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=f=880:d=8',
        '-f',
        'wav',
        'pipe:1',
      ])
      const response = await page.request.post('/api/assets', {
        headers: { 'content-type': 'audio/wav', 'x-file-name': encodeURIComponent(otherName) },
        data,
      })
      expect(response.status()).toBe(201)
      otherId = ((await response.json()) as { id: string }).id
    }
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
      if (kind === 'video')
        await panel.getByRole('button', { name: '放大查看素材', exact: true }).click()
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
    await open()
    await play()
    const closed = await player.elementHandle()
    const atClose = await surface
      .getByRole('button', { name: '关闭', exact: true })
      .evaluate((button, kind) => {
        const media = button.closest('[role="dialog"]')!.querySelector<HTMLMediaElement>(kind)!
        ;(button as HTMLButtonElement).click()
        return new Promise<{ paused: boolean; src: string | null; connected: boolean }>((resolve) =>
          requestAnimationFrame(() =>
            resolve({
              paused: media.paused,
              src: media.getAttribute('src'),
              connected: media.isConnected,
            }),
          ),
        )
      }, kind)
    await test.info().attach('first-closing-frame', {
      body: JSON.stringify(atClose),
      contentType: 'application/json',
    })
    expect(atClose).toMatchObject({ paused: true, src: null })
    await expect(surface).toHaveCount(0)
    await expect
      .poll(() =>
        closed!.evaluate((el: HTMLMediaElement) => ({
          paused: el.paused,
          src: el.getAttribute('src'),
        })),
      )
      .toEqual({ paused: true, src: null })
    await open()
    await play()
    const failed = await player.elementHandle()
    await page.route(`**/api/assets/${id}?failed=1`, (route) => route.fulfill({ status: 503 }))
    await player.evaluate((el: HTMLMediaElement) => {
      el.src += '?failed=1'
      el.load()
    })
    await expect(surface.getByRole('alert')).toContainText(
      kind === 'video' ? '视频加载失败' : '音频加载失败',
    )
    await expect
      .poll(() =>
        failed!.evaluate((el: HTMLMediaElement) => ({
          paused: el.paused,
          src: el.getAttribute('src'),
        })),
      )
      .toEqual({ paused: true, src: null })
    await surface.getByRole('button', { name: '重试加载', exact: true }).click()
    await play()
    await expect(player).toHaveAttribute('src', `/api/assets/${id}`)
    const recovered = await player.elementHandle()
    let final = recovered
    if (kind === 'audio') {
      await panel.getByRole('button', { name: `查看素材 ${otherName}`, exact: true }).click()
      await expect
        .poll(() =>
          recovered!.evaluate((el: HTMLMediaElement) => ({
            paused: el.paused,
            src: el.getAttribute('src'),
          })),
        )
        .toEqual({ paused: true, src: null })
      await play()
      await expect(player).toHaveAttribute('src', `/api/assets/${otherId}`)
      final = await player.elementHandle()
    }
    await surface.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(surface).toHaveCount(0)
    await expect
      .poll(() =>
        final!.evaluate((el: HTMLMediaElement) => ({
          paused: el.paused,
          src: el.getAttribute('src'),
        })),
      )
      .toEqual({ paused: true, src: null })
    expect(errors).toEqual([])
    await closed!.dispose()
    await failed!.dispose()
    await recovered!.dispose()
    if (final !== recovered) await final!.dispose()
  })
}
