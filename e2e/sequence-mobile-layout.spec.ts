import { expect, test } from './fixtures'
import { centerOf, newProject, zoomTo } from './canvas'

for (const viewport of [
  { width: 390, height: 700, aspectRatio: '16:9', minWidth: 240, minHeight: 100 },
  { width: 800, height: 560, aspectRatio: '9:16', minWidth: 130, minHeight: 240 },
  { width: 390, height: 700, aspectRatio: '9:16', minWidth: 130, minHeight: 240 },
]) {
  test(`序列 ${viewport.width}×${viewport.height} ${viewport.aspectRatio} 中预览、编辑、时间线与关闭均可访问`, async ({
    page,
  }) => {
    await newProject(page)
    const id = await page.evaluate(
      (aspectRatio) =>
        window.__plein.addNode({
          type: 'plein/animatic',
          name: '小窗口序列布局',
          x: 300,
          y: 200,
          params: {
            aspectRatio,
            subtitles: false,
            shots: [{ shotId: 'one', duration: 3, dialogue: [] }],
          },
        }),
      viewport.aspectRatio,
    )
    await zoomTo(page, [id])
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
    const editor = page.getByRole('dialog', { name: '序列', exact: true })
    await expect(editor).toBeVisible()
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    const close = editor.getByRole('button', { name: '关闭', exact: true })
    await expect(close).toBeInViewport()
    expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    )
    const stage = editor.locator('.seq-stage')
    await expect
      .poll(async () => (await stage.boundingBox())?.width ?? 0)
      .toBeGreaterThan(viewport.minWidth)
      .catch(async (error) => {
        const layout = await editor
          .locator('.seq-edit-top, .seq-monitor, .seq-viewer, .seq-stage, .seq-inspector')
          .evaluateAll((elements) =>
            elements.map((element) => {
              const rect = element.getBoundingClientRect()
              const css = getComputedStyle(element)
              return {
                className: element.className,
                width: rect.width,
                height: rect.height,
                flex: css.flex,
                minHeight: css.minHeight,
              }
            }),
          )
        await test.info().attach('sequence-layout', {
          body: JSON.stringify(layout, null, 2),
          contentType: 'application/json',
        })
        throw error
      })
    await expect
      .poll(async () => (await stage.boundingBox())?.height ?? 0)
      .toBeGreaterThan(viewport.minHeight)
    const play = editor.getByRole('button', { name: '播放', exact: true })
    expect(
      await stage
        .getByText('缺少分镜图 · 保留镜头时长与已有配音', { exact: true })
        .evaluate((element) => {
          const range = document.createRange()
          range.selectNodeContents(element)
          const text = range.getBoundingClientRect()
          const frame = element.closest('.seq-stage')!.getBoundingClientRect()
          return text.left >= frame.left - 1 && text.right <= frame.right + 1
        }),
    ).toBe(true)
    await play.scrollIntoViewIfNeeded()
    await expect(play).toBeInViewport()
    await editor.screenshot({
      path: test
        .info()
        .outputPath(
          `sequence-${viewport.width}-${viewport.height}-${viewport.aspectRatio.replace(':', '-')}-preview.png`,
        ),
      animations: 'disabled',
    })
    const input = editor.getByRole('spinbutton', { name: '样片镜头时长（秒）', exact: true })
    await input.scrollIntoViewIfNeeded()
    await input.fill('4.5')
    await input.blur()
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            (window.__plein.engine.doc.get(id)!.params!.shots as Array<{ duration: number }>)[0]!
              .duration,
          id,
        ),
      )
      .toBe(4.5)
    const clip = editor.locator('.seq-clip').first()
    await clip.scrollIntoViewIfNeeded()
    await expect(clip).toBeInViewport()
    await expect(close).toBeInViewport()
    expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    )
    await editor.screenshot({
      path: test
        .info()
        .outputPath(
          `sequence-${viewport.width}-${viewport.height}-${viewport.aspectRatio.replace(':', '-')}.png`,
        ),
      animations: 'disabled',
    })
    await close.click()
    await expect(editor).not.toBeVisible()
  })
}
