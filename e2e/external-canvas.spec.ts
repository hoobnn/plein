import { expect, test } from './fixtures'
import { newProject, waitEngine } from './canvas'

test(
  '即梦同步在宽屏与窄屏都可逐项比对，切换目标立即撤下旧操作',
  { tag: '@core' },
  async ({ page }) => {
    const ref = { provider: 'jimeng-canvas', target: '757b9115-a5b4-4ef3-8743-abfc13866bdd' }
    let previews = 0
    let writes = 0
    await page.route('**/external/*', (route) => {
      const op = new URL(route.request().url()).pathname.split('/').at(-1)
      if (op === 'preview') {
        previews++
        return route.fulfill({
          json: {
            ...ref,
            rows: [
              {
                rowId: 'local/one',
                revision: '1'.repeat(64),
                kind: 'text',
                state: 'conflict',
                localId: 'one',
                remoteId: 'two',
                local: { title: '序章', text: 'Plein 版本' },
                remote: { title: '序章', text: '即梦版本' },
                actions: ['pull', 'push', 'unlink'],
              },
            ],
          },
        })
      }
      if (op === 'apply') writes++
      return route.fulfill({ json: [] })
    })
    await newProject(page)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 800 })
      if (width < 1280) {
        await page.getByRole('button', { name: '画布工具' }).click()
        await page.getByRole('menuitem', { name: '即梦同步' }).click()
      } else await page.getByRole('button', { name: '即梦同步' }).click()
      const popup = page.getByRole('dialog', { name: '即梦画布同步' })
      const target = popup.getByLabel('即梦项目链接或 ID')
      await target.fill(ref.target)
      await target.press('Enter')
      await expect(popup.getByText('即梦版本', { exact: true })).toBeVisible()
      const remoteLink = popup.getByRole('link', { name: '打开即梦画布' })
      await expect(remoteLink).toHaveAttribute(
        'href',
        'https://jimeng.jianying.com/ai-tool/ai-canvas/' + ref.target,
      )
      await expect(popup.getByRole('button', { name: '用即梦版本更新 Plein' })).toBeEnabled()
      expect(await popup.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      await target.fill('other')
      await expect(remoteLink).toHaveCount(0)
      await expect(popup.getByRole('button', { name: '用即梦版本更新 Plein' })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(popup).toHaveCount(0)
    }
    expect(previews).toBe(2)
    expect(writes).toBe(0)
  },
)

