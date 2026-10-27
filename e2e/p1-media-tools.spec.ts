import { expect, test, type Page } from './fixtures'
import { solidPng, sineWav } from '../packages/providers/src/mock/media'
import { MOCK_WEBM_BASE64 } from '../packages/providers/src/mock/video-fixture'
import { centerOf, newProject, zoomTo } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (
    await chooser
  ).setFiles([
    {
      name: '统一图片.png',
      mimeType: 'image/png',
      buffer: Buffer.from(solidPng(120, 120, [70, 100, 150])),
    },
    {
      name: '统一视频.webm',
      mimeType: 'video/webm',
      buffer: Buffer.from(MOCK_WEBM_BASE64, 'base64'),
    },
    { name: '统一音频.wav', mimeType: 'audio/wav', buffer: Buffer.from(sineWav(2)) },
  ])
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          [...window.__plein.engine.doc.elements()].filter((el) =>
            ['image', 'video', 'audio'].includes(el.kind),
          ).length,
      ),
    )
    .toBe(3)
  return page.evaluate(() =>
    Object.fromEntries(
      [...window.__plein.engine.doc.elements()]
        .filter((el) => ['image', 'video', 'audio'].includes(el.kind))
        .map((el) => [el.kind, el.id]),
    ),
  )
}
async function openTools(page: Page, id: string) {
  await page.keyboard.press('Escape')
  await zoomTo(page, [id])
  const p = await centerOf(page, id)
  await page.mouse.click(p.x, p.y)
  await page
    .getByRole('toolbar', { name: '结果操作' })
    .getByRole('button', { name: '媒体工具', exact: true })
    .click()
  return page.getByRole('dialog', { name: '媒体工具', exact: true })
}

test('统一媒体工具分组，图片配方和 AI 精修只创建已连接草稿，裁剪保持可用', async ({ page }) => {
  const ids = await fixture(page)
  const submissions: string[] = []
  page.on('request', (r) => {
    if (
      r.method() === 'POST' &&
      /\/(run|run-flow|run-batch|commit)$/.test(new URL(r.url()).pathname)
    )
      submissions.push(r.url())
  })
  let menu = await openTools(page, ids.image!)
  await expect(menu.getByRole('group', { name: '本地处理', exact: true })).toBeVisible()
  await expect(menu.getByRole('group', { name: 'AI 能力', exact: true })).toBeVisible()
  await expect(menu.getByRole('group', { name: '提示词配方', exact: true })).toBeAttached()
  await menu.getByRole('button', { name: '角色三视图', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          [...window.__plein.engine.doc.elements()].filter((el) => el.name === '角色三视图').length,
      ),
    )
    .toBe(1)
  const recipe = await page.evaluate(() =>
    [...window.__plein.engine.doc.elements()].find((el) => el.name === '角色三视图')!,
  )
  expect(recipe.results).toBeUndefined()
  expect(recipe.params!.prompt).toContain('三视图')
  expect(
    await page.evaluate(
      ({ source, id }) =>
        [...window.__plein.engine.doc.edges()].some((e) => e.from[0] === source && e.to[0] === id),
      { source: ids.image!, id: recipe.id },
    ),
  ).toBe(true)
  menu = await openTools(page, ids.image!)
  await menu.getByRole('button', { name: 'AI 扩图', exact: true }).click()
  const process = await page.evaluate(() =>
    [...window.__plein.engine.doc.elements()].find((el) => el.nodeType === 'plein/image-process')!,
  )
  expect(process.params!.operation).toBe('outpaint')
  expect(process.results).toBeUndefined()
  expect(submissions).toEqual([])
  menu = await openTools(page, ids.image!)
  await menu.getByRole('button', { name: '裁剪', exact: true }).click()
  await menu.getByLabel('宽', { exact: true }).fill('60')
  await menu.getByRole('button', { name: '开始加工', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'image').length,
      ),
    )
    .toBe(2)
  expect(submissions).toEqual([])
})

