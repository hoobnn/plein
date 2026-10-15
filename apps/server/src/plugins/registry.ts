import {
  capabilityIdError,
  capabilityToolName,
  type ElementTypeDefinition,
  type ExecutorDefinition,
  type NodeDefinition,
  nodeKey,
  type PluginCapabilityDefinition,
  PLUGIN_API_VERSION,
  type PluginManifest,
  type ProviderDefinition,
  type ServerPluginDefinition,
  type PromptPresetDefinition,
  type TemplateDefinition,
  vendorOf,
} from '@plein/plugin-sdk'
import semver from 'semver'

export type PluginStatus = 'active' | 'error'

export interface PluginEntry {
  manifest: PluginManifest
  builtin: boolean
  status: PluginStatus
  /** 加载失败的原因 */
  error?: string
}

interface Owned<T> {
  def: T
  plugin: string
}

/**
 * 插件注册表：内置与第三方插件的贡献都登记在这里，按插件归属。
 * 注册是原子的：校验全部通过才登记，任何一项不合规整个插件标记为 error，不影响其他插件和服务启动。
 */
export class PluginRegistry {
  private entries = new Map<string, PluginEntry>()
  readonly nodes = new Map<string, Owned<NodeDefinition>>()
  readonly executors = new Map<string, Owned<ExecutorDefinition>>()
  readonly providers = new Map<string, Owned<ProviderDefinition>>()
  readonly templates = new Map<string, Owned<TemplateDefinition>>()
  readonly prompts = new Map<string, Owned<PromptPresetDefinition>>()
  readonly elements = new Map<string, Owned<ElementTypeDefinition>>()
  /** 按 id 登记的插件能力 */
  readonly capabilities = new Map<string, Owned<PluginCapabilityDefinition>>()

  register(sp: ServerPluginDefinition, opts: { builtin: boolean }): PluginEntry {
    const { manifest } = sp.plugin
    let entry: PluginEntry
    try {
      this.validate(sp)
      entry = { manifest, builtin: opts.builtin, status: 'active' }
    } catch (err) {
      entry = { manifest, builtin: opts.builtin, status: 'error', error: (err as Error).message }
    }
    // 同 id 已存在时不覆盖原插件
    if (!this.entries.has(manifest.id)) this.entries.set(manifest.id, entry)
    if (entry.status === 'active') this.add(sp)
    return entry
  }

  /** 卸下一个插件和它的全部贡献（停用、重新加载第三方插件时用） */
  unregister(id: string) {
    this.entries.delete(id)
    for (const map of [
      this.nodes,
      this.executors,
      this.providers,
      this.templates,
      this.elements,
      this.prompts,
      this.capabilities,
    ] as Array<Map<string, Owned<unknown>>>) {
      for (const [k, v] of map) if (v.plugin === id) map.delete(k)
    }
  }

  get plugins(): PluginEntry[] {
    return [...this.entries.values()]
  }

  plugin(id: string) {
    return this.entries.get(id)
  }

  /** 某节点类型已安装的最新版本 */
  latestNode(type: string): Owned<NodeDefinition> | undefined {
    let best: Owned<NodeDefinition> | undefined
    for (const n of this.nodes.values()) {
      if (n.def.type === type && (!best || n.def.version > best.def.version)) best = n
    }
    return best
  }

