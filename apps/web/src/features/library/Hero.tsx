import type { LibraryKindSpec } from '@plein/nodes'
import { useState } from 'react'
import { assetUrls } from '../../api/client'
import { Icon } from '../../ui/icons'
import { KIND_ICONS } from './LibraryAdd'

/** 档案大图：换图时新图在旧图上交叉淡入并轻微回缩，底部一行写着现在看的是哪一项 */
export function Hero({
  kind,
  assetId,
  caption,
  name,
  readOnly,
  completeImage = false,
}: {
  kind: LibraryKindSpec
  assetId: string | null
  caption?: string
  name: string
  readOnly: boolean
  completeImage?: boolean
}) {
  // 叠两层：下面是上一张，上面是新的一张从透明淡入，换得再快也不闪白
  const [layers, setLayers] = useState<Array<{ id: string | null; key: number }>>([
    { id: assetId, key: 0 },
  ])
  const [failedKey, setFailedKey] = useState(-1)
  const top = layers[layers.length - 1]!
  if (top.id !== assetId) setLayers([top, { id: assetId, key: top.key + 1 }])
  return (
    <div className="lib-hero" data-complete-image={completeImage || undefined}>
      {layers.map((l, i) =>
        l.id ? (
          <img
            key={l.key}
            src={assetUrls.variant(l.id, 'thumb-1024')}
            alt=""
            draggable={false}
            data-enter={i === layers.length - 1 && layers.length > 1 ? '' : undefined}
            onAnimationEnd={() => setLayers((ls) => ls.slice(-1))}
            onError={() => setFailedKey((previous) => Math.max(previous, l.key))}
          />
        ) : (
          <span
            key={l.key}
            data-enter={i === layers.length - 1 && layers.length > 1 ? '' : undefined}
            onAnimationEnd={() => setLayers((ls) => ls.slice(-1))}
            className="lib-hero-empty"
          >
            <Icon name={KIND_ICONS[kind.id]} size={24} />
            {readOnly
              ? `官方${kind.title}只有提示词，复制到「我的」之后可以加参考图`
              : '还没有参考图'}
          </span>
        ),
      )}
      {assetId && failedKey === top.key && (
        <span role="alert" className="lib-hero-empty">
          <Icon name="image" size={24} />
          <span>参考图加载失败</span>
          <button
            type="button"
            className="ui-btn ui-btn-secondary"
            onClick={() => setLayers([{ id: assetId, key: top.key + 1 }])}
          >
            <Icon name="retry" size={14} />
            重新加载参考图
          </button>
        </span>
      )}
      {assetId && (
        <a
          href={assetUrls.original(assetId)}
          target="_blank"
          rel="noreferrer"
          aria-label="查看原图"
          title="查看原图"
          className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn lib-hero-original"
        >
          <Icon name="expand" size={14} />
        </a>
      )}
      <div className="lib-hero-caption">
        <span className="truncate text-base font-semibold">{name}</span>
        {caption && <span className="truncate text-xs">{caption}</span>}
      </div>
    </div>
  )
}
