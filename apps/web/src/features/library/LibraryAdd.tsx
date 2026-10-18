import { LIBRARY_KINDS } from '@plein/nodes'
import type { Engine } from '@plein/canvas-core'
import type { LibraryKind } from '@plein/protocol'
import { useState } from 'react'
import { type CanvasMedia, mediaSelectionKey, selectionSeed } from './canvas'
import { useLibrary } from './store'
import { Icon, type IconName } from '../../ui/icons'
import { Popover } from '../../ui/Popover'
import { Presence } from '../../ui/Presence'
import { useCanvas } from '../../stores/canvas'

export const KIND_ICONS: Record<LibraryKind, IconName> = {
  character: 'character',
  scene: 'scene',
  prop: 'puzzle',
  style: 'palette',
  effect: 'wand',
}

const KIND_HINTS: Record<LibraryKind, string> = {
  character: '人物造型，跨画布保持同一个人',
  scene: '地点、光线与氛围',
  prop: '反复出现的关键物件',
  style: '整部片统一的画风参考',
  effect: '运镜、转场的参考视频或封面',
}

/**
 * 画布上的图片 / 视频「存入资产库」：先选存成哪类资产，
 * 再打开资产库里预填好的新建表单，名称、标签、槽位确认后再保存。
 */
interface LibraryAddProps {
  media: readonly CanvasMedia[]
  /** bar：浮动工具条按钮；inline：生成器第一行的安静按钮 */
  variant: 'bar' | 'inline'
}

export function LibraryAdd(props: LibraryAddProps) {
  const canvasId = useCanvas((s) => s.canvasId)
  return (
    <LibraryAddMenu key={JSON.stringify([canvasId, mediaSelectionKey(props.media)])} {...props} />
  )
}

function LibraryAddMenu({ media, variant }: LibraryAddProps) {
  const [opened, setOpened] = useState<{
    anchor: HTMLElement
    engine: Engine | null
    canvasId: string | null
  } | null>(null)
  if (!media.length) return null
  const images = media.filter((m) => m.kind === 'image').length
  const videos = media.length - images
  const pick = (kind: LibraryKind) => {
    const current = useCanvas.getState()
    const seed = current.engine && selectionSeed(current.engine, media)
    setOpened(null)
    if (
      !opened ||
      current.engine !== opened.engine ||
      current.canvasId !== opened.canvasId ||
      !seed
    ) {
      current.notify('素材已变化，请重新打开存入资产库')
      return
    }
    useLibrary.getState().show(kind, seed)
  }
  const btn = variant === 'inline' ? 'ui-btn ui-btn-sm ui-btn-quiet' : 'ui-bar-btn'
  return (
    <>
      <button
        type="button"
        className={`${btn} ui-btn-menu`}
        aria-expanded={!!opened}
        aria-label="存入资产库"
        title="存入资产库：存成角色、场景、道具、风格或特效，跨画布、跨项目复用"
        onClick={(e) => {
          const { engine, canvasId } = useCanvas.getState()
          setOpened(opened ? null : { anchor: e.currentTarget, engine, canvasId })
        }}
      >
        <Icon name="library" size={14} />
        {/* 生成器第一行已经很挤，只放图标 */}
        {variant === 'bar' && '存入资产库'}
        <Icon name="chevronDown" size={12} />
      </button>
      <Presence>
        {opened && (
          <Popover
            anchor={opened.anchor}
            onClose={() => setOpened(null)}
            label="存入资产库"
            width={260}
          >
            <div className="ui-menu-label">
              {media.length > 1
                ? `把 ${images ? `${images} 张图片` : ''}${images && videos ? '、' : ''}${
                    videos ? `${videos} 个视频` : ''
                  }存为`
                : '存为'}
            </div>
            {LIBRARY_KINDS.map((k) => {
              // 视频只有特效收；只选了视频时其他类别存不进东西
              const usable = images > 0 || !!k.video
              return (
                <button
                  key={k.id}
                  type="button"
                  className="ui-menu-item items-start"
                  disabled={!usable}
                  title={usable ? undefined : `${k.title}只收图片`}
                  onClick={() => pick(k.id)}
                >
                  <span className="mt-0.5">
                    <Icon name={KIND_ICONS[k.id]} size={14} />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span>{k.title}</span>
                    <span className="truncate text-xs text-ink-subtle">{KIND_HINTS[k.id]}</span>
                  </span>
                </button>
              )
            })}
          </Popover>
        )}
      </Presence>
    </>
  )
}
