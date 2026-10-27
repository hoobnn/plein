import { expect, type Page, test } from './fixtures'
import { centerOf, newProject, showStoryboardCards, zoomTo } from './canvas'

async function fixture(page: Page) {
  await page.route('**/api/catalog', async (route) => {
    const response = await route.fetch()
    const catalog = await response.json()
    for (const provider of catalog.providers)
      for (const model of provider.models)
        if (model.capabilities.includes('video.generate'))
          model.promptGuide = { version: 'fixture-1', text: 'Fixture 指南：动作与相机分别描述。' }
    await route.fulfill({ response, json: catalog })
  })
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/storyboard',
      name: '镜头控制测试',
      x: 100,
      y: 100,
      params: {
        shots: ['one', 'two'].map((id, no) => ({
          id,
          no: no + 1,
          duration: 3,
          description: `原画面${no + 1}`,
          imagePrompt: '原图手改',
          motionPrompt: '原运动手改',
          lighting: '原光影',
        })),
      },
    }),
  )
  const editor = page.getByRole('dialog', { name: '分镜表', exact: true })
  const open = async () => {
    await zoomTo(page, [id])
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
    await expect(editor).toBeVisible()
    await showStoryboardCards(editor)
  }
  await open()
  await editor.getByRole('button', { name: '展开为节点', exact: true }).click()
  await expect(editor).toHaveCount(0)
  const video = await page.evaluate(
    (id) =>
      [...window.__plein.engine.doc.elements()].find((el) => {
        const source = el.params?.source as
          | { storyboard?: string; shot?: string; role?: string }
          | undefined
        return source?.storyboard === id && source.shot === 'one' && source.role === 'video'
      })!.id,
    id,
  )
  await open()
  const posts: string[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/(?:run|run-flow|run-batch|storyboard-batch\/commit)(?:\?|$)/.test(request.url())
    )
      posts.push(request.url())
  })
  await editor.getByRole('button', { name: '镜头 1 控制', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '镜头控制', exact: true })
  await expect(dialog).toBeVisible()
  return { id, video, editor, dialog, posts }
}

test('镜头控制保留原文，仅采用所选字段，显式同步后与有效节点输入一致，零自动生成', async ({
  page,
}, testInfo) => {
  const { id, video, editor, dialog, posts } = await fixture(page)
  const before = await page.evaluate(
    ({ id, video }) => ({
      shots: window.__plein.engine.doc.get(id)!.params!.shots,
      node: window.__plein.engine.doc.get(video)!.params,
    }),
    { id, video },
  )
  await expect(dialog.getByTestId('model-prompt-guide')).toContainText('fixture-1')
  await dialog.getByRole('textbox', { name: '相机视角', exact: true }).fill('低机位仰拍')
  await dialog.getByRole('textbox', { name: '相机运动', exact: true }).fill('相机缓慢横移')
  await dialog.getByRole('textbox', { name: '主体动作', exact: true }).fill('主体保持原姿态')
  await dialog.getByRole('textbox', { name: '光源位置', exact: true }).fill('主体左后方')
  await dialog.getByRole('textbox', { name: '照射方向', exact: true }).fill('向右前方照射')
  await dialog.getByRole('button', { name: '生成提示词草稿', exact: true }).click()
  const proposal = dialog.getByRole('textbox', { name: '建议运动提示词', exact: true })
  expect(await proposal.inputValue()).toContain('原运动手改；相机视角：低机位仰拍')
  await proposal.fill(`${await proposal.inputValue()}；用户补充节奏`)
  await proposal.scrollIntoViewIfNeeded()
  await dialog.screenshot({ path: testInfo.outputPath('control-editable-draft.png') })
  await dialog.getByRole('button', { name: '采用勾选字段', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const after = await page.evaluate(
    ({ id, video }) => ({
      shots: window.__plein.engine.doc.get(id)!.params!.shots as Array<Record<string, unknown>>,
      node: window.__plein.engine.doc.get(video)!.params,
    }),
    { id, video },
  )
  expect(after.node).toEqual(before.node)
  const original = before.shots as typeof after.shots
  expect(after.shots[1]).toEqual(original[1])
  expect(after.shots[0]!.imagePrompt).toBe(original[0]!.imagePrompt)
  expect(after.shots[0]!.motionPrompt).toContain('用户补充节奏')
  expect(after.shots[0]!.lighting).toContain('光源位置：主体左后方；照射方向：向右前方照射')
  await editor.getByRole('button', { name: /^查看差异/ }).click()
  const sync = page.getByRole('dialog', { name: '计划差异', exact: true })
  await sync.getByRole('button', { name: '同步计划改动', exact: true }).click()
  const canvasId = decodeURIComponent(page.url().split('#/c/')[1]!.split('?')[0]!)
  const response = await page.request.get(`/api/canvases/${canvasId}/nodes/${video}/input`)
  expect(response.status()).toBe(200)
  const input = await response.json()
  expect(input.prompt).toContain('相机运动：相机缓慢横移')
  expect(input.prompt).toContain('主体动作：主体保持原姿态')
  expect(input.prompt).toContain('向右前方照射')
  expect(input.model.ref).toBe(before.node!.model)
  expect(posts).toEqual([])
})

test('同帧换模型拒绝旧草稿，模型未知只展示通用方法，实时只读不写入', async ({ page }, testInfo) => {
  const { id, video, dialog, posts } = await fixture(page)
  await dialog.getByRole('textbox', { name: '相机运动', exact: true }).fill('缓慢拉远')
  await dialog.getByRole('button', { name: '生成提示词草稿', exact: true }).click()
  await dialog
    .getByRole('button', { name: '采用勾选字段', exact: true })
    .evaluate((button, video) => {
      const params = window.__plein.engine.doc.mutable(video)!.get('params') as {
        set(key: string, value: unknown): void
      }
      params.set('model', 'missing:model')
      ;(button as HTMLButtonElement).click()
    }, video)
  await expect(dialog).toContainText('草稿未写入')
  await expect(dialog).toContainText('当前没有可用的模型声明')
  expect(
    await page.evaluate(
      (id) =>
        (window.__plein.engine.doc.get(id)!.params!.shots as Array<{ motionPrompt: string }>)[0]!
          .motionPrompt,
      id,
    ),
  ).toBe('原运动手改')
  await dialog.screenshot({ path: testInfo.outputPath('control-model-changed.png') })
  await page.evaluate(() => {
    const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
      schemaVersion: number
      meta: { set(key: string, value: unknown): void }
    }
    doc.meta.set('schemaVersion', doc.schemaVersion + 1)
  })
  await expect(dialog.getByRole('button', { name: '生成提示词草稿', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '采用勾选字段', exact: true })).toBeDisabled()
  await expect(dialog).toContainText('当前只读')
  expect(posts).toEqual([])
})

test('镜头控制 Escape 只关闭当前层，分镜表保留且零生成', async ({ page }) => {
  const { dialog, editor, posts } = await fixture(page)
  await dialog.getByRole('textbox', { name: '相机运动', exact: true }).fill('缓慢推近')
  await dialog.getByRole('button', { name: '生成提示词草稿', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(editor).toBeVisible()
  await expect(editor.getByRole('article')).toHaveCount(2)
  expect(posts).toEqual([])
})
