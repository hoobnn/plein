import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import type { PreparedInput } from '../packages/protocol/src/runs'
import {
  clickElement,
  revealGenerator,
  confirmBatchChecklist,
  newProject,
  waitEngine,
  waitNode,
} from './canvas'

const canvasId = (page: Page) => /#\/c\/([^/?]+)/.exec(page.url())![1]!
const promptOf = (page: Page, id: string) =>
  page.evaluate((id) => String(window.__plein.engine.doc.get(id)?.params?.prompt ?? ''), id)
const adoptedOf = (page: Page, id: string) =>
  page.evaluate(
    (id) => window.__plein.engine.doc.mutable(id)?.get('adopted') as string | undefined,
    id,
  )

async function seedImages(page: Page, count = 3) {
  const ids = await page.evaluate(
    (count) =>
      Array.from({ length: count }, (_, i) =>
        window.__plein.addNode({
          type: 'plein/image',
          name: ['左景', '右景', '替代参考'][i] ?? `参考${i}`,
          params: { model: 'plein/mock:image', prompt: `参考构图 ${i}` },
          x: -900,
          y: i * 400,
        }),
      ),
    count,
  )
  for (const id of ids) {
    await expect
      .poll(async () =>
        (await page.request.get(`/api/canvases/${canvasId(page)}/nodes/${id}/input`)).status(),
      )
      .toBe(200)
    const result = await page.request.post(`/api/canvases/${canvasId(page)}/nodes/${id}/run`, {
      data: {},
    })
    expect(result.status()).toBe(202)
    await waitNode(page, id)
  }
  return ids
}

async function seedStoryboard(page: Page, name: string) {
  return page.evaluate(
    (name) =>
      window.__plein.addNode({
        type: 'plein/storyboard',
        name,
        params: {
          shots: [1, 2].map((no) => ({
            id: `review-${no}`,
            no,
            duration: 5,
            shotSize: '中景',
            description: `镜头 ${no}`,
            characters: [],
            emotion: '',
            lighting: '',
            sfx: '',
            dialogue: [],
            imagePrompt: `构图 ${no}`,
            motionPrompt: `运镜 ${no}`,
          })),
        },
        x: 400,
        y: 300,
      }),
    name,
  )
}

