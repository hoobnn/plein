import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'
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
const tileNames = (page: import('./fixtures').Page) =>
  page
    .getByTestId('generator')
    .getByRole('group')
    .evaluateAll((tiles) => tiles.map((t) => t.getAttribute('aria-label') ?? ''))

test(
  '参考图拖动换序：放下重排、Esc 取消不改顺序、撤销一次恢复',
  { tag: '@core' },
  async ({ page }) => {
    await newProject(page)
    await addNode(page, '角色')
    const card = await byName(page, '角色')
    await revealGenerator(page)

    const upload = async (file: string, expected: number) => {
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
      await expect.poll(() => edgesInto(page, card.id)).toHaveLength(expected)
    }
    await upload('a.png', 1)
    await upload('b.png', 2)
    await upload('c.png', 3)

    expect(await tileNames(page)).toEqual(['参考 1：a.png', '参考 2：b.png', '参考 3：c.png'])

    // 把第 2 块（b）拖到第 1 块（a）上：插入到它前面
    const drag = async (from: number, to: number) => {
      const tiles = page.getByTestId('generator').getByRole('group')
      const fromBox = await tiles.nth(from).boundingBox()
      const toBox = await tiles.nth(to).boundingBox()
      await page.mouse.move(fromBox!.x + fromBox!.width / 2, fromBox!.y + fromBox!.height / 2)
      await page.mouse.down()
      await page.mouse.move(toBox!.x + toBox!.width / 2, toBox!.y + toBox!.height / 2, { steps: 8 })
      await page.mouse.up()
    }
    await drag(1, 0)
    await expect
      .poll(() => tileNames(page))
      .toEqual(['参考 1：b.png', '参考 2：a.png', '参考 3：c.png'])

    // Esc 取消：拖起来再按 Esc，顺序不变。
    // 应用层会把 Esc 当作取消选中并关闭面板（与旧原生拖拽一致），重新选中后断言。
    const tiles = page.getByTestId('generator').getByRole('group')
    const fromBox = await tiles.nth(0).boundingBox()
    await page.mouse.move(fromBox!.x + fromBox!.width / 2, fromBox!.y + fromBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(fromBox!.x + fromBox!.width / 2 + 60, fromBox!.y, { steps: 6 })
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
  },
)
