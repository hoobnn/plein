import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { expect, test } from './fixtures'
import { newProject, revealGenerator, waitNode, zoomTo } from './canvas'

const sharp = createRequire(new URL('../apps/server/package.json', import.meta.url))(
  'sharp',
) as typeof import('../apps/server/node_modules/sharp').default

/** 截图的中心像素：用来判断画面真的画出来了，而不只是元素在 DOM 里。 */
async function centerRgb(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const at = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4
  return [data[at]!, data[at + 1]!, data[at + 2]!]
}

test.describe('媒体浏览器冒烟', { tag: '@core' }, () => {
  test('图片平移只处理当前指针，取消、失焦、切换与重置结束拖动', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    const target = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/image',
        name: '平移边界',
        params: { model: 'plein/mock:image', prompt: '两个候选', count: 2 },
        x: 400,
        y: 300,
      }),
    )
    await page.getByRole('treeitem', { name: '平移边界 定位到画布', exact: true }).click()
    // 编辑器固定在卡片下方，先把它移进窗口再点生成
    await revealGenerator(page)
    const generator = page.getByTestId('generator')
    await generator.getByRole('button', { name: '生成', exact: true }).click()
    await waitNode(page, target)
    const adopted = await page.evaluate(
      (id) => window.__plein.engine.doc.mutable(id)?.get('adopted'),
      target,
    )
    const open = () => generator.getByRole('button', { name: '全屏查看', exact: true }).click()
    await open()
    const viewer = page.getByRole('dialog', { name: '查看「平移边界」', exact: true })
    const surface = viewer.getByRole('img', { name: '平移边界', exact: true }).locator('..')
    const transform = () => surface.evaluate((node: HTMLElement) => node.style.transform)
    const box = (await surface.boundingBox())!
    const x = box.x + box.width / 2,
      y = box.y + box.height / 2
    const origin = await transform()
    await page.mouse.move(x, y)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(x + 40, y)
    await page.mouse.up({ button: 'right' })
    expect(await transform()).toBe(origin)
    const begin = async () => {
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 30, y, { steps: 3 })
    }
    await begin()
    const active = await transform()
    await surface.dispatchEvent('pointermove', { pointerId: 2, clientX: x + 250, clientY: y })
    expect(await transform()).toBe(active)
    await surface.dispatchEvent('pointerup', { pointerId: 2 })
    await surface.dispatchEvent('pointercancel', { pointerId: 2 })
    await page.mouse.move(x + 60, y)
    expect(await transform()).not.toBe(active)
    const canceled = await transform()
    await surface.dispatchEvent('pointercancel', { pointerId: 1 })
    await page.mouse.move(x + 90, y)
    await page.mouse.up()
    expect(await transform()).toBe(canceled)
    for (const end of ['capture', 'blur'] as const) {
      await begin()
      const before = await transform()
      if (end === 'capture') await surface.evaluate((node) => node.releasePointerCapture(1))
      else await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      await page.mouse.move(x + 90, y)
      await page.mouse.up()
      expect(await transform()).toBe(before)
      await expect(surface).toHaveCSS('cursor', 'grab')
    }
    await begin()
    await page.keyboard.press('ArrowRight')
    await page.mouse.move(x + 100, y)
    await page.mouse.up()
    expect(await transform()).toBe(origin)
    await expect(surface).toHaveCSS('cursor', 'grab')
    await begin()
    await viewer.getByRole('button', { name: '重置图片视图', exact: true }).focus()
    await page.keyboard.press('Enter')
    await page.mouse.move(x + 100, y)
    await page.mouse.up()
    expect(await transform()).toBe(origin)
    await begin()
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    await page.mouse.move(x + 100, y)
    await page.mouse.up()
    await open()
    expect(await transform()).toBe(origin)
    await expect(surface).toHaveCSS('cursor', 'grab')
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), target),
    ).toBe(adopted)
    expect(errors).toEqual([])
  })

  test('图片候选与对比图可独立恢复，滑杆和缩放不遮挡重试且不改变采用', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    const assets: string[] = []
    for (const color of ['blue', 'green']) {
      const data = execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=c=${color}:s=96x64`,
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        'pipe:1',
      ])
      const response = await page.request.post('/api/assets', {
        headers: { 'content-type': 'image/png', 'x-file-name': `review-${color}.png` },
        data,
      })
      expect(response.status()).toBe(201)
      assets.push(((await response.json()) as { id: string }).id)
    }
    const target = await page.evaluate((assets) => {
      const id = window.__plein.addNode({
        type: 'plein/image',
        name: '候选图恢复',
        params: { prompt: '比较两张图片' },
        x: 400,
        y: 300,
      })
      const mutable = window.__plein.engine.doc.mutable(id) as unknown as {
        set(key: string, value: unknown): void
      }
      mutable.set(
        'results',
        [...assets, assets[1]!].map((assetId, index) => ({
          id: `image-${index}`,
          runId: 'fixture-run',
          port: 'images',
          value: { type: 'image', assetId },
          at: index + 1,
        })),
      )
      mutable.set('adopted', 'image-0')
      return id
    }, assets)
    const failed = new Set(assets)
    const requests = [0, 0]
    for (const [index, id] of assets.entries())
      await page.route(`**/api/assets/${id}`, (route) => {
        requests[index] = requests[index]! + 1
        return failed.has(id) ? route.fulfill({ status: 503 }) : route.continue()
      })
    const next = page.getByRole('button', { name: '下一个结果', exact: true })
    await expect(next).toBeVisible()
    await zoomTo(page, [target])
    await next.click()
    const viewer = page.getByRole('dialog', { name: '查看「候选图恢复」', exact: true })
    await viewer.getByRole('button', { name: '预览上一个候选', exact: true }).click()
    await expect(viewer.getByRole('alert')).toContainText('图片加载失败')
    // 对比下拉已换成 ui/Select（Base UI），点开触发器再点选项；弹层挂在 body 上
    await viewer.getByRole('combobox', { name: '对比候选' }).click()
    await page.getByRole('option', { name: /^候选 2/ }).click()
    await expect(viewer.getByRole('alert')).toHaveCount(2)
    await viewer.screenshot({
      path: test.info().outputPath('image-comparison-failed.png'),
      animations: 'disabled',
    })
    failed.delete(assets[0]!)
    await viewer.getByRole('button', { name: '重新加载候选 A', exact: true }).click()
    await expect
      .poll(() =>
        viewer
          .getByRole('img', { name: '候选 A', exact: true })
          .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true)
    await expect(viewer.getByRole('alert')).toHaveCount(1)
    await viewer.getByRole('combobox', { name: '对比方式' }).click()
    await page.getByRole('option', { name: '滑杆', exact: true }).click()
    await viewer.getByRole('slider', { name: '图片对比滑杆' }).fill('90')
    for (let i = 0; i < 4; i++)
      await viewer.getByRole('button', { name: '放大图片', exact: true }).click()
    const retry = viewer.getByRole('button', { name: '重新加载候选 B', exact: true })
    const before = requests[1]!
    await retry.focus()
    await retry.press('Enter')
    await expect.poll(() => requests[1]).toBeGreaterThan(before)
    await expect(retry).toBeVisible()
    await viewer.screenshot({
      path: test.info().outputPath('image-slider-failed.png'),
      animations: 'disabled',
    })
    failed.delete(assets[1]!)
    await retry.click()
    await expect
      .poll(() =>
        viewer
          .getByRole('img', { name: '候选 B', exact: true })
          .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true)
    await expect(viewer.getByRole('alert')).toHaveCount(0)
    await viewer.getByRole('combobox', { name: '对比候选' }).click()
    await page.getByRole('option', { name: '不对比', exact: true }).click()
    await viewer.getByRole('button', { name: '预览下一个候选', exact: true }).click()
    await expect(viewer.getByRole('img', { name: '候选图恢复', exact: true })).toHaveAttribute(
      'src',
      new RegExp(assets[1]!),
    )
    await expect(viewer.getByRole('alert')).toHaveCount(0)
    await viewer.getByRole('combobox', { name: '对比候选' }).click()
    await page.getByRole('option', { name: /^候选 3/ }).click()
    const duplicate = viewer.getByRole('img', { name: '候选 B', exact: true })
    await expect
      .poll(() =>
        duplicate.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true)
    // 同一 URL 可能复用已解码缓存，用受控错误事件检查两侧状态隔离。
    // 注入要排在真实 load 的处理之后：complete 为真只说明资源就位，load 任务可能
    // 还在队列里，迟到的 onLoad 会把刚注入的失败态清掉（预期 1 个 alert 会变 0）。
    // 派发排进页面自己的定时器队列，就一定晚于先入队的 load 任务。
    await duplicate.evaluate((image: HTMLImageElement) => {
      setTimeout(() => image.dispatchEvent(new Event('error', { bubbles: false })), 0)
    })
    await expect(viewer.getByRole('alert')).toHaveCount(1)
    await expect(viewer.getByRole('alert')).toHaveText('候选 B加载失败')
    await expect
      .poll(() =>
        viewer
          .getByRole('img', { name: '候选 A', exact: true })
          .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true)
    await retry.click()
    await expect
      .poll(() =>
        duplicate.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true)
    await expect(viewer.getByRole('alert')).toHaveCount(0)
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), target),
    ).toBe('image-0')
    expect(errors).toEqual([])
  })

  for (const kind of ['audio', 'video'] as const) {
    test(`候选${kind}失败可恢复，切换和关闭停止旧播放且不改变采用`, async ({ page, context }) => {
      await newProject(page)
      const assets: string[] = []
      for (const index of [0, 1]) {
        const data = execFileSync('ffmpeg', [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          kind === 'audio'
            ? `sine=f=${440 + index * 220}:d=8`
            : `color=c=${index ? 'green' : 'blue'}:s=2560x1440:d=2:r=12`,
          ...(kind === 'audio'
            ? ['-f', 'wav']
            : ['-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4']),
          'pipe:1',
        ])
        const response = await page.request.post('/api/assets', {
          headers: {
            'content-type': kind === 'audio' ? 'audio/wav' : 'video/mp4',
            'x-file-name': `review-${kind}-${index}.${kind === 'audio' ? 'wav' : 'mp4'}`,
          },
          data,
        })
        expect(response.status()).toBe(201)
        assets.push(((await response.json()) as { id: string }).id)
      }
      const target = await page.evaluate(
        ({ kind, assets }) => {
          const id = window.__plein.addNode({
            type: kind === 'audio' ? 'plein/speech' : 'plein/video',
            name: `恢复${kind}候选`,
            params: {},
            x: 400,
            y: 300,
          })
          const mutable = window.__plein.engine.doc.mutable(id) as unknown as {
            set(key: string, value: unknown): void
          }
          mutable.set(
            'results',
            assets.map((assetId, index) => ({
              id: `candidate-${index}`,
              runId: 'fixture-run',
              port: kind,
              value: { type: kind, assetId },
              at: index + 1,
            })),
          )
          mutable.set('adopted', 'candidate-0')
          return id
        },
        { kind, assets },
      )
      let fail = true
      await page.route(`**/api/assets/${assets[0]}`, (route) =>
        fail ? route.fulfill({ status: 503 }) : route.continue(),
      )
      const next = page.getByRole('button', { name: '下一个结果', exact: true })
      await expect(next).toBeVisible()
      await zoomTo(page, [target])
      await next.click()
      const viewer = page.getByRole('dialog', { name: `查看「恢复${kind}候选」`, exact: true })
      await viewer.getByRole('button', { name: '预览上一个候选', exact: true }).click()
      await expect(viewer.getByRole('alert')).toContainText(
        kind === 'audio' ? '音频加载失败' : '视频加载失败',
      )
      const retry = viewer.getByRole('button', { name: '重新加载媒体', exact: true })
      await retry.focus()
      await retry.press('Enter')
      await expect(retry).toBeVisible()
      await viewer.screenshot({
        path: test.info().outputPath(`${kind}-failure.png`),
        animations: 'disabled',
      })
      await viewer.getByRole('button', { name: '预览下一个候选', exact: true }).click()
      const player = viewer.locator(kind)
      const label = `恢复${kind}候选 ${kind === 'audio' ? '音频' : '视频'}播放器`
      await expect(player).toHaveAccessibleName(label)
      await expect
        .poll(() => player.evaluate((el: HTMLMediaElement) => el.readyState))
        .toBeGreaterThanOrEqual(1)
      await player.evaluate((el: HTMLMediaElement) => el.play())
      await expect
        .poll(() => player.evaluate((el: HTMLMediaElement) => el.currentTime))
        .toBeGreaterThan(0)
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
          (node) =>
            !node.ignored && /无法播放媒体|unable to play media/i.test(JSON.stringify(node)),
        ),
      ).toEqual([])
      await cdp.detach()
      if (kind === 'video')
        expect(
          await player.evaluate((el: HTMLVideoElement) => [el.videoWidth, el.videoHeight]),
        ).toEqual([2560, 1440])
      const previous = await player.elementHandle()
      await viewer.getByRole('button', { name: '预览上一个候选', exact: true }).click()
      await expect(viewer.getByRole('alert')).toBeVisible()
      await expect
        .poll(() =>
          previous!.evaluate((el: HTMLMediaElement) => el.paused && !el.getAttribute('src')),
        )
        .toBe(true)
      fail = false
      await retry.click()
      await expect
        .poll(() => player.evaluate((el: HTMLMediaElement) => el.readyState))
        .toBeGreaterThanOrEqual(1)
      await player.evaluate((el: HTMLMediaElement) => el.play())
      await expect
        .poll(() => player.evaluate((el: HTMLMediaElement) => el.currentTime))
        .toBeGreaterThan(0)
      await expect(player).toHaveAttribute('src', new RegExp(assets[0]!))
      expect(
        await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), target),
      ).toBe('candidate-0')
      const closing = await player.elementHandle()
      await viewer.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(viewer).toHaveCount(0)
      await expect
        .poll(() =>
          closing!.evaluate((el: HTMLMediaElement) => el.paused && !el.getAttribute('src')),
        )
        .toBe(true)
      await previous!.dispose()
      await closing!.dispose()
    })
  }

  test('历史双击视频打开审片浮层后画面可见、能播放，关闭后历史恢复可点', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    const target = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/video',
        name: '双击审片',
        params: { model: 'plein/mock:video', mode: 'text', prompt: '双击打开审片', duration: 2 },
        x: 400,
        y: 300,
      }),
    )
    const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
    await expect
      .poll(async () =>
        (await page.request.get(`/api/canvases/${canvas}/nodes/${target}/input`)).status(),
      )
      .toBe(200)
    expect(
      (
        await page.request.post(`/api/canvases/${canvas}/nodes/${target}/run`, { data: {} })
      ).status(),
    ).toBe(202)
    await waitNode(page, target)
    await page.getByRole('button', { name: '生成历史', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '生成历史', exact: true })
    const card = panel.getByRole('button', { name: '预览「双击审片」' })
    await expect(card).toBeVisible()
    await expect.poll(() => panel.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1)
    // 缩略图就是视频首帧，记下它的颜色，稍后确认审片区画的是同一帧
    const expected = await centerRgb(
      await card.locator('img').screenshot({ animations: 'disabled' }),
    )
    const box = (await card.boundingBox())!
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)
    const viewer = page.getByRole('dialog', { name: '查看「双击审片」', exact: true })
    // 初始帧停在 opacity 0 时浮层只剩声音、画面全黑，这一步必须等它真的显示出来
    await expect.poll(() => viewer.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1)
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()
    const player = viewer.locator('video')
    await expect
      .poll(() => player.evaluate((el: HTMLVideoElement) => el.readyState))
      .toBeGreaterThanOrEqual(2)
    await expect
      .poll(() => player.evaluate((el: HTMLVideoElement) => el.currentTime))
      .toBeGreaterThan(0)
    expect(await player.evaluate((el: HTMLVideoElement) => el.videoWidth)).toBe(64)
    const media = (await player.boundingBox())!
    expect(media.width).toBeGreaterThan(0)
    expect(media.height).toBeGreaterThan(0)
    const painted = await centerRgb(
      await page.screenshot({
        clip: {
          x: media.x + media.width / 2 - 2,
          y: media.y + media.height / 2 - 2,
          width: 4,
          height: 4,
        },
      }),
    )
    for (const [index, value] of expected.entries())
      expect(Math.abs(painted[index]! - value), `审片区第 ${index} 个通道应为视频帧`).toBeLessThan(
        24,
      )
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    await expect(panel).toBeVisible()
    // 关掉审片后历史必须重新可以点：不能有残留的透明浮层盖在上面
    expect(
      await page.evaluate(
        ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[aria-label="预览「双击审片」"]'),
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      ),
    ).toBe(true)
    await expect(card).toBeVisible()
    expect(errors).toEqual([])
  })
})