async function openStoryboard(page: Page, id: string) {
  await clickElement(page, id)
  await revealGenerator(page)
  await page
    .getByTestId('generator')
    .getByRole('button', { name: /^编辑分镜表/ })
    .click()
  const dialog = page.getByRole('dialog', { name: '分镜表', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

test(
  '首页仅加载轻量闭包，进入画布后才加载编辑器并正常运行',
  { tag: '@production' },
  async ({ page }) => {
    type Chunk = { file: string; imports?: string[] }
    const dist = process.env.PLEIN_E2E_DIST
      ? pathToFileURL(`${process.env.PLEIN_E2E_DIST}/`)
      : new URL('../apps/web/dist-e2e/', import.meta.url)
    const manifest = JSON.parse(
      readFileSync(new URL('.vite/manifest.json', dist), 'utf8'),
    ) as Record<string, Chunk>
    const home = new Set<string>()
    const visit = (key: string) => {
      if (home.has(key)) return
      home.add(key)
      for (const dependency of manifest[key]!.imports ?? []) visit(dependency)
    }
    visit('index.html')
    visit('src/pages/Home.tsx')
    const files = new Set([...home].map((key) => manifest[key]!.file))
    const bodies = [...files].map((file) => readFileSync(new URL(file, dist)))
    const compressedBytes = bodies.reduce((bytes, body) => bytes + gzipSync(body).length, 0)
    expect(compressedBytes, '首页完整静态 JS 闭包的 gzip 预算').toBeLessThanOrEqual(300 * 1024)
    expect(home.has('src/pages/Editor.tsx')).toBe(false)
    expect(home.has('src/features/stage/StagePanel.tsx')).toBe(false)
    expect([...home].some((key) => /node_modules\/(?:jassub|pixi\.js)\//.test(key))).toBe(false)
    // Match implementation diagnostics, not CodeMirror theme packages or dynamic import names.
    for (const marker of [
      'CodeMirror plugin crashed',
      'Invalid JSON representation for EditorState',
      'A VideoSample was garbage collected without first being closed',
      '[PixiJS] Vertex Array Objects are not supported on this device',
    ])
      expect(
        bodies.some((body) => body.includes(marker)),
        marker,
      ).toBe(false)

    const requested = new Set<string>()
    page.on('request', (request) => {
      if (request.resourceType() === 'script')
        requested.add(new URL(request.url()).pathname.slice(1))
    })
    await page.goto('/')
    await expect(page.getByRole('button', { name: '新建项目', exact: true })).toBeVisible()
    await page.waitForLoadState('networkidle')
    expect(requested.has(manifest['src/pages/Home.tsx']!.file)).toBe(true)
    expect([...requested].filter((file) => !files.has(file))).toEqual([])
    expect(await page.evaluate(() => !!window.__plein)).toBe(false)
    await page.getByRole('button', { name: '新建项目', exact: true }).click()
    await expect(page).toHaveURL(/#\/c\//)
    await waitEngine(page)
    expect(requested.has(manifest['src/pages/Editor.tsx']!.file)).toBe(true)
    await expect(page.locator('canvas').first()).toBeVisible()
  },
)

test('参考素材可真实预览、重排和替换；实际送入顺序跟随界面', async ({ page }) => {
  await newProject(page)
  const sources = await seedImages(page)
  const target = await page.evaluate((ids) => {
    const id = window.__plein.addNode({
      type: 'plein/image',
      name: '构图审核',
      params: { model: 'plein/mock:image', prompt: '保留两张参考的构图' },
      x: 400,
      y: 300,
    })
    if (!window.__plein.connect([ids[0]!, 'images'], [id, 'references']))
      throw new Error('first reference fixture failed')
    if (!window.__plein.connect([ids[1]!, 'images'], [id, 'references']))
      throw new Error('second reference fixture failed')
    return id
  }, sources)
  await clickElement(page, target)
  await revealGenerator(page)
  const generator = page.getByTestId('generator')
  await expect(generator.getByRole('group', { name: '参考 1：左景', exact: true })).toBeVisible()
  await generator.getByTitle('预览「左景」').click()
  const preview = page.getByRole('dialog', { name: '查看「左景」' })
  await expect(preview.getByRole('img', { name: '左景', exact: true })).toBeVisible()
  await preview.getByRole('button', { name: '关闭', exact: true }).click()
  await generator.getByRole('button', { name: '管理参考 2', exact: true }).click()
  await page.getByRole('button', { name: '向前移动参考 2', exact: true }).click()
  await expect(generator.getByRole('group', { name: '参考 1：右景', exact: true })).toBeVisible()
  const prepared = async () =>
    (await (
      await page.request.get(`/api/canvases/${canvasId(page)}/nodes/${target}/input`)
    ).json()) as PreparedInput
  await expect
    .poll(async () => (await prepared()).inputs.references?.map((input) => input.source))
    .toEqual([sources[1], sources[0]])
  await generator.getByRole('button', { name: '管理参考 1', exact: true }).click()
  await page.getByRole('button', { name: '替换参考 1', exact: true }).click()
  await generator
    .getByRole('combobox', { name: '替换参考素材' })
    .selectOption(JSON.stringify([sources[2], 'images']))
  await expect(
    generator.getByRole('group', { name: '参考 1：替代参考', exact: true }),
  ).toBeVisible()
  await expect
    .poll(async () => (await prepared()).inputs.references?.map((input) => input.source))
    .toEqual([sources[2], sources[0]])
  const actual = generator.getByTestId('input-preview')
  await actual.getByRole('button', { name: /实际输入/ }).click()
  await expect(actual).toContainText('替代参考')
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length ?? 0, target),
  ).toBe(0)
})

test('空单输入上传期间被接入新参考时，不覆盖新参考且保留上传素材', async ({ page }) => {
  await newProject(page)
  const [source] = await seedImages(page, 1)
  const asset = await page.evaluate(
    (id) => window.__plein.engine.doc.get(id)!.results![0]!.value.assetId as string,
    source!,
  )
  const file = await (await page.request.get(`/api/assets/${asset}`)).body()
  const target = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image-edit',
      name: '单输入上传竞态',
      params: { prompt: '保持新接入的原图' },
      x: 400,
      y: 300,
    }),
  )
  let release!: () => void
  let started!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  const uploading = new Promise<void>((resolve) => (started = resolve))
  await page.route('**/api/assets', async (route) => {
    const response = await route.fetch()
    started()
    await held
    await route.fulfill({ response })
  })
  await clickElement(page, target)
  await revealGenerator(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('generator').getByRole('button', { name: '上传参考', exact: true }).click()
  await page
    .getByRole('dialog', { name: '上传参考', exact: true })
    .getByRole('button', { name: '原图', exact: true })
    .click()
  await (await chooser).setFiles({ name: '慢上传.png', mimeType: 'image/png', buffer: file })
  await uploading
  try {
    expect(
      await page.evaluate(
        ({ source, target }) => window.__plein.connect([source, 'images'], [target, 'image']),
        { source: source!, target },
      ),
    ).toBeTruthy()
  } finally {
    release()
  }
  await expect
    .poll(() =>
      page.evaluate(
        () => [...window.__plein.engine.doc.elements()].filter((e) => e.kind === 'image').length,
      ),
    )
    .toBe(1)
  const actual = await page.evaluate(
    (id) => [...window.__plein.engine.doc.edges()].filter((edge) => edge.to[0] === id),
    target,
  )
  expect(actual.map((edge) => edge.from)).toEqual([[source, 'images']])
  await expect(
    page.getByTestId('generator').getByRole('group', { name: '参考 1：左景', exact: true }),
  ).toBeVisible()
})

test('提示词先审建议，取消不写回、采用可编辑、协作变更不覆盖，展开编辑支持引用补全', async ({
  page,
}) => {
  await newProject(page)
  const target = await page.evaluate(() => {
    window.__plein.addNode({ type: 'plein/character', name: '林夏', params: {}, x: -500, y: 0 })
    return window.__plein.addNode({
      type: 'plein/image',
      name: '提示词审核',
      params: { model: 'plein/mock:image', prompt: '雨夜的天台' },
      x: 400,
      y: 300,
    })
  })
  await clickElement(page, target)
  await revealGenerator(page)
  const generator = page.getByTestId('generator')
  const suggestion = page.getByRole('dialog', { name: '提示词建议' })
  const suggest = async () => {
    const response = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/api/prompt/rewrite'),
    )
    await generator.getByRole('button', { name: '优化提示词', exact: true }).click()
    expect((await response).status()).toBe(200)
    await expect(suggestion.getByRole('button', { name: '采用建议', exact: true })).toBeEnabled()
  }
  await suggest()
  expect(await promptOf(page, target)).toBe('雨夜的天台')
  await suggestion.getByRole('button', { name: '关闭', exact: true }).click()
  expect(await promptOf(page, target)).toBe('雨夜的天台')
  await suggest()
  await suggestion
    .getByRole('textbox', { name: '建议提示词', exact: true })
    .fill('审核后的雨夜天台')
  await suggestion.getByRole('button', { name: '采用建议', exact: true }).click()
  await expect(suggestion).toBeHidden()
  expect(await promptOf(page, target)).toBe('审核后的雨夜天台')
  await suggest()
  // Simulate a collaborator changing the shared document while the review dialog is open.
  await page.evaluate((id) => {
    const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
      set(key: string, value: string): void
    }
    params.set('prompt', '协作端的新提示词')
  }, target)
  await suggestion.getByRole('button', { name: '采用建议', exact: true }).click()
  await expect(suggestion.getByRole('alert')).toContainText('未覆盖当前内容')
  expect(await promptOf(page, target)).toBe('协作端的新提示词')
  await suggestion.getByRole('button', { name: '关闭', exact: true }).click()
  await generator.getByRole('button', { name: '放大编辑提示词', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '编辑提示词', exact: true })
  const prompt = editor.getByRole('textbox', { name: '提示词', exact: true })
  await prompt.fill('雨夜里 @林')
  await editor
    .getByRole('listbox', { name: '引用资产' })
    .getByRole('option', { name: /林夏/ })
    .click()
  await expect(prompt).toHaveValue('雨夜里 @林夏 ')
  await editor.getByRole('button', { name: '关闭', exact: true }).click()
  expect(await promptOf(page, target)).toBe('雨夜里 @林夏 ')
})

