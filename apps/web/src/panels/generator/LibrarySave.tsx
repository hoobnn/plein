import type { Engine } from '@plein/canvas-core'
import type { CanvasElement } from '@plein/doc'
import { libraryKindOfNode } from '@plein/nodes'
import { useState } from 'react'
import { saveCardToLibrary } from '../../canvas/library'
import { useCanvas } from '../../stores/canvas'
import { useLibrary } from '../../stores/library'
import { Icon } from '../../ui/icons'

/** 资产卡的「存入资产库」：卡片记着条目时是「更新资产库」，另附一个打开资产库查看的入口 */
export function LibrarySave({ engine, el }: { engine: Engine; el: CanvasElement }) {
  const items = useLibrary((s) => s.items)
  const loaded = useLibrary((s) => s.loaded)
  const [busy, setBusy] = useState(false)
  const kind = libraryKindOfNode(el.nodeType)
  if (!kind || !loaded) return null
  const linked = items.some((i) => i.id === el.params?.libraryId)

  const save = async () => {
    setBusy(true)
    try {
      const lib = useLibrary.getState()
      // 输入框失焦时才写回文档，点按钮那一刻 props 里的 el 可能还是旧的
      const current = engine.doc.get(el.id) ?? el
      const { item, created } = await saveCardToLibrary(engine, current, lib.projectId, lib)
      useCanvas
        .getState()
        .notify(
          created
            ? `已存入资产库：${kind.title}「${item.name}」，其他画布可以直接取用`
            : `已更新资产库里的${kind.title}「${item.name}」`,
        )
    } catch (err) {
      useCanvas.getState().notify(`存入资产库失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-none items-center gap-0.5">
      <button
        type="button"
        disabled={busy}
        onClick={() => void save()}
        title={
          linked
            ? '把卡片当前的名字、设定和参考图更新到资产库'
            : '把这张卡片固化到资产库，跨画布、跨项目复用'
        }
        className="ui-btn ui-btn-quiet ui-btn-sm"
      >
        <Icon name="library" size={14} />
        {linked ? '更新资产库' : '存入资产库'}
      </button>
      <button
        type="button"
        aria-label={`打开资产库的${kind.title}`}
        title={`打开资产库的${kind.title}`}
        onClick={() => useLibrary.getState().show(kind.id)}
        className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
      >
        <Icon name="chevronRight" size={14} />
      </button>
    </div>
  )
}
