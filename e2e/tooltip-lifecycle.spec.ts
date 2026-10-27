import { expect, test } from './fixtures'
import { clickElement, newProject, revealGenerator } from './canvas'

test('悬停中的生成按钮随任务状态更新提示，移出后不恢复旧说明', async ({ page }) => {
  await newProject(page)
  const config = '/api/providers/plein/mock/config'
  const original = await (await page.request.get(config)).json()
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '动态悬停提示',
      params: { prompt: '透明水杯', model: 'plein/mock:image' },
      x: 400,
      y: 200,
    }),
  )
  const canvas = new URL(page.url()).hash.split('/').at(-1)!
  try {
    expect(
      (
        await page.request.put(config, {
          data: { settings: { ...original.settings, latencyMs: 20000 } },
        })
      ).ok(),
    ).toBe(true)
    await clickElement(page, id)
    // 编辑器固定在卡片下方，先把它移进窗口再悬停里面的控件
    await revealGenerator(page)
    const generator = page.getByTestId('generator')
    await generator.getByRole('button', { name: '生成', exact: true }).hover()
    const tip = page.getByRole('tooltip')
    await expect(tip).toContainText('生成')
    // 从另一入口启动同一节点，指针保持悬停，避免点击隐藏提示掩盖状态变化。
    expect((await page.request.post(`/api/canvases/${canvas}/nodes/${id}/run`)).status()).toBe(202)
    const cancel = generator.getByRole('button', { name: '取消', exact: true })
    await expect(cancel).toBeEnabled()
    await expect(tip).toHaveText('取消')
    await page.mouse.move(0, 0)
    await expect(tip).toHaveCount(0)
    await expect(cancel).toHaveAttribute('title', '取消')
    await cancel.hover()
    await expect(tip).toHaveText('取消')
    await cancel.click()
    await expect(generator.getByRole('button', { name: '生成', exact: true })).toBeEnabled()
  } finally {
    await page.request.post(`/api/canvases/${canvas}/nodes/${id}/cancel`)
    await page.request.put(config, { data: { settings: original.settings } })
  }
})

