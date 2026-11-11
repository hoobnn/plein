import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useCatalog } from '../../stores/catalog'
import { AnimatePresence } from '../../ui/motion'
import { useWelcomeReopen } from './reopen'
import { WelcomeDialog } from './WelcomeDialog'

/** 手动重开的新手引导：读取目录后展示，关闭只收起，不影响首次引导的记录 */
export function WelcomeReopenHost() {
  const { open, dismiss } = useWelcomeReopen(
    useShallow((s) => ({ open: s.open, dismiss: s.dismiss })),
  )
  const { catalog, load } = useCatalog(useShallow((s) => ({ catalog: s.catalog, load: s.load })))
  useEffect(() => {
    if (open) void load()
  }, [open, load])
  return <AnimatePresence>{open && catalog && <WelcomeDialog onClose={dismiss} />}</AnimatePresence>
}