test('候选浏览与 A/B 对比不改变采用结果，明确采用后才更新且可撤销', async ({ page }) => {
  await newProject(page)
  const target = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '候选审核',
      params: { model: 'plein/mock:image', prompt: '雨夜镜头', count: 2 },
      x: 400,
      y: 300,
    }),
  )
  await clickElement(page, target)
  await revealGenerator(page)
  const generator = page.getByTestId('generator')
  await generator.getByRole('button', { name: '生成', exact: true }).click()
  await waitNode(page, target)
  const original = await adoptedOf(page, target)
  expect(original).toBeTruthy()
  await generator.getByRole('button', { name: '全屏查看', exact: true }).click()
  const review = page.getByRole('dialog', { name: '查看「候选审核」', exact: true })
  await review.getByRole('button', { name: '预览下一个候选', exact: true }).click()
  await expect(review.getByRole('button', { name: '采用此候选', exact: true })).toBeEnabled()
  expect(await adoptedOf(page, target)).toBe(original)
  const comparison = review.getByRole('combobox', { name: '对比候选' })
  await comparison.selectOption({ label: '候选 1 · 已采用' })
  await expect(review.getByRole('img', { name: '候选 A', exact: true })).toBeVisible()
  await expect(review.getByRole('img', { name: '候选 B', exact: true })).toBeVisible()
  await review.getByRole('combobox', { name: '对比方式' }).selectOption('slider')
  const slider = review.getByRole('slider', { name: '图片对比滑杆' })
  await slider.fill('70')
  expect(await adoptedOf(page, target)).toBe(original)
  await review.getByRole('button', { name: '采用此候选', exact: true }).click()
  const adopted = await adoptedOf(page, target)
  expect(adopted).not.toBe(original)
  await expect(review.getByRole('button', { name: '已采用', exact: true })).toBeDisabled()
  await review.getByRole('button', { name: '关闭', exact: true }).click()
  await page.mouse.click(700, 120)
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => adoptedOf(page, target)).toBe(original)
})

