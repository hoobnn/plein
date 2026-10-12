import type { Engine } from '@plein/canvas-core'
import { setParam } from '@plein/doc'
import type { Catalog } from '@plein/protocol'
import { useState } from 'react'
import { ApiError, api } from '../../api/client'
import { mentionTargets, type NodeInfo } from '../../canvas/nodes'
import { useCanvas } from '../../stores/canvas'
import { Icon } from '../../ui/icons'

type Mode = 'optimize' | 'translate'

const NO_CHAT = '没有可用的对话模型：在设置的「模型平台」里启用支持对话的平台'

/**
 * 发送按钮左侧的“优化提示词”“翻译提示词”：用已启用的对话模型改写，
 * 结果整段写回提示词，算一个撤销步；`@引用` 和【占位】由服务端原样保留。
 */
export function PromptTools({
  engine,
  elId,
  promptKey: pk,
  text,
  node,
  catalog,
}: {
  engine: Engine
  elId: string
  promptKey: string
  text: string
  node: NodeInfo
  catalog: Catalog | null
}) {
  const [busy, setBusy] = useState<Mode | null>(null)
  const hasChat = (catalog?.providers ?? []).some(
    (p) => p.enabled && p.configured && p.models.some((m) => m.capabilities.includes('text.chat')),
  )
  const target =
    node.capability === 'video.generate'
      ? 'video'
      : node.capability === 'image.generate'
        ? 'image'
        : null
  const empty = !text.trim()

  const rewrite = async (mode: Mode) => {
    const { notify } = useCanvas.getState()
    if (busy) return
    if (!hasChat) return notify(NO_CHAT)
    if (empty) return notify('先写提示词')
    setBusy(mode)
    try {
      const res = await api.rewritePrompt({
        text,
        mode,
        target: target ?? 'image',
        mentions: [...mentionTargets(engine).keys()],
      })
      // 等待期间提示词被改过（自己或协作者）就不覆盖
      if (String(engine.doc.get(elId)?.params?.[pk] ?? '') !== text)
        return notify('提示词已经改动，没有写回改写结果')
      engine.doc.undo.stopCapturing()
      setParam(engine.doc, elId, pk, res.text)
      engine.doc.undo.stopCapturing()
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '改写失败，请重试')
    } finally {
      setBusy(null)
    }
  }

  const button = (mode: Mode, label: string, icon: 'wand' | 'languages') => {
    const disabled = !hasChat || empty || (busy !== null && busy !== mode)
    const hint = !hasChat
      ? NO_CHAT
      : empty
        ? `先写提示词再${label}`
        : busy === mode
          ? `正在${label}…`
          : label
    return (
      <button
        type="button"
        aria-label={label}
        aria-disabled={disabled || undefined}
        aria-busy={busy === mode || undefined}
        title={hint}
        onClick={() => void rewrite(mode)}
        className="ui-btn ui-btn-lg ui-btn-quiet ui-icon-btn aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-ink-muted"
      >
        {busy === mode ? <span className="ui-spinner size-4" /> : <Icon name={icon} />}
      </button>
    )
  }

  return (
    <div className="flex items-center">
      {target && button('optimize', '优化提示词', 'wand')}
      {button('translate', '翻译提示词', 'languages')}
    </div>
  )
}
