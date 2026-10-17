import type { UserTemplate } from '@plein/protocol'
import { create } from 'zustand'
import { api } from '../../api/client'
import { reconcileList } from '../../api/listSnapshot'

interface TemplateStore {
  templates: UserTemplate[]
  load(): Promise<void>
  save(title: string, data: object): Promise<UserTemplate>
  remove(id: string): Promise<void>
}

/** 用户存的模板（Frame 存为模板），节点选择器里列出 */
export const useTemplates = create<TemplateStore>((set, get) => {
  let loading: Promise<void> | undefined
  let removed: Set<string> | undefined
  return {
    templates: [],
    load() {
      if (loading) return loading
      const before = get().templates
      removed = new Set()
      loading = api
        .templates()
        .then(
          (items) => set({ templates: reconcileList(items, before, get().templates, removed) }),
          () => {
            /* 演示模式或未登录时没有模板接口，保留已有条目 */
          },
        )
        .finally(() => {
          loading = undefined
          removed = undefined
        })
      return loading
    },
    async save(title, data) {
      const t = await api.saveTemplate(title, data)
      set({ templates: [t, ...get().templates.filter((item) => item.id !== t.id)] })
      return t
    },
    async remove(id) {
      await api.deleteTemplate(id)
      removed?.add(id)
      set({ templates: get().templates.filter((t) => t.id !== id) })
    },
  }
})
