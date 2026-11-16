import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from './fixtures'
import {
  addNode,
  byName,
  clickElement,
  edgesInto,
  elements,
  newProject,
  revealGenerator,
} from './canvas'

/**
 * 生成节点面板的参考素材：只有一处权威列表。
 * 只靠 @ 送入、没连线的图也要出现在顶部，编号与最终提示词里的编号一致。
 */

let dir = ''
/** 足够长、会跨行的参考文件名：编辑器里原样显示，换行与 textarea 一致。 */
const longName = `wrap-${'reference-name-'.repeat(14)}.png`

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-e2e-reference-authority-'))
  const ff = (...args: string[]) =>
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])
  ff('-f', 'lavfi', '-i', 'color=c=red:s=64x48', '-frames:v', '1', join(dir, 'a.png'))
  ff('-f', 'lavfi', '-i', 'color=c=blue:s=64x48', '-frames:v', '1', join(dir, longName))
})

test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

const nodeByType = async (page: Page, nodeType: string) => {
  const list = (await elements(page)).filter((e) => e.nodeType === nodeType)
  expect(list, `画布上应有且只有一个 ${nodeType}`).toHaveLength(1)
  return list[0]!
}

/** 上传一张图片：画布上多出一个有名字的图片元素 */
async function uploadReference(page: Page, hostId: string, file: string) {
  const chooser = page.waitForEvent('filechooser')
  const upload = page
    .getByTestId('generator')
    .getByRole('button', { name: '上传参考', exact: true })
  await revealGenerator(page, upload)
  await upload.click()
  await page
    .getByRole('dialog', { name: '上传参考', exact: true })
    .getByRole('button', { name: '参考图', exact: true })
    .click()
  await (await chooser).setFiles(join(dir, file))
  await expect.poll(() => edgesInto(page, hostId)).toHaveLength(1)
}

