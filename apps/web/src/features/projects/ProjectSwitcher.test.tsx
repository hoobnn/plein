// @vitest-environment happy-dom
import type { Canvas, Project } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { mockFetch } from '../../testing/fetch'
import { fireEvent, renderApp, screen, waitFor, within } from '../../testing/render'
import { ProjectSwitcher } from './ProjectSwitcher'

const canvas: Canvas = {
  id: 'canvas-1',
  projectId: 'project-1',
  title: '第一张画布',
  createdAt: 1,
  updatedAt: 1,
}
const project: Project = {
  id: canvas.projectId,
  title: '雨后的项目',
  createdAt: 1,
  updatedAt: 1,
  canvases: 1,
  lastCanvasId: canvas.id,
}

async function setup() {
  const fetch = mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === `/api/projects/${project.id}`)
      return Response.json(project)
    if (request.method === 'GET' && path === `/api/projects/${project.id}/canvases`)
      return Response.json([canvas])
  })
  useCanvas.setState({ canvasId: canvas.id })
  const { user } = renderApp(<ProjectSwitcher canvas={canvas} />, {
    route: { name: 'canvas', id: canvas.id },
  })
  await user.click(await screen.findByRole('button', { name: project.title }))
  const dialog = await screen.findByRole('dialog', { name: '重命名项目' })
  const input = within(dialog).getByRole<HTMLInputElement>('textbox', { name: '项目名称' })
  const writes = () => fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')
  return { user, dialog, input, writes }
}

it('项目改名空白不可保存，原名称确认不提交', async () => {
  const { user, dialog, input, writes } = await setup()
  await user.clear(input)
  await user.type(input, '   ')
  expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: '保存' }).disabled).toBe(
    true,
  )
  await user.keyboard('{Enter}')
  expect(screen.getByRole('dialog', { name: '重命名项目' })).toBe(dialog)
  expect(writes()).toHaveLength(0)

  await user.clear(input)
  await user.type(input, project.title)
  await user.click(within(dialog).getByRole('button', { name: '保存' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(writes()).toHaveLength(0)
})

it('项目改名组字结束的 Esc 229 不丢弃输入，普通取消不写入', async () => {
  const { user, dialog, input, writes } = await setup()
  await user.clear(input)
  await user.type(input, '中文组字中的项目名称')
  for (const composing of [{ keyCode: 229 }, { isComposing: true }]) {
    fireEvent.keyDown(input, { key: 'Escape', ...composing })
    expect(screen.getByRole('dialog', { name: '重命名项目' })).toBe(dialog)
    expect(dialog.hasAttribute('data-closing')).toBe(false)
    expect(input.value).toBe('中文组字中的项目名称')
  }
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(writes()).toHaveLength(0)
})
