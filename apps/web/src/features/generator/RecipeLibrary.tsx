import type { Engine } from '@plein/canvas-core'
import type { CanvasElement } from '@plein/doc'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { focusGenerator } from '../../canvas/presets'
import type { NodeInfo } from '../../canvas/nodes'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { Icon } from '../../ui/icons'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Presence } from '../../ui/Presence'
import {
  applyRecipe,
  recipeGuides,
  recipeSignature,
  searchRecipes,
  type RecipePreset,
} from './recipes'

export function RecipeLibrary({
  engine,
  el,
  node,
}: {
  engine: Engine
  el: CanvasElement
  node: NodeInfo
}) {
  const [opened, setOpened] = useState<{
    engine: Engine
    nodeId: string
    canvasId: string | null
    params: string
    type: string
    version: number
  } | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const openedRef = useRef(opened)
  openedRef.current = opened
  const active = useRef(true)
  const requestId = useRef(0)
  const pending = useRef<number | null>(null)
  const catalog = useCatalog((s) => s.catalog)
  const items = catalog ? searchRecipes(catalog.prompts, node, query, catalog.plugins) : []
  const available = catalog ? searchRecipes(catalog.prompts, node, '') : []
  const target = useRef({ engine, id: el.id, available: available.length > 0 })
  target.current = { engine, id: el.id, available: available.length > 0 }
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- 请求计数器不是 DOM 引用，卸载时要作废最新请求。
      requestId.current++
      pending.current = null
      openedRef.current = null
    }
  }, [])
  if (!available.length) return null
  const close = () => {
    requestId.current++
    pending.current = null
    openedRef.current = null
    setBusy(false)
    setOpened(null)
  }
  const adopt = async (preset: RecipePreset) => {
    const snapshot = openedRef.current
    if (!snapshot || pending.current !== null) return
    const request = ++requestId.current
    pending.current = request
    const current = () => {
      const state = useCanvas.getState()
      return (
        active.current &&
        openedRef.current === snapshot &&
        requestId.current === request &&
        target.current.available &&
        target.current.engine === snapshot.engine &&
        target.current.id === snapshot.nodeId &&
        state.engine === snapshot.engine &&
        state.canvasId === snapshot.canvasId
      )
    }
    setBusy(true)
    setError('')
    try {
      if (!current()) return
      const latest = await api.catalog()
      if (!current()) return
      const problem = applyRecipe(snapshot.engine, latest, snapshot.nodeId, preset, snapshot)
      if (problem) return setError(problem)
      close()
      focusGenerator(snapshot.engine, snapshot.nodeId)
    } catch (err) {
      if (current()) setError(`配方目录读取失败，未改写草稿：${(err as Error).message}`)
    } finally {
      if (pending.current === request) {
        pending.current = null
        if (active.current) setBusy(false)
      }
    }
  }
  return (
    <>
      <div>
        <button
          type="button"
          className="ui-btn ui-btn-quiet ui-btn-sm"
          onClick={() => {
            const current = engine.doc.get(el.id)
            if (!current || engine.doc.readOnly) return
            requestId.current++
            pending.current = null
            setBusy(false)
            setQuery('')
            setError('')
            const snapshot = {
              engine,
              nodeId: current.id,
              canvasId: useCanvas.getState().canvasId,
              params: recipeSignature(current.params),
              type: current.nodeType ?? '',
              version: current.nodeVersion ?? 1,
            }
            openedRef.current = snapshot
            setOpened(snapshot)
          }}
        >
          <Icon name="presets" size={14} />
          创作配方
        </button>
      </div>
      <Presence>
        {opened && (
          <Modal label="创作配方" onClose={close} isolateKeys className="max-w-4xl">
            <ModalHeader title="创作配方" onClose={close} />
            <div className="flex min-h-0 flex-col gap-3 px-5 pb-5">
              <p className="ui-help flex-none">
                先选做法，再编辑草稿。保留当前模型，不会自动生成。
              </p>
              <input
                aria-label="搜索创作配方"
                placeholder="搜索用途、名称或来源"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="ui-input flex-none"
              />
              {error && (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              )}
              {busy && (
                <p role="status" className="ui-help">
                  正在核对配方…
                </p>
              )}
              <div className="ui-scrollbar grid min-h-0 grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2">
                {items.map((preset) => {
                  const guide = recipeGuides[preset.id]
                  return (
                    <article
                      key={preset.id}
                      className="flex flex-col gap-3 rounded-xl border border-line p-4"
                    >
                      {guide && (
                        <div className="rounded-lg bg-surface-2 p-3">
                          <div
                            className={`grid ${guide.cells.length === 4 ? 'grid-cols-2' : 'grid-cols-3'} gap-1.5`}
                            aria-label={`${preset.title}结构示意`}
                          >
                            {guide.cells.map((cell) => (
                              <span
                                key={cell}
                                className="rounded-sm border border-line px-1 py-3 text-center text-xs text-ink-muted"
                              >
                                {cell}
                              </span>
                            ))}
                          </div>
                          <p className="mt-2 text-xs text-ink-subtle">结构示意 · 非生成效果</p>
                        </div>
                      )}
                      <div>
                        <h3 className="text-sm font-semibold">{preset.title}</h3>
                        {preset.description && <p className="mt-1 ui-help">{preset.description}</p>}
                      </div>
                      <p className="text-sm text-ink-muted">
                        {guide?.inputs ?? '按提示词填写内容，参考素材需自行添加。'}
                      </p>
                      <p className="ui-help">
                        {guide?.note ?? '先检查实际输入和模型能力，再手动生成并审片。'}
                      </p>
                      <p className="ui-help">
                        来源：
                        {catalog?.plugins.find((p) => p.id === preset.plugin)?.name ??
                          preset.plugin}{' '}
                        ·{' '}
                        {catalog?.plugins.find((p) => p.id === preset.plugin)?.version ??
                          '版本未知'}
                        <br />
                        生成效果待实测
                      </p>
                      <details className="text-xs text-ink-subtle">
                        <summary className="cursor-pointer">查看提示词与参数</summary>
                        <p className="mt-2 whitespace-pre-wrap break-words">{preset.template}</p>
                        {preset.params && (
                          <pre className="mt-2 whitespace-pre-wrap break-words">
                            {JSON.stringify(preset.params, null, 2)}
                          </pre>
                        )}
                      </details>
                      <button
                        type="button"
                        className="ui-btn ui-btn-secondary mt-auto self-start"
                        disabled={busy}
                        onClick={() => void adopt(preset)}
                      >
                        套用「{preset.title}」到草稿
                      </button>
                    </article>
                  )
                })}
                {!items.length && <p className="ui-help">没有匹配的配方，试试其他关键词。</p>}
              </div>
            </div>
          </Modal>
        )}
      </Presence>
    </>
  )
}
