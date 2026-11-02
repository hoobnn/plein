import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useClosing } from '../../../ui/Presence'
import { Slider } from '../../../ui/Slider'
import { Field } from './SettingsFields'

/** 音量：0–200%，松手时写入；滑轨左段按音量填色 */
export function Volume(props: {
  label: string
  /** 无障碍名称，默认同 label */
  aria?: string
  value: number
  onChange(v: number): void
}) {
  const [draft, setDraft] = useState<number | null>(null)
  const pending = useRef<number | null>(null)
  const pointer = useRef<number | null>(null)
  const cancelled = useRef<number | null>(null)
  const change = useRef(props.onChange)
  change.current = props.onChange
  const closing = useClosing()
  const finish = useCallback((save: boolean) => {
    const value = pending.current
    if (!save && pointer.current !== null) cancelled.current = pointer.current
    pointer.current = null
    pending.current = null
    setDraft(null)
    if (save && value !== null) change.current(value)
  }, [])
  // 外部值更新、面板退场或卸载时，都不能把旧草稿留到下一次松手。
  useLayoutEffect(() => {
    finish(false)
    return () => finish(false)
  }, [props.value, closing, finish])
  useEffect(() => {
    const up = (e: PointerEvent) => {
      if (cancelled.current === e.pointerId) cancelled.current = null
      else if (pointer.current === e.pointerId) finish(true)
    }
    const cancel = (e: PointerEvent) => {
      if (pointer.current === e.pointerId) finish(false)
    }
    const blur = () => finish(false)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', blur)
    }
  }, [finish])
  const v = draft ?? props.value
  return (
    <Field label={props.label}>
      <span className="seq-volume">
        <Slider
          aria-label={props.aria ?? props.label}
          min={0}
          max={2}
          step={0.05}
          className="seq-range"
          value={v}
          onPointerDown={(e) => {
            if (e.button !== 0 || closing) return
            cancelled.current = null
            pointer.current = e.pointerId
          }}
          onValueChange={(value) => {
            if (cancelled.current !== null || closing) return
            pending.current = value
            setDraft(value)
          }}
          onKeyDown={() => {
            cancelled.current = null
          }}
          onKeyUp={() => {
            if (pointer.current === null) finish(true)
          }}
          onBlur={() => {
            finish(pointer.current === null)
          }}
        />
        <span className="seq-volume-value">{Math.round(v * 100)}%</span>
      </span>
    </Field>
  )
}
