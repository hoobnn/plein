import { expect, test } from './fixtures'
import { solidPng } from '../packages/providers/src/mock/media'
import { centerOf, newProject, zoomTo } from './canvas'

test('逐镜头流程可选运镜、核对资产、本地补齐提示词，保留手写内容且不生成', async ({ page }) => {
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (
    await chooser
  ).setFiles({
    name: '角色参考.png',
    mimeType: 'image/png',
    buffer: Buffer.from(solidPng(128, 128, [80, 110, 150])),
  })
  await expect
    .poll(() =>
      page.evaluate(
        () => [...window.__plein.engine.doc.elements()].filter((e) => e.kind === 'image').length,
      ),
    )
    .toBe(1)
  const id = await page.evaluate(() => {
    const image = [...window.__plein.engine.doc.elements()].find((e) => e.kind === 'image')!
    const hero = window.__plein.addNode({
      type: 'plein/character',
      name: '林夏',
      params: {},
      x: 0,
      y: 0,
    })
    window.__plein.connect([image.id, 'image'], [hero, 'references'])
    window.__plein.addNode({ type: 'plein/scene', name: '天台', params: {}, x: 0, y: 400 })
    window.__plein.addNode({ type: 'plein/prop', name: '玻璃杯', params: {}, x: 400, y: 400 })
    return window.__plein.addNode({
      type: 'plein/storyboard',
      name: '镜头制作验收',
      x: 500,
      y: 100,
      params: {
        shots: [
          {
            id: 'shot-one',
            no: 1,
            duration: 3,
            description: '林夏拿起杯子',
            characters: ['林夏', '天台', '玻璃杯'],
            imagePrompt: '用户手写的首帧提示词',
            dialogue: [{ character: '林夏', line: '我们走吧' }],
          },
          { id: 'shot-two', no: 2, duration: 4, description: '林夏走向门口', characters: ['林夏'] },
        ],
      },
    })
  })
  let generated = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/(run|run-batch|run-flow)(\?|$)/.test(request.url()))
      generated++
  })
  await zoomTo(page, [id])
  const at = await centerOf(page, id)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.getByRole('dialog', { name: '分镜表', exact: true })
  const table = editor.getByRole('table', { name: '逐镜头分镜表', exact: true })
  const row = table.getByRole('row', { name: '镜头 01', exact: true })
  await expect(row).toBeVisible()
  await row.getByRole('combobox', { name: '镜头 1 运镜预设', exact: true }).click()
  await page.getByRole('option', { name: '推近', exact: true }).click()
  const shots = () =>
    page.evaluate(
      (id) =>
        window.__plein.engine.doc.get(id)!.params!.shots as Array<{
          cameraMotion?: string
          imagePrompt: string
          motionPrompt: string
        }>,
      id,
    )
  await expect.poll(async () => (await shots())[0]?.cameraMotion).toBe('推近主体')
  await editor.getByRole('navigation', { name: '镜头制作流程' }).getByRole('button').nth(1).click()
  await expect(
    editor.getByRole('article', { name: '林夏素材', exact: true }).getByRole('img'),
  ).toBeVisible()
  await expect(editor.getByRole('article', { name: '天台素材', exact: true })).toContainText(
    '待准备',
  )
  await editor
    .getByRole('textbox', { name: '全局视觉风格', exact: true })
    .fill('胶片夜景，保留自然肤质')
  await editor.getByRole('textbox', { name: '全局视觉风格', exact: true }).blur()
  await page.screenshot({ path: test.info().outputPath('assets.png') })
  await editor.getByRole('navigation', { name: '镜头制作流程' }).getByRole('button').nth(2).click()
  await row.getByRole('checkbox', { name: '选择镜头 1', exact: true }).check()
  await editor.getByRole('button', { name: '本地补齐所选提示词', exact: true }).click()
  await expect.poll(async () => (await shots())[0]?.motionPrompt).toContain('推近主体')
  await expect.poll(async () => (await shots())[1]?.imagePrompt).toBe('')
  await expect(
    editor.getByRole('button', { name: '本地补齐所选提示词', exact: true }),
  ).toBeDisabled()
  await row.getByRole('checkbox', { name: '选择镜头 1', exact: true }).uncheck()
  await editor.getByRole('button', { name: '本地补齐全部提示词', exact: true }).click()
  await expect.poll(async () => (await shots())[0]?.imagePrompt).toBe('用户手写的首帧提示词')
  await expect.poll(async () => (await shots())[0]?.motionPrompt).toContain('推近主体')
  await expect.poll(async () => (await shots())[1]?.imagePrompt).toContain('胶片夜景')
  await row.getByRole('button', { name: '查看提示词', exact: true }).click()
  const prompts = page.getByRole('dialog', { name: '镜头最终提示词', exact: true })
  await expect(prompts.getByRole('textbox', { name: '分镜图提示词', exact: true })).toHaveValue(
    '用户手写的首帧提示词',
  )
  await expect(prompts.getByRole('textbox', { name: '视频运动提示词', exact: true })).toHaveValue(
    /推近主体/,
  )
  await page.screenshot({ path: test.info().outputPath('prompts.png') })
  await prompts.getByRole('textbox', { name: '分镜图提示词', exact: true }).fill('修改后关闭也保留')
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await shots())[0]?.imagePrompt).toBe('修改后关闭也保留')
  await expect(prompts).toHaveCount(0)
  await expect(editor).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('shot-table.png') })
  await editor.getByRole('button', { name: '详细卡片', exact: true }).click()
  await expect(editor.getByRole('article')).toHaveCount(2)
  await editor.getByRole('button', { name: '镜头表格', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 700 })
  await table
    .getByRole('row', { name: '镜头 02', exact: true })
    .getByRole('textbox', { name: '画面', exact: true })
    .fill('窄窗口编辑保留')
  await table
    .getByRole('row', { name: '镜头 02', exact: true })
    .getByRole('textbox', { name: '画面', exact: true })
    .blur()
  expect(generated).toBe(0)
})
