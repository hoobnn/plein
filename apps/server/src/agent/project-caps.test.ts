import { describe, expect, it } from 'vite-plus/test'
import { bootServer, createCanvas } from '../testing'
import { Approvals } from './approvals'
import { AgentChanges } from './changes'
import { callTool } from './mcp'
import { agentTools, serverCapabilities, serverContext, type ToolEnv } from './tools'

async function fixture() {
  const { server } = await bootServer()
  const { id } = await createCanvas(server)
  const env: ToolEnv = {
    canvasId: id,
    ownerId: 'local',
    rooms: server.rooms,
    runs: server.runs,
    host: server.plugins,
    assets: server.assets,
    library: server.library,
    canvasApi: server.canvasApi,
  }
  const invoke = (name: string, args: unknown, as = env) =>
    serverCapabilities.invoke(name, serverContext(as), args)
  return { server, id, env, invoke }
}

describe('项目与画布管理能力', () => {
  it('新建、改名、列出、分页并删除项目与画布', async () => {
    const f = await fixture()
    const project = (await f.invoke('create_project', { title: '短片' })) as {
      project_id: string
      canvas_id: string
    }
    expect(project.canvas_id).toBeTruthy()
    await f.invoke('rename_project', { project_id: project.project_id, title: '长片' })
    const list = (await f.invoke('list_projects', {})) as {
      total: number
      items: Array<{ id: string; title: string; canvases: number }>
    }
    expect(list.items.find((p) => p.id === project.project_id)).toMatchObject({
      title: '长片',
      canvases: 1,
    })
    const first = (await f.invoke('list_projects', { limit: 1 })) as {
      items: unknown[]
      next_offset?: number
    }
    expect(first.items).toHaveLength(1)
    expect(first.next_offset).toBe(1)

    const second = (await f.invoke('create_canvas', {
      title: '第二幕',
      project_id: project.project_id,
    })) as { canvas_id: string; project_id: string }
    expect(second.project_id).toBe(project.project_id)
    await f.invoke('rename_canvas', { canvas_id: second.canvas_id, title: '第二幕改' })
    const canvases = (await f.invoke('list_canvases', {
      project_id: project.project_id,
    })) as Array<{
      id: string
      title: string
      project_title: string
    }>
    expect(canvases.map((c) => c.id)).toContain(second.canvas_id)
    expect(canvases.find((c) => c.id === second.canvas_id)).toMatchObject({
      title: '第二幕改',
      project_title: '长片',
    })
    const all = (await f.invoke('list_canvases', {})) as Array<{ id: string; viewing?: boolean }>
    expect(all.find((c) => c.id === f.id)?.viewing).toBe(true)
    expect(await f.invoke('list_canvases', { limit: 1 })).toHaveLength(1)

    await f.invoke('delete_canvas', { canvas_id: second.canvas_id })
    expect(await f.invoke('list_canvases', { project_id: project.project_id })).toHaveLength(1)
    await f.invoke('delete_project', { project_id: project.project_id })
    await expect(
      f.invoke('rename_project', { project_id: project.project_id, title: 'x' }),
    ).rejects.toThrow('list_projects')
  })

  it('只能操作自己的项目与画布，且不能删本会话正在用的画布', async () => {
    const f = await fixture()
    const other: ToolEnv = { ...f.env, ownerId: 'other', canvasId: '' }
    await expect(f.invoke('delete_canvas', { canvas_id: f.id }, other)).rejects.toThrow('不存在')
    expect(await f.invoke('list_canvases', {}, other)).toEqual([])
    const session = { ...f.env, execution: { abort: new AbortController() } } as unknown as ToolEnv
    await expect(f.invoke('delete_canvas', { canvas_id: f.id }, session)).rejects.toThrow(
      '正在操作',
    )
    await expect(f.invoke('create_canvas', { project_id: 'nope' })).rejects.toThrow('list_projects')
    // 路径注入：id 里的 ../ 被编码，不会折成别的路由
    await expect(f.invoke('delete_canvas', { canvas_id: '../projects/x' })).rejects.toThrow()
  })

  it('删除类能力在规则模式下先要确认，未批准不删除', async () => {
    const f = await fixture()
    const changes = new AgentChanges('p', f.id, 'local', f.server.rooms, f.server.runs)
    changes.begin('turn')
    const approvals = new Approvals(() => {})
    const tools = agentTools(f.env, { changes, approvals, mode: () => 'rules' })
    const made = (await f.invoke('create_canvas', { title: '待删' })) as { canvas_id: string }
    for (const [name, input] of [
      ['delete_canvas', { canvas_id: made.canvas_id }],
      ['delete_project', { project_id: 'whatever' }],
    ] as const) {
      const r = await callTool(
        tools.find((t) => t.name === name)!,
        input,
      )
      const text = r.content[0]!.type === 'text' ? r.content[0]!.text : ''
      expect(JSON.parse(text).status).toBe('needs_approval')
    }
    const ids = ((await f.invoke('list_canvases', {})) as Array<{ id: string }>).map((c) => c.id)
    expect(ids).toContain(made.canvas_id)
  })
})