test('只靠 @ 送入的参考图在顶部可见，编号与最终提示词一致', { tag: '@core' }, async ({ page }) => {
  await newProject(page)
  // 图片元素先落到画布上（挂在角色卡下），本身也可以被 @ 引用。
  await addNode(page, '角色')
  const card = await byName(page, '角色')
  await revealGenerator(page)
  await uploadReference(page, card.id, 'a.png')

  // 生成图片节点不连线，只在提示词里 @ 那张图。
  await addNode(page, '生成图片', { x: 1200, y: 450 })
  const target = await nodeByType(page, 'plein/image')
  await clickElement(page, target.id)
  await revealGenerator(page)
  const prompt = page.getByTestId('generator').getByRole('textbox', { name: '提示词' })
  await prompt.click()
  await prompt.fill('@a.png')
  await page
    .getByRole('option', { name: /a\.png/ })
    .first()
    .click()
  await expect(prompt).toHaveValue(/@a\.png/)

  // 顶部参考素材区是唯一权威列表：@ 送入的图也在里面。
  const row = page.getByTestId('submitted-references')
  const tile = row.getByRole('group', { name: '参考 1：a.png' })
  await expect(tile).toBeVisible()
  // 这个节点没有连线，素材完全来自 @。
  expect(await edgesInto(page, target.id)).toHaveLength(0)

  // 编号在缩略图左上角（长编号会伸出缩略图），管理按钮在左下角：两者不互相遮盖，也不压住拖动区域。
  const tokenBox = await tile.locator('[data-token]').first().boundingBox()
  const manageBox = await tile.getByRole('button', { name: '管理参考 1' }).boundingBox()
  expect(manageBox!.y).toBeGreaterThanOrEqual(tokenBox!.y + tokenBox!.height)
  // 来源写在瓦片 title 里，不再占一排标签。
  await expect(tile).toHaveAttribute('title', /来自 @ 引用/)

  // 编号与最终提示词里的编号必须是同一个。
  const token = await tile.locator('[data-token]').first().getAttribute('data-token')
  expect(token).toBe('图1')
  // 正文只显示用户写的原文，编号放进悬停提示。
  const editorMark = page.getByTestId('mention-highlights').locator('mark').first()
  await expect(editorMark).toHaveText('@a.png')
  await expect(editorMark).toHaveAttribute('data-title', /a\.png → 图1/)
  await page
    .getByTestId('generator')
    .getByRole('button', { name: /实际输入/ })
    .click()
  const finalPrompt = page.getByTestId('final-prompt')
  await expect(finalPrompt).toBeVisible()
  await expect(finalPrompt).toContainText(token!)
  await expect(finalPrompt).not.toContainText('参考对应')

  // 面板里不再有单独的「引用」一栏，图片也只在顶部列一次。
  await expect(page.getByTestId('generator').getByText('引用', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('input-preview').getByRole('figure')).toHaveCount(0)
})

test('短名称 @ 在正文里保持原文，悬停能读到编号', { tag: '@core' }, async ({ page }) => {
  await newProject(page)
  await addNode(page, '角色')
  const card = await byName(page, '角色')
  await revealGenerator(page)
  await uploadReference(page, card.id, 'a.png')
  const image = (await elements(page)).find((el) => el.kind === 'image')!
  expect(image).toBeTruthy()

  // 把图片改成只有一个字的名称：正文只显示原文「@叶」，编号靠悬停提示读到。
  await clickElement(page, image.id)
  await page.keyboard.press('F2')
  const rename = page.getByRole('dialog', { name: '重命名节点' })
  await rename.getByRole('textbox').fill('叶')
  await rename.getByRole('button', { name: '保存并同步引用' }).click()
  expect((await byName(page, '叶')).id).toBe(image.id)

  const targetId = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '短名称引用',
      params: { model: 'plein/mock:image', prompt: '' },
      x: 1200,
      y: 450,
    }),
  )
  await clickElement(page, targetId)
  await revealGenerator(page)
  const prompt = page.getByTestId('generator').getByRole('textbox', { name: '提示词' })
  await prompt.click()
  await prompt.fill('@叶')
  await page.getByRole('option', { name: /^叶/ }).first().click()
  await expect(prompt).toHaveValue(/@叶/)

  await page.getByTestId('generator').getByRole('button', { name: '放大编辑提示词' }).click()
  const dialog = page.getByRole('dialog', { name: '编辑提示词' })
  const mark = dialog.getByTestId('mention-highlights').locator('mark').first()
  await expect(mark).toHaveText('@叶')
  // 等服务端编号回来再悬停，否则读到的是「正在确认」提示。
  await expect(mark).toHaveAttribute('data-title', /叶 → 图1/)
  const markBox = (await mark.boundingBox())!
  await page.mouse.move(markBox.x + markBox.width / 2, markBox.y + markBox.height / 2)
  // 提示放在实际接收鼠标事件的 textarea 上，悬停引用即可看到。
  await expect(dialog.getByRole('textbox', { name: '提示词' })).toHaveAttribute('title', /叶 → 图1/)
})

test('跨行的长引用只显示原文，不改变换行与选区', { tag: '@core' }, async ({ page }) => {
  await newProject(page)
  await addNode(page, '角色')
  const card = await byName(page, '角色')
  await revealGenerator(page)
  await uploadReference(page, card.id, longName)

  await addNode(page, '生成图片', { x: 1200, y: 450 })
  const target = await nodeByType(page, 'plein/image')
  await clickElement(page, target.id)
  await revealGenerator(page)
  const prompt = page.getByTestId('generator').getByRole('textbox', { name: '提示词' })
  await prompt.click()
  await prompt.fill(`@${longName}`)
  await page.getByRole('option').first().click()
  expect(await prompt.inputValue()).toContain(longName)

  const mark = page.getByTestId('mention-highlights').locator('mark').first()
  // 镜像层直接显示原文，不叠名称或徽标，换行与 textarea 一致。
  await expect(mark).toHaveText(`@${longName}`)
  expect(await mark.evaluate((el) => el.getClientRects().length)).toBeGreaterThan(1)
  // 镜像层不改 textarea 的值和选区。
  await prompt.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(2, 5))
  expect(
    await prompt.evaluate((el) => {
      const input = el as HTMLTextAreaElement
      return [input.selectionStart, input.selectionEnd]
    }),
  ).toEqual([2, 5])
})
