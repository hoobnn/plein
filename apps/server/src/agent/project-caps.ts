import { capabilityFor, CapabilityError } from '@plein/capabilities'
import { API, type Canvas, type Project } from '@plein/protocol'
import { z } from 'zod'
import { callInternal } from './internal-api'
import type { ServerContext } from './tools'

const cap = capabilityFor<ServerContext>()
const id = z.string().min(1).max(200)
const title = z.string().trim().min(1).max(200)
const page = {
  offset: z.number().int().min(0).default(0).describe('跳过前多少条，用于翻页'),
  limit: z.number().int().min(1).max(200).default(50).describe('最多返回多少条'),
}
const iso = (ms: number) => new Date(ms).toISOString()
const PROJECT_PATH = /^\/api\/projects\/[^/]+$/
const CANVAS_PATH = /^\/api\/canvases\/[^/]+$/
const HINT_PROJECT = '先用 list_projects 查询项目 id'
const HINT_CANVAS = '先用 list_canvases 查询画布 id'

/**
 * 不依赖「当前画布」的能力：外部 MCP 不为它们追加 canvas_id，也不要求画布存在
 *（空工作区里也要能新建项目）。
 */
export const workspaceToolNames = new Set<string>()
const workspace = <T extends { name: string }>(definition: T): T => {
  workspaceToolNames.add(definition.name)
  return definition
}

export const listProjects = workspace(
  cap({
    name: 'list_projects',
    title: '列出项目',
    group: 'project',
    where: 'server',
    effect: 'read',
    description:
      '列出用户的全部项目（最近改过的在前）：id、标题、画布数、最近修改时间、最近画布 id。项目是一部片子的容器，下面挂多张画布。条数等于 limit 时可能还有更多，把 offset 加上 limit 继续翻页。',
    input: z.object(page),
    run: async (ctx, a) => {
      const rows = await callInternal<Project[]>(ctx, {
        method: 'GET',
        path: API.projects,
        pathname: /^\/api\/projects$/,
      })
      const items = rows.slice(a.offset, a.offset + a.limit).map((p) => ({
        id: p.id,
        title: p.title,
        canvases: p.canvases,
        updated_at: iso(p.updatedAt),
        last_canvas_id: p.lastCanvasId,
      }))
      return {
        total: rows.length,
        items,
        ...(a.offset + items.length < rows.length ? { next_offset: a.offset + items.length } : {}),
      }
    },
  }),
)

export const createProject = workspace(
  cap({
    name: 'create_project',
    title: '新建项目',
    group: 'project',
    where: 'server',
    effect: 'edit',
    description:
      '新建项目，同时建好它的第一张空画布，返回 project_id 和 canvas_id。之后用 canvas_id 作为其它工具的画布参数操作它；项目下想要更多画布用 create_canvas。',
    input: z.object({ title: title.default('未命名项目') }),
    run: async (ctx, a) => {
      const p = await callInternal<Project>(ctx, {
        method: 'POST',
        path: API.projects,
        pathname: /^\/api\/projects$/,
        body: { title: a.title },
      })
      return { project_id: p.id, title: p.title, canvas_id: p.lastCanvasId }
    },
  }),
)

export const renameProject = workspace(
  cap({
    name: 'rename_project',
    title: '重命名项目',
    group: 'project',
    where: 'server',
    effect: 'edit',
    description: '修改项目标题。项目 id 来自 list_projects。',
    input: z.object({ project_id: id, title }),
    run: async (ctx, a) => {
      const p = await callInternal<Project>(
        ctx,
        {
          method: 'PATCH',
          path: API.project(a.project_id),
          pathname: PROJECT_PATH,
          body: { title: a.title },
        },
        HINT_PROJECT,
      )
      return { project_id: p.id, title: p.title }
    },
  }),
)

const PROJECT_DELETE = '删除项目及其下全部画布（不能撤销，资产库条目保留）'
export const deleteProject = workspace(
  cap({
    name: 'delete_project',
    title: '删除项目',
    group: 'project',
    where: 'server',
    effect: 'destructive',
    approval: () => ({ reason: PROJECT_DELETE, ids: [] }),
    description:
      '永久删除一个项目和它下面的全部画布（不能撤销；资产库条目保留）。先用 list_projects 和 list_canvases 确认要删的是哪个、里面有什么，并让用户明确同意后再调用。不能删除本会话正在操作的画布所在的项目。',
    input: z.object({ project_id: id }),
    run: async (ctx, a) => {
      if (ctx.env.canvasId) {
        const inside = await callInternal<Canvas[]>(
          ctx,
          {
            method: 'GET',
            path: API.projectCanvases(a.project_id),
            pathname: /^\/api\/projects\/[^/]+\/canvases$/,
          },
          HINT_PROJECT,
        )
        if (inside.some((c) => c.id === ctx.env.canvasId))
          throw new CapabilityError('这个项目包含本会话正在操作的画布，不能删除')
      }
      await callInternal(
        ctx,
        { method: 'DELETE', path: API.project(a.project_id), pathname: PROJECT_PATH },
        HINT_PROJECT,
      )
      return { deleted: a.project_id }
    },
  }),
)