test('整组恢复运行入口后清除已失效的停止说明，移出不还原旧标题', async ({ page }) => {
  await newProject(page)
  const config = '/api/providers/plein/mock/config'
  const original = await (await page.request.get(config)).json()
  let group = ''
  try {
    await page.request.put(config, {
      data: { settings: { ...original.settings, latencyMs: 20_000 } },
    })
    const frame = await page.evaluate(() => {
      const id = window.__plein.addNode({
        type: 'plein/image',
        name: '悬停状态水杯',
        params: { prompt: '透明水杯', model: 'plein/mock:image' },
        x: 400,
        y: 200,
      })
      const e = window.__plein.engine as typeof window.__plein.engine & { groupSelection(): void }
      e.selection.set([id])
      e.groupSelection()
      e.zoomToFit()
      return e.selection.values()[0]!
    })
    const peer = await page.context().newPage()
    try {
      await peer.goto(page.url())
      await peer.waitForFunction(() => !!window.__plein?.engine)
      await expect
        .poll(() => peer.evaluate((id) => !!window.__plein.engine.doc.get(id), frame))
        .toBe(true)
    } finally {
      await peer.close()
    }
    const toolbar = page.getByRole('toolbar', { name: 'Frame 操作', exact: true })
    const started = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/frames/${frame}/run`) && response.request().method() === 'POST',
    )
    await toolbar.getByRole('button', { name: '运行整组（1）', exact: true }).click()
    const response = await started
    expect(response.status()).toBe(202)
    group = (await response.json()).groupId
    const stop = toolbar.getByRole('button', { name: '停止运行', exact: true })
    await expect(stop).toBeEnabled()
    await stop.hover()
    const tip = page.getByRole('tooltip')
    await expect(tip).toContainText('停止整组')
    // 从服务端停止，指针不移动，不用 pointerdown 隐藏提示掩盖状态变化。
    expect((await page.request.post(`/api/runs/groups/${group}/cancel`)).status()).toBe(204)
    const run = toolbar.getByRole('button', { name: '运行整组（1）', exact: true })
    await expect(run).toBeVisible()
    await expect(tip).toHaveCount(0)
    await page.mouse.move(0, 0)
    await expect(run).not.toHaveAttribute('title', /停止整组/)
    await run.hover()
    await expect(tip).toHaveCount(0)
    await page.screenshot({
      path: test.info().outputPath('run-title-cleared.png'),
      animations: 'disabled',
    })
  } finally {
    if (group) await page.request.post(`/api/runs/groups/${group}/cancel`)
    await page.request.put(config, { data: { settings: original.settings } })
  }
})

test('协作删除悬停控件所属节点后，提示立即退场，不悬挂在画布上', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '协作悬停水杯',
      params: { prompt: '透明水杯', model: 'plein/mock:image' },
      x: 400,
      y: 200,
    }),
  )
  const peer = await page.context().newPage()
  try {
    await peer.goto(page.url())
    await peer.waitForFunction(() => !!window.__plein?.engine)
    await expect
      .poll(() => peer.evaluate((id) => !!window.__plein.engine.doc.get(id), id))
      .toBe(true)
    await page.bringToFront()
    await clickElement(page, id)
    // 编辑器固定在卡片下方，先把它移进窗口再悬停里面的控件
    await revealGenerator(page)
    await page.getByTestId('generator').getByRole('button', { name: '生成', exact: true }).hover()
    const tip = page.getByRole('tooltip')
    await expect(tip).toContainText('生成')
    await peer.evaluate((id) => {
      const e = window.__plein.engine as typeof window.__plein.engine & { deleteSelection(): void }
      e.selection.set([id])
      e.deleteSelection()
    }, id)
    await expect
      .poll(() => page.evaluate((id) => !!window.__plein.engine.doc.get(id), id))
      .toBe(false)
    await expect(page.getByTestId('generator')).toHaveCount(0)
    await expect(tip).toHaveCount(0)
  } finally {
    await peer.close()
  }
})

test('悬停按钮的图标被替换后漏掉 pointerout，指针进入别处时提示仍然退场', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '换图标悬停',
      params: { prompt: '透明水杯', model: 'plein/mock:image' },
      x: 400,
      y: 200,
    }),
  )
  await clickElement(page, id)
  const button = page.getByTestId('generator').getByRole('button', { name: '生成', exact: true })
  // 全程派发事件、真实指针留在角落：指针真停在按钮上时，浏览器会在图标替换后补发移动，重新弹出提示。
  await page.mouse.move(0, 0)
  await button
    .locator('svg')
    .evaluate((el) =>
      el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })),
    )
  const tip = page.getByRole('tooltip')
  await expect(tip).toContainText('生成')
  // 任务开始时按钮换图标，指针下的节点被移除，浏览器不再给它派发 pointerout，
  // 下一次移动只在新位置派发 pointerover。这里直接复现这一事件序列。
  await button.evaluate((el) => {
    el.replaceChildren(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
    document
      .querySelector('canvas')!
      .dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  })
  await expect(tip).toHaveCount(0)
})

for (const change of ['empty', 'remove', 'replace'] as const) {
  test(`悬停标题 ${change} 与移出发生在同一任务时，不把旧说明恢复回去`, async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/image',
        name: '标题边界水杯',
        params: { prompt: '透明水杯', model: 'plein/mock:image' },
        x: 400,
        y: 200,
      }),
    )
    await clickElement(page, id)
    // 编辑器固定在卡片下方，先把它移进窗口再悬停里面的控件
    await revealGenerator(page)
    const button = page.getByTestId('generator').getByRole('button', { name: '生成', exact: true })
    await button.hover()
    const tip = page.getByRole('tooltip')
    await expect(tip).toContainText('生成')
    // 故障注入 DOM 边界：在观察器回调前退出悬停，覆盖真实控件更新与指针离开的竞态。
    await button.evaluate((el, change) => {
      if (change === 'remove') el.removeAttribute('title')
      else el.setAttribute('title', change === 'empty' ? '' : '新的操作说明')
      el.dispatchEvent(
        new PointerEvent('pointerout', {
          bubbles: true,
          pointerType: 'mouse',
          relatedTarget: document.body,
        }),
      )
    }, change)
    await expect(tip).toHaveCount(0)
    expect(await button.getAttribute('title')).toBe(
      change === 'remove' ? null : change === 'empty' ? '' : '新的操作说明',
    )
    expect(await button.getAttribute('data-tip')).toBeNull()
    await page.mouse.move(0, 0)
    await button.hover()
    if (change === 'replace') await expect(tip).toHaveText('新的操作说明')
    else await expect(tip).toHaveCount(0)
  })
}
