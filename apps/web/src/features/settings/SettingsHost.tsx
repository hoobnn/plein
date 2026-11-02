import { AnimatePresence } from '../../ui/motion'
import { SettingsDialog, type Section } from './Settings'

export function SettingsHost({
  open,
  initial,
  onClose,
}: {
  open: boolean
  initial?: Section
  onClose(): void
}) {
  return (
    <AnimatePresence>
      {open && <SettingsDialog initial={initial} onClose={onClose} />}
    </AnimatePresence>
  )
}
