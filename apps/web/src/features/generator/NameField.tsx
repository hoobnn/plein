import { useEffect, useId, useState } from 'react'

/**
 * 节点名：资产卡靠它被 @ 引用；失焦或回车时写入文档。
 *
 * 同伴在别处改了名字时，本机的草稿不能被覆盖：这时让用户明确选一个，
 * 而不是悄悄丢掉刚打的字。
 */
export function NameField({
  value,
  hint,
  trailing,
  onChange,
}: {
  value: string
  hint?: string
  trailing?: React.ReactNode
  onChange(v: string): boolean | void
}) {
  const [edit, setEdit] = useState({ base: value, draft: value })
  const conflictId = useId()
  useEffect(() => {
    setEdit((prev) =>
      prev.draft === prev.base || prev.draft === value ? { base: value, draft: value } : prev,
    )
  }, [value])
  const { draft, base } = edit
  const conflict = base !== value && draft.trim() !== value
  const reset = () => setEdit({ base: value, draft: value })
  const commit = () => {
    const v = draft.trim()
    if (v && v !== value) {
      // 画布变成只读时写入会被拒绝：草稿退回原样，不留在半提交状态
      if (onChange(v) === false) reset()
      else setEdit({ base: v, draft: v })
    } else reset()
  }
  return (
    <div className="plein-generator-name border-b border-line">
      <div className="flex items-center gap-2 px-4 py-3 pr-12">
        <input
          aria-label="节点名称"
          aria-describedby={conflict ? conflictId : undefined}
          value={draft}
          onChange={(e) => setEdit({ base, draft: e.target.value })}
          onBlur={() => {
            if (!conflict) commit()
          }}
          onKeyDown={(e) => {
            // 组字中不提交：回车与 Esc 都交给输入法
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
              e.stopPropagation()
              return
            }
            if (e.key === 'Escape' && draft !== value) {
              e.preventDefault()
              e.stopPropagation()
              reset()
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              if (conflict) commit()
              e.currentTarget.blur()
            }
          }}
          className="min-w-0 flex-1 rounded-sm bg-transparent text-base font-semibold text-ink outline-none"
        />
        {hint && (
          <span title={hint} className="max-w-1/2 truncate text-xs text-ink-subtle">
            {hint}
          </span>
        )}
        {trailing}
      </div>
      {conflict && (
        <div className="space-y-2 px-4 pb-3">
          <p id={conflictId} role="status" className="break-words text-xs text-ink-subtle">
            名称已在其他位置更新为「{value}」。请选择要使用的名称。
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="ui-btn ui-btn-secondary" onClick={reset}>
              使用更新后的名称
            </button>
            <button type="button" className="ui-btn ui-btn-secondary" onClick={commit}>
              保留当前输入
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
