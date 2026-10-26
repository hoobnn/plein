import { expect, test } from '@playwright/test'
import { solidPng } from '../packages/providers/src/mock/media'
import { clickElement, handleOf, newProject, settle } from './canvas'

test('低高度窗口选中文本后输出端口仍可直接拖线', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 320 })
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/text',
      name: '保留编辑内容',
      params: { text: '正文不丢失' },
      x: 400,
      y: 200,
    }),
  )
  await clickElement(page, id)
  await settle(page, id)
  await expect
    .poll(async () => {
      const at = await handleOf(page, id, 'out')
      return page.evaluate((p) => document.elementFromPoint(p.x, p.y)?.tagName, at)
    })
    .toBe('CANVAS')
  const at = await handleOf(page, id, 'out')
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(400, 80, { steps: 5 })
  await page.mouse.up()
  await expect(page.getByRole('dialog', { name: '添加节点', exact: true })).toBeVisible()
})

async function placeCard(page: import('@playwright/test').Page, id: string) {
  await page.evaluate((id) => {
    const engine = window.__plein.engine as Window['__plein']['engine'] & {
      camera: { panBy(x: number, y: number): void }
    }
    const rect = engine.doc.worldRect(id)
    const at = engine.worldToClient(rect.x + rect.w / 2, rect.y)
    engine.camera.panBy(innerWidth / 2 - at.x, 80 - at.y)
  }, id)
}

async function expectBelow(page: import('@playwright/test').Page, id: string) {
  await expect
    .poll(async () =>
      page.evaluate((id) => {
        const engine = window.__plein.engine
        const rect = engine.doc.worldRect(id)
        const tl = engine.worldToClient(rect.x, rect.y)
        const br = engine.worldToClient(rect.x + rect.w, rect.y + rect.h)
        const panel = document.querySelector('[data-testid="node-editor"]')!.getBoundingClientRect()
        return Math.max(
          Math.abs(panel.top - br.y - 12),
          Math.abs(panel.x + panel.width / 2 - (tl.x + br.x) / 2),
        )
      }, id),
    )
    .toBeLessThan(1)
}

for (const type of ['plein/text', 'plein/image', 'plein/video', 'plein/character']) {
  test(`${type} 编辑器始终在卡片下方，平移缩放和切换节点保留锚点及正文`, async ({ page }) => {
    await newProject(page)
    const ids = await page.evaluate(
      (type) =>
        [0, 1].map((i) =>
          window.__plein.addNode({
            type,
            name: `固定编辑节点 ${i}`,
            params: {},
            x: 400 + i * 400,
            y: 200,
          }),
        ),
      type,
    )
    await clickElement(page, ids[0]!)
    await placeCard(page, ids[0]!)
    const editor = page.getByTestId('node-editor')
    const panel = page.getByTestId('generator')
    const prompt = panel.getByRole('textbox', { name: '提示词', exact: true })
    await prompt.fill('节点内容保留 🌧️')
    await expectBelow(page, ids[0]!)
    await page.evaluate(() => {
      const engine = window.__plein.engine as Window['__plein']['engine'] & {
        camera: {
          panBy(x: number, y: number): void
          zoomAt(x: number, y: number, factor: number): void
        }
      }
      engine.camera.panBy(35, 24)
      engine.camera.zoomAt(700, 200, 0.8)
    })
    await expectBelow(page, ids[0]!)
    await page.evaluate((id) => window.__plein.engine.selection.set([id]), ids[1]!)
    await expect(
      editor.getByRole('button', { name: '关闭节点编辑器', exact: true }),
    ).toHaveAttribute('title', '关闭固定编辑节点 1编辑器')
    await expectBelow(page, ids[1]!)
    await page.evaluate((id) => window.__plein.engine.selection.set([id]), ids[0]!)
    await expect(prompt).toHaveValue('节点内容保留 🌧️')
    const beforeResize = await editor.boundingBox()
    await page.setViewportSize({ width: 390, height: 800 })
    await placeCard(page, ids[0]!)
    await expectBelow(page, ids[0]!)
    await expect(editor).toHaveAttribute('data-placement', 'below')
    await expect(panel).toHaveAttribute('data-compact', 'false')
    await expect(prompt).toHaveValue('节点内容保留 🌧️')
    const box = await editor.boundingBox()
    expect(box!.width).toBe(840)
    expect(Math.abs(box!.height - beforeResize!.height)).toBeLessThan(1)
    await page.evaluate(() =>
      (
        window.__plein.engine as Window['__plein']['engine'] & {
          camera: { panBy(x: number, y: number): void }
        }
      ).camera.panBy(0, 500),
    )
    await expectBelow(page, ids[0]!)
    const nearEdge = await editor.boundingBox()
    expect(nearEdge!.width).toBe(840)
    expect(Math.abs(nearEdge!.height - beforeResize!.height)).toBeLessThan(1)
    await page.setViewportSize({ width: 1440, height: 900 })
    await placeCard(page, ids[0]!)
    await editor.getByRole('button', { name: '关闭节点编辑器', exact: true }).click()
    await expect(editor).toHaveCount(0)
  })
}

