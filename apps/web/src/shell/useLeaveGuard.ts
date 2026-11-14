import { useEffect } from 'react'
import { setLeaveGuard } from '../router'
import { confirmDialog, dialogOpen } from '../ui/Dialog'

/**
 * 画布还有本机独有的改动（服务端和本机缓存都没确认）时的离开保护：
 * 换画布、回首页、浏览器后退先问一次；刷新或关闭页面交给浏览器的 beforeunload。
 * 没有未保存改动时完全不拦，正常已保存的导航照旧。
 */
export function useLeaveGuard(active: boolean, canvasTitle?: string) {
  useEffect(() => {
    if (!active) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    setLeaveGuard({
      blocks: () => active,
      confirm: async () => {
        // 已有对话框开着（如改名）：先让用户处理它，不叠第二个
        if (dialogOpen()) return false
        return confirmDialog({
          title: '还有改动没有保存',
          message: `「${canvasTitle ?? '这张画布'}」的改动还没有确认保存到服务端或本机缓存。现在离开会丢失这些改动。`,
          confirmLabel: '丢弃改动并离开',
          cancelLabel: '留在编辑',
          danger: true,
        })
      },
    })
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      setLeaveGuard(null)
    }
  }, [active, canvasTitle])
}