test('审片按钮 Enter 执行按钮本意，只有预览区 Enter 才采用候选', async ({ page }) => {
  await newProject(page)
  const target = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '键盘审核',
      params: { model: 'plein/mock:image', prompt: '两个候选', count: 2 },
      x: 400,
      y: 300,
    }),
  )
  await clickElement(page, target)
  await revealGenerator(page)
  const generator = page.getByTestId('generator')
  await generator.getByRole('button', { name: '生成', exact: true }).click()
  await waitNode(page, target)
  const original = await adoptedOf(page, target)
  const review = page.getByRole('dialog', { name: '查看「键盘审核」', exact: true })
  await generator.getByRole('button', { name: '全屏查看', exact: true }).click()
  await review.getByRole('button', { name: '预览下一个候选', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(review.getByRole('button', { name: '采用此候选', exact: true })).toBeEnabled()
  expect(await adoptedOf(page, target)).toBe(original)
  await review.getByRole('button', { name: '关闭', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(review).toBeHidden()
  expect(await adoptedOf(page, target)).toBe(original)
  await generator.getByRole('button', { name: '全屏查看', exact: true }).click()
  await review.getByRole('button', { name: '预览下一个候选', exact: true }).click()
  await review.getByRole('img', { name: '键盘审核', exact: true }).click()
  await expect(review.getByRole('group', { name: '候选审片操作', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => adoptedOf(page, target)).not.toBe(original)
  await expect(review.getByRole('button', { name: '已采用', exact: true })).toBeDisabled()
})

test('分镜审核单行恢复只取回原任务，不重新生成其他镜头', async ({ page }) => {
  await newProject(page)
  const boardId = await seedStoryboard(page, '恢复审核分镜')
  const open = () => openStoryboard(page, boardId)
  let dialog = await open()
  await dialog.getByRole('button', { name: '展开为节点', exact: true }).click()
  await expect(dialog).toBeHidden()
  const image = await page.evaluate(
    (boardId) =>
      [...window.__plein.engine.doc.elements()].find((el) => {
        const src = el.params?.source as
          | { storyboard?: string; shot?: string; role?: string }
          | undefined
        return src?.storyboard === boardId && src.shot === 'review-1' && src.role === 'image'
      })!.id,
    boardId,
  )
  const before = await page.evaluate(() => [...window.__plein.engine.doc.elements()].length)
  let submissions = 0
  const recovered: unknown[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/nodes\/[^/]+\/run$/.test(request.url())) submissions++
  })
  // Only the recovery projection/receipt are fixtures; the canvas, editor and row controls are real.
  await page.route('**/api/canvases/*/jobs/latest', (route) =>
    route.fulfill({
      json: {
        jobs: [
          {
            id: 'review-existing',
            nodeId: image,
            nodeType: 'plein/image',
            status: 'failed',
            attempts: 1,
            error: '保存中断',
            createdAt: Date.now(),
            recovery: { state: 'fetch_failed', refetchable: true, remoteId: 'remote-kept' },
          },
        ],
        groups: [],
      },
    }),
  )
  await page.route('**/api/canvases/*/jobs/review-existing/recover', async (route) => {
    recovered.push(route.request().postDataJSON())
    await route.fulfill({ json: { ok: true } })
  })
  dialog = await open()
  await dialog.getByRole('button', { name: '审核镜头', exact: true }).click()
  const table = dialog.getByRole('table', { name: '逐镜审核', exact: true })
  const row = table.locator('[data-shot-id="review-1"]')
  await expect(row.getByTestId('job-recovery')).toContainText('平台已生成，结果没存到本地')
  await expect(table.locator('[data-shot-id="review-2"]').getByTestId('job-recovery')).toHaveCount(
    0,
  )
  await row.getByRole('button', { name: '重新获取', exact: true }).click()
  await expect.poll(() => recovered).toEqual([{ action: 'refetch' }])
  expect(submissions).toBe(0)
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()].length)).toBe(before)
})

