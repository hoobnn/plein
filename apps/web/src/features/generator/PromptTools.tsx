import type { Engine } from '@plein/canvas-core'
import { setParam } from '@plein/doc'
import type { Catalog } from '@plein/protocol'
import { useEffect, useRef, useState } from 'react'
import { ApiError, api } from '../../api/client'
import { mentionTargets, type NodeInfo } from '../../canvas/nodes'
import { useCanvas } from '../../stores/canvas'
import { Icon } from '../../ui/icons'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Presence } from '../../ui/Presence'

type Mode = 'optimize' | 'translate'
const NO_CHAT = '没有可用的对话模型：在设置的「模型平台」里启用支持对话的平台'

/** 改写先成为草稿，用户明确采用时才修改画布。 */
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
  const [draft, setDraft] = useState<{
    base: string
    text: string
    model: string
    mode: Mode
    busy: boolean
    error?: string
  } | null>(null)
  const [detail, setDetail] = useState<'refine' | 'expand'>('refine')
  const controller = useRef<AbortController | null>(null)
  const hasChat = (catalog?.providers ?? []).some(
    (p) => p.enabled && p.configured && p.models.some((m) => m.capabilities.includes('text.chat')),
  )
  const target = node.capability === 'video.generate' ? 'video' : 'image'
  useEffect(() => {
    setDraft(null)
    return () => controller.current?.abort()
  }, [engine, elId])
  const close = () => {
    controller.current?.abort()
    controller.current = null
    setDraft(null)
  }
  const rewrite = async (mode: Mode) => {
    if (draft?.busy || !text.trim()) return
    if (!hasChat) return useCanvas.getState().notify(NO_CHAT)
    const abort = new AbortController()
    controller.current?.abort()
    controller.current = abort
    const generationModel = String(engine.doc.get(elId)?.params?.model ?? '')
    setDraft({ base: text, text: '', model: generationModel, mode, busy: true })
    try {
      const canvasId = useCanvas.getState().canvasId
      const input = canvasId ? await api.nodeInput(canvasId, elId).catch(() => null) : null
      if (abort.signal.aborted) return
      const res = await api.rewritePrompt(
        {
          text,
          mode,
          target,
          detail,
          ...(generationModel ? { generationModel } : {}),
          ...(input
            ? {
                inputContext: {
                  mode: String(input.params.mode ?? ''),
                  references: input.refs
                    .map(
                      (r) =>
                        `${r.name}：${r.sent.length ? '已送入参考图' : (r.reason ?? '文字参考')}`,
                    )
                    .slice(0, 64),
                },
              }
            : {}),
          mentions: [...new Set(mentionTargets(engine).map((t) => t.name))],
        },
        abort.signal,
      )
      if (abort.signal.aborted || useCanvas.getState().engine !== engine) return
      setDraft({ base: text, text: res.text, model: generationModel, mode, busy: false })
    } catch (err) {
      if (!abort.signal.aborted)
        setDraft((d) =>
          d
            ? {
                ...d,
                busy: false,
                error: err instanceof ApiError ? err.message : '改写失败，请重试',
              }
            : null,
        )
    }
  }
  const adopt = () => {
    if (!draft || draft.busy || !draft.text.trim()) return
    if (engine.doc.readOnly) {
      setDraft({ ...draft, error: '当前画布只读，建议已保留；恢复编辑权限后可重新采用。' })
      return
    }
    if (useCanvas.getState().engine !== engine) {
      setDraft({ ...draft, error: '画布已切换，建议未采用。请复制建议后在新画布重试。' })
      return
    }
    const current = engine.doc.get(elId)
    if (
      !current ||
      String(current.params?.[pk] ?? '') !== draft.base ||
      String(current.params?.model ?? '') !== draft.model
    ) {
      setDraft({ ...draft, error: '提示词或模型已变化，未覆盖当前内容。请复制建议或重新改写。' })
      return
    }
    engine.doc.undo.stopCapturing()
    setParam(engine.doc, elId, pk, draft.text)
    engine.doc.undo.stopCapturing()
    close()
  }
  return (
    <>
      <div className="flex items-center">
        {(node.capability === 'image.generate' || node.capability === 'video.generate') && (
          <button
            type="button"
            aria-label="优化提示词"
            title={hasChat ? '优化提示词：先查看建议再采用' : NO_CHAT}
            disabled={!hasChat || !text.trim()}
            className="ui-btn ui-btn-lg ui-btn-quiet ui-icon-btn"
            onClick={() => void rewrite('optimize')}
          >
            <Icon name="wand" />
          </button>
        )}
        <button
          type="button"
          aria-label="翻译提示词"
          title={hasChat ? '翻译提示词：先查看建议再采用' : NO_CHAT}
          disabled={!hasChat || !text.trim()}
          className="ui-btn ui-btn-lg ui-btn-quiet ui-icon-btn"
          onClick={() => void rewrite('translate')}
        >
          <Icon name="languages" />
        </button>
      </div>
      <Presence>
        {draft && (
          <Modal label="提示词建议" onClose={close} top isolateKeys className="max-w-5xl">
            <ModalHeader
              title={draft.mode === 'translate' ? '翻译建议' : '优化建议'}
              onClose={close}
            >
              {draft.mode === 'optimize' && (
                <select
                  aria-label="优化方式"
                  className="ui-input"
                  value={detail}
                  disabled={draft.busy}
                  onChange={(e) => setDetail(e.target.value as 'refine' | 'expand')}
                >
                  <option value="refine">保留原意精修</option>
                  <option value="expand">扩展细节</option>
                </select>
              )}
              {!draft.busy && (
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary"
                  onClick={() => void rewrite(draft.mode)}
                >
                  重新生成建议
                </button>
              )}
              <button
                type="button"
                className="ui-btn ui-btn-primary"
                disabled={draft.busy || !draft.text.trim()}
                onClick={adopt}
              >
                采用建议
              </button>
            </ModalHeader>
            <div className="grid min-h-80 gap-4 overflow-auto p-5 md:grid-cols-2">
              <label className="flex flex-col gap-2 text-sm">
                原提示词
                <textarea
                  aria-label="原提示词"
                  readOnly
                  value={draft.base}
                  className="ui-input min-h-64 flex-1 resize-y"
                />
              </label>
              <label className="flex flex-col gap-2 text-sm">
                {draft.busy ? '正在生成建议…' : '建议提示词（可编辑）'}
                <textarea
                  aria-label="建议提示词"
                  disabled={draft.busy}
                  value={draft.text}
                  onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                  className="ui-input min-h-64 flex-1 resize-y"
                />
              </label>
            </div>
            {draft.error && (
              <p role="alert" className="px-5 pb-3 text-sm text-danger">
                {draft.error}
              </p>
            )}
            <p className="border-t border-line px-5 py-3 text-xs text-ink-muted">
              关闭或取消不会修改原文。采用后可撤销。
            </p>
          </Modal>
        )}
      </Presence>
    </>
  )
}
