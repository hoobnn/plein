import type { UserTemplate } from '@plein/protocol'
import { create } from 'zustand'
import { api } from '../../api/client'

interface TemplateStore {
  templates: UserTemplate[]
  load(): Promise<void>
  save(title: string, data: object): Promise<UserTemplate>
  remove(id: string): Promise<void>
}

/** 用户存的模板（Frame 存为模板），节点选择器里列出 */
export const useTemplates = create<TemplateStore>((set, get) => ({
  templates: [],
  async load() {
    try {
      set({ templates: await api.templates() })
    } catch {
      // 演示模式或未登录时没有模板接口，保持为空
    }
  },
  async save(title, data) {
    const t = await api.saveTemplate(title, data)
    set({ templates: [t, ...get().templates] })
    return t
  },
  async remove(id) {
    await api.deleteTemplate(id)
    set({ templates: get().templates.filter((t) => t.id !== id) })
  },
}))
