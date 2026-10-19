import type { Engine } from '@plein/canvas-core'
import { elementMedia } from '@plein/doc'
import { Icon } from '../ui/icons'
import { useBatchDownload } from './useBatchDownload'

interface Props {
  engine: Engine
  assetId: string
  /** 当前选中元素的下载：读取完成时再核对文档，避免帧通知前交出旧素材。 */
  elementId?: string
  name: string
  label?: string
  className?: string
  iconOnly?: boolean
}

/** 切换采用结果或交付版本时，中止旧文件读取并移除旧操作状态。 */
export function AssetDownloadButton(props: Props) {
  return <DownloadSession key={props.assetId} {...props} />
}

function DownloadSession({
  engine,
  assetId,
  elementId,
  name,
  label = '下载',
  className = 'ui-btn ui-btn-quiet',
  iconOnly = false,
}: Props) {
  const download = useBatchDownload(engine, true, () => {
    if (!elementId) return true
    const selected = engine.selection.values()
    const source = engine.doc.get(elementId)
    return (
      selected.length === 1 &&
      selected[0] === elementId &&
      !!source &&
      elementMedia(source)?.assetId === assetId
    )
  })
  const retry = download.remaining.length > 0
  const text = download.running
    ? '正在读取原文件'
    : retry
      ? download.cancelled
        ? '继续下载'
        : '重试下载'
      : label
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        className={className}
        aria-label={text}
        aria-busy={download.running}
        disabled={download.running}
        title={`${text}：${name}`}
        onClick={() => void download.start(retry ? download.remaining : [{ assetId, name }])}
      >
        {iconOnly && download.running ? (
          <span className="animate-spin">
            <Icon name="retry" size={14} />
          </span>
        ) : iconOnly ? (
          <Icon name={retry && !download.cancelled ? 'warning' : 'download'} size={14} />
        ) : (
          text
        )}
      </button>
      {download.running && (
        <button
          type="button"
          className="ui-btn ui-btn-sm ui-btn-quiet ui-icon-btn"
          aria-label="取消下载"
          title="取消读取原文件"
          onClick={download.cancel}
        >
          <Icon name="x" size={14} />
        </button>
      )}
      {retry && (
        <span role="status" className={iconOnly ? 'sr-only' : 'text-xs text-ink-muted'}>
          {download.cancelled ? '文件未下载，可继续' : '原文件读取失败，可重试'}
        </span>
      )}
    </span>
  )
}
