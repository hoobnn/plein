import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from './fixtures'
import { addNode, byName, clickElement, edgesInto, newProject, revealGenerator } from './canvas'

let dir = ''

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-e2e-reference-reorder-'))
  const ff = (...args: string[]) =>
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])
  const colors = { a: 'red', b: 'blue', c: 'green' } as const
  for (const [name, color] of Object.entries(colors))
    ff('-f', 'lavfi', '-i', `color=c=${color}:s=64x48`, '-frames:v', '1', join(dir, `${name}.png`))
})

test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** 参考图瓦片的显示顺序（aria-label 里的素材名）；多输入端口的顺序以界面上这条为准 */
const tileNames = (page: Page) =>
  page
    .getByTestId('generator')
    .getByRole('group')
    .evaluateAll((tiles) => tiles.map((t) => t.getAttribute('aria-label') ?? ''))

async function uploadReference(page: Page, hostId: string, file: string, expected: number) {
  const chooser = page.waitForEvent('filechooser')
  const uploadButton = page
    .getByTestId('generator')
    .getByRole('button', { name: '上传参考', exact: true })
  await revealGenerator(page, uploadButton)
  await uploadButton.click()
  await page
    .getByRole('dialog', { name: '上传参考', exact: true })
    .getByRole('button', { name: '参考图', exact: true })
    .click()
  await (await chooser).setFiles(join(dir, file))
  await expect.poll(() => edgesInto(page, hostId)).toHaveLength(expected)
}

test('从参考图编号点击可打开预览', { tag: '@core' }, async ({ page }) => {
  await newProject(page)
  await addNode(page, '角色')
  const card = await byName(page, '角色')
  await revealGenerator(page)
  await uploadReference(page, card.id, 'a.png', 1)

  const token = page
    .getByTestId('generator')
    .getByRole('group', { name: '参考 1：a.png' })
    .locator('[data-token]')
  const tokenBox = await token.boundingBox()
  await page.mouse.click(tokenBox!.x + tokenBox!.width / 2, tokenBox!.y + tokenBox!.height / 2)
  await expect(page.getByRole('dialog', { name: '查看「a.png」' })).toBeVisible()
})

test('从参考图编号拖动可换序', { tag: '@core' }, async ({ page }) => {
  await newProject(page)
  await addNode(page, '角色')
  const card = await byName(page, '角色')
  await revealGenerator(page)
  await uploadReference(page, card.id, 'a.png', 1)
  await uploadReference(page, card.id, 'b.png', 2)
  expect(await tileNames(page)).toEqual(['参考 1：a.png', '参考 2：b.png'])

  const tiles = page.getByTestId('generator').getByRole('group')
  const tokenBox = await tiles.nth(1).locator('[data-token]').boundingBox()
  const targetBox = await tiles.nth(0).boundingBox()
  await page.mouse.move(tokenBox!.x + tokenBox!.width / 2, tokenBox!.y + tokenBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, {
    steps: 8,
  })
  await page.mouse.up()

  await expect.poll(() => tileNames(page)).toEqual(['参考 1：b.png', '参考 2：a.png'])
})

test(
  '参考图拖动换序：放下重排、Esc 取消不改顺序、撤销一次恢复',
  { tag: '@core' },
  async ({ page }) => {
    await newProject(page)
    await addNode(page, '角色')
    const card = await byName(page, '角色')
    await revealGenerator(page)

    await uploadReference(page, card.id, 'a.png', 1)
    await uploadReference(page, card.id, 'b.png', 2)
    await uploadReference(page, card.id, 'c.png', 3)

    expect(await tileNames(page)).toEqual(['参考 1：a.png', '参考 2：b.png', '参考 3：c.png'])

    // 把第 2 块（b）拖到第 1 块（a）上：插入到它前面。返回落点坐标
    const drag = async (from: number, to: number) => {
      const tiles = page.getByTestId('generator').getByRole('group')
      const fromBox = await tiles.nth(from).boundingBox()
      const toBox = await tiles.nth(to).boundingBox()
      const point = { x: toBox!.x + toBox!.width / 2, y: toBox!.y + toBox!.height / 2 }
      await page.mouse.move(fromBox!.x + fromBox!.width / 2, fromBox!.y + fromBox!.height / 2)
      await page.mouse.down()
      await page.mouse.move(point.x, point.y, { steps: 8 })
      await page.mouse.up()
      return point
    }
    await drag(1, 0)
    await expect
      .poll(() => tileNames(page))
      .toEqual(['参考 1：b.png', '参考 2：a.png', '参考 3：c.png'])
    // 落点点击抑制在测试末尾用受控时钟验证；此处先重选节点继续
    await clickElement(page, card.id)
    await revealGenerator(page)

    // Esc 取消：拖起来再按 Esc，顺序不变。
    // 应用层会把 Esc 当作取消选中并关闭面板（与旧原生拖拽一致），重新选中后断言。
    const tiles = page.getByTestId('generator').getByRole('group')
    const dragBox = await tiles.nth(0).boundingBox()
    await page.mouse.move(dragBox!.x + dragBox!.width / 2, dragBox!.y + dragBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(dragBox!.x + dragBox!.width / 2 + 60, dragBox!.y, { steps: 6 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await clickElement(page, card.id)
    await revealGenerator(page)
    expect(await tileNames(page)).toEqual(['参考 1：b.png', '参考 2：a.png', '参考 3：c.png'])

    // 撤销一次回到原顺序：一次拖拽是一个撤销分组
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect
      .poll(() => tileNames(page))
      .toEqual(['参考 1：a.png', '参考 2：b.png', '参考 3：c.png'])

    // 拖拽放下后的落点点击抑制：用受控时钟代替「必须赶在 50ms 内点击」的真实时序——
    // 时钟暂停后窗口只在 clock 推进时关闭，不受调度延迟影响。
    // 放在本段末尾：安装后 Motion / 画布的 rAF 被接管，之后不再有其他交互。
    await page.clock.install()
    // 跳到未来固定时刻并暂停：目标留 400ms 裕量，避免与 install 后已走过的时钟相比“回到过去”
    await page.clock.pauseAt(Date.now() + 400)
    const finalDrop = await drag(0, 1)
    const viewer = page.getByRole('dialog', { name: /查看「/ })
    // 窗口内（时钟未推进）：落点点击不开预览
    await page.mouse.click(finalDrop.x, finalDrop.y)
    await expect(viewer).toHaveCount(0)
    // 推进越过 50ms 窗口（顺带让挂起的动画帧走完）：点击正常打开预览
    await page.clock.runFor(200)
    await page.mouse.click(finalDrop.x, finalDrop.y)
    await expect(viewer).toBeVisible()
  },
)
