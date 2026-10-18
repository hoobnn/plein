import { expect, type Page, test } from '@playwright/test'
import { centerOf, clickElement, newProject, waitEngine } from './canvas'

async function open(page: Page, id: string) {
  await clickElement(page, id)
  const at = await centerOf(page, id)
  await page.mouse.dblclick(at.x, at.y)
}
const fields = (page: Page) =>
  page
    .getByRole('dialog', { name: '分镜表', exact: true })
    .getByRole('textbox', { name: '台词', exact: true })
const saved = (page: Page, id: string) =>
  page.evaluate(
    (id) =>
      (
        window.__plein.engine.doc.get(id)!.params!.shots as Array<{
          dialogue: Array<{ id: string; character: string; line: string }>
        }>
      )[0]!.dialogue,
    id,
  )

for (const dirty of [false, true]) {
  test(`台词${dirty ? '已有草稿' : '仅聚焦'}时同伴修改，失焦不覆盖对方内容`, async ({
    page,
    context,
  }) => {
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/storyboard',
        name: '台词协作',
        x: 400,
        y: 200,
        params: {
          shots: [
            {
              id: 'one',
              no: 1,
              duration: 4,
              dialogue: [
                { id: 'a', character: '林晚', line: '原始第一句' },
                { id: 'b', character: '老周', line: '原始第二句' },
              ],
            },
          ],
        },
      }),
    )
    await open(page, id)
    const peerContext = await context.browser()!.newContext()
    try {
      const peer = await peerContext.newPage()
      await peer.goto(page.url())
      await waitEngine(peer)
      await expect(peer.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected')
      await expect.poll(() => saved(peer, id)).toHaveLength(2)
      await open(peer, id)
      if (dirty) await fields(page).first().fill('林晚：本机未提交台词😀')
      else await fields(page).first().focus()
      await fields(peer).first().fill('林晚：同伴已保存第一句')
      await fields(peer).first().blur()
      await expect.poll(async () => (await saved(page, id))[0]!.line).toBe('同伴已保存第一句')
      await fields(page).first().press('Tab')
      expect((await saved(page, id))[0]!.line).toBe('同伴已保存第一句')
      expect((await saved(page, id))[1]).toMatchObject({
        id: 'b',
        character: '老周',
        line: '原始第二句',
      })
      if (dirty) {
        await expect(fields(page).first()).toHaveValue('林晚：本机未提交台词😀')
        await expect(
          page.getByRole('dialog', { name: '分镜表' }).getByRole('status'),
        ).toContainText('台词已在其他位置更新')
        const cell = page.locator('[data-dialogue-id="a"]').first()
        await cell.getByRole('button', { name: '使用最新台词', exact: true }).click()
        await expect(fields(page).first()).toHaveValue('林晚：同伴已保存第一句')
        await expect(fields(page).first()).toBeFocused()
        await fields(page).first().fill('林晚：本机第一句\n老周：本机新一句')
        await fields(peer).first().fill('林晚：同伴再次修改')
        await fields(peer).first().blur()
        await expect.poll(async () => (await saved(page, id))[0]!.line).toBe('同伴再次修改')
        await fields(page).first().blur()
        expect((await saved(page, id))[0]!.line).toBe('同伴再次修改')
        await page.setViewportSize({ width: 800, height: 560 })
        const keep = cell.getByRole('button', { name: '保留当前台词', exact: true })
        await keep.scrollIntoViewIfNeeded()
        await expect(keep).toBeInViewport()
        expect(await cell.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
        await page.screenshot({ path: test.info().outputPath('dialogue-conflict-narrow.png') })
        await keep.click()
        await expect(fields(page)).toHaveCount(3)
        const result = await saved(page, id)
        expect(result[0]).toEqual({ id: 'a', character: '林晚', line: '本机第一句' })
        expect(result[1]).toMatchObject({ character: '老周', line: '本机新一句' })
        expect(['a', 'b']).not.toContain(result[1]!.id)
        expect(result[2]).toEqual({ id: 'b', character: '老周', line: '原始第二句' })
        await expect.poll(() => saved(peer, id)).toEqual(result)
        await expect(cell.getByRole('status')).toHaveCount(0)
        await expect(fields(page).first()).toBeFocused()
      } else await expect(fields(page).first()).toHaveValue('林晚：同伴已保存第一句')
    } finally {
      await peerContext.close()
    }
  })
}

for (const operation of ['update', 'move', 'delete'] as const) {
  test(`台词同帧 ${operation} 后提交，按稳定身份保留新内容与说话人`, async ({ page }) => {
    await newProject(page)
    const { id, speaker } = await page.evaluate(() => {
      const speaker = window.__plein.addNode({
        type: 'plein/character',
        name: '林晚',
        x: -700,
        y: 200,
        params: {},
      })
      const id = window.__plein.addNode({
        type: 'plein/storyboard',
        name: '台词身份边界',
        x: 400,
        y: 200,
        params: {
          shots: [
            {
              id: 'one',
              no: 1,
              duration: 4,
              dialogue: [
                { id: 'a', character: '林晚', line: '原始第一句' },
                { id: 'b', character: '老周', line: '原始第二句' },
              ],
            },
          ],
        },
      })
      return { id, speaker }
    })
    await open(page, id)
    await fields(page).first().fill('林晚：本机修改')
    await page.evaluate(
      ({ id, speaker, operation }) => {
        const doc = window.__plein.engine.doc
        const shots = doc.get(id)!.params!.shots as Array<{
          dialogue: Array<Record<string, unknown>>
        }>
        const params = doc.mutable(id)!.get('params') as { set(key: string, value: unknown): void }
        params.set(
          'shots',
          shots.map((shot) => ({
            ...shot,
            dialogue:
              operation === 'update'
                ? shot.dialogue.map((line) =>
                    line.id === 'a'
                      ? { ...line, line: '同帧新台词', speaker: { elementId: speaker } }
                      : line,
                  )
                : operation === 'move'
                  ? [...shot.dialogue].reverse()
                  : shot.dialogue.filter((line) => line.id !== 'a'),
          })),
        )
        ;(document.activeElement as HTMLElement).blur()
      },
      { id, speaker, operation },
    )
    const result = await saved(page, id)
    if (operation === 'update') {
      expect(result[0]).toMatchObject({
        id: 'a',
        line: '同帧新台词',
        speaker: { elementId: speaker },
      })
      const cell = page.locator('[data-dialogue-id="a"]').first()
      await expect(cell.getByRole('status')).toContainText('台词已在其他位置更新')
      await cell.getByRole('button', { name: '保留当前台词', exact: true }).click()
      expect((await saved(page, id))[0]).toMatchObject({
        id: 'a',
        character: '林晚',
        line: '本机修改',
        speaker: { elementId: speaker },
      })
    } else if (operation === 'move') {
      expect(result).toEqual([
        { id: 'b', character: '老周', line: '原始第二句' },
        { id: 'a', character: '林晚', line: '本机修改' },
      ])
    } else {
      expect(result).toEqual([{ id: 'b', character: '老周', line: '原始第二句' }])
      await expect(fields(page)).toHaveCount(1)
      await expect(fields(page).first()).toHaveValue('老周：原始第二句')
    }
  })
}