test(
  '短剧差异按正文和状态筛选，定位真实节点并记住这张画布已确认的项目',
  { tag: '@core' },
  async ({ page }) => {
    await newProject(page)
    const { shot, outline } = await page.evaluate(() => {
      const shot = window.__plein.addNode({
        type: 'plein/text',
        name: '开场分镜',
        params: { text: '雪夜进站' },
        x: 3600,
        y: 2400,
      })
      const outline = window.__plein.addNode({
        type: 'plein/text',
        name: '大纲',
        params: { text: '定稿' },
        x: 0,
        y: 0,
      })
      window.__plein.engine.selection.set([outline])
      return { shot, outline }
    })
    const ref = { provider: 'jimeng-novel', target: '9876543210123456789/1000' }
    const operations: string[] = []
    await page.route('**/external/**', (route) => {
      const path = new URL(route.request().url()).pathname.split('/external/')[1]!
      if (path === 'targets') return route.fulfill({ json: [] })
      operations.push(path)
      if (path !== 'preview')
        return route.fulfill({ status: 405, json: { message: '意外的外部操作' } })
      expect(route.request().postDataJSON()).toMatchObject({
        provider: ref.provider,
        target: '1000',
      })
      return route.fulfill({
        json: {
          ...ref,
          rows: [
            {
              rowId: 'outline',
              revision: '1'.repeat(64),
              kind: 'text',
              state: 'synced',
              localId: outline,
              remoteId: 'node-outline',
              local: { title: '大纲', text: '定稿' },
              remote: { title: '大纲', text: '定稿' },
              actions: ['unlink'],
            },
            {
              rowId: 'shot',
              revision: '2'.repeat(64),
              kind: 'text',
              state: 'conflict',
              localId: shot,
              remoteId: 'node-shot',
              local: { title: '开场分镜', text: '雪夜进站' },
              remote: { title: '开场分镜', text: '昼间进站' },
              actions: ['pull', 'push', 'unlink'],
            },
            {
              rowId: 'station',
              revision: '3'.repeat(64),
              kind: 'text',
              state: 'remote-only',
              localId: null,
              remoteId: 'node-station',
              local: null,
              remote: { title: '场记', text: '雪夜空镜' },
              actions: ['pull'],
            },
          ],
        },
      })
    })
    const open = page.getByRole('button', { name: '即梦同步' })
    const dialog = page.getByRole('dialog', { name: '即梦画布同步' })
    const project = dialog.getByLabel('即梦项目链接或 ID')
    await open.click()
    await dialog.getByRole('combobox', { name: '创作平台' }).click()
    await page.getByRole('option', { name: '即梦短剧' }).click()
    await project.fill('1000')
    await dialog.getByRole('button', { name: '读取差异' }).click()
    const nav = dialog.getByRole('navigation', { name: '同步节点' })
    await expect(nav.getByRole('button')).toHaveCount(3)
    const remoteLink = dialog.getByRole('link', { name: '打开即梦画布' })
    await expect(remoteLink).toHaveAttribute(
      'href',
      'https://jimeng.jianying.com/novel/detail/canvas?projectId=1000',
    )
    await expect(remoteLink).toHaveAttribute('target', '_blank')
    await expect(remoteLink).toHaveAttribute('rel', /noopener/)
    await dialog.getByRole('searchbox', { name: '查找同步节点' }).fill('雪夜')
    await expect(nav.getByRole('button')).toHaveCount(2)
    await expect(nav.getByRole('button', { name: /大纲/ })).toHaveCount(0)
    await dialog.getByRole('combobox', { name: '同步状态' }).click()
    await page.getByRole('option', { name: /双方均有修改/ }).click()
    await expect(nav.getByRole('button')).toHaveCount(1)
    await expect(nav.getByRole('button', { name: /开场分镜/ })).toBeVisible()
    await expect(dialog.getByRole('region', { name: '即梦', exact: true })).toContainText(
      '昼间进站',
    )
    await dialog.getByRole('button', { name: '定位到画布' }).click()
    await expect(dialog).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
      .toEqual([shot])
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, shot)).toBe(
      '雪夜进站',
    )

    await page.reload()
    await waitEngine(page)
    await open.click()
    await expect(dialog.getByRole('combobox', { name: '创作平台' })).toHaveText('即梦短剧')
    await expect(project).toHaveValue(ref.target)
    await expect(dialog.getByRole('button', { name: '读取差异' })).toBeEnabled()
    await expect(nav).toHaveCount(0)
    await expect(remoteLink).toHaveCount(0)
    expect(operations).toEqual(['preview'])
  },
)

test(
  '全能画布可以从空白项目导出一个 Plein 媒体，新节点按发布回执定位',
  { tag: '@core' },
  async ({ page }) => {
    const ref = { provider: 'jimeng-canvas', target: 'ca957611-53f3-4264-b224-158a213c30ec' }
    const localAssetId = 'a'.repeat(64)
    let published: unknown
    await page.route('**/api/assets?kind=image', (route) =>
      route.fulfill({
        json: {
          items: [{ id: localAssetId, kind: 'image', name: '封面定稿' }],
          nextCursor: null,
        },
      }),
    )
    await page.route('**/external/**', (route) => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith('/preview'))
        return route.fulfill({
          json: {
            ...ref,
            rows: published
              ? [
                  {
                    rowId: 'cover-row',
                    kind: 'image',
                    state: 'remote-only',
                    revision: '2'.repeat(64),
                    localId: null,
                    local: null,
                    remoteId: 'node_cover',
                    remote: { title: '封面定稿', text: '' },
                    actions: ['pull'],
                  },
                ]
              : [],
          },
        })
      if (path.endsWith('/media/publish')) {
        published = route.request().postDataJSON()
        return route.fulfill({ json: { nodeId: 'node_cover', assetId: 'resource_cover' } })
      }
      return route.fulfill({ json: [] })
    })
    await newProject(page)
    await page.getByRole('button', { name: '即梦同步' }).click()
    const dialog = page.getByRole('dialog', { name: '即梦画布同步' })
    await dialog.getByLabel('即梦项目链接或 ID').fill(ref.target)
    await dialog.getByRole('button', { name: '读取差异' }).click()
    await dialog.getByRole('button', { name: '导出 Plein 素材' }).click()
    await dialog.getByRole('combobox', { name: 'Plein 素材' }).click()
    await page.getByRole('option', { name: /封面定稿/ }).click()
    await dialog.getByRole('button', { name: '保存到即梦画布' }).click()
    await expect(dialog.getByRole('status')).toHaveText('素材已保存到即梦节点 node_cover')
    await expect(dialog.getByRole('region', { name: '节点差异' })).toContainText('封面定稿')
    expect(published).toEqual({ ...ref, localAssetId })
  },
)
