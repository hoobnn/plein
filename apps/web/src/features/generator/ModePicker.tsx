import { VIDEO_MODE_LABELS, VIDEO_MODES, type VideoMode } from '@plein/nodes'
import { useState } from 'react'
import { Icon, type IconName } from '../../ui/icons'
import { Popover } from '../../ui/Popover'
import { Presence } from '../../ui/Presence'

const MODES: Record<VideoMode, { icon: IconName; hint: string }> = {
  text: { icon: 'text', hint: '只用提示词，不使用连入的图片' },
  image: { icon: 'imageToVideo', hint: '连入 1 张图作首帧' },
  frames: { icon: 'frames', hint: '连入 2 张图，上面的作首帧、下面的作尾帧' },
  reference: { icon: 'references', hint: '使用连入的图片、视频与音频，按所选模型能力校验' },
}

/** 视频生成模式：由用户指定，连入的图片按模式使用 */
export function ModePicker({
  value,
  images,
  videos = 0,
  audios = 0,
  onChange,
}: {
  value: VideoMode
  /** 已连入的图片数，用来提示每种模式还差什么 */
  images: number
  videos?: number
  audios?: number
  onChange(v: VideoMode): void
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const current = MODES[value] ?? MODES.text
  return (
    <>
      <button
        type="button"
        aria-label="生成模式"
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        className="ui-btn ui-btn-lg ui-btn-menu flex-none"
      >
        <Icon name={current.icon} />
        <span>{VIDEO_MODE_LABELS[value] ?? VIDEO_MODE_LABELS.text}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      <Presence>
        {anchor && (
          <Popover anchor={anchor} onClose={() => setAnchor(null)} label="视频生成模式" width={280}>
            <p className="ui-section-title px-2 pt-1 pb-2">视频生成模式</p>
            <div role="listbox" aria-label="视频生成模式" className="flex flex-col gap-0.5">
              {VIDEO_MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="option"
                  aria-selected={m === value}
                  onClick={() => {
                    onChange(m)
                    setAnchor(null)
                  }}
                  className="ui-menu-item items-start"
                >
                  <Icon name={MODES[m].icon} />
                  <span className="ui-menu-text">
                    <span className="truncate">{VIDEO_MODE_LABELS[m]}</span>
                    <span className="ui-menu-desc">
                      {MODES[m].hint}
                      {m === 'reference'
                        ? `（${images} 张图、${videos} 段视频、${audios} 段音频）`
                        : m !== 'text' && `（已连 ${images} 张）`}
                    </span>
                  </span>
                  {m === value && <Icon name="check" size={14} />}
                </button>
              ))}
            </div>
          </Popover>
        )}
      </Presence>
    </>
  )
}
