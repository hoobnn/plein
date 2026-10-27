import { expect, type Page, test } from './fixtures'
import { newProject } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const canvasId = decodeURIComponent(page.url().split('#/c/')[1]!)
  const canvas = await (await page.request.get(`/api/canvases/${canvasId}`)).json()
  const project = await (await page.request.get(`/api/projects/${canvas.projectId}`)).json()
  return { canvas, project }
}

for (const width of [320]) {
  test(
    `${width}px 画布顶栏项目改名失败保留输入，可修改后重试`,
    { tag: '@core' },
    async ({ page }) => {
      await newProject(page)
      const canvasId = decodeURIComponent(page.url().split('#/c/')[1]!)
      const canvas = await (await page.request.get(`/api/canvases/${canvasId}`)).json()
      const project = await (await page.request.get(`/api/projects/${canvas.projectId}`)).json()
      await page.setViewportSize({ width, height: 900 })
      let writes = 0
      await page.route(`**/api/projects/${project.id}`, (route) => {
        if (route.request().method() !== 'PATCH') return route.continue()
        writes++
        return writes === 1
          ? route.fulfill({ status: 503, json: { message: '项目名称暂时无法保存' } })
          : route.continue()
      })
      await page.getByRole('button', { name: project.title, exact: true }).click()
      const input = page.getByRole('textbox')
      await expect(input).toHaveAccessibleName('项目名称')
      await input.fill('雨后的项目 🌧️ 保留草稿')
      await input.press('Enter')
      await expect(page.getByRole('alert')).toContainText('项目名称暂时无法保存')
      await expect(input).toHaveValue('雨后的项目 🌧️ 保留草稿')
      await expect(input).toBeFocused()
      const bounds = await input.boundingBox()
      expect(bounds!.width).toBeGreaterThan(200)
      await page.screenshot({
        path: test.info().outputPath('header-project-rename-failed.png'),
        animations: 'disabled',
      })
      await input.fill('雨后的项目 🌧️ 重试成功')
      await input.press('Enter')
      await expect(input).toHaveCount(0)
      await expect(
        page.getByRole('button', { name: '雨后的项目 🌧️ 重试成功', exact: true }),
      ).toBeVisible()
      expect((await (await page.request.get(`/api/projects/${project.id}`)).json()).title).toBe(
        '雨后的项目 🌧️ 重试成功',
      )
      expect(writes).toBe(2)
    },
  )
}

test('项目改名保存中只提交一次，关闭后迟到成功仍更新原项目', { tag: '@core' }, async ({ page }) => {
  const { project } = await fixture(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let writes = 0
  await page.route(`**/api/projects/${project.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    writes++
    await pending
    return route.continue()
  })
  try {
    await page.getByRole('button', { name: project.title, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '重命名项目', exact: true })
    await dialog.getByRole('textbox').fill('保存中的原项目')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => writes).toBe(1)
    await expect(dialog.getByRole('textbox')).toBeDisabled()
    await expect(dialog.getByRole('button', { name: '保存中…', exact: true })).toBeDisabled()
    await page.keyboard.press('Enter')
    expect(writes).toBe(1)
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    release()
    await expect(page.getByRole('button', { name: '保存中的原项目', exact: true })).toBeVisible()
    expect(writes).toBe(1)
  } finally {
    release()
  }
})

for (const returned of [false, true]) {
  test(
    `项目改名确认前离开原画布（返回=${returned}）不提交旧上下文`,
    { tag: '@core' },
    async ({ page }) => {
      const { canvas, project } = await fixture(page)
      const other = await (
        await page.request.post('/api/canvases', {
          data: { projectId: project.id, title: '另一画布' },
        })
      ).json()
      let writes = 0
      page.on('request', (request) => {
        if (request.method() === 'PATCH' && request.url().endsWith(`/api/projects/${project.id}`))
          writes++
      })
      await page.getByRole('button', { name: project.title, exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '重命名项目', exact: true })
      await dialog.getByRole('textbox').fill('不应保存的旧草稿')
      await page.evaluate((id) => {
        location.hash = `#/c/${id}`
      }, other.id)
      await expect(
        page.getByRole('button', { name: '切换画布', exact: true, includeHidden: true }),
      ).toHaveText(other.title)
      if (returned) {
        await page.evaluate((id) => {
          location.hash = `#/c/${id}`
        }, canvas.id)
        await expect(
          page.getByRole('button', { name: '切换画布', exact: true, includeHidden: true }),
        ).toHaveText(canvas.title)
      }
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await expect(dialog.getByRole('alert')).toContainText('画布已切换')
      await expect(dialog.getByRole('textbox')).toHaveValue('不应保存的旧草稿')
      expect(writes).toBe(0)
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await expect(dialog).toHaveCount(0)
    },
  )
}
