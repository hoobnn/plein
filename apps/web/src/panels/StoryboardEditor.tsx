import type { Engine } from '@plein/canvas-core'
import { setParam } from '@plein/doc'
import { newShotId, SHOT_SIZES, type Shot } from '@plein/nodes'
import { useEffect, useState } from 'react'
import { expandedNodes, expandShots, runExpanded, shotsOf } from '../canvas/storyboard'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'

/** 文档变化时重渲染（协作者改表格也能看到） */
function useDocVersion(engine: Engine) {
  const [v, setV] = useState(0)
  useEffect(() => engine.onViewChange(() => setV((x) => x + 1)), [engine])
  return v
}

const cell =
  'w-full resize-none rounded-md bg-transparent px-2 py-1.5 text-sm leading-snug text-ink outline-none ring-1 ring-transparent hover:ring-line focus:bg-surface-2 focus:ring-accent/50'

/** 台词在表格里写成“角色：台词”一行一句 */
const dialogueText = (s: Shot) =>
  s.dialogue.map((d) => (d.character ? `${d.character}：${d.line}` : d.line)).join('\n')
const parseDialogue = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^([^：:]{1,12})[：:](.*)$/.exec(l)
      return m ? { character: m[1]!.trim(), line: m[2]!.trim() } : { character: '', line: l }
    })
const splitNames = (text: string) =>
  text
    .split(/[、,，\s]+/)
    .map((s) => s.replace(/^@/, '').trim())
    .filter(Boolean)

/** 分镜表格编辑器：全屏浮层，改单元格即写入文档并标记为手改 */
export function StoryboardEditor() {
  const engine = useCanvas((s) => s.engine)
  const id = useCanvas((s) => s.storyboard)
  const close = () => useCanvas.getState().openStoryboard(null)
  if (!engine || !id || !engine.doc.get(id)) return null
  return <Editor engine={engine} id={id} onClose={close} />
}

