import { QueryClient } from '@tanstack/react-query'
import type { Canvas, Project } from '@plein/protocol'
import { ApiError } from './client'

/**
 * 服务端数据的读取缓存（TanStack Query）：列表类数据（项目、画布、任务）用 useQuery 读，
 * 改完后按 key 失效重新拉。请求本身仍走 api（类型来自 @plein/protocol）；
 * 画布内容走 Yjs 同步，资产库、模板等命令式用的状态仍在 zustand 里。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 4xx（没权限、不存在、参数错）重试也没用
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      // 切回窗口时刷新一下，其余时候 10 秒内的数据直接用
      staleTime: 10_000,
    },
  },
})

export const queryKeys = {
  projects: ['projects'] as const,
  project: (id: string) => ['projects', id] as const,
  projectCanvases: (id: string) => ['projects', id, 'canvases'] as const,
  canvas: (id: string) => ['canvases', id] as const,
  canvasJobs: (canvasId: string) => ['canvases', canvasId, 'jobs'] as const,
  groupItems: (groupId: string) => ['groups', groupId, 'items'] as const,
  capabilities: ['capabilities'] as const,
  mcpExternal: ['mcp', 'external'] as const,
  localPlugins: ['plugins', 'local'] as const,
  localClis: ['agent', 'clis'] as const,
  voices: ['voices'] as const,
}

/** 已获服务端确认的改名立即更新已加载列表，保留应答中没有的列表封面。 */
export function cacheProject(project: Project) {
  queryClient.setQueryData(queryKeys.project(project.id), project)
  queryClient.setQueryData<Project[]>(queryKeys.projects, (items) =>
    items?.map((item) => (item.id === project.id ? { ...item, ...project } : item)),
  )
}

/** 当前页及切换后重新打开的页面都读取同一份已确认画布名称。 */
export async function cacheCanvas(canvas: Canvas) {
  await queryClient.cancelQueries({ queryKey: queryKeys.canvas(canvas.id), exact: true })
  await queryClient.cancelQueries({
    queryKey: queryKeys.projectCanvases(canvas.projectId),
    exact: true,
  })
  queryClient.setQueryData(queryKeys.canvas(canvas.id), canvas)
  queryClient.setQueryData<Canvas[]>(queryKeys.projectCanvases(canvas.projectId), (items) =>
    items?.map((item) => (item.id === canvas.id ? { ...item, ...canvas } : item)),
  )
}

/** 项目或其画布有改动：项目列表（画布数、更新时间）和该项目的数据都要重新拉 */
export const invalidateProjects = () =>
  queryClient.invalidateQueries({ queryKey: queryKeys.projects })