test('视频续镜和音频分段从同一入口使用，锁定及多选范围有明确说明', async ({ page }) => {
  const ids = await fixture(page)
  let menu = await openTools(page, ids.video!)
  await expect(menu.getByRole('button', { name: '本地拉片', exact: true })).toBeVisible()
  await menu.getByRole('button', { name: '从尾帧续镜', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          [...window.__plein.engine.doc.elements()].filter((el) => el.nodeType === 'plein/video')
            .length,
      ),
    )
    .toBe(1)
  const continuation = await page.evaluate(() =>
    [...window.__plein.engine.doc.elements()].find((el) => el.nodeType === 'plein/video')!,
  )
  expect(continuation.results).toBeUndefined()
  expect(continuation.params!.continuesFrom).toMatchObject({ elementId: ids.video })
  menu = await openTools(page, ids.audio!)
  await expect(menu.getByRole('group', { name: '音频工具范围' })).toContainText('手动切分')
  await menu.getByRole('button', { name: '手动切分', exact: true }).click()
  await expect(menu.getByLabel('切成几段', { exact: true })).toBeVisible()
  await expect(menu.getByLabel('切分区间预览')).toContainText('将生成 2 段')
  await menu.getByRole('button', { name: '开始加工', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'audio').length,
      ),
    )
    .toBe(3)
  menu = await openTools(page, ids.image!)
  await page.evaluate(
    (id) =>
      (
        window.__plein.engine.doc.mutable(id)! as unknown as { set(k: string, v: unknown): void }
      ).set('locked', true),
    ids.image!,
  )
  await expect(menu).toContainText('所选素材已锁定')
  await expect(
    menu.getByRole('button', { name: 'AI 精修（放大 / 扩图 / 抠图）', exact: true }),
  ).toBeDisabled()
  await expect(menu.getByRole('button', { name: '裁剪', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await page.evaluate((ids) => {
    ;(
      window.__plein.engine.doc.mutable(ids.image!)! as unknown as {
        set(k: string, v: unknown): void
      }
    ).set('locked', false)
    window.__plein.engine.selection.set([ids.image!, ids.video!])
    window.__plein.engine.zoomToFit([ids.image!, ids.video!])
  }, ids)
  await page.getByRole('button', { name: '批量加工', exact: true }).click()
  const batch = page.getByRole('dialog', { name: '批量加工', exact: true })
  await expect(batch).toContainText('请先单选')
  await expect(batch.getByRole('button', { name: '角色三视图', exact: true })).toBeDisabled()
})

test('缺少 ffmpeg 或启用模型时展示原因，仍可建立待配置草稿', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('plein.welcome', '1'))
  await page.route('**/api/media/caps', (route) =>
    route.fulfill({ json: { ffmpeg: false, subtitles: false, rubberband: false } }),
  )
  await page.route('**/api/catalog', async (route) => {
    const response = await route.fetch()
    const catalog = await response.json()
    catalog.providers = catalog.providers.map((provider: Record<string, unknown>) => ({
      ...provider,
      enabled: false,
    }))
    await route.fulfill({ response, json: catalog })
  })
  const ids = await fixture(page)
  let menu = await openTools(page, ids.video!)
  await expect(menu).toContainText('本机未提供 ffmpeg')
  await expect(menu.getByRole('button', { name: '从尾帧续镜', exact: true })).toBeDisabled()
  menu = await openTools(page, ids.image!)
  await expect(menu).toContainText('未启用声明支持此操作的模型')
  await expect(menu.getByRole('button', { name: 'AI 扩图', exact: true })).toBeDisabled()
  await menu.getByRole('button', { name: 'AI 精修（放大 / 扩图 / 抠图）', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          [...window.__plein.engine.doc.elements()].filter(
            (el) => el.nodeType === 'plein/image-process',
          ).length,
      ),
    )
    .toBe(1)
})
