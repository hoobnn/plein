import type { ProviderInfo } from '@plein/protocol'
import { lazy, Suspense, useEffect, useState } from 'react'
import { useCatalog } from '../../stores/catalog'
import { LoadingPanel } from '../../ui/LoadingPanel'
import { Presence } from '../../ui/Presence'

const WelcomeDialog = lazy(() =>
  import('./WelcomeDialog').then((m) => ({ default: m.WelcomeDialog })),
)
const DONE_KEY = 'plein.welcome'

function welcomed() {
  try {
    return localStorage.getItem(DONE_KEY) === '1'
  } catch {
    return true
  }
}

function markWelcomed() {
  try {
    localStorage.setItem(DONE_KEY, '1')
  } catch {}
}

const usable = (p: ProviderInfo) => p.enabled && p.configured

/** 已完成引导的首页不读取平台目录；首次引导只在确认需要时加载配置表单。 */
export function Welcome() {
  const [eligible, setEligible] = useState(() => !welcomed())
  const { catalog, error, load } = useCatalog()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (eligible) void load()
  }, [eligible, load])
  // 目录没读到时引导开不了；重试到读出来为止，别让首次启动引导悄悄消失。
  useEffect(() => {
    if (!eligible || !error || catalog) return
    const timer = setTimeout(() => void load(), 1000)
    return () => clearTimeout(timer)
  }, [eligible, catalog, error, load])
  useEffect(() => {
    // 只在打开首页时判断：引导里填好密钥后不会突然消失。
    if (eligible && catalog && !catalog.providers.some(usable)) setOpen(true)
  }, [eligible, catalog])
  const close = () => {
    markWelcomed()
    setEligible(false)
    setOpen(false)
  }
  return (
    <Suspense fallback={open ? <LoadingPanel label="正在打开首次使用引导…" /> : null}>
      <Presence>{open && catalog && <WelcomeDialog onClose={close} />}</Presence>
    </Suspense>
  )
}
