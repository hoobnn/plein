import { expect, type Page, test } from './fixtures'
import { centerOf, clickElement, newProject, showStoryboardCards, waitEngine } from './canvas'
import { slowFile } from './slow-file'

const field = (page: Page) =>
  page
    .getByRole('dialog', { name: '分镜表', exact: true })
    .getByLabel('画面', { exact: true })
    .first()
async function open(page: Page, id: string) {
  await clickElement(page, id)
  const at = await centerOf(page, id)
  await page.mouse.dblclick(at.x, at.y)
  await showStoryboardCards(page.getByRole('dialog', { name: '分镜表', exact: true }))
  await expect(field(page)).toBeVisible()
}
const saved = (page: Page, id: string) =>
  page.evaluate(
    (id) =>
      (window.__plein.engine.doc.get(id)!.params!.shots as Array<{ description: string }>)[0]!
        .description,
    id,
  )
for (const dirty of [false, true]) {
  test(`分镜画面${dirty ? '已有草稿' : '仅聚焦'}时同伴更新，失焦不覆盖新内容`, async ({
    page,
    context,
  }) => {
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/storyboard',
        name: '协作分镜',
        x: 400,
        y: 200,
        params: {
          shots: [
            {
              id: 'one',
              no: 1,
              duration: 3,
              description: '原始画面',
              imagePrompt: '雨后桌面',
              dialogue: [],
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
      await expect.poll(() => saved(peer, id)).toBe('原始画面')
      await open(peer, id)
      if (dirty) await field(page).fill('本机尚未提交的画面😀')
      else await field(page).focus()
      await field(peer).fill('同伴已保存的新画面')
      await field(peer).blur()
      await expect.poll(() => saved(page, id)).toBe('同伴已保存的新画面')
      await expect(field(page)).toBeFocused()
      await field(page).press('Tab')
      expect(await saved(page, id)).toBe('同伴已保存的新画面')
      if (dirty) {
        await expect(field(page)).toHaveValue('本机尚未提交的画面😀')
        await expect(
          page.getByRole('dialog', { name: '分镜表' }).getByRole('status'),
        ).toContainText('画面已在其他位置更新')
      } else await expect(field(page)).toHaveValue('同伴已保存的新画面')
      await expect.poll(() => saved(peer, id)).toBe('同伴已保存的新画面')
      if (dirty) {
        const cell = page.locator('[data-storyboard-field="画面"]').first()
        await cell.getByRole('button', { name: '使用最新内容', exact: true }).click()
        await expect(field(page)).toHaveValue('同伴已保存的新画面')
        await expect(cell.getByRole('status')).toHaveCount(0)
        await expect(field(page)).toBeFocused()
        await field(page).fill('确认保留的本机画面')
        expect(await saved(page, id)).toBe('同伴已保存的新画面')
        await field(peer).fill('同伴再次更新画面')
        await field(peer).blur()
        await expect.poll(() => saved(page, id)).toBe('同伴再次更新画面')
        await expect(field(page)).toHaveValue('确认保留的本机画面')
        await field(page).blur()
        expect(await saved(page, id)).toBe('同伴再次更新画面')
        await cell.getByRole('button', { name: '保留当前输入', exact: true }).click()
        await expect.poll(() => saved(peer, id)).toBe('确认保留的本机画面')
        await expect(cell.getByRole('status')).toHaveCount(0)
        await expect(field(page)).toBeFocused()
        await field(page).fill('小窗口里的本机草稿😀')
        const long = '同伴补充的长画面说明，包含雨后木桌与水杯。'.repeat(60)
        await field(peer).fill(long)
        await field(peer).blur()
        await expect.poll(() => saved(page, id)).toBe(long)
        await page.setViewportSize({ width: 800, height: 560 })
        const useLatest = cell.getByRole('button', { name: '使用最新内容', exact: true })
        await useLatest.scrollIntoViewIfNeeded()
        await expect(useLatest).toBeInViewport()
        expect(await cell.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
        await page.screenshot({ path: test.info().outputPath('storyboard-conflict-narrow.png') })
        await useLatest.click()
        await expect(field(page)).toHaveValue(long)
        await expect(cell.getByRole('status')).toHaveCount(0)
      }
    } finally {
      await peerContext.close()
    }
  })
}

for (const [key, label, local, remote] of [
  ['description', '画面', '本机画面草稿', '同帧新画面'],
  ['imagePrompt', '分镜图提示词', '本机生成提示词', '同帧新提示词'],
  ['characters', '出场', '@本机角色', ['同帧新角色']],
] as const) {
  test(`${label}文档更新尚未通知时失焦，也不覆盖新内容`, async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/storyboard',
        name: '同帧分镜',
        x: 400,
        y: 200,
        params: {
          shots: [
            {
              id: 'one',
              no: 1,
              duration: 3,
              description: '原始画面',
              imagePrompt: '原始提示词',
              characters: ['原始角色'],
              dialogue: [],
            },
          ],
        },
      }),
    )
    await open(page, id)
    const input = page
      .getByRole('dialog', { name: '分镜表' })
      .getByLabel(label, { exact: true })
      .first()
    await input.fill(local)
    await page.evaluate(
      ({ id, key, remote }) => {
        const doc = window.__plein.engine.doc
        const shots = doc.get(id)!.params!.shots as Array<Record<string, unknown>>
        const params = doc.mutable(id)!.get('params') as { set(key: string, value: unknown): void }
        params.set(
          'shots',
          shots.map((shot) => ({ ...shot, [key]: remote })),
        )
        // 同一个 JS 任务中触发 blur，React 仍持有上一次文档通知的 props。
        ;(document.activeElement as HTMLElement).blur()
      },
      { id, key, remote },
    )
    const read = () =>
      page.evaluate(
        ({ id, key }) =>
          (window.__plein.engine.doc.get(id)!.params!.shots as Array<Record<string, unknown>>)[0]![
            key
          ],
        { id, key },
      )
    expect(await read()).toEqual(remote)
    await expect(input).toHaveValue(local)
    const cell = page.locator(`[data-storyboard-field="${label}"]`).first()
    await expect(cell.getByRole('status')).toContainText('已在其他位置更新')
    await cell.getByRole('button', { name: '保留当前输入', exact: true }).click()
    await expect.poll(read).toEqual(key === 'characters' ? ['本机角色'] : local)
    await expect(cell.getByRole('status')).toHaveCount(0)
  })
}

// 这批用例要跑真实渲染、编码或很大的工程，单条本来就慢
slowFile(test)
