import { useEffect } from 'react'
import { isEditableTarget } from '@plein/canvas-core'
import { desktop } from '../desktop'
import { useCanvas } from '../stores/canvas'
import { Icon } from '../ui/icons'

const mac = desktop ? desktop.platform === 'darwin' : /Mac/i.test(navigator.platform)
const MOD = mac ? '⌘' : 'Ctrl'

/** 与引擎、生成器里实际绑定的快捷键一致 */
const GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  {
    title: '创作',
    items: [
      ['添加节点', 'Tab / 双击空白'],
      ['生成', `${MOD} ↵`],
      ['打组 / 解组', `${MOD} G / ⇧ ${MOD} G`],
      ['整理画布', '⌥ ⇧ F'],
      ['复制一份', `${MOD} D`],
      ['复制 / 粘贴', `${MOD} C / ${MOD} V`],
      ['删除', '⌫'],
      ['提示词预设', '行首 /'],
      ['引用角色、场景', '@'],
    ],
  },
  {
    title: '视图',
    items: [
      ['缩放', `${MOD} + 滚轮 / 双指捏合`],
      ['移动画布', '空格 + 拖动 / 滚轮'],
      ['适应画布', '⇧ 1'],
      ['缩放到选中', '⇧ 2'],
      ['缩放到 100%', `${MOD} 0`],
    ],
  },
  {
    title: '编辑',
    items: [
      ['撤销 / 重做', `${MOD} Z / ⇧ ${MOD} Z`],
      ['全选', `${MOD} A`],
      ['选择工具 / 抓手', 'V / H'],
      ['微移（⇧ 每次 10）', '方向键'],
      ['置于顶层 / 底层', `${MOD} ] / ${MOD} [`],
      ['取消选择', 'Esc'],
      ['快捷键面板', '?'],
    ],
  },
]

/** 快捷键面板：按 ? 或工具栏按钮打开 */
export function Shortcuts() {
  const open = useCanvas((s) => s.shortcuts)
  const toggle = useCanvas((s) => s.toggleShortcuts)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      if (e.key === '?') {
        e.preventDefault()
        toggle()
      } else if (e.key === 'Escape' && useCanvas.getState().shortcuts) toggle(false)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [toggle])
  if (!open) return null
  return (
    <div className="pointer-events-auto fixed inset-0 z-40 flex items-end justify-center p-4 pb-20">
      <button
        type="button"
        aria-label="关闭快捷键面板"
        tabIndex={-1}
        onClick={() => toggle(false)}
        className="absolute inset-0 cursor-default bg-scrim/40"
      />
      <section
        role="dialog"
        aria-label="快捷键"
        className="ui-float relative w-full max-w-[880px] rounded-[20px] p-5"
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">快捷键</h2>
          <button
            type="button"
            aria-label="关闭"
            onClick={() => toggle(false)}
            className="ui-btn ui-btn-quiet ui-icon-btn"
          >
            <Icon name="x" />
          </button>
        </header>
        <div className="grid gap-6 sm:grid-cols-3">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <h3 className="mb-2 text-xs font-medium text-accent">{g.title}</h3>
              <ul className="flex flex-col gap-2">
                {g.items.map(([label, keys]) => (
                  <li key={label} className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="text-ink-muted">{label}</span>
                    <span className="ui-kbd whitespace-nowrap">{keys}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
