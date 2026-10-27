import { expect, test } from './fixtures'
import { newProject } from './canvas'

for (const operation of ['create', 'delete'] as const) {
  for (const outcome of ['success', 'failure'] as const) {
    for (const navigation of ['switch', 'return'] as const) {
      test(`画布${operation === 'create' ? '新建' : '删除'}迟到${outcome === 'success' ? '成功' : '失败'}：${navigation === 'switch' ? '停留其他画布' : '切换后返回原画布'}`, async ({
        page,
        request,
      }) => {
        await newProject(page)
        const origin = decodeURIComponent(page.url().split('#/c/')[1]!)
        const canvas = await (await request.get(`/api/canvases/${origin}`)).json()
        const other = await (
          await request.post('/api/canvases', {
            data: { projectId: canvas.projectId, title: '当前正在编辑的画布' },
          })
        ).json()
        await request.post('/api/canvases', {
          data: { projectId: canvas.projectId, title: '其他备用画布' },
        })
        const expected = navigation === 'switch' ? other : canvas
        const path = operation === 'create' ? '/api/canvases' : `/api/canvases/${origin}`
        const method = operation === 'create' ? 'POST' : 'DELETE'
        let release!: () => void
        const pending = new Promise<void>((resolve) => {
          release = resolve
        })
        let received = 0
        await page.route(`**${path}`, async (route) => {
          if (route.request().method() !== method) return route.continue()
          received++
          await pending
          if (outcome === 'failure')
            return route.fulfill({ status: 503, json: { message: '旧画布操作暂时失败' } })
          return route.fulfill({ response: await route.fetch() })
        })
        await page.evaluate(
          ({ path, method }) => {
            const fetch = window.fetch.bind(window)
            window.fetch = async (...args) => {
              const response = await fetch(...args)
              if (new URL(response.url).pathname === path && args[1]?.method === method) {
                const mark = () =>
                  setTimeout(() => {
                    requestAnimationFrame(() =>
                      requestAnimationFrame(() => {
                        document.body.dataset.canvasMutationRead = 'true'
                      }),
                    )
                  }, 0)
                const json = response.json.bind(response)
                response.json = async () => {
                  const body = await json()
                  mark()
                  return body
                }
                const text = response.text.bind(response)
                response.text = async () => {
                  const body = await text()
                  mark()
                  return body
                }
              }
              return response
            }
          },
          { path, method },
        )
        try {
          await page.getByRole('button', { name: '切换画布', exact: true }).click()
          await page
            .getByRole('button', {
              name: operation === 'create' ? '新建画布' : '删除当前画布',
              exact: true,
            })
            .click()
          const dialog = page.getByRole('dialog', {
            name: operation === 'create' ? '新建画布' : `删除画布「${canvas.title}」？`,
            exact: true,
          })
          if (operation === 'create') await dialog.getByRole('textbox').fill('迟到的新画布')
          await dialog
            .getByRole('button', { name: operation === 'create' ? '新建' : '删除', exact: true })
            .click()
          await expect.poll(() => received).toBe(1)
          if (operation === 'create')
            await dialog.getByRole('button', { name: '关闭', exact: true }).click()
          await expect(dialog).toHaveCount(0)
          await page.getByRole('button', { name: '切换画布', exact: true }).click()
          await page
            .getByRole('dialog', { name: '画布', exact: true })
            .getByRole('button', { name: other.title, exact: true })
            .click()
          await expect(page.getByRole('button', { name: '切换画布', exact: true })).toHaveText(
            other.title,
          )
          await expect(page.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected')
          await page.waitForFunction(
            () => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.tagName === 'CANVAS',
          )
          if (navigation === 'return') {
            await page.getByRole('button', { name: '切换画布', exact: true }).click()
            await page
              .getByRole('dialog', { name: '画布', exact: true })
              .getByRole('button', { name: canvas.title, exact: true })
              .click()
            await expect(page.getByRole('button', { name: '切换画布', exact: true })).toHaveText(
              canvas.title,
            )
            await expect(page.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected')
            await page.waitForFunction(
              () =>
                document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.tagName === 'CANVAS',
            )
          }
          const before = await page.evaluate(() => [...window.__plein.engine.doc.elements()])
          release()
          await page.waitForFunction(() => document.body.dataset.canvasMutationRead === 'true')
          const deletedCurrent =
            navigation === 'return' && operation === 'delete' && outcome === 'success'
          if (deletedCurrent) {
            // WebSocket 的删除通知可能先于 HTTP 应答送达，此时已安全返回首页。
            await expect(page).not.toHaveURL(new RegExp(`#/c/${origin}$`))
          } else {
            await expect(page.getByRole('button', { name: '切换画布', exact: true })).toHaveText(
              expected.title,
            )
            expect(page.url()).toContain(`#/c/${expected.id}`)
            expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(
              before,
            )
          }
          await expect(page.getByText('旧画布操作暂时失败', { exact: true })).toHaveCount(0)
          const list = await (
            await request.get(`/api/projects/${canvas.projectId}/canvases`)
          ).json()
          if (deletedCurrent) {
            const activeId = page.url().split('#/c/')[1]
            if (activeId)
              expect(
                list.some((item: { id: string }) => item.id === decodeURIComponent(activeId)),
              ).toBe(true)
            else {
              await expect(page).toHaveURL(/#\/$/)
              await expect(page.getByRole('heading', { name: /^我的项目/ })).toBeVisible()
            }
          }
          if (operation === 'create')
            expect(list.some((item: { title: string }) => item.title === '迟到的新画布')).toBe(
              outcome === 'success',
            )
          else
            expect(list.some((item: { id: string }) => item.id === origin)).toBe(
              outcome !== 'success',
            )
        } finally {
          release()
        }
      })
    }
  }
}