test('分镜批量默认沿用已有结果，选中只生成目标，全重生成需确认且保留历史', async ({ page }) => {
  await newProject(page)
  const boardId = await seedStoryboard(page, '批量范围审核')
  let dialog = await openStoryboard(page, boardId)
  await dialog.getByRole('button', { name: '展开为节点', exact: true }).click()
  await expect(dialog).toBeHidden()
  const images = await page.evaluate((boardId) => {
    const images = [...window.__plein.engine.doc.elements()]
      .filter((el) => {
        const source = el.params?.source as { storyboard?: string; role?: string } | undefined
        return source?.storyboard === boardId && source.role === 'image'
      })
      .sort((a, b) =>
        String((a.params?.source as { shot?: string } | undefined)?.shot).localeCompare(
          String((b.params?.source as { shot?: string } | undefined)?.shot),
        ),
      )
    for (const image of images) {
      const params = window.__plein.engine.doc.mutable(image.id)!.get('params') as {
        set(key: string, value: string): void
      }
      params.set('model', 'plein/mock:image')
    }
    return images.map((image) => image.id)
  }, boardId)
  expect(images).toHaveLength(2)
  for (const id of images) {
    await expect
      .poll(async () => {
        const r = await page.request.get(`/api/canvases/${canvasId(page)}/nodes/${id}/input`)
        return r.ok() ? ((await r.json()) as PreparedInput).model?.ref : null
      })
      .toBe('plein/mock:image')
  }
  // One shot already has an adopted result; the other still needs its first candidate.
  expect(
    (
      await page.request.post(`/api/canvases/${canvasId(page)}/nodes/${images[0]}/run`, {
        data: {},
      })
    ).status(),
  ).toBe(202)
  await waitNode(page, images[0]!)
  const original = await adoptedOf(page, images[0]!)
  let submissions = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/storyboard-batch/commit'))
      submissions++
  })
  const counts = () =>
    page.evaluate(
      (ids) => ids.map((id) => window.__plein.engine.doc.get(id)?.results?.length ?? 0),
      images,
    )
  dialog = await openStoryboard(page, boardId)
  await dialog.getByRole('button', { name: '批量出分镜图', exact: true }).click()
  expect(submissions).toBe(0)
  await confirmBatchChecklist(page)
  expect(submissions).toBe(1)
  await expect.poll(counts).toEqual([1, 1])
  expect(await adoptedOf(page, images[0]!)).toBe(original)
  await dialog.getByRole('button', { name: '批量出分镜图', exact: true }).click()
  const checklist = page.getByRole('dialog', { name: '批量生成清单', exact: true })
  await expect(checklist.getByLabel('清单汇总')).toContainText('沿用 2 项')
  await expect(
    checklist.getByRole('button', { name: '确认并开始生成', exact: true }),
  ).toBeDisabled()
  await checklist.getByRole('button', { name: '取消', exact: true }).click()
  expect(submissions).toBe(1)
  await dialog.getByRole('checkbox', { name: '选择镜头 1', exact: true }).check()
  await dialog.getByRole('button', { name: '批量出分镜图', exact: true }).click()
  await confirmBatchChecklist(page)
  expect(submissions).toBe(2)
  await expect.poll(counts).toEqual([2, 1])
  await dialog.getByRole('checkbox', { name: '选择镜头 1', exact: true }).uncheck()
  await dialog.getByRole('button', { name: '全部重新生成', exact: true }).click()
  await page
    .getByRole('menu', { name: '全部重新生成', exact: true })
    .getByRole('menuitem', { name: '分镜图', exact: true })
    .click()
  await expect(checklist.getByLabel('清单汇总')).toContainText('生成 2 项')
  expect(submissions).toBe(2)
  await checklist.getByRole('button', { name: '取消', exact: true }).click()
  await expect(checklist).toBeHidden()
  expect(submissions).toBe(2)
  await dialog.getByRole('button', { name: '全部重新生成', exact: true }).click()
  await page
    .getByRole('menu', { name: '全部重新生成', exact: true })
    .getByRole('menuitem', { name: '分镜图', exact: true })
    .click()
  await expect(checklist).toBeVisible()
  expect(submissions).toBe(2)
  await confirmBatchChecklist(page)
  expect(submissions).toBe(3)
  await expect.poll(counts).toEqual([3, 2])
  expect(
    await page.evaluate(
      ({ id, result }) => window.__plein.engine.doc.get(id)?.results?.some((r) => r.id === result),
      { id: images[0]!, result: original },
    ),
  ).toBe(true)
})
