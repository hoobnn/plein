import { expect, test } from './fixtures'
import {
  addNode,
  centerOf,
  clickElement,
  deselect,
  edgesInto,
  elements,
  handleOf,
  newProject,
  waitEngine,
} from './canvas'

// DOM 状态由相邻组件测试覆盖；此处只保留实际布局、命中、原生输入和编辑器集成。
test.describe('画布操作浏览器断点', { tag: '@core' }, () => {
  for (const width of [320]) {
    test(`${width}px 顶栏工具可达，面板关闭后能继续切换视图`, async ({ page }) => {
      await newProject(page)
      const canvasId = decodeURIComponent(page.url().split('#/c/')[1]!)
      const canvas = await (await page.request.get(`/api/canvases/${canvasId}`)).json()
      const projectName = `很长的项目名称${'雨后水杯'.repeat(15)}`
      await page.request.patch(`/api/projects/${canvas.projectId}`, {
        data: { title: projectName },
      })
      await page.request.patch(`/api/canvases/${canvasId}`, {
        data: { title: '很长的画布名称'.repeat(15) },
      })
      await page.reload()
      await waitEngine(page)
      await page.setViewportSize({ width, height: 900 })
      await page.getByRole('button', { name: '故事板', exact: true }).click()
      for (const button of [
        page.getByRole('button', { name: projectName, exact: true }),
        page.getByRole('button', { name: '切换画布', exact: true }),
        page.getByRole('button', { name: '工作流', exact: true }),
      ]) {
        await expect
          .poll(() =>
            button.evaluate((el) => {
              const r = el.getBoundingClientRect()
              return (
                r.x >= 0 &&
                r.right <= innerWidth &&
                el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
              )
            }),
          )
          .toBe(true)
      }
      const compact = page.getByRole('button', { name: '画布工具', exact: true })
      await page.getByRole('button', { name: projectName, exact: true }).click()
      const renameDialog = page.getByRole('dialog', { name: '重命名项目', exact: true })
      const rename = renameDialog.getByRole('textbox')
      await expect(rename).toBeFocused()
      expect(
        await rename.evaluate((el) => {
          const r = el.getBoundingClientRect()
          return r.x >= 0 && r.right <= innerWidth && r.width > 200
        }),
      ).toBe(true)
      await rename.press('Escape')
      await expect(rename).toHaveCount(0)
      if (await compact.isVisible()) await compact.click()
      const settings = page.getByRole(width < 1280 ? 'menuitem' : 'button', {
        name: '设置',
        exact: true,
      })
      const bounds = await settings.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
      await settings.click()
      const panel = page.getByRole('dialog', { name: '设置', exact: true })
      await expect(panel).toBeVisible()
      await page.setViewportSize({ width: 1000, height: 240 })
      const lastSection = panel
        .getByRole('navigation', { name: '设置分区' })
        .getByRole('button')
        .last()
      await lastSection.scrollIntoViewIfNeeded()
      await lastSection.click()
      await expect(lastSection).toHaveAttribute('aria-current', 'page')
      await expect(lastSection).toBeInViewport({ ratio: 1 })
      await expect(panel.getByRole('button', { name: '关闭', exact: true })).toBeInViewport()
      await page.keyboard.press('Escape')
      await expect(panel).toHaveCount(0)
      await page.getByRole('button', { name: '工作流', exact: true }).click()
      await expect(
        page.getByRole('complementary', { name: '侧栏', exact: true, includeHidden: true }),
      ).toBeAttached()
      await page.route(
        (url) => url.pathname.startsWith('/api/'),
        (route) => route.abort('internetdisconnected'),
      )
      await page.setViewportSize({ width: 320, height: 640 })
      await page.goto('/#/demo?n=0')
      await waitEngine(page)
      const prompt = page.getByText('双击空白处或按 Tab 添加节点', { exact: true })
      await expect(prompt).toBeVisible()
      const point = (await prompt.boundingBox())!
      await page.mouse.dblclick(point.x + point.width / 2, point.y + point.height / 2)
      const picker = page.getByRole('dialog', { name: '添加节点', exact: true })
      await picker.getByRole('textbox', { name: '搜索节点' }).fill('Markdown')
      await picker.getByRole('option', { name: 'Markdown', exact: true }).click()
      await expect(prompt).toHaveCount(0)
      await page.evaluate(() =>
        (window.__plein.engine as typeof window.__plein.engine & { undo(): void }).undo(),
      )
      await expect(prompt).toBeVisible()
    })
  }

  test('小窗口从文本拉线创建图片节点，取消不改文档，创建与连线可一起撤销重做', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 320 })
    await newProject(page)
    const source = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/text',
        name: '连接来源',
        params: { text: '保留来源' },
        x: 400,
        y: 200,
      }),
    )
    await clickElement(page, source)
    await deselect(page)
    const original = await elements(page)
    const open = async () => {
      const point = await handleOf(page, source, 'out')
      await page.mouse.move(point.x, point.y)
      await page.mouse.down()
      await page.mouse.move(950, 150, { steps: 5 })
      await page.mouse.up()
    }
    const menu = page.getByRole('dialog', { name: '添加节点', exact: true })
    await open()
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    expect(await elements(page)).toEqual(original)
    expect(await page.evaluate(() => [...window.__plein.engine.doc.edges()])).toEqual([])
    await open()
    await menu.getByRole('textbox', { name: '搜索节点' }).fill('生成图片')
    await menu.getByRole('option', { name: '生成图片', exact: true }).click()
    await expect(menu).toHaveCount(0)
    await expect.poll(async () => (await elements(page)).length).toBe(2)
    const target = (await elements(page)).find((el) => el.nodeType === 'plein/image')!
    await expect.poll(() => edgesInto(page, target.id)).toEqual([[source, 'text', 'prompt']])
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect.poll(() => elements(page)).toEqual(original)
    expect(await page.evaluate(() => [...window.__plein.engine.doc.edges()])).toEqual([])
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect.poll(() => edgesInto(page, target.id)).toEqual([[source, 'text', 'prompt']])
    expect(await elements(page)).toHaveLength(2)
  })
  for (const width of [320]) {
    test(`${width}px 多选操作条避让面板，复制连线和打组可撤销重做`, async ({ page }) => {
      await newProject(page)
      await page.setViewportSize({ width, height: 900 })
      if (width === 1440) {
        const handle = page.getByRole('separator', { name: '调整侧栏宽度', exact: true })
        await handle.focus()
        for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight')
        await expect(handle).toHaveAttribute('aria-valuenow', '480')
      }
      if (width >= 640) await page.getByRole('button', { name: '任务', exact: true }).click()
      const ids = await page.evaluate(() => {
        const a = window.__plein.addNode({
          type: 'plein/text',
          name: '多选甲',
          params: { text: '透明水杯' },
          x: 3000,
          y: 2000,
        })
        const b = window.__plein.addNode({
          type: 'plein/image',
          name: '多选乙',
          params: { model: 'plein/mock:image' },
          x: 3460,
          y: 2000,
        })
        window.__plein.connect([a, 'text'], [b, 'prompt'])
        window.__plein.engine.selection.set([a, b])
        window.__plein.engine.zoomToFit([a, b])
        return [a, b]
      })
      const bar = page.getByRole('toolbar', { name: '多选操作', exact: true })
      await expect(bar).toBeVisible()
      const fits = async () => {
        const box = (await bar.boundingBox())!
        const sidebar = page.getByRole('complementary', {
          name: '侧栏',
          exact: true,
          includeHidden: true,
        })
        const side = (await sidebar.boundingBox())!
        const left =
          (await sidebar.getAttribute('aria-hidden')) === 'true' ? 0 : side.x + side.width
        const tasks = page.getByRole('complementary', { name: '任务', exact: true })
        const right = await tasks.evaluateAll(
          (panels) => panels[0]?.getBoundingClientRect().x ?? window.innerWidth,
        )
        return box.x >= left + 4 && box.x + box.width <= right - 4 && box.y >= 64
      }
      await expect.poll(fits, { timeout: 1500 }).toBe(true)
      const hittable = () =>
        bar.locator('button:enabled').evaluateAll((buttons) =>
          buttons.every((button) => {
            const r = button.getBoundingClientRect()
            return (
              document
                .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
                ?.closest('button') === button
            )
          }),
        )
      await expect.poll(hittable).toBe(true)
      await page.evaluate(() =>
        (
          window.__plein.engine.doc as unknown as { undo: { stopCapturing(): void } }
        ).undo.stopCapturing(),
      )
      await bar.getByRole('button', { name: '复制一份', exact: true }).click()
      const snapshot = () =>
        page.evaluate(() => ({
          elements: [...window.__plein.engine.doc.elements()].map((el) => ({
            id: el.id,
            parentId: el.parentId,
          })),
          edges: [...window.__plein.engine.doc.edges()],
          selection: window.__plein.engine.selection.values(),
        }))
      await expect.poll(async () => (await snapshot()).elements.length).toBe(4)
      const copied = await snapshot()
      expect(copied.edges).toHaveLength(2)
      expect(copied.selection).toHaveLength(2)
      expect(copied.selection.every((id) => !ids.includes(id))).toBe(true)
      expect(
        copied.edges.some(
          (edge) =>
            copied.selection.includes(edge.from[0]) && copied.selection.includes(edge.to[0]),
        ),
      ).toBe(true)
      await page.keyboard.press('ControlOrMeta+z')
      await expect.poll(async () => (await snapshot()).elements.length).toBe(2)
      expect((await snapshot()).edges).toHaveLength(1)
      await page.keyboard.press('ControlOrMeta+Shift+z')
      await expect.poll(async () => (await snapshot()).elements.length).toBe(4)
      expect((await snapshot()).edges).toHaveLength(2)
      await page.evaluate((ids) => window.__plein.engine.selection.set(ids), ids)
      await bar.getByRole('button', { name: '打组', exact: true }).click()
      await expect.poll(async () => (await snapshot()).elements.length).toBe(5)
      const grouped = await snapshot()
      const frame = grouped.selection[0]!
      expect(
        ids.every((id) => grouped.elements.find((el) => el.id === id)?.parentId === frame),
      ).toBe(true)
      await page.keyboard.press('ControlOrMeta+z')
      await expect.poll(async () => (await snapshot()).elements.length).toBe(4)
      expect(
        (await snapshot()).elements
          .filter((el) => ids.includes(el.id))
          .every((el) => el.parentId === null),
      ).toBe(true)
      await page.keyboard.press('ControlOrMeta+Shift+z')
      await expect.poll(async () => (await snapshot()).elements.length).toBe(5)
      expect((await snapshot()).edges).toHaveLength(2)
      await page.evaluate((ids) => {
        window.__plein.engine.selection.set(ids)
        window.__plein.engine.zoomToFit(ids)
      }, ids)
      await expect.poll(fits).toBe(true)
      await expect.poll(hittable).toBe(true)
      await page.setViewportSize({ width: 1000, height: 320 })
      const point = { x: 950, y: 230 }
      await page.evaluate(
        ({ frame, point }) => {
          const engine = window.__plein.engine as typeof window.__plein.engine & {
            camera: { panBy(x: number, y: number): void }
          }
          engine.selection.set([frame])
          const rect = engine.doc.worldRect(frame)
          const current = engine.worldToClient(rect.x + 80, rect.y + 16)
          engine.camera.panBy(point.x - current.x, point.y - current.y)
        },
        { frame, point },
      )
      await page.mouse.click(point.x, point.y, { button: 'right' })
      const menu = page.getByRole('menu')
      await expect(menu).toBeVisible()
      await page.keyboard.press('End')
      await expect(menu.getByRole('menuitem').last()).toBeInViewport({ ratio: 1 })
      await menu.getByRole('menuitem').last().click({ trial: true })
      const menuBox = (await menu.boundingBox())!
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(312)
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
      await page.screenshot({
        path: test.info().outputPath('selection-toolbar.png'),
        animations: 'disabled',
      })
      if (width >= 640) {
        await page
          .getByRole('complementary', { name: '任务', exact: true })
          .getByRole('button', { name: '关闭', exact: true })
          .click()
        await expect.poll(fits).toBe(true)
        await page.getByRole('button', { name: '任务', exact: true }).click()
        await expect.poll(fits).toBe(true)
        await expect.poll(hittable).toBe(true)
      }
    })
  }
  for (const initialWidth of [1440]) {
    test(`${initialWidth}px 助手与任务互相切换保留草稿，断点和主动展开侧栏正确释放边距`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: initialWidth, height: 900 })
      await newProject(page)
      const assistant = page.getByRole('complementary', { name: '助手', exact: true })
      const tasks = page.getByRole('complementary', { name: '任务', exact: true })
      const openTasks = page.getByRole('button', { name: '任务', exact: true })
      const openAgent = page.getByRole('button', { name: '打开助手', exact: true })
      const right = () =>
        page.evaluate(
          () =>
            (window.__plein.engine as unknown as { camera: { insets: { right: number } } }).camera
              .insets.right,
        )
      await openAgent.click()
      const input = assistant.getByPlaceholder('让小满帮你做点什么…')
      await expect(input).toBeFocused()
      await input.fill('切换面板时保留这份草稿')
      await openTasks.click()
      await expect(tasks).toBeVisible()
      await expect(assistant).toHaveCount(0)
      await expect.poll(right).toBe(initialWidth >= 640 ? 372 : 0)
      for (const width of [640, 639, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        await expect.poll(right).toBe(width >= 640 ? 372 : 0)
        await expect
          .poll(async () => Math.round((await tasks.boundingBox())!.width))
          .toBe(width >= 640 ? 360 : width - 24)
      }
      await openAgent.click()
      await expect(tasks).toHaveCount(0)
      await expect(input).toHaveValue('切换面板时保留这份草稿')
      await expect.poll(right).toBe(424)
      await page.getByRole('button', { name: '收起助手', exact: true }).click()
      await expect.poll(right).toBe(0)
      await openTasks.click()
      await page.setViewportSize({ width: 900, height: 900 })
      const sidebar = page.getByRole('complementary', {
        name: '侧栏',
        exact: true,
        includeHidden: true,
      })
      await expect(sidebar).toHaveAttribute('aria-hidden', 'true')
      await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
      await expect(tasks).toHaveCount(0)
      await expect(sidebar).toHaveAttribute('aria-hidden', 'false')
      await expect.poll(right).toBe(0)
      expect(await page.evaluate(() => localStorage.getItem('plein:sidebar'))).not.toBe('closed')
      await page.screenshot({
        path: test.info().outputPath('right-panel-switch.png'),
        animations: 'disabled',
      })
    })
  }
  test('弹层内文本框保留原生撤销重做，按钮上的撤销不会继续改正文', async ({ page }) => {
    await newProject(page)
    await addNode(page, '文本')
    const prompt = page.getByRole('textbox', { name: '提示词', exact: true })
    await prompt.fill('放大前正文')
    const id = (await elements(page))[0]!.id
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    const close = settings.getByRole('button', { name: '关闭', exact: true })
    await close.focus()
    await page.evaluate(
      (id) => window.dispatchEvent(new CustomEvent('plein:focus-generator', { detail: id })),
      id,
    )
    await expect(close).toBeFocused()
    await close.press('ControlOrMeta+z')
    // Modal 会把背景置为 inert，后台正文应从文档验证；关闭后再验证可访问输入框。
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, id)).toBe(
      '放大前正文',
    )
    await expect(close).toBeFocused()
    await close.click()
    await expect(prompt).toHaveValue('放大前正文')
    await page.evaluate(
      (id) => window.dispatchEvent(new CustomEvent('plein:focus-generator', { detail: id })),
      id,
    )
    await expect(prompt).toBeFocused()
    await page.getByRole('button', { name: '放大编辑提示词', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '编辑提示词', exact: true })
    const input = dialog.getByRole('textbox', { name: '提示词', exact: true })
    await input.fill('弹层内部新正文')
    await input.press('ControlOrMeta+z')
    await expect(input).toHaveValue('放大前正文')
    await input.press('ControlOrMeta+Shift+z')
    await expect(input).toHaveValue('弹层内部新正文')
    await dialog.getByRole('button', { name: '关闭', exact: true }).press('ControlOrMeta+z')
    await expect(input).toHaveValue('弹层内部新正文')
  })

  for (const kind of ['storyboard', 'sequence'] as const) {
    for (const action of ['cancel'] as const) {
      test(`${kind} 下拉菜单键盘 ${action} 不触发父级编辑器`, async ({ page }) => {
        await newProject(page)
        const id = await page.evaluate(
          (kind) =>
            window.__plein.addNode({
              type: kind === 'storyboard' ? 'plein/storyboard' : 'plein/animatic',
              name: '下拉键盘',
              x: 400,
              y: 200,
              params:
                kind === 'storyboard'
                  ? {
                      shots: [
                        {
                          id: 'one',
                          no: 1,
                          duration: 3,
                          shotSize: '中景',
                          description: '保留的画面',
                          dialogue: [],
                        },
                      ],
                    }
                  : { subtitles: false, shots: [{ shotId: 'one', duration: 3, dialogue: [] }] },
            }),
          kind,
        )
        await clickElement(page, id)
        const at = await centerOf(page, id)
        await page.mouse.dblclick(at.x, at.y)
        const editor = page.getByRole('dialog', {
          name: kind === 'storyboard' ? '分镜表' : '序列',
          exact: true,
        })
        if (kind === 'sequence')
          await editor.getByRole('button', { name: '成片', exact: true }).click()
        // 表格视图的景别下拉按镜头编号命名
        const label = kind === 'storyboard' ? '镜头 1 景别' : '转场'
        const trigger = editor.getByRole('combobox', { name: label, exact: true })
        const list = page.getByRole('listbox')
        const initial = await trigger.innerText()
        const params = () => page.evaluate((id) => window.__plein.engine.doc.get(id)!.params, id)
        const before = await params()
        const bounds = await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)
        const time = kind === 'sequence' ? await editor.locator('.seq-time').innerText() : undefined
        if (action !== 'cancel') {
          await trigger.focus()
          await trigger.press('ArrowDown')
          await expect(list).toBeVisible()
          await expect(list).toHaveAccessibleName(label)
          await page.keyboard.press('End')
          const last = await list.getByRole('option').last().innerText()
          await page.keyboard.press(action === 'space' ? 'Space' : 'Enter')
          await expect(list).toBeHidden()
          await expect(trigger).toHaveText(last)
          await expect(trigger).toBeFocused()
          const saved = await params()
          if (kind === 'storyboard')
            expect((saved!.shots as Array<{ shotSize: string }>)[0]!.shotSize).toBe(last)
          else expect(saved!.transition).toBe(last)
        } else {
          await trigger.click()
          await expect(list).toBeVisible()
          await expect(list).toHaveAccessibleName(label)
          await page.keyboard.press('ArrowDown')
          await page.keyboard.press('Escape')
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              ),
          )
          await expect(list).toBeHidden()
          await expect(editor).toHaveCSS('opacity', '1')
          await expect(trigger).toBeFocused()
          await expect(trigger).toHaveText(initial)
          expect(await params()).toEqual(before)
        }
        expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([id])
        expect(await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)).toEqual(
          bounds,
        )
        if (time) await expect(editor.locator('.seq-time')).toHaveText(time)
        if (kind === 'sequence')
          await expect(
            editor.locator('.seq-monitor').getByRole('button', { name: '播放', exact: true }),
          ).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(editor).toBeHidden()
      })
    }
  }

  test('序列按钮上的空格激活该按钮，回到开头与关闭不误启动播放', async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/animatic',
        name: '按钮空格归属',
        x: 400,
        y: 200,
        params: { subtitles: false, shots: [{ shotId: 'one', duration: 3, dialogue: [] }] },
      }),
    )
    await clickElement(page, id)
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
    const editor = page.getByRole('dialog', { name: '序列', exact: true })
    const monitor = editor.locator('.seq-monitor')
    const start = monitor.getByRole('button', { name: '回到开头', exact: true })
    await start.focus()
    await page.keyboard.press('Shift+ArrowRight')
    await expect(monitor.locator('.seq-time > span').first()).toHaveText('0:01.0')
    await start.press('Space')
    await expect(monitor.locator('.seq-time > span').first()).toHaveText('0:00.0')
    await expect(monitor.getByRole('button', { name: '播放', exact: true })).toBeVisible()
    await monitor.locator('.seq-stage').click()
    await page.keyboard.press('Space')
    await expect(monitor.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
    await page.keyboard.press('Space')
    await expect(monitor.getByRole('button', { name: '播放', exact: true })).toBeVisible()
    await editor.focus()
    await editor.press('Space')
    await expect(monitor.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
    await editor.press('Space')
    await expect(monitor.getByRole('button', { name: '播放', exact: true })).toBeVisible()
    await editor.getByRole('button', { name: '关闭', exact: true }).press('Space')
    await expect(editor).toHaveCount(0)
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([id])
  })
})
