import { profileId, type ProfileLook } from '@plein/nodes'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLibraryFieldFocus } from './LibraryFields'
import type { HeroControl } from './profile.types'

/** 按条目身份保留悬停，名称和图片始终从当前草稿读取；删除后自动撤下预览。 */
export function useProfileHover(
  items: Array<{ id: string; assetId?: string; caption: string }>,
  hero: HeroControl,
) {
  const [id, setId] = useState<string | null>(null)
  const current = items.find((item) => item.id === id)
  useEffect(() => {
    if (id !== null) hero.onPreview(current?.assetId ?? null, current?.caption)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- 依赖当前条目的身份与显示数据，避免新回调触发循环
  }, [id, current?.id, current?.assetId, current?.caption])
  return {
    enter: (id: string) => {
      setId(id)
      const item = items.find((item) => item.id === id)
      hero.onPreview(item?.assetId ?? null, item?.caption)
    },
    leave: () => {
      setId(null)
      hero.onPreview(null)
    },
  }
}

export const emptyLook = (name: string): ProfileLook => ({
  id: profileId(),
  name,
  aliases: [],
  description: '',
  images: [],
})

/** 先停在不会被增删替换的区域，提交后仅在焦点仍归本区域时交接到新控件。 */
export function useProfileFocus() {
  const focus = useLibraryFieldFocus()
  const pending = useRef<string | null>(null)
  useLayoutEffect(() => {
    const selector = pending.current
    pending.current = null
    if (!selector || document.activeElement !== focus.props.ref.current) return
    const target = focus.props.ref.current?.querySelector<HTMLElement>(selector)
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
  return {
    ...focus,
    to(selector: string) {
      focus.park()
      pending.current = selector
    },
  }
}

export const profileControl = (kind: 'period' | 'look' | 'state', id: string) =>
  `[data-profile-${kind}="${CSS.escape(id)}"]`
