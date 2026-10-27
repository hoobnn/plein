import { expect, type Page, test } from './fixtures'
import { centerOf, contextMenu, newProject, settle, waitEngine } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const ids = await page.evaluate(() => [
    window.__plein.addNode({
      type: 'plein/text',
      name: '海边文本',
      params: { text: '海边' },
      x: 1600,
      y: 1000,
    }),
    window.__plein.addNode({
      type: 'plein/text',
      name: '山林文本',
      params: { text: '山林' },
      x: 2100,
      y: 1000,
    }),
    window.__plein.addNode({ type: 'plein/image', name: '海边图片', params: {}, x: 2600, y: 1000 }),
  ])
  const sidebar = page.getByRole('complementary', { name: '侧栏', exact: true })
  await expect(sidebar.getByRole('treeitem')).toHaveCount(3)
  return { sidebar, ids }
}

for (const close of ['Escape', 'button']) {
  test(`侧栏搜索通过 ${close} 关闭后焦点返回搜索入口，结果恢复`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 560 })
    const { sidebar } = await fixture(page)
    const open = sidebar.getByRole('button', { name: '搜索', exact: true })
    await open.click()
    const query = sidebar.getByRole('textbox', { name: '搜索画布元素', exact: true })
    await expect(query).toBeFocused()
    await query.fill('海边')
    await expect(sidebar.getByRole('treeitem')).toHaveCount(2)
    if (close === 'Escape')
      await sidebar.screenshot({
        path: test.info().outputPath('sidebar-search.png'),
        animations: 'disabled',
      })
    if (close === 'Escape') await query.press('Escape')
    else await sidebar.getByRole('button', { name: '关闭搜索', exact: true }).click()
    await expect(query).toHaveCount(0)
    await expect(sidebar.getByRole('treeitem')).toHaveCount(3)
    await expect(open).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(query).toBeFocused()
    await expect(query).toHaveValue('')
  })
}

for (const mode of ['composition', 'legacy229']) {
  test(`侧栏搜索的 ${mode} 确认取消不关闭搜索或丢失查询`, async ({ page }) => {
    const { sidebar } = await fixture(page)
    await sidebar.getByRole('button', { name: '搜索', exact: true }).click()
    const query = sidebar.getByRole('textbox', { name: '搜索画布元素', exact: true })
    await query.fill('海边')
    const selection = await page.evaluate(() => window.__plein.engine.selection.values())
    const sent = await query.evaluate((input, mode) => {
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true,
        isComposing: mode === 'composition',
        keyCode: mode === 'legacy229' ? 229 : 27,
      })
      input.dispatchEvent(event)
      return { composing: event.isComposing, keyCode: event.keyCode }
    }, mode)
    if (mode === 'composition') expect(sent.composing).toBe(true)
    else expect(sent.keyCode).toBe(229)
    await expect(query).toBeVisible()
    await expect(query).toHaveValue('海边')
    await expect(query).toBeFocused()
    await expect(sidebar.getByRole('treeitem')).toHaveCount(2)
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual(selection)
  })
}

test('侧栏类型与名称组合筛选实时响应重命名和删除，并能定位正确节点', async ({ page }) => {
  const { sidebar, ids } = await fixture(page)
  await sidebar.getByRole('button', { name: '按类型筛选', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '文本', exact: true }).click()
  await expect(sidebar.getByRole('treeitem')).toHaveCount(2)
  await sidebar.getByRole('button', { name: '搜索', exact: true }).click()
  const query = sidebar.getByRole('textbox', { name: '搜索画布元素', exact: true })
  await query.fill('海边')
  await expect(sidebar.getByRole('treeitem')).toHaveCount(1)
  const original = sidebar.locator(`[role="treeitem"][data-id="${ids[0]}"]`)
  await expect(original).toHaveAccessibleName('海边文本 定位到画布')
  await original.press('F2')
  const rename = original.getByRole('textbox')
  await rename.fill('海湾文本')
  await rename.press('Enter')
  await expect(sidebar.getByRole('treeitem')).toHaveCount(0)
  await expect(sidebar.getByText('没有符合条件的元素', { exact: true })).toBeVisible()
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, ids[0]!)).toBe(
    '海湾文本',
  )
  await query.fill('海湾')
  const result = sidebar.getByRole('treeitem', { name: '海湾文本 定位到画布', exact: true })
  await result.click()
  await expect(result).toHaveAttribute('aria-selected', 'true')
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([ids[0]])
  await result.getByRole('button', { name: '定位到画布', exact: true }).click()
  await settle(page, ids[0]!)
  const position = await centerOf(page, ids[0]!)
  const bounds = (await sidebar.boundingBox())!
  expect(position.x).toBeGreaterThan(bounds.x + bounds.width)
  await contextMenu(page, ids[0]!, '删除')
  await expect(sidebar.getByRole('treeitem')).toHaveCount(0)
  expect(await page.evaluate((id) => !!window.__plein.engine.doc.get(id), ids[0]!)).toBe(false)
})

