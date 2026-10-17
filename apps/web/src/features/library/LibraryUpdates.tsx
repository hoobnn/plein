import type {
  LibraryCardUpdate,
  LibraryItem,
  LibrarySyncField,
  LibraryUpdates,
} from '@plein/protocol'
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { useCanvas } from '../../stores/canvas'

const labels: Record<LibrarySyncField, string> = {
  name: '名称',
  description: '设定',
  voice: '音色',
  profile: '角色档案',
  references: '参考素材',
}
const key = (card: LibraryCardUpdate) => `${card.canvasId}:${card.nodeId}`
const display = (value: unknown) =>
  typeof value === 'string' ? value || '空' : JSON.stringify(value, null, 2)

export function LibraryUpdatesPanel({ item }: { item: LibraryItem }) {
  const [data, setData] = useState<LibraryUpdates | null>(null)
  const [selection, setSelection] = useState<Record<string, LibrarySyncField[]>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    if (!open) return
    let active = true
    setError('')
    api.libraryUpdates(item.id).then(
      (result) => {
        if (!active) return
        setData(result)
        setSelection(
          Object.fromEntries(
            result.cards.map((card) => [
              key(card),
              card.pinned ? [] : card.changes.map((c) => c.field),
            ]),
          ),
        )
      },
      (err) => {
        if (active) setError((err as Error).message)
      },
    )
    return () => {
      active = false
    }
  }, [item.id, item.updatedAt, refresh, open])
  const apply = async (mode: 'update' | 'keep' | 'unpin', only?: LibraryCardUpdate) => {
    if (!data || busy) return
    const cards = only ? [only] : data.cards.filter((card) => selection[key(card)]?.length)
    if (!cards.length) return
    setBusy(true)
    setError('')
    try {
      const result = await api.applyLibraryUpdates(item.id, {
        revision: data.revision,
        targets: cards.map((card) => ({
          canvasId: card.canvasId,
          nodeId: card.nodeId,
          expected: card.expected,
          mode,
          ...(mode === 'update' ? { fields: selection[key(card)] } : {}),
        })),
      })
      setRefresh((n) => n + 1)
      useCanvas
        .getState()
        .notify(
          result.persistence === 'pending'
            ? '修改已应用，保存暂未完成，服务端正在重试'
            : mode === 'update'
              ? '选中的卡片已同步，请查看下游影响'
              : mode === 'keep'
                ? '已固定当前卡片版本'
                : '已解除版本固定',
        )
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="rounded-xl border border-line p-3" aria-label="跨画布资产更新">
      <button
        type="button"
        className="ui-btn ui-btn-secondary"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        查看画布中的版本
      </button>
      {open && (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-xs text-ink-subtle">
            保存设定后，在这里选择要同步的画布与字段。固定的卡片保留当前设定和参考素材。
          </p>
          <button
            type="button"
            className="ui-btn ui-btn-sm"
            disabled={busy}
            onClick={() => setRefresh((n) => n + 1)}
          >
            刷新差异
          </button>
          {data?.cards.length === 0 && (
            <p className="text-sm text-ink-muted">还没有画布使用这条资产。</p>
          )}
          {data?.cards.map((card) => (
            <div key={key(card)} className="rounded-lg border border-line p-3">
              <p className="text-sm font-medium">
                {card.canvasTitle} · {card.name}
                {card.pinned ? ' · 已固定' : ''}
              </p>
              {!card.changes.length && <p className="text-xs text-ink-subtle">与资产库一致</p>}
              {card.changes.map((change) => (
                <details key={change.field} className="mt-2">
                  <summary className="text-sm">
                    <label>
                      <input
                        type="checkbox"
                        disabled={busy || card.pinned}
                        checked={selection[key(card)]?.includes(change.field) ?? false}
                        onChange={(e) =>
                          setSelection((prev) => ({
                            ...prev,
                            [key(card)]: e.target.checked
                              ? [...(prev[key(card)] ?? []), change.field]
                              : (prev[key(card)] ?? []).filter((f) => f !== change.field),
                          }))
                        }
                      />{' '}
                      {labels[change.field]}
                    </label>{' '}
                    · 查看差异
                  </summary>
                  <div className="grid gap-2 text-xs md:grid-cols-2">
                    <div>
                      <b>画布当前</b>
                      <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all">
                        {display(change.before)}
                      </pre>
                    </div>
                    <div>
                      <b>资产库新版</b>
                      <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all">
                        {display(change.after)}
                      </pre>
                    </div>
                  </div>
                </details>
              ))}
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-quiet mt-2"
                disabled={busy}
                onClick={() => void apply(card.pinned ? 'unpin' : 'keep', card)}
              >
                {card.pinned ? '解除固定' : '固定当前版本'}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            disabled={busy || !Object.values(selection).some((value) => value.length)}
            onClick={() => void apply('update')}
          >
            {busy ? '同步中…' : '同步选中的字段'}
          </button>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
