// @vitest-environment happy-dom
import { API, type ExternalRow } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { renderApp, screen } from '../../testing/render'
import { ExternalCanvasDialog } from './ExternalCanvasDialog'

it('202 个可导入节点只选前 200 个，换选后只提交最终选中的 ID 和版本', async () => {
  const canvasId = 'review-canvas'
  const target = { provider: 'jimeng-canvas', target: '94559844-5ce9-455a-8797-8b9907e7a669' }
  const rows = Array.from({ length: 202 }, (_, index): ExternalRow => {
    const id = String(index + 1)
    return {
      rowId: 'remote/' + id,
      revision: id.padStart(64, '0'),
      kind: 'text',
      state: 'remote-only',
      localId: null,
      local: null,
      remoteId: id,
      remote: { title: '镜头 ' + id, text: '' },
      actions: ['pull'],
    }
  })
  const submissions: unknown[] = []
  mockFetch(async (req) => {
    const path = new URL(req.url).pathname
    if (path === API.externalCanvas(canvasId, 'targets')) return Response.json([])
    if (path === API.externalCanvas(canvasId, 'preview'))
      return Response.json({ ...target, rows: submissions.length ? [] : rows })
    if (path === API.externalCanvas(canvasId, 'pull-new')) {
      const body = await req.json()
      submissions.push(body)
      return Response.json({ imported: body.rows.length })
    }
  })
  const { user } = renderApp(<ExternalCanvasDialog canvasId={canvasId} onClose={() => {}} />)
  await user.type(screen.getByLabelText('即梦项目链接或 ID'), target.target)
  await user.click(screen.getByRole('button', { name: '读取差异' }))
  await user.click(await screen.findByRole('button', { name: '选中前 200 项' }))

  const choices = screen.getAllByRole<HTMLInputElement>('checkbox', { name: /^选择导入「镜头 / })
  expect(choices).toHaveLength(202)
  expect(choices.slice(0, 200).every((choice) => choice.checked && !choice.disabled)).toBe(true)
  expect(choices.slice(200).every((choice) => !choice.checked && choice.disabled)).toBe(true)

  const first = choices[0]!
  const last = choices[201]!
  await user.click(first)
  expect(last.disabled).toBe(false)
  await user.click(last)
  expect(first.checked).toBe(false)
  expect(first.disabled).toBe(true)
  expect(choices[200]!.disabled).toBe(true)
  expect(last.checked).toBe(true)
  expect(submissions).toEqual([])
  await user.click(screen.getByRole('button', { name: '导入所选（200）' }))
  expect(await screen.findByText('已导入 200 个即梦节点')).toBeTruthy()
  const selected = [...rows.slice(1, 200), rows[201]!]
  expect(submissions).toEqual([
    { ...target, rows: selected.map(({ rowId, revision }) => ({ rowId, revision })) },
  ])
})