export const listCanvases = workspace(
  cap({
    name: 'list_canvases',
    title: '列出画布',
    group: 'project',
    where: 'server',
    effect: 'read',
    description:
      '列出用户的画布（最近改过的在前），带所属项目；标出本次正在操作或用户正在看的那块（viewing）。可用 project_id 只看某个项目。返回数组；条数等于 limit 时可能还有更多，把 offset 加上 limit 继续翻页。画布 id 用于其它工具的 canvas_id。',
    input: z.object({
      project_id: id.optional().describe('只列出这个项目下的画布；不填列出全部'),
      ...page,
    }),
    run: async (ctx, a) => {
      const [canvases, projects] = await Promise.all([
        callInternal<Canvas[]>(ctx, {
          method: 'GET',
          path: a.project_id
            ? `${API.canvases}?projectId=${encodeURIComponent(a.project_id)}`
            : API.canvases,
          pathname: /^\/api\/canvases$/,
        }),
        callInternal<Project[]>(ctx, {
          method: 'GET',
          path: API.projects,
          pathname: /^\/api\/projects$/,
        }),
      ])
      const titles = new Map(projects.map((p) => [p.id, p.title]))
      return canvases.slice(a.offset, a.offset + a.limit).map((c) => ({
        id: c.id,
        title: c.title,
        project_id: c.projectId,
        project_title: titles.get(c.projectId),
        updated_at: iso(c.updatedAt),
        ...(c.elements === undefined ? {} : { elements: c.elements }),
        ...(c.id === ctx.env.canvasId ? { viewing: true } : {}),
      }))
    },
  }),
)

export const createCanvas = workspace(
  cap({
    name: 'create_canvas',
    title: '新建画布',
    group: 'project',
    where: 'server',
    effect: 'edit',
    description:
      '在指定项目下新建一张空画布，返回 canvas_id。不填 project_id 会新建一个同名的新项目来放它；想放进已有项目先用 list_projects 取 id。',
    input: z.object({
      title: title.default('未命名画布'),
      project_id: id.optional().describe('建在哪个项目下；不填则新建同名项目'),
    }),
    run: async (ctx, a) => {
      const c = await callInternal<Canvas>(
        ctx,
        {
          method: 'POST',
          path: API.canvases,
          pathname: /^\/api\/canvases$/,
          body: { title: a.title, ...(a.project_id ? { projectId: a.project_id } : {}) },
        },
        HINT_PROJECT,
      )
      return { canvas_id: c.id, title: c.title, project_id: c.projectId }
    },
  }),
)

export const renameCanvas = workspace(
  cap({
    name: 'rename_canvas',
    title: '重命名画布',
    group: 'project',
    where: 'server',
    effect: 'edit',
    description: '修改画布标题。画布 id 来自 list_canvases。',
    input: z.object({ canvas_id: id, title }),
    run: async (ctx, a) => {
      const c = await callInternal<Canvas>(
        ctx,
        {
          method: 'PATCH',
          path: API.canvas(a.canvas_id),
          pathname: CANVAS_PATH,
          body: { title: a.title },
        },
        HINT_CANVAS,
      )
      return { canvas_id: c.id, title: c.title }
    },
  }),
)

const CANVAS_DELETE = '删除画布及其全部内容（不能撤销）'
export const deleteCanvas = workspace(
  cap({
    name: 'delete_canvas',
    title: '删除画布',
    group: 'project',
    where: 'server',
    effect: 'destructive',
    approval: () => ({ reason: CANVAS_DELETE, ids: [] }),
    description:
      '永久删除一张画布和里面的全部内容（不能撤销）。先用 list_canvases 确认画布 id，并让用户明确同意后再调用。不能删除本会话正在操作的画布；项目里的最后一张画布也可以删，项目本身保留。',
    input: z.object({ canvas_id: id }),
    run: async (ctx, a) => {
      if (ctx.env.canvasId && a.canvas_id === ctx.env.canvasId)
        throw new CapabilityError('不能删除本会话正在操作的画布')
      await callInternal(
        ctx,
        { method: 'DELETE', path: API.canvas(a.canvas_id), pathname: CANVAS_PATH },
        HINT_CANVAS,
      )
      return { deleted: a.canvas_id }
    },
  }),
)

export const projectCapabilities = [
  listProjects,
  createProject,
  renameProject,
  deleteProject,
  listCanvases,
  createCanvas,
  renameCanvas,
  deleteCanvas,
]
