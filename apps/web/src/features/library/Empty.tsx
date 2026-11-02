import type { LibraryKindSpec } from '@plein/nodes'
import { EmptyState } from '../../ui/EmptyState'
import { Icon } from '../../ui/icons'
import type { Scope } from './library.utils'

export function Empty({
  kind,
  scope,
  filtered,
  onClear,
  onCreate,
}: {
  kind: LibraryKindSpec
  scope: Scope
  filtered: boolean
  onClear(): void
  onCreate(): void
}) {
  const text = filtered
    ? `没有符合条件的${kind.title}`
    : scope === 'favorite'
      ? `还没有收藏的${kind.title}`
      : scope === 'recent'
        ? `还没有用过的${kind.title}`
        : scope === 'project'
          ? `这个项目还没有${kind.title}`
          : `还没有${kind.title}`
  return (
    <EmptyState
      icon={filtered ? 'search' : 'library'}
      title={text}
      hint={
        filtered
          ? '试试其他关键词，或清空搜索和筛选。'
          : `${kind.description}。也可以在画布上选中图片${kind.video ? '或视频' : ''}，点工具条上的「存入资产库」。`
      }
      action={
        <button
          type="button"
          onClick={filtered ? onClear : onCreate}
          className="ui-btn ui-btn-secondary"
        >
          <Icon name={filtered ? 'retry' : 'plus'} />
          {filtered ? '清空搜索和筛选' : `新建${kind.title}`}
        </button>
      }
    />
  )
}
