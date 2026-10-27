import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { queryKeys } from '../../api/query'
import { routeHash } from '../../router'
import { useState } from 'react'

/** 只读取当前项目的现有画布索引，不加载其他文档或聚合猜测进度。 */
export function ProductionCanvasIndex({ canvasId }: { canvasId: string }) {
  const [expanded, setExpanded] = useState(false)
  const canvas = useQuery({
    queryKey: queryKeys.canvas(canvasId),
    queryFn: () => api.canvas(canvasId),
    enabled: expanded,
  })
  const projectId = canvas.data?.projectId
  const list = useQuery({
    queryKey: queryKeys.projectCanvases(projectId ?? ''),
    queryFn: () => api.projectCanvases(projectId!),
    enabled: expanded && !!projectId,
    staleTime: 0,
  })
  const error = canvas.error ?? list.error
  return (
    <details
      className="border-t border-line pt-2 text-2xs"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="cursor-pointer">当前项目的画布</summary>
      <div className="mt-2 flex flex-col gap-1">
        {error ? (
          <p role="status">
            画布索引读取失败：{error.message}{' '}
            <button
              className="underline"
              type="button"
              onClick={() => {
                if (canvas.error) void canvas.refetch()
                else void list.refetch()
              }}
            >
              重试读取
            </button>
          </p>
        ) : canvas.isPending || list.isPending ? (
          <p role="status">正在读取画布索引…</p>
        ) : !list.data?.length ? (
          <p role="status">这个项目暂时没有可打开的画布。</p>
        ) : (
          <ul aria-label="制作画布索引">
            {list.data?.map((item) => (
              <li key={item.id}>
                <a
                  aria-current={item.id === canvasId ? 'page' : undefined}
                  className="block rounded px-1 py-1 hover:bg-hover"
                  href={routeHash({ name: 'canvas', id: item.id })}
                >
                  {item.title}
                  {list.data!.some((other) => other.id !== item.id && other.title === item.title)
                    ? ` · ${item.id}`
                    : ''}
                  {item.id === canvasId ? '（当前）' : ''}
                </a>
              </li>
            ))}
          </ul>
        )}
        <p className="text-ink-subtle">点击进入对应画布；其他画布的制作进度在打开后读取。</p>
      </div>
    </details>
  )
}
