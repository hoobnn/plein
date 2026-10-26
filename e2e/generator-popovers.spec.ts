import { expect, test } from '@playwright/test'
import { clickElement, revealGenerator, newProject } from './canvas'

for (const { type, trigger, label } of [
  { type: 'plein/video', trigger: '参数', label: '参数' },
  { type: 'plein/video', trigger: '模型', label: '选择模型' },
]) {
  test(`${type} ${trigger}弹层在卡片下方编辑器调整窗口后保持可操作且焦点可返回`, async ({
    page,
  }) => {
    await newProject(page)
    const id = await page.evaluate(
      (type) =>
        window.__plein.addNode({
          type,
          name: '参数浮层测试',
          params: { prompt: '保留长描述' },
          x: 400,
          y: 200,
        }),
      type,
    )
    await clickElement(page, id)
    await revealGenerator(page)
    await page.evaluate((id) => {
      const engine = window.__plein.engine as Window['__plein']['engine'] & {
        camera: { panBy(x: number, y: number): void }
      }
      const rect = engine.doc.worldRect(id)
      const at = engine.worldToClient(rect.x, rect.y + rect.h / 2)
      engine.camera.panBy(0, 160 - at.y)
    }, id)
    const panel = page.getByTestId('generator')
    await panel.getByRole('button', { name: trigger, exact: true }).click()
    const popover = page.getByRole('dialog', { name: label, exact: true })
    await expect(popover).toBeVisible()
    await page.setViewportSize({ width: 1440, height: 640 })
    await expect(panel).toHaveAttribute('data-compact', 'false')
    await expect(popover).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(popover).toHaveCount(0)
    await expect(panel.getByRole('button', { name: trigger, exact: true })).toBeFocused()
  })
}

for (const height of [900, 640]) {
  test(`模型供应商切换保持弹层和平台栏位置稳定（窗口高 ${height}）`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height })
    await page.addInitScript(() =>
      localStorage.setItem(
        'plein:recent-models:local',
        JSON.stringify(['test/provider-0:model-0', 'test/provider-1:model-0']),
      ),
    )
    await page.route('**/api/catalog', async (route) => {
      const response = await route.fetch()
      const catalog = await response.json()
      const base = catalog.providers.find((p: { models: unknown[] }) => p.models.length)
      catalog.providers = [8, 2, 5].map((count, index) => ({
        ...base,
        id: `test/provider-${index}`,
        title: `测试平台 ${index}`,
        enabled: true,
        configured: true,
        models: Array.from({ length: count }, (_, i) => ({
          ...base.models[0],
          id: `model-${i}`,
          title: `模型 ${i}`,
          capabilities: ['video.generate'],
          description: '',
        })),
      }))
      await route.fulfill({ response, json: catalog })
    })
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/video',
        name: '供应商切换测试',
        params: { model: 'test/provider-0:model-0' },
        x: 400,
        y: 200,
      }),
    )
    await clickElement(page, id)
    await revealGenerator(page)
    // 固定尺寸编辑器可以超出视口；先移动卡片，让菜单按钮处于可操作区域。
    await page.evaluate((id) => {
      const engine = window.__plein.engine as Window['__plein']['engine'] & {
        camera: { panBy(x: number, y: number): void }
      }
      const rect = engine.doc.worldRect(id)
      const at = engine.worldToClient(rect.x, rect.y + rect.h)
      engine.camera.panBy(0, 80 - at.y)
    }, id)
    const panel = page.getByTestId('generator')
    if ((await panel.getAttribute('data-compact')) === 'true') {
      await panel.getByRole('button', { name: /^编辑/ }).click()
    }
    await panel.getByRole('button', { name: '模型', exact: true }).click()
    const popup = page.getByRole('dialog', { name: '选择模型', exact: true })
    const rail = popup.getByRole('tablist', { name: '平台', exact: true })
    await expect(popup).toBeVisible()
    // 等待弹层进场结束，再逐帧记录供应商切换，避免只看动画结束的截图。
    await popup.evaluate(async (el) => {
      await Promise.all(el.getAnimations().map((a) => a.finished))
    })
    const before = await rail.boundingBox()
    const target = rail.getByRole('tab').nth(1)
    await target.hover()
    const samples = await rail.evaluate(async (el) => {
      const boxes = []
      for (let i = 0; i < 30; i++) {
        await new Promise(requestAnimationFrame)
        const { x, y, width, height } = el.getBoundingClientRect()
        boxes.push({ x, y, width, height })
      }
      return boxes
    })
    for (const box of samples) {
      expect(Math.abs(box.y - before!.y)).toBeLessThan(1)
      expect(Math.abs(box.height - before!.height)).toBeLessThan(1)
    }
    await expect(target).toHaveAttribute('aria-selected', 'true')
    await expect(
      popup.getByRole('listbox', { name: '测试平台 1 的模型', exact: true }),
    ).toBeVisible()
  })
}

for (const width of [1440, 390]) {
  test(`固定编辑区内模型与参数完整排版且互不遮挡（窗口宽 ${width}）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.route('**/api/catalog', async (route) => {
      const response = await route.fetch()
      const catalog = await response.json()
      const base = catalog.providers.find((p: { models: unknown[] }) => p.models.length)
      catalog.providers = [
        {
          ...base,
          id: 'minimax/api',
          title: 'MiniMax',
          enabled: true,
          configured: true,
          models: [
            {
              ...base.models[0],
              id: 'MiniMax-H3-Highspeed',
              title: 'MiniMax-H3-Highspeed',
              capabilities: ['video.generate'],
            },
          ],
        },
      ]
      await route.fulfill({ response, json: catalog })
    })
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/video',
        name: '长模型名布局验收',
        params: {
          model: 'minimax/api:MiniMax-H3-Highspeed',
          mode: 'reference',
          prompt: '测试布局',
          duration: 15,
        },
        x: 400,
        y: 200,
      }),
    )
    await clickElement(page, id)
    await revealGenerator(page)
    const panel = page.getByTestId('generator')
    if ((await panel.getAttribute('data-compact')) === 'true') {
      await panel.getByRole('button', { name: /^编辑/ }).click()
    }
    const model = panel.getByRole('button', { name: '模型', exact: true })
    const title = model.getByText('MiniMax-H3-Highspeed', { exact: true })
    await expect(title).toBeVisible()
    expect(
      await title.evaluate(
        (el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1,
      ),
    ).toBe(true)
    const footer = panel.locator('footer')
    expect(await footer.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    const controls = await footer.locator('button').evaluateAll((buttons) =>
      buttons.map((el) => {
        const { x, y, width, height } = el.getBoundingClientRect()
        return { x, y, width, height }
      }),
    )
    const footerBox = await footer.boundingBox()
    for (const [i, a] of controls.entries()) {
      expect(a.x).toBeGreaterThanOrEqual(footerBox!.x)
      expect(a.x + a.width).toBeLessThanOrEqual(footerBox!.x + footerBox!.width)
      for (const b of controls.slice(i + 1)) {
        expect(
          a.x < b.x + b.width &&
            a.x + a.width > b.x &&
            a.y < b.y + b.height &&
            a.y + a.height > b.y,
        ).toBe(false)
      }
    }
    await expect(footer.getByRole('button', { name: '生成', exact: true })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath(`generator-layout-${width}.png`) })
  })
}
