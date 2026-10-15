import { useEffect, useRef } from 'react'
import { Icon } from '../../ui/icons'
import { clock, type Playhead, usePlaying } from './playhead'

/**
 * 预览下方的播放条：左边时间码，中间回到开头 / 播放 / 跳到结尾，右边预览说明。
 * 时间码直接改 DOM，播放时不让 React 每帧重渲染。
 */
export function Transport({
  playhead,
  total,
  note,
}: {
  playhead: Playhead
  total: number
  /** 预览和成片的差别，收在说明图标的悬停提示里 */
  note: string
}) {
  const playing = usePlaying(playhead)
  return (
    <div className="seq-transport">
      <TimeReadout playhead={playhead} total={total} />
      <div className="seq-transport-controls">
        <button
          type="button"
          className="ui-btn ui-btn-quiet ui-icon-btn"
          aria-label="回到开头"
          title="回到开头（Home）"
          onClick={() => playhead.seek(0)}
        >
          <Icon name="skipBack" />
        </button>
        <button
          type="button"
          className="seq-play"
          aria-label={playing ? '暂停' : '播放'}
          title={playing ? '暂停（空格）' : '播放（空格）'}
          disabled={total <= 0}
          onClick={() => playhead.toggle()}
        >
          <Icon name={playing ? 'pause' : 'play'} size={14} />
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-quiet ui-icon-btn"
          aria-label="跳到结尾"
          title="跳到结尾（End）"
          onClick={() => playhead.seek(total)}
        >
          <Icon name="skipForward" />
        </button>
      </div>
      <span className="seq-transport-note" title={note} aria-label={note} role="note">
        <Icon name="info" size={14} />
        预览
      </span>
    </div>
  )
}

function TimeReadout({ playhead, total }: { playhead: Playhead; total: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const update = () => {
      if (ref.current) ref.current.textContent = clock(playhead.t)
    }
    update()
    return playhead.subscribe(update)
  }, [playhead])
  return (
    <span className="seq-time">
      <span ref={ref} />
      <span className="seq-time-total"> / {clock(total)}</span>
    </span>
  )
}
