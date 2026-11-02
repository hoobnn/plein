import type { DesktopSaved } from '@plein/protocol'
import { AnimatePresence } from '../ui/motion'
import { Toast } from '../ui/Toast'

export function DesktopSavedToast({
  saved,
  showLabel,
  onShow,
  onClose,
}: {
  saved: DesktopSaved | null
  showLabel: string
  onShow(path: string): void
  onClose(): void
}) {
  const path = saved?.savePath
  return (
    <AnimatePresence>
      {saved ? (
        <Toast
          action={
            path && (
              <button
                type="button"
                className="ui-btn ui-btn-quiet ui-btn-sm"
                onClick={() => {
                  onShow(path)
                  onClose()
                }}
              >
                {showLabel}
              </button>
            )
          }
        >
          {saved.state === 'completed' ? `已保存「${saved.name}」` : `「${saved.name}」保存失败`}
        </Toast>
      ) : null}
    </AnimatePresence>
  )
}
