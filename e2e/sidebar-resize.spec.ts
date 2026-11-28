import { expect, test } from './fixtures'
import { newProject, waitEngine } from './canvas'

test(
  '侧栏拖宽：跟手、松手提交、Esc 取消恢复、方向键微调、刷新后宽度保持',
  { tag: '@core' },
  async ({ page }) => {
    await newProject(page)
    const sidebar = page.locator('aside[aria-label="侧栏"]')
    await expect(sidebar).toBeVisible()
    const handle = page.getByRole('separator', { name: '调整侧栏宽度' })
    const width = async () => (await sidebar.boundingBox())!.width
    const before = await width()

    // 拖动中宽度就跟着走（跟手），松手提交偏好
    const box = await handle.boundingBox()
    const y = box!.y + box!.height / 2
    const x = box!.x + box!.width / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 40, y, { steps: 4 })
    expect(await width()).toBeGreaterThan(before + 20)
    await page.mouse.move(x + 142, y, { steps: 4 })
    await page.mouse.up()
    const widened = await width()
    expect(widened).toBeGreaterThan(before + 60)
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('plein:sidebar-width')))
      .toBe(String(Math.round(widened)))

    // Esc 取消：宽度恢复拖拽前值，偏好不动
    const stored = await page.evaluate(() => localStorage.getItem('plein:sidebar-width'))
    const box2 = await handle.boundingBox()
    await page.mouse.move(box2!.x + box2!.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(box2!.x + box2!.width / 2 + 60, y, { steps: 4 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    expect(await width()).toBe(widened)
    expect(await page.evaluate(() => localStorage.getItem('plein:sidebar-width'))).toBe(stored)

    // 方向键微调：8px 一步并提交
    await handle.focus()
    await page.keyboard.press('ArrowRight')
    expect(await width()).toBe(Math.round(widened) + 8)
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('plein:sidebar-width')))
      .toBe(String(Math.round(widened) + 8))

    // 宽度变化的第一帧也不能把侧栏按上一个视口的百分比拉伸到画布上。
    const preferred = Math.round(widened) + 8
    for (const target of [390, 320, 1440]) {
      const sample = await sidebar.evaluateHandle((panel) => ({
        width: new Promise<number>((resolve) => {
          window.addEventListener('resize', () => resolve(panel.getBoundingClientRect().width), {
            once: true,
          })
        }),
      }))
      await page.setViewportSize({ width: target, height: 900 })
      expect(await sample.evaluate((result) => result.width)).toBe(Math.min(target - 12, preferred))
      await sample.dispose()
    }

    // 窄屏启动时只限制当前显示宽度，放宽窗口后仍要恢复旧偏好。
    await page.setViewportSize({ width: 320, height: 640 })
    await page.reload()
    await waitEngine(page)
    await expect.poll(() => sidebar.evaluate((panel) => panel.offsetWidth)).toBe(308)
    expect(await page.evaluate(() => localStorage.getItem('plein:sidebar-width'))).toBe(
      String(preferred),
    )
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(sidebar).toBeVisible()
    await expect.poll(width).toBe(preferred)
    // 库的起始位置也必须同步，否则重新开始拖动时会跳回窄屏下的宽度。
    const restored = (await handle.boundingBox())!
    const restoredX = restored.x + restored.width / 2
    await page.mouse.move(restoredX, y)
    await page.mouse.down()
    await page.mouse.move(restoredX + 16, y, { steps: 2 })
    await page.mouse.up()
    expect(await width()).toBe(preferred + 16)
    await handle.dblclick()
    await expect.poll(width).toBe(before)
    expect(await page.evaluate(() => localStorage.getItem('plein:sidebar-width'))).toBe(
      String(before),
    )
  },
)

test(
  '热区边缘（分隔条 DOM 之外）起拖：plein-resizing 生效、Esc 取消恢复、松手持久化',
  { tag: '@core' },
  async ({ page, browser }) => {
    await newProject(page)
    // 库的命中热区比分隔条 DOM（8px）宽（fine 10px / coarse 20px）：从 DOM 左侧 6px 起拖，
    // 验证接驳层不依赖分隔条自身的 pointerdown 也能收口取消与提交。
    // 触摸偏移取 -6：实测 coarse 热区左边界在 DOM 左沿外 6px，再往外会被页面滚动意图吞掉。
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      hasTouch: true,
    })
    const touchPage = await context.newPage()
    try {
      await touchPage.goto(page.url())
      await waitEngine(touchPage)
      const sidebar = touchPage.locator('aside[aria-label="侧栏"]')
      await expect(sidebar).toBeVisible()
      const handle = touchPage.getByRole('separator', { name: '调整侧栏宽度' })
      const width = async () => (await sidebar.boundingBox())!.width
      const before = await width()
      const box = await handle.boundingBox()
      const y = box!.y + box!.height / 2
      const startX = Math.round(box!.x) - 6
      expect(startX).toBeLessThan(box!.x)

      const session = await touchPage.context().newCDPSession(touchPage)
      const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x?: number) =>
        session.send('Input.dispatchTouchEvent', {
          type,
          touchPoints: type === 'touchEnd' ? [] : [{ x: x ?? startX, y }],
        })

      // 从热区边缘起拖：拖动中 plein-resizing 生效、宽度跟手
      await touch('touchStart')
      await touch('touchMove', startX + 40)
      await touch('touchMove', startX + 70)
      await expect(touchPage.locator('html')).toHaveClass(/plein-resizing/)
      await expect.poll(width).toBeGreaterThan(before + 40)

      // Esc 取消：恢复拖拽前宽度，不写偏好；之后的移动与抬手不再改宽度
      await touchPage.keyboard.press('Escape')
      await touch('touchEnd')
      await expect.poll(width).toBe(before)
      expect(await touchPage.evaluate(() => localStorage.getItem('plein:sidebar-width'))).toBeNull()

      // 同一位置再拖一次并松手：提交偏好
      await touch('touchStart')
      await touch('touchMove', startX + 50)
      await touch('touchEnd')
      await expect.poll(width).toBeGreaterThan(before + 30)
      const widened = await width()
      await expect
        .poll(() => touchPage.evaluate(() => localStorage.getItem('plein:sidebar-width')))
        .toBe(String(Math.round(widened)))
    } finally {
      await context.close()
    }
  },
)