for (const commit of ['Enter', 'blur']) {
  test(`侧栏改名期间变为只读，${commit} 不写入也不抛错，恢复后可重新编辑`, async ({ page }) => {
    const { sidebar, ids } = await fixture(page)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const row = sidebar.locator(`[role="treeitem"][data-id="${ids[0]}"]`)
    await row.press('F2')
    const rename = row.getByRole('textbox', { name: '元素名称', exact: true })
    await rename.fill('只读期间不应保存')
    await page.evaluate(() => {
      ;(
        window.__plein.engine.doc as typeof window.__plein.engine.doc & { readOnly: boolean }
      ).readOnly = true
    })
    if (commit === 'Enter') await rename.press('Enter')
    else await sidebar.getByRole('button', { name: '搜索', exact: true }).click()
    await expect(rename).toHaveCount(0)
    await expect(
      commit === 'Enter'
        ? row
        : sidebar.getByRole('textbox', { name: '搜索画布元素', exact: true }),
    ).toBeFocused()
    await expect(page.getByText('画布已变为只读，名称未保存', { exact: true })).toBeVisible()
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, ids[0]!)).toBe(
      '海边文本',
    )
    expect(errors).toEqual([])
    await page.evaluate(() => {
      ;(
        window.__plein.engine.doc as typeof window.__plein.engine.doc & { readOnly: boolean }
      ).readOnly = false
    })
    await row.press('F2')
    await rename.fill('恢复后保存')
    await rename.press('Enter')
    await expect(row).toContainText('恢复后保存')
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, ids[0]!)).toBe(
      '恢复后保存',
    )
  })
}

for (const commit of ['Enter', 'blur'] as const) {
  for (const dirty of [false, true]) {
    test(`侧栏改名${dirty ? '已有草稿' : '仅聚焦'}时同伴改名，${commit} 不静默覆盖远端名称`, async ({
      page,
      context,
    }) => {
      const { sidebar, ids } = await fixture(page)
      const row = sidebar.locator(`[role="treeitem"][data-id="${ids[0]}"]`)
      const peerContext = await context.browser()!.newContext()
      try {
        const peer = await peerContext.newPage()
        await peer.goto(page.url())
        await waitEngine(peer)
        const peerRow = peer.locator(`[role="treeitem"][data-id="${ids[0]}"]`)
        await expect(peerRow).toBeVisible()
        await row.press('F2')
        const input = row.getByRole('textbox', { name: '元素名称', exact: true })
        if (dirty) await input.fill('本机尚未提交')
        await peerRow.press('F2')
        const peerInput = peerRow.getByRole('textbox', { name: '元素名称', exact: true })
        await peerInput.fill('同伴已保存')
        await peerInput.press('Enter')
        const name = () => page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, ids[0]!)
        await expect.poll(name).toBe('同伴已保存')
        if (commit === 'Enter') await input.press('Enter')
        else await sidebar.getByRole('button', { name: '搜索', exact: true }).click()
        expect(await name()).toBe('同伴已保存')
        if (dirty) {
          await expect(input).toHaveValue('本机尚未提交')
          await expect(
            page.getByText('名称已在其他位置更新，已保留输入；请确认后再次保存', { exact: true }),
          ).toBeVisible()
          await input.press('Enter')
          await expect.poll(name).toBe('本机尚未提交')
        } else await expect(input).toHaveCount(0)
      } finally {
        await peerContext.close()
      }
    })
  }
}

