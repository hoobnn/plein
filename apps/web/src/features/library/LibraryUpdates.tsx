import type { LibraryCardUpdate, LibraryItem, LibrarySyncField } from '@plein/protocol'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import {
  emptyUpdatesRead,
  pendingUpdatesRead,
  readLibraryUpdates,
  updatesReadReady,
  defaultUpdatesSelection,
  libraryCardKey as key,
} from './updatesRead'

const labels: Record<LibrarySyncField, string> = {
  name: '名称',
  description: '设定',
  voice: '音色',
  profile: '角色档案',
  references: '参考素材',
}
const display = (value: unknown) =>
  typeof value === 'string' ? value || '空' : JSON.stringify(value, null, 2)

export function LibraryUpdatesPanel({ item }: { item: LibraryItem }) {
  const [read, setRead] = useState(emptyUpdatesRead)
  const { data, error } = read
  const source = JSON.stringify(item)
  const ready = updatesReadReady(read, source)
  const lifetime = useRef({ active: true })
  const mutation = useRef(false)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    const session = { active: true }
    lifetime.current = session
    return () => {
      session.active = false
    }
  }, [item.id])
  const [selection, setSelection] = useState<Record<string, LibrarySyncField[]>>({})
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const errorRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (open && error) errorRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open, error])
  useEffect(() => {
    if (!open) return
    return readLibraryUpdates(item.id, source, setRead, (result) => {
      setSelection(defaultUpdatesSelection(result))
    })
  }, [item.id, source, refresh, open])
  const refreshDiff = () => {
    setRead(pendingUpdatesRead)
    setRefresh((value) => value + 1)
  }
  const apply = async (mode: 'update' | 'keep' | 'unpin', only?: LibraryCardUpdate) => {
    if (!data || !ready || mutation.current) return
    const cards = only ? [only] : data.cards.filter((card) => selection[key(card)]?.length)
    if (!cards.length) return
    const session = lifetime.current
    mutation.current = true
    setBusy(true)
    setNotice('')
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
      if (!session.active) return
      refreshDiff()
      setNotice(
        result.persistence === 'pending'
          ? '修改已应用，保存暂未完成，服务端正在重试'
          : mode === 'update'
            ? '选中的卡片已同步，请查看下游影响'
            : mode === 'keep'
              ? '已固定当前卡片版本'
              : '已解除版本固定',
      )
    } catch (err) {
      if (session.active) setRead((state) => ({ ...state, error: (err as Error).message }))
    } finally {
      mutation.current = false
      if (session.active) setBusy(false)
    }
  }
  return (
    <section className="rounded-xl border border-line p-3" aria-label="跨画布资产更新">
      <button
        type="button"
        className="ui-btn ui-btn-secondary"
        onClick={() => {
          if (!open) setRead(pendingUpdatesRead)
          setOpen((value) => !value)
        }}
        aria-expanded={open}
      >
        查看画布中的版本
      </button>
      {notice && (
        <p role="status" className="mt-2 text-xs text-ink-muted">
          {notice}
        </p>
      )}
      {open && (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-xs text-ink-subtle">
            保存设定后，在这里选择要同步的画布与字段。固定的卡片保留当前设定和参考素材。
          </p>
          <button
            type="button"
            className="ui-btn ui-btn-sm"
            disabled={busy || read.loading}
            onClick={() => {
              setNotice('')
              refreshDiff()
            }}
          >
            刷新差异
          </button>
          {!ready && !error && (
            <p role="status" className="text-xs text-ink-subtle">
              正在读取差异…
            </p>
          )}
          {ready && data?.cards.length === 0 && (
            <p className="text-sm text-ink-muted">还没有画布使用这条资产。</p>
          )}
          <fieldset disabled={busy || !ready} className="contents">
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
          </fieldset>
          {error && (
            <p ref={errorRef} role="alert" className="text-sm text-danger">
              {error}。请刷新差异后重试。
            </p>
          )}
        </div>
      )}
    </section>
  )
}