test('顶部画布参考可搜索接入素材，排除重复引用并支持撤销', async ({ page }) => {
  await newProject(page)
  const ids = await page.evaluate(() => [
    window.__plein.addNode({
      type: 'plein/image',
      name: '画布中的人物图',
      params: {},
      x: 100,
      y: 100,
    }),
    window.__plein.addNode({
      type: 'plein/video',
      name: '接入素材的视频',
      params: { mode: 'reference' },
      x: 500,
      y: 100,
    }),
  ])
  await clickElement(page, ids[1]!)
  await placeCard(page, ids[1]!)
  const editor = page.getByTestId('node-editor')
  await editor.getByRole('button', { name: '画布参考', exact: true }).click()
  const picker = page.getByRole('dialog', { name: '画布参考', exact: true })
  await picker.getByRole('textbox', { name: '搜索画布参考', exact: true }).fill('人物图')
  await picker.getByRole('option').filter({ hasText: '画布中的人物图' }).click()
  await expect(picker).toHaveCount(0)
  await expect(
    editor.getByRole('group', { name: '未送入：画布中的人物图', exact: true }),
  ).toBeVisible()
  const edges = () =>
    page.evaluate(
      ([source, target]) =>
        [...window.__plein.engine.doc.edges()].filter(
          (edge) => edge.from[0] === source && edge.to[0] === target,
        ).length,
      ids,
    )
  await expect.poll(edges).toBe(1)
  await editor.getByRole('button', { name: '画布参考', exact: true }).click()
  await picker.getByRole('textbox', { name: '搜索画布参考', exact: true }).fill('人物图')
  await expect(picker.getByRole('option')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(edges).toBe(0)
})

test('多参考图和长引用警告仍为提示词保留至少八行阅读空间，辅助信息可完整展开', async ({
  page,
}, info) => {
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (
    await chooser
  ).setFiles(
    [0, 1].map((i) => ({
      name: `参考图${i}.png`,
      mimeType: 'image/png',
      buffer: Buffer.from(solidPng(720, 720, [30 + i * 100, 80, 130])),
    })),
  )
  await expect
    .poll(() =>
      page.evaluate(
        () => [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'image').length,
      ),
    )
    .toBe(2)
  const missing = [0, 1, 2].map((i) => `缺失参考${i}${'角色场景与服装的完整说明'.repeat(8)}`)
  const prompt = `${missing.map((name) => `@${name}。`).join('\n')}\n${'保持人物身份、镜头运动和声音连续。\n'.repeat(20)}`
  const id = await page.evaluate((prompt) => {
    const id = window.__plein.addNode({
      type: 'plein/video',
      name: '长提示词空间',
      params: { model: 'plein/mock:video', mode: 'reference', prompt },
      x: 400,
      y: 200,
    })
    for (const el of window.__plein.engine.doc.elements())
      if (el.kind === 'image') window.__plein.connect([el.id, 'image'], [id, 'images'])
    return id
  }, prompt)
  await clickElement(page, id)
  await placeCard(page, id)
  const generator = page.getByTestId('generator')
  const field = generator.getByRole('textbox', { name: '提示词', exact: true })
  const preview = generator.getByTestId('input-preview')
  await expect(preview).toHaveAttribute('aria-busy', 'false')
  await expect(generator.getByTestId('submitted-references').getByRole('group')).toHaveCount(2)
  await expect(field).toHaveValue(prompt)
  const refs = generator.locator('.plein-prompt-references')
  const warnings = refs.getByText(/^未找到：/)
  await expect(warnings).toHaveCount(3)
  for (let i = 0; i < missing.length; i++)
    expect(await warnings.nth(i).locator('..').getAttribute('title')).toContain(missing[i])
  expect((await refs.boundingBox())!.height).toBeLessThanOrEqual(40)
  await expect.poll(async () => (await field.boundingBox())!.height).toBeGreaterThanOrEqual(192)
  const lineHeight = await field.evaluate((el) =>
    Number.parseFloat(getComputedStyle(el).lineHeight),
  )
  const textHeight = await field.evaluate((el) => {
    const s = getComputedStyle(el)
    return el.clientHeight - Number.parseFloat(s.paddingTop) - Number.parseFloat(s.paddingBottom)
  })
  expect(textHeight / lineHeight).toBeGreaterThanOrEqual(8)
  await generator.screenshot({ path: info.outputPath('compact-long-prompt.png') })
  const toggle = preview.getByRole('button', { name: /^实际输入/ })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect((await preview.boundingBox())!.width).toBeGreaterThan(
    (await generator.boundingBox())!.width - 4,
  )
  await toggle.click()
  const presets = generator.getByTestId('shot-presets')
  await presets.locator('summary').click()
  await expect(presets.locator('details')).toHaveAttribute('open', '')
  expect((await presets.boundingBox())!.width).toBeGreaterThan(
    (await generator.boundingBox())!.width - 4,
  )
  await presets.locator('summary').click()
  await expect(field).toHaveValue(prompt)
  await expect(field).toBeInViewport({ ratio: 1 })
  await expect(generator.getByRole('button', { name: '生成', exact: true })).toBeInViewport({
    ratio: 1,
  })
})