function Editor({ engine, id, onClose }: { engine: Engine; id: string; onClose(): void }) {
  useDocVersion(engine)
  const catalog = useCatalog((s) => s.catalog)
  const notify = useCanvas((s) => s.notify)
  const el = engine.doc.get(id)
  const shots = shotsOf(el)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const expanded = expandedNodes(engine, id)
  const targets = picked.size ? shots.filter((s) => picked.has(s.id)) : shots
  const targetIds = targets.map((s) => s.id)

  useEffect(() => {
    // 捕获阶段拦下按键：表格打开时画布的快捷键（删除、方向键等）不生效
    const key = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])

  const write = (next: Shot[]) => setParam(engine.doc, id, 'shots', next)
  const patch = (shotId: string, p: Partial<Shot>) =>
    write(shots.map((s) => (s.id === shotId ? { ...s, ...p, edited: true } : s)))
  const addShot = () => {
    const no = (shots.at(-1)?.no ?? 0) + 1
    write([
      ...shots,
      {
        id: newShotId(),
        no,
        duration: 5,
        shotSize: '中景',
        description: '',
        characters: [],
        emotion: '',
        lighting: '',
        sfx: '',
        dialogue: [],
        imagePrompt: '',
        motionPrompt: '',
        edited: true,
      },
    ])
  }
  const remove = (shotId: string) => write(shots.filter((s) => s.id !== shotId))
  const scope = picked.size ? `选中的 ${picked.size} 个镜头` : '全部镜头'

  const expand = () => {
    const frames = expandShots(engine, id, targetIds, catalog)
    const already = targets.filter((s) => expanded.has(s.id)).length
    notify(
      frames.length
        ? `已展开 ${frames.length} 个镜头${already ? `，${already} 个之前展开过，已跳过` : ''}`
        : '这些镜头都已展开过',
    )
    if (frames.length) {
      onClose()
      engine.zoomToFit([id, ...frames])
    }
  }
  const batch = (role: 'image' | 'video') => {
    const { started, skipped } = runExpanded(engine, id, targetIds, role)
    const label = role === 'image' ? '分镜图' : '视频'
    if (!started && !skipped) notify('先把镜头展开成节点，再批量生成')
    else
      notify(
        `已开始生成 ${started} 个${label}${skipped ? `；${skipped} 个镜头还没有分镜图，已跳过` : ''}`,
      )
  }

  const btn =
    'h-8 rounded-lg px-3 text-sm text-ink hover:bg-white/8 disabled:cursor-not-allowed disabled:opacity-40'
  return (
    <div
      className="pointer-events-auto fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-6"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <section
        role="dialog"
        aria-label="分镜表"
        className="flex max-h-full w-full max-w-[1400px] flex-col overflow-hidden rounded-2xl bg-surface shadow-[var(--shadow-3)]"
      >
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="mr-2 text-base font-medium">{el?.name ?? '分镜'}</h2>
          <span className="text-sm text-ink-muted">
            {shots.length} 个镜头 · {shots.reduce((t, s) => t + s.duration, 0)} 秒
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1">
            <span className="mr-1 text-xs text-ink-muted">作用于{scope}</span>
            <button type="button" className={btn} onClick={addShot}>
              添加镜头
            </button>
            <button type="button" className={btn} disabled={!shots.length} onClick={expand}>
              展开为节点
            </button>
            <button
              type="button"
              className={btn}
              disabled={!expanded.size}
              onClick={() => batch('image')}
            >
              批量出分镜图
            </button>
            <button
              type="button"
              className={btn}
              disabled={!expanded.size}
              onClick={() => batch('video')}
            >
              批量生成视频
            </button>
            <button
              type="button"
              aria-label="关闭"
              className="ml-1 flex size-8 items-center justify-center rounded-lg text-ink-muted hover:bg-white/8 hover:text-ink"
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </header>
        {shots.length === 0 ? (
          <p className="px-6 py-16 text-center text-sm text-ink-muted">
            还没有镜头。把剧本连到分镜节点后点“生成”，或手动添加镜头。
          </p>
        ) : (
          <div className="overflow-auto">
            <table className="w-full min-w-[1200px] border-collapse text-left text-sm">
              <thead className="sticky top-0 z-10 bg-surface text-xs text-ink-muted">
                <tr>
                  <th className="w-10 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label="全选"
                      checked={picked.size > 0 && picked.size === shots.length}
                      onChange={(e) =>
                        setPicked(new Set(e.target.checked ? shots.map((s) => s.id) : []))
                      }
                    />
                  </th>
                  <th className="w-12 px-2 py-2 font-normal">镜号</th>
                  <th className="w-16 px-2 py-2 font-normal">时长</th>
                  <th className="w-20 px-2 py-2 font-normal">景别</th>
                  <th className="px-2 py-2 font-normal">画面</th>
                  <th className="w-32 px-2 py-2 font-normal">出场</th>
                  <th className="w-56 px-2 py-2 font-normal">台词（角色：台词）</th>
                  <th className="px-2 py-2 font-normal">分镜图提示词</th>
                  <th className="w-48 px-2 py-2 font-normal">运动提示词</th>
                  <th className="w-20 px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {shots.map((s) => (
                  <tr key={s.id} className="border-t border-line align-top">
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        aria-label={`选择镜头 ${s.no}`}
                        checked={picked.has(s.id)}
                        onChange={(e) => {
                          const next = new Set(picked)
                          if (e.target.checked) next.add(s.id)
                          else next.delete(s.id)
                          setPicked(next)
                        }}
                      />
                    </td>
                    <td className="px-2 py-2.5 tabular-nums text-ink-muted">
                      {String(s.no).padStart(2, '0')}
                    </td>
                    <td className="px-1 py-1">
                      <input
                        type="number"
                        min={1}
                        max={30}
                        aria-label="时长"
                        className={cell}
                        value={s.duration}
                        onChange={(e) => patch(s.id, { duration: Number(e.target.value) || 1 })}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <select
                        aria-label="景别"
                        className={cell}
                        value={s.shotSize}
                        onChange={(e) =>
                          patch(s.id, { shotSize: e.target.value as Shot['shotSize'] })
                        }
                      >
                        {SHOT_SIZES.map((o) => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                    </td>
                    <TextCell
                      value={s.description}
                      label="画面"
                      onChange={(v) => patch(s.id, { description: v })}
                    />
                    <TextCell
                      value={s.characters.join('、')}
                      label="出场"
                      onChange={(v) => patch(s.id, { characters: splitNames(v) })}
                    />
                    <TextCell
                      value={dialogueText(s)}
                      label="台词"
                      onChange={(v) => patch(s.id, { dialogue: parseDialogue(v) })}
                    />
                    <TextCell
                      value={s.imagePrompt}
                      label="分镜图提示词"
                      onChange={(v) => patch(s.id, { imagePrompt: v })}
                    />
                    <TextCell
                      value={s.motionPrompt}
                      label="运动提示词"
                      onChange={(v) => patch(s.id, { motionPrompt: v })}
                    />
                    <td className="px-2 py-2.5 text-right text-xs">
                      {expanded.has(s.id) ? (
                        <span className="text-ink-muted">已展开</span>
                      ) : (
                        <button
                          type="button"
                          className="text-ink-muted hover:text-[#ff8a8a]"
                          onClick={() => remove(s.id)}
                        >
                          删除
                        </button>
                      )}
                      {s.edited && <div className="mt-1 text-ink-muted/70">手改</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

/** 单元格：失焦时写入，避免每个按键都改一次文档并标记手改 */
function TextCell({
  value,
  label,
  onChange,
}: {
  value: string
  label: string
  onChange(v: string): void
}) {
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setDraft(value)
  }, [value, focused])
  return (
    <td className="px-1 py-1">
      <textarea
        aria-label={label}
        rows={2}
        className={`${cell} field-sizing-content min-h-9`}
        value={focused ? draft : value}
        onFocus={() => {
          setDraft(value)
          setFocused(true)
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setFocused(false)
          if (draft !== value) onChange(draft)
        }}
      />
    </td>
  )
}