for (const filtered of [false, true]) {
  test(`同伴删除正在改名的元素，${filtered ? '空筛选返回搜索' : '其余元素承接焦点'}，撤销后可重新改名`, async ({
    page,
    context,
  }) => {
    const { sidebar, ids } = await fixture(page)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const peerContext = await context.browser()!.newContext()
    try {
      const peer = await peerContext.newPage()
      await peer.goto(page.url())
      await waitEngine(peer)
      const peerRow = peer.locator(`[role="treeitem"][data-id="${ids[0]}"]`)
      await expect(peerRow).toBeVisible()
      if (filtered) {
        await sidebar.getByRole('button', { name: '搜索', exact: true }).click()
        await sidebar.getByRole('textbox', { name: '搜索画布元素', exact: true }).fill('海边文本')
        await expect(sidebar.getByRole('treeitem')).toHaveCount(1)
      }
      const row = sidebar.locator(`[role="treeitem"][data-id="${ids[0]}"]`)
      await row.press('F2')
      await row.getByRole('textbox', { name: '元素名称', exact: true }).fill('未保存的旧草稿')
      const index = await row.evaluate((el) =>
        [...el.parentElement!.querySelectorAll('[role="treeitem"]')].indexOf(el),
      )
      await peerRow.click()
      await peer.keyboard.press('Delete')
      await expect(row).toHaveCount(0)
      const target = filtered
        ? sidebar.getByRole('textbox', { name: '搜索画布元素', exact: true })
        : sidebar.getByRole('treeitem').nth(Math.min(index, 1))
      await expect(target).toBeFocused()
      expect(errors).toEqual([])
      await peer.getByRole('button', { name: '撤销', exact: true }).click()
      await expect(row).toBeVisible()
      await row.press('F2')
      const restored = row.getByRole('textbox', { name: '元素名称', exact: true })
      await expect(restored).toHaveValue('海边文本')
      await restored.fill('恢复后的名称')
      await restored.press('Enter')
      await expect
        .poll(() => peer.evaluate((id) => window.__plein.engine.doc.get(id)?.name, ids[0]!))
        .toBe('恢复后的名称')
      expect(errors).toEqual([])
    } finally {
      await peerContext.close()
    }
  })
}

for (const elsewhere of [false, true]) {
  test(`同伴删除侧栏行后${elsewhere ? '不抢走搜索输入焦点' : '空列表可从搜索入口继续导航'}`, async ({
    page,
    context,
  }) => {
    const { sidebar, ids } = await fixture(page)
    const peerContext = await context.browser()!.newContext()
    try {
      const peer = await peerContext.newPage()
      await peer.goto(page.url())
      await waitEngine(peer)
      if (!elsewhere) {
        for (const id of ids.slice(1)) {
          await peer.locator(`[role="treeitem"][data-id="${id}"]`).click()
          await peer.keyboard.press('Delete')
        }
        await expect(sidebar.getByRole('treeitem')).toHaveCount(1)
      }
      const row = sidebar.locator(`[role="treeitem"][data-id="${ids[0]}"]`)
      await row.focus()
      if (elsewhere) {
        await sidebar.getByRole('button', { name: '搜索', exact: true }).click()
        await sidebar.getByRole('textbox', { name: '搜索画布元素', exact: true }).fill('海边')
      }
      await peer.locator(`[role="treeitem"][data-id="${ids[0]}"]`).click()
      await peer.keyboard.press('Delete')
      await expect(row).toHaveCount(0)
      if (elsewhere) {
        const query = sidebar.getByRole('textbox', { name: '搜索画布元素', exact: true })
        await expect(sidebar.getByRole('treeitem')).toHaveCount(1)
        await expect(query).toBeFocused()
        await expect(query).toHaveValue('海边')
      } else {
        await expect(sidebar.getByRole('button', { name: '搜索', exact: true })).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(
          sidebar.getByRole('textbox', { name: '搜索画布元素', exact: true }),
        ).toBeFocused()
      }
    } finally {
      await peerContext.close()
    }
  })
}
