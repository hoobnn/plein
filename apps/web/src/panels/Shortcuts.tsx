import { isEditableTarget } from '@plein/canvas-core'
import { Fragment, useEffect } from 'react'
import { useCanvas } from '../stores/canvas'
import { MOD, shortcut as k } from '../ui/keys'
import { Modal, ModalHeader } from '../ui/Modal'

/** 一种按法：同时按下的几个键；一项操作可以有几种按法 */
type Combo = string[]

/** 与引擎、生成器里实际绑定的快捷键一致 */
const GROUPS: Array<{ title: string; items: Array<[string, ...Combo[]]> }> = [
  {
    title: '创作',
    items: [
      ['添加节点', ['Tab'], ['双击空白']],
      ['生成', [k('mod+enter')]],
      ['打组 / 解组', [k('mod+g')], [k('mod+shift+g')]],
      ['整理画布', [k('alt+shift+f')]],
      ['复制一份', [k('mod+d')]],
      ['复制 / 粘贴', [k('mod+c')], [k('mod+v')]],
      ['删除', [k('backspace')]],
      ['提示词预设', ['行首 /']],
      ['引用角色、场景', ['@']],
    ],
  },
  {
    title: '视图',
    items: [
      ['缩放', [MOD, '滚轮'], ['双指捏合']],
      ['移动画布', ['空格', '拖动'], ['滚轮']],
      ['适应画布', [k('shift+1')]],
      ['缩放到选中', [k('shift+2')]],
      ['放大 / 缩小', [k('mod+plus')], [k('mod+minus')]],
      ['缩放到 100%', [k('mod+0')]],
      ['展开 / 收起侧栏', [k('mod+\\')]],
    ],
  },
  {
    title: '编辑',
    items: [
      ['撤销 / 重做', [k('mod+z')], [k('mod+shift+z')]],
      ['全选', [k('mod+a')]],
      ['选择 / 抓手', ['V'], ['H']],
      ['微移（按住 ⇧ 每次 10）', ['方向键']],
      ['置于顶层 / 底层', [k('mod+]')], [k('mod+[')]],
      ['取消选择', ['Esc']],
      ['快捷键面板', ['?']],
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
  const close = () => toggle(false)
  return (
    <Modal label="快捷键" onClose={close} align="bottom" className="max-w-220">
      <ModalHeader title="快捷键" onClose={close} divider={false} />
      <div className="grid gap-x-8 gap-y-6 px-5 pb-5 sm:grid-cols-3">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3 className="ui-section-title mb-2">{g.title}</h3>
            <ul className="flex flex-col">
              {g.items.map(([label, ...combos]) => (
                <li key={label} className="flex h-8 items-center justify-between gap-3">
                  <span className="truncate text-ink-muted">{label}</span>
                  <span className="flex flex-none items-center gap-1 text-2xs text-ink-subtle">
                    {combos.map((combo, i) => (
                      <Fragment key={combo.join()}>
                        {i > 0 && <span className="px-0.5">/</span>}
                        {combo.map((cap, j) => (
                          <Fragment key={cap}>
                            {j > 0 && '+'}
                            <kbd className="ui-keycap">{cap}</kbd>
                          </Fragment>
                        ))}
                      </Fragment>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  )
}
