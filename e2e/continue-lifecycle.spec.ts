import { execFileSync } from 'node:child_process'
import { expect, type Page, test } from '@playwright/test'
import { newProject, revealGenerator, settle, waitEngine, zoomTo } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const bytes = execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=teal:s=160x90:d=0.6:r=10',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    'frag_keyframe+empty_moov',
    '-f',
    'mp4',
    'pipe:1',
  ])
  const upload = await page.request.post('/api/assets', {
    headers: { 'Content-Type': 'video/mp4' },
    data: bytes,
  })
  expect(upload.status()).toBe(201)
  const asset = (await upload.json()).id as string
  const ids = await page.evaluate((asset) => {
    const engine = window.__plein.engine as typeof window.__plein.engine & {
      paste(data: unknown): void
    }
    engine.paste({
      plein: 1,
      edges: [],
      elements: [
        {
          id: 'source',
          kind: 'video',
          assetId: asset,
          name: '续镜原片',
          x: 300,
          y: 200,
          w: 240,
          h: 135,
          rotation: 0,
          locked: false,
          parentId: null,
        },
      ],
    })
    const source = [...engine.doc.elements()][0]!.id
    const other = window.__plein.addNode({
      type: 'plein/text',
      name: '等待时继续编辑',
      params: { text: '保留正文' },
      x: 900,
      y: 200,
    })
    engine.selection.set([source])
    return { source, other }
  }, asset)
  await zoomTo(page, [ids.source, ids.other])
  return { ...ids, asset, origin: decodeURIComponent(page.url().split('#/c/')[1]!) }
}

async function hold(page: Page, failure = false) {
  let ready = false,
    finished = false,
    count = 0
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/media/derive', async (route) => {
    const number = ++count
    const response = await route.fetch()
    if (number > 1) return route.fulfill({ response })
    ready = true
    await waiting
    if (failure)
      await route.fulfill({ status: 503, json: { message: '测试旧取帧失败' } }).catch(() => {})
    else await route.fulfill({ response }).catch(() => {})
    finished = true
  })
  return { release, ready: () => ready, finished: () => finished, count: () => count }
}
async function start(page: Page) {
  await page.getByRole('button', { name: '续镜', exact: true }).click()
  await page
    .getByRole('dialog', { name: '续镜', exact: true })
    .getByRole('button', { name: /从尾帧续/ })
    .click()
}
const continued = (page: Page) =>
  page.evaluate(() =>
    [...window.__plein.engine.doc.elements()].filter(
      (el) => el.nodeType === 'plein/video' && el.params?.continuesFrom,
    ),
  )

for (const interaction of ['edit', 'back'] as const) {
  test(`续镜取帧等待期间 ${interaction} 保留当前操作并可定位新镜头`, async ({ page }) => {
    const f = await fixture(page)
    const held = await hold(page)
    try {
      await start(page)
      await expect.poll(held.ready).toBe(true)
      await page.getByRole('treeitem', { name: '等待时继续编辑 定位到画布', exact: true }).click()
      await settle(page, f.other)
      const prompt = page
        .getByTestId('generator')
        .getByRole('textbox', { name: '提示词', exact: true })
      if (interaction === 'edit') await prompt.fill('取帧期间保留的新正文')
      else {
        await page.getByRole('treeitem', { name: '续镜原片 定位到画布', exact: true }).click()
        await settle(page, f.source)
        await expect(page.getByRole('button', { name: '取帧中…', exact: true })).toBeDisabled()
      }
      const snapshot = () =>
        page.evaluate(() => {
          const engine = window.__plein.engine as typeof window.__plein.engine & {
            camera: { x: number; y: number; zoom: number }
          }
          return {
            selection: engine.selection.values(),
            camera: { x: engine.camera.x, y: engine.camera.y, zoom: engine.camera.zoom },
          }
        })
      const before = await snapshot()
      held.release()
      await expect.poll(async () => (await continued(page)).length).toBe(1)
      expect(await snapshot()).toEqual(before)
      if (interaction === 'edit') {
        await expect(prompt).toBeFocused()
        await expect(prompt).toHaveValue('取帧期间保留的新正文')
      }
      expect(held.count()).toBe(1)
      await page.getByRole('button', { name: '定位新素材', exact: true }).click()
      const next = (await continued(page))[0]!
      expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([next.id])
      expect(next.params?.continuesFrom).toMatchObject({
        elementId: f.source,
        assetId: f.asset,
        last: true,
      })
    } finally {
      held.release()
    }
  })
}

for (const failure of [false]) {
  test(`切换画布后旧续镜${failure ? '失败' : '成功'}不写入或打断新画布`, async ({ page }) => {
    const f = await fixture(page)
    const canvas = await (await page.request.get(`/api/canvases/${f.origin}`)).json()
    const other = await (
      await page.request.post('/api/canvases', {
        data: { projectId: canvas.projectId, title: '续镜等待的新画布' },
      })
    ).json()
    const held = await hold(page, failure)
    try {
      await start(page)
      await expect.poll(held.ready).toBe(true)
      await page.goto(`/#/c/${other.id}`)
      await waitEngine(page)
      held.release()
      await expect.poll(held.finished).toBe(true)
      expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toHaveLength(0)
      expect((await page.locator('.ui-toast').allTextContents()).join('')).not.toMatch(
        /接出下一个镜头|测试旧取帧失败/,
      )
      await page.goto(`/#/c/${f.origin}`)
      await waitEngine(page)
      expect(await continued(page)).toHaveLength(0)
    } finally {
      held.release()
    }
  })
}

