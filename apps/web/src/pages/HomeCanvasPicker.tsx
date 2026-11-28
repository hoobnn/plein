import type { Project } from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import { queryKeys } from '../api/query'
import { routeHash } from '../router'
import { EmptyState } from '../ui/EmptyState'
import { fullTime, relativeTime } from '../ui/format'
import { Icon } from '../ui/icons'
import { Modal, ModalHeader } from '../ui/Modal'
import { AnimatePresence } from '../ui/motion'
import { HomeSearch } from './HomeSearch'

export function HomeCanvasPicker({
  project,
  onClose,
}: {
  project: Project | null
  onClose(): void
}) {
  return (
    <AnimatePresence>
      {project && <CanvasPicker key={project.id} project={project} onClose={onClose} />}
    </AnimatePresence>
  )
}

function CanvasPicker({ project, onClose }: { project: Project; onClose(): void }) {
  const [query, setQuery] = useState('')
  const { data, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.projectCanvases(project.id),
    queryFn: () => api.projectCanvases(project.id),
    refetchOnMount: 'always',
  })
  const term = query.trim().toLowerCase()
  // 服务端已按最近编辑倒序排列，同一毫秒内也有稳定的顺序。
  const shown = data?.filter((canvas) => canvas.title.toLowerCase().includes(term))
  const title = `选择画布 · ${project.title}`
  return (
    <Modal label={title} onClose={onClose} size="sm">
      <ModalHeader title={title} onClose={onClose} />
      <div className="flex min-h-0 flex-col gap-3 p-4 [&>.home-search]:w-full [&>.home-search]:shrink-0">
        {!!data?.length && <HomeSearch scope="画布" value={query} onChange={setQuery} />}
        {error && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-danger">
              {data ? '画布列表刷新失败' : '画布列表加载失败'}：{error.message}
            </span>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              重新读取
            </button>
          </div>
        )}
        {!data && !error && (
          <p role="status" className="py-4 text-ink-muted">
            正在读取画布…
          </p>
        )}
        {shown &&
          (shown.length ? (
            <ul aria-label="项目画布" className="ui-scrollbar min-h-0 overflow-y-auto">
              {shown.map((canvas) => (
                <li key={canvas.id}>
                  <a
                    className="flex min-h-12 items-center gap-3 rounded-md px-2 py-2 text-ink hover:bg-hover focus-visible:bg-hover"
                    href={routeHash({ name: 'canvas', id: canvas.id })}
                  >
                    <Icon name="frame" size={16} />
                    <span className="min-w-0 flex-1 break-words">{canvas.title}</span>
                    <span
                      className="shrink-0 text-xs text-ink-subtle"
                      title={fullTime(canvas.updatedAt)}
                    >
                      {relativeTime(canvas.updatedAt)}编辑
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              compact
              icon={term ? 'search' : 'frame'}
              title={term ? '没有匹配的画布' : '项目里还没有画布'}
            />
          ))}
      </div>
    </Modal>
  )
}
