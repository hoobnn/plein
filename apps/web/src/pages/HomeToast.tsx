import { AnimatePresence } from '../ui/motion'
import { Toast } from '../ui/Toast'

export function HomeToast({ notice }: { notice: string | null }) {
  return <AnimatePresence>{notice && <Toast>{notice}</Toast>}</AnimatePresence>
}