test('窄窗口取消取帧后立即重试，只创建新请求的一个镜头', async ({ page }) => {
  const f = await fixture(page)
  await page.setViewportSize({ width: 390, height: 600 })
  await page.waitForFunction(
    () =>
      (window.__plein.engine as unknown as { camera: { width: number } }).camera.width ===
      innerWidth,
  )
  await zoomTo(page, [f.source])
  const held = await hold(page)
  try {
    await start(page)
    await expect.poll(held.ready).toBe(true)
    // 素材浮条和生成器里各有一个取消取帧，这里要的是素材浮条上那个
    const cancel = page
      .getByRole('toolbar', { name: '结果操作', exact: true })
      .getByRole('button', { name: '取消取帧', exact: true })
      .first()
    await expect(cancel).toBeInViewport()
    await page.screenshot({
      path: test.info().outputPath('continue-pending.png'),
      animations: 'disabled',
    })
    const failed = page.waitForEvent('requestfailed', (request) =>
      request.url().endsWith('/api/media/derive'),
    )
    await cancel.click()
    expect((await failed).failure()?.errorText).toMatch(/ABORT|CANCEL/i)
    await expect(page.getByRole('button', { name: '续镜', exact: true })).toBeFocused()
    expect(await continued(page)).toHaveLength(0)
    await start(page)
    await expect.poll(async () => (await continued(page)).length).toBe(1)
    held.release()
    await expect.poll(held.finished).toBe(true)
    expect(await continued(page)).toHaveLength(1)
    expect(held.count()).toBe(2)
    const next = (await continued(page))[0]!
    const from = next.params!.continuesFrom as { assetId: string; frameAssetId: string }
    expect(from.assetId).toBe(f.asset)
    const meta = await (await page.request.get(`/api/assets/${from.frameAssetId}/meta`)).json()
    expect(meta).toMatchObject({ width: 160, height: 90 })
    await expect
      .poll(async () =>
        (await page.request.get(`/api/canvases/${f.origin}/nodes/${next.id}/input`)).status(),
      )
      .toBe(200)
    const input = await (
      await page.request.get(`/api/canvases/${f.origin}/nodes/${next.id}/input`)
    ).json()
    expect(input.inputs.images).toEqual([
      expect.objectContaining({ type: 'image', assetId: from.frameAssetId }),
    ])
  } finally {
    held.release()
  }
})

test('取帧失败保留原视频，恢复后可从同一入口重试', async ({ page }) => {
  const f = await fixture(page)
  const held = await hold(page, true)
  try {
    await start(page)
    await expect.poll(held.ready).toBe(true)
    held.release()
    await expect(page.locator('.ui-toast')).toContainText('测试旧取帧失败')
    expect(await continued(page)).toHaveLength(0)
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([f.source])
    await start(page)
    await expect.poll(async () => (await continued(page)).length).toBe(1)
    expect(held.count()).toBe(2)
  } finally {
    held.release()
  }
})

async function staleFixture(page: Page) {
  const f = await fixture(page)
  await start(page)
  await expect.poll(async () => (await continued(page)).length).toBe(1)
  const next = (await continued(page))[0]!
  const before = next.params!.continuesFrom as { frameAssetId: string }
  const bytes = execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=orange:s=160x90:d=0.6:r=10',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    'frag_keyframe+empty_moov',
    '-f',
    'mp4',
    'pipe:1',
  ])
  const response = await page.request.post('/api/assets', {
    headers: { 'Content-Type': 'video/mp4' },
    data: bytes,
  })
  expect(response.status()).toBe(201)
  const asset = (await response.json()).id as string
  await page.evaluate(
    ({ id, asset }) =>
      (
        window.__plein.engine.doc.mutable(id) as unknown as {
          set(key: string, value: unknown): void
        }
      ).set('assetId', asset),
    { id: f.source, asset },
  )
  // 编辑器固定在卡片下方，先把它移进窗口再点里面的按钮
  await revealGenerator(page)
  await expect(
    page.getByTestId('continued-from').getByRole('button', { name: '换成新画面', exact: true }),
  ).toBeVisible()
  return { ...f, next: next.id, before, asset }
}
const fromOf = (page: Page, id: string) =>
  page.evaluate(
    (id) =>
      window.__plein.engine.doc.get(id)?.params?.continuesFrom as {
        assetId: string
        frameAssetId: string
      },
    id,
  )

