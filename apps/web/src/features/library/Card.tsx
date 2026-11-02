import {
  CHARACTER_IMAGE_SLOTS,
  type LibraryKindSpec,
  normalizeLibraryImages,
  profileSize,
  sceneViewImages,
} from '@plein/nodes'
import type { LibraryItem } from '@plein/protocol'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../ui/icons'
import { coverOf } from './canvas'
import { thumb } from './LibraryFields'
import { tagLine } from './library.utils'
import { useLibrary } from './store'

export function Card({
  kind,
  item,
  source,
  canPlace,
  placing,
  onOpen,
  onPlace,
}: {
  kind: LibraryKindSpec
  item: LibraryItem
  source?: string
  canPlace: boolean
  placing: boolean
  onOpen(cover: HTMLElement | null): void
  onPlace(): void
}) {
  const cover = coverOf(item, kind)
  const update = useLibrary((s) => s.update)
  const favoritePending = useRef(false)
  const favoriteLive = useRef(false)
  const [favoriteBusy, setFavoriteBusy] = useState(false)
  const [favoriteError, setFavoriteError] = useState<string | null>(null)
  useEffect(() => {
    favoriteLive.current = true
    return () => {
      favoriteLive.current = false
    }
  }, [])
  const toggleFavorite = async () => {
    if (favoritePending.current) return
    favoritePending.current = true
    setFavoriteBusy(true)
    setFavoriteError(null)
    try {
      await update(item.id, { favorite: !item.favorite })
    } catch (error) {
      if (favoriteLive.current)
        setFavoriteError(`收藏未更改：${(error as Error).message}。点击星标重试。`)
    } finally {
      favoritePending.current = false
      if (favoriteLive.current) setFavoriteBusy(false)
    }
  }
  const coverRef = useRef<HTMLDivElement>(null)
  const profile = item.profile ? profileSize(item.profile) : null
  // 悬停时从底部升起：一行一个时期，后面跟着这个时期的服饰
  const peek = item.profile ? profilePeek(item.profile) : []
  const sceneSummary =
    kind.id === 'scene' && item.images.length === 0 && (item.sceneViews?.length ?? 0) > 0
      ? `${item.sceneViews!.length} 个视角 · ${sceneViewImages(item.sceneViews).length} 张视角图`
      : ''
  const characterImages = kind.id === 'character' ? normalizeLibraryImages(kind, item.images) : []
  const imageKinds = CHARACTER_IMAGE_SLOTS.filter((slot) =>
    characterImages.some((image) => image.slot === slot.id),
  ).length
  return (
    <li data-library-id={item.id} className="home-card lib-card group relative">
      <div className="relative">
        <button
          type="button"
          onClick={() => onOpen(coverRef.current)}
          className="lib-card-open block w-full text-left"
        >
          <div
            ref={coverRef}
            data-lib-cover={item.id}
            data-kind={kind.id}
            className="lib-card-cover"
          >
            {cover ? (
              <img src={cover} alt="" loading="lazy" draggable={false} />
            ) : (
              <span className="line-clamp-6 px-4 text-xs text-ink-subtle">
                {item.description || '没有参考图'}
              </span>
            )}
            {peek.length > 0 && (
              <span className="lib-card-peek" aria-hidden="true">
                {peek.map((row, r) => (
                  <span key={row.id} className="lib-card-peek-row">
                    <span
                      className="lib-card-peek-period"
                      style={{ '--i': r * 4 } as React.CSSProperties}
                    >
                      {row.image ? (
                        <img src={thumb(row.image)} alt="" loading="lazy" draggable={false} />
                      ) : (
                        <Icon name="period" size={12} />
                      )}
                      <span className="truncate">{row.name}</span>
                    </span>
                    {row.outfits.map((outfit, i) => (
                      <img
                        key={outfit.id}
                        src={thumb(outfit.assetId)}
                        alt=""
                        loading="lazy"
                        draggable={false}
                        style={{ '--i': r * 4 + i + 1 } as React.CSSProperties}
                      />
                    ))}
                    {row.more > 0 && (
                      <span
                        className="lib-card-peek-more"
                        style={{ '--i': r * 4 + 4 } as React.CSSProperties}
                      >
                        +{row.more}
                      </span>
                    )}
                  </span>
                ))}
              </span>
            )}
          </div>
          <div className="px-3 py-3">
            <div className="truncate text-sm font-medium">{item.name}</div>
            <div className="truncate text-xs text-ink-subtle" title={source}>
              {source && <>{source} · </>}
              {item.profile && profile && (profile.periods || profile.expressions)
                ? profileLine(item.profile, profile)
                : tagLine(kind, item.tags) || sceneSummary || `${item.images.length} 张参考图`}
            </div>
          </div>
        </button>
        {kind.id === 'character' && (
          <span className="ui-badge lib-card-completeness" title="已添加的角色图片类型">
            {imageKinds} / 4 形象
          </span>
        )}
        <button
          type="button"
          aria-label={item.favorite ? '取消收藏' : '收藏'}
          aria-pressed={item.favorite}
          title={item.favorite ? '取消收藏' : '收藏'}
          disabled={favoriteBusy}
          aria-busy={favoriteBusy || undefined}
          onClick={() => void toggleFavorite()}
          className={`ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn absolute top-2 right-2 bg-float ${
            item.favorite
              ? 'text-warning'
              : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
          }`}
        >
          <Icon name="star" size={14} />
        </button>
        {canPlace && (
          <button
            type="button"
            onClick={onPlace}
            disabled={placing}
            className="ui-btn ui-btn-primary ui-btn-sm lib-card-place absolute bottom-16 left-1/2"
          >
            {placing ? '正在放入…' : '添加到画布'}
          </button>
        )}
      </div>
      {favoriteError && (
        <p role="alert" className="mx-3 mb-3 rounded-lg bg-danger/5 px-2 py-2 text-xs text-danger">
          {favoriteError}。点击星标重试。
        </p>
      )}
    </li>
  )
}

/** 卡片底部一行：「少年 3 套 · 青年 2 套 · 8 表情」，一眼看出服饰挂在哪个时期 */
function profileLine(p: NonNullable<LibraryItem['profile']>, n: ReturnType<typeof profileSize>) {
  return [
    ...p.periods.map((x) => (x.outfits.length ? `${x.name} ${x.outfits.length} 套` : x.name)),
    n.expressions && `${n.expressions} 表情`,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** 悬停预览：最多 3 个时期，每个时期带服饰首图，一行放不下 3 张时末格换成「+N」 */
function profilePeek(p: NonNullable<LibraryItem['profile']>) {
  return p.periods.slice(0, 3).map((x) => {
    const outfits = x.outfits.flatMap((o) =>
      o.images.slice(0, 1).map((assetId) => ({ id: o.id, assetId })),
    )
    const shown = outfits.slice(0, x.outfits.length > 3 ? 2 : 3)
    return {
      id: x.id,
      name: x.name,
      image: x.images[0] ?? null,
      outfits: shown,
      more: x.outfits.length - shown.length,
    }
  })
}