  private validate(sp: ServerPluginDefinition) {
    const { manifest, nodes, templates, elements, prompts } = sp.plugin
    const id = manifest.id
    if (this.entries.has(id)) throw new Error(`插件 ${id} 已加载`)
    if (!semver.validRange(manifest.engines.plein)) {
      throw new Error(`engines.plein 不是合法的版本范围：${manifest.engines.plein}`)
    }
    if (
      !semver.satisfies(PLUGIN_API_VERSION, manifest.engines.plein, { includePrerelease: true })
    ) {
      throw new Error(`插件需要插件 API ${manifest.engines.plein}，当前为 ${PLUGIN_API_VERSION}`)
    }

    const vendor = vendorOf(id)
    const own = (kind: string, cid: string) => {
      if (vendorOf(cid) !== vendor)
        throw new Error(`${kind} ${cid} 不在插件的命名空间 ${vendor}/ 下`)
    }
    const sameSet = (kind: string, declared: string[], actual: string[]) => {
      const a = [...new Set(declared)].sort()
      const b = [...new Set(actual)].sort()
      if (a.length !== declared.length || b.length !== actual.length)
        throw new Error(`${kind} 有重复项`)
      const missing = b.filter((x) => !a.includes(x))
      const extra = a.filter((x) => !b.includes(x))
      if (missing.length) throw new Error(`清单 contributes.${kind} 缺少：${missing.join('、')}`)
      if (extra.length)
        throw new Error(`清单 contributes.${kind} 声明了但没有提供：${extra.join('、')}`)
    }

    const nodeKeys = nodes.map((n) => nodeKey(n.type, n.version))
    sameSet('nodes', manifest.contributes.nodes, nodeKeys)
    sameSet(
      'providers',
      manifest.contributes.providers,
      sp.providers.map((p) => p.id),
    )
    sameSet(
      'templates',
      manifest.contributes.templates,
      templates.map((t) => t.id),
    )
    sameSet(
      'elements',
      manifest.contributes.elements,
      elements.map((e) => e.type),
    )
    sameSet(
      'prompts',
      manifest.contributes.prompts,
      prompts.map((p) => p.id),
    )

    for (const n of nodes) {
      own('节点', n.type)
      if (this.nodes.has(nodeKey(n.type, n.version)))
        throw new Error(`节点 ${nodeKey(n.type, n.version)} 已被其他插件注册`)
    }
    for (const p of sp.providers) {
      own('Provider', p.id)
      if (this.providers.has(p.id)) throw new Error(`Provider ${p.id} 已被其他插件注册`)
      const allowed = new Set(manifest.permissions.secrets)
      for (const s of p.secrets) {
        if (!allowed.has(s.name))
          throw new Error(`Provider ${p.id} 使用的密钥 ${s.name} 没有在 permissions.secrets 里声明`)
      }
    }
    for (const t of templates) {
      own('模板', t.id)
      if (this.templates.has(t.id)) throw new Error(`模板 ${t.id} 已被其他插件注册`)
      for (const n of t.nodes) {
        const key = nodeKey(n.type, n.version)
        if (!nodeKeys.includes(key) && !this.nodes.has(key))
          throw new Error(`模板 ${t.id} 用到未安装的节点 ${key}`)
      }
    }
    for (const e of elements) {
      own('元素类型', e.type)
      if (this.elements.has(e.type)) throw new Error(`元素类型 ${e.type} 已被其他插件注册`)
    }
    sameSet(
      'capabilities',
      manifest.contributes.capabilities,
      sp.capabilities.map((c) => c.id),
    )
    const tools = new Set([...this.capabilities.values()].map((c) => capabilityToolName(c.def.id)))
    for (const c of sp.capabilities) {
      own('能力', c.id)
      const bad = capabilityIdError(c.id)
      if (bad) throw new Error(bad)
      const tool = capabilityToolName(c.id)
      if (tools.has(tool)) throw new Error(`能力 ${c.id} 与其他插件的能力重名`)
      tools.add(tool)
      if (c.palette && !c.input.safeParse({}).success)
        throw new Error(`能力 ${c.id} 出现在命令面板里，输入的每个字段都要可选`)
    }
    for (const p of prompts) {
      own('提示词预设', p.id)
      if (this.prompts.has(p.id)) throw new Error(`提示词预设 ${p.id} 已被其他插件注册`)
    }
    // 执行器只能实现本插件声明的节点
    const seen = new Set<string>()
    for (const ex of sp.executors) {
      const key = nodeKey(ex.node.type, ex.node.version)
      if (!nodeKeys.includes(key)) throw new Error(`执行器 ${key} 对应的节点不是本插件声明的`)
      if (seen.has(key)) throw new Error(`执行器 ${key} 重复`)
      seen.add(key)
    }
  }

  private add(sp: ServerPluginDefinition) {
    const plugin = sp.plugin.manifest.id
    for (const def of sp.plugin.nodes)
      this.nodes.set(nodeKey(def.type, def.version), { def, plugin })
    for (const def of sp.executors)
      this.executors.set(nodeKey(def.node.type, def.node.version), { def, plugin })
    for (const def of sp.providers) this.providers.set(def.id, { def, plugin })
    for (const def of sp.plugin.templates) this.templates.set(def.id, { def, plugin })
    for (const def of sp.plugin.elements) this.elements.set(def.type, { def, plugin })
    for (const def of sp.plugin.prompts) this.prompts.set(def.id, { def, plugin })
    for (const def of sp.capabilities) this.capabilities.set(def.id, { def, plugin })
  }
}