for (const interaction of ['edit', 'back'] as const) {
  test(`更新首帧等待期间 ${interaction} 保留当前编辑与共享等待状态`, async ({ page }) => {
    const f = await staleFixture(page)
    const held = await hold(page)
    try {
      await page
        .getByTestId('continued-from')
        .getByRole('button', { name: '换成新画面', exact: true })
        .click()
      await expect.poll(held.ready).toBe(true)
      await page.getByRole('treeitem', { name: '等待时继续编辑 定位到画布', exact: true }).click()
      await settle(page, f.other)
      const prompt = page
        .getByTestId('generator')
        .getByRole('textbox', { name: '提示词', exact: true })
      if (interaction === 'edit') await prompt.fill('首帧更新期间继续编辑')
      else {
        await page
          .getByRole('treeitem', { name: '续镜原片 · 续镜 定位到画布', exact: true })
          .click()
        await settle(page, f.next)
        await expect(
          page.getByTestId('continued-from').getByRole('button', { name: '取帧中…', exact: true }),
        ).toBeDisabled()
      }
      const selection = await page.evaluate(() => window.__plein.engine.selection.values())
      held.release()
      await expect.poll(async () => (await fromOf(page, f.next)).assetId).toBe(f.asset)
      expect((await fromOf(page, f.next)).frameAssetId).not.toBe(f.before.frameAssetId)
      expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual(selection)
      if (interaction === 'edit') {
        await expect(prompt).toBeFocused()
        await expect(prompt).toHaveValue('首帧更新期间继续编辑')
      }
      expect(held.count()).toBe(1)
    } finally {
      held.release()
    }
  })
}

test('更新首帧可取消并重试，旧响应不替换已经更新的画面', async ({ page }) => {
  const f = await staleFixture(page)
  const held = await hold(page)
  const panel = page.getByTestId('continued-from')
  try {
    await panel.getByRole('button', { name: '换成新画面', exact: true }).click()
    await expect.poll(held.ready).toBe(true)
    await panel.getByRole('button', { name: '取消取帧', exact: true }).click()
    await expect(panel.getByRole('button', { name: '换成新画面', exact: true })).toBeFocused()
    expect((await fromOf(page, f.next)).frameAssetId).toBe(f.before.frameAssetId)
    await panel.getByRole('button', { name: '换成新画面', exact: true }).click()
    await expect.poll(async () => (await fromOf(page, f.next)).assetId).toBe(f.asset)
    const updated = await fromOf(page, f.next)
    held.release()
    await expect.poll(held.finished).toBe(true)
    expect(await fromOf(page, f.next)).toEqual(updated)
    expect(held.count()).toBe(2)
  } finally {
    held.release()
  }
})

for (const failure of [false]) {
  test(`切换画布后旧首帧更新${failure ? '失败' : '成功'}不改旧来路或提示新画布`, async ({
    page,
  }) => {
    const f = await staleFixture(page)
    const canvas = await (await page.request.get(`/api/canvases/${f.origin}`)).json()
    const other = await (
      await page.request.post('/api/canvases', {
        data: { projectId: canvas.projectId, title: '更新首帧等待的新画布' },
      })
    ).json()
    const held = await hold(page, failure)
    try {
      await page
        .getByTestId('continued-from')
        .getByRole('button', { name: '换成新画面', exact: true })
        .click()
      await expect.poll(held.ready).toBe(true)
      await page.goto(`/#/c/${other.id}`)
      await waitEngine(page)
      held.release()
      await expect.poll(held.finished).toBe(true)
      expect((await page.locator('.ui-toast').allTextContents()).join('')).not.toMatch(
        /已换成|测试旧取帧失败/,
      )
      await page.goto(`/#/c/${f.origin}`)
      await waitEngine(page)
      expect((await fromOf(page, f.next)).frameAssetId).toBe(f.before.frameAssetId)
    } finally {
      held.release()
    }
  })
}

test('指定时间续镜校验无效值和超出时长，修改后使用正确帧重试', async ({ page }) => {
  const f = await fixture(page)
  let requests = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/media/derive')) requests++
  })
  await page.getByRole('button', { name: '续镜', exact: true }).click()
  const popup = page.getByRole('dialog', { name: '续镜', exact: true })
  const at = popup.getByLabel('从第几秒续', { exact: true })
  const submit = popup.getByRole('button', { name: '续', exact: true })
  await expect(submit).toBeDisabled()
  for (const value of ['-1', 'abc']) {
    await at.fill(value)
    await submit.click()
    await expect(page.locator('.ui-toast')).toContainText('时间看不懂')
    await expect(popup).toBeVisible()
  }
  expect(requests).toBe(0)
  await at.fill('9')
  await submit.click()
  await expect(page.locator('.ui-toast')).toContainText('超出素材长度')
  expect(await continued(page)).toHaveLength(0)
  await page.getByRole('button', { name: '续镜', exact: true }).click()
  await at.fill('0.2')
  await submit.click()
  await expect.poll(async () => (await continued(page)).length).toBe(1)
  const next = (await continued(page))[0]!
  expect(next.params?.continuesFrom).toMatchObject({
    elementId: f.source,
    assetId: f.asset,
    at: 0.2,
  })
  expect(requests).toBe(2)
})
