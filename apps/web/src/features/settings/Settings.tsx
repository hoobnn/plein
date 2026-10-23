import { DataMaintenance } from './DataMaintenance'
import { ProviderSettings } from './ProviderSettings'
import { Group } from './SettingsGroup'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { queryKeys } from '../../api/query'
import { desktop } from '../../desktop'
import { useCatalog } from '../../stores/catalog'
import { useTheme } from '../../stores/theme'
import { Icon, type IconName } from '../../ui/icons'
import { Modal, ModalHeader } from '../../ui/Modal'
import { THEME_OPTIONS } from '../../ui/ThemeToggle'
import { ExternalMcp } from './ExternalMcp'
import { LocalPlugins } from './LocalPlugins'
import { LocalClis } from '../agent/LocalClis'
import { useAgent } from '../agent/store'
import { SkillBrowser } from '../agent/AgentSkills'
import { SlidePill, SlideSwap } from '../../ui/Slide'

export { ProviderRow } from './ProviderSettings'

export type Section = 'appearance' | 'providers' | 'local' | 'mcp' | 'plugins' | 'skills' | 'data'

/** 设置：左侧分区导航，右侧当前分区 */
export function SettingsDialog({ onClose, initial }: { onClose(): void; initial?: Section }) {
  const { catalog, load, error: catalogError } = useCatalog()
  const [section, setSection] = useState<Section>(initial ?? 'appearance')
  const [openProvider, setOpenProvider] = useState<string | null>(null)
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const { data: externalMcp } = useQuery({
    queryKey: queryKeys.mcpExternal,
    queryFn: api.externalMcp,
  })
  // 本机 CLI 只在本机模式可用：那时状态里才有 Claude Code / Codex
  const agentStatus = useAgent((s) => s.status)
  useEffect(() => {
    if (!useAgent.getState().status) void useAgent.getState().loadStatus()
  }, [])
  const localCli = !!agentStatus?.agents.some((a) => a.id !== 'builtin')
  const providers = catalog?.providers ?? []
  const plugins = catalog?.plugins ?? []
  const sections: Array<{ id: Section; label: string; icon: IconName; badge?: number }> = [
    { id: 'appearance', label: '外观', icon: 'palette' },
    {
      id: 'providers',
      label: '模型平台',
      icon: 'sparkle',
      badge: providers.filter((p) => p.enabled && p.configured).length,
    },
    ...(localCli ? [{ id: 'local' as const, label: '本机 AI', icon: 'terminal' as const }] : []),
    { id: 'skills', label: '技能与画布能力', icon: 'sparkle' },
    // 对外开放 MCP 只在本机模式可用：其他模式下接口返回 403，不显示这一栏
    ...(externalMcp ? [{ id: 'mcp' as const, label: 'MCP', icon: 'plug' as const }] : []),
    { id: 'plugins', label: '插件', icon: 'puzzle', badge: plugins.length },
    { id: 'data' as const, label: '数据', icon: 'folder' as const },
  ]
  const current = sections.find((s) => s.id === section) ?? sections[0]!

  return (
    <Modal label="设置" onClose={onClose} top className="h-[min(640px,100%)] max-w-215 sm:flex-row">
      <nav
        aria-label="设置分区"
        className="ui-slide flex flex-none gap-1 overflow-x-auto border-b border-line bg-surface-2 p-2 sm:w-52 sm:flex-col sm:overflow-visible sm:border-r sm:border-b-0 sm:p-3"
      >
        <h2 className="hidden px-2.5 pt-1.5 pb-3 text-lg font-semibold sm:block">设置</h2>
        <SlidePill variant="seg" />
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-current={s.id === current.id ? 'page' : undefined}
            onClick={() => setSection(s.id)}
            className={`flex h-8 flex-none items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors ${
              s.id === current.id ? 'text-ink' : 'text-ink-muted hover:bg-hover hover:text-ink'
            }`}
          >
            <Icon name={s.icon} />
            <span className="flex-1 text-left">{s.label}</span>
            {!!s.badge && (
              <span className="hidden text-2xs text-ink-subtle tabular-nums sm:inline">
                {s.badge}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ModalHeader title={current.label} onClose={onClose} divider={false} />
        <div className="ui-scrollbar flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-5 pt-2 pb-5">
          {/* 分区导航是竖排的：内容按上下方向滑入 */}
          <SlideSwap
            index={sections.indexOf(current)}
            axis="y"
            className="flex flex-col gap-8"
            preserveState
          >
            {current.id === 'appearance' && (
              <Group title="主题" hint="跟随系统时，会随系统的浅色 / 深色自动切换">
                <Appearance />
              </Group>
            )}
            <div hidden={current.id !== 'providers'}>
              <ProviderSettings
                catalog={catalog}
                catalogError={catalogError}
                load={load}
                openProvider={openProvider}
                onToggleOpen={(id) => setOpenProvider(openProvider === id ? null : id)}
                active={current.id === 'providers'}
              />
            </div>
            {current.id === 'local' && (
              <Group
                title="命令行 AI"
                hint="小满可以直接用你电脑上已登录的 Claude Code 或 Codex，沿用它们自己的账号、MCP 和 skill"
              >
                <LocalClis />
              </Group>
            )}
            {current.id === 'mcp' && (
              <Group
                title="让其他 AI 应用连进来"
                hint="对外开放 Plein 自己的 MCP，只接受本机的连接"
              >
                <ExternalMcp />
              </Group>
            )}
            {current.id === 'skills' && <SkillBrowser />}
            {current.id === 'plugins' && (
              <Group
                title="本机插件"
                hint="数据目录 plugins/ 下的第三方插件。默认不启用，看过它要的权限再打开；启用后在单独的进程里运行"
              >
                <LocalPlugins />
              </Group>
            )}
            {current.id === 'plugins' && (
              <Group title="内置插件">
                <ul className="rounded-lg ring-1 ring-line">
                  {plugins
                    .filter((p) => p.builtin)
                    .map((p) => (
                      <li
                        key={p.id}
                        className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm">{p.name}</span>
                          <span className="block truncate text-xs text-ink-subtle">
                            {p.id} · {p.version}
                          </span>
                          {p.error && (
                            <span className="mt-0.5 block text-xs break-words text-danger">
                              {p.error}
                            </span>
                          )}
                        </span>
                        <span
                          className={`ui-tag ${p.status === 'active' ? 'ui-tag-success' : 'ui-tag-danger'}`}
                        >
                          {p.status === 'active' ? '已加载' : '加载失败'}
                        </span>
                      </li>
                    ))}
                </ul>
              </Group>
            )}
            {current.id === 'data' && <DataMaintenance />}
            {current.id === 'data' && desktop && (
              <Group title="数据目录" hint="画布、素材和平台密钥都保存在本机的数据目录里">
                <div>
                  <button
                    type="button"
                    onClick={() => void desktop?.openDataDir()}
                    className="ui-btn ui-btn-secondary"
                  >
                    打开数据目录
                  </button>
                </div>
              </Group>
            )}
          </SlideSwap>
        </div>
      </div>
    </Modal>
  )
}

/** 外观：主题三选一 */
function Appearance() {
  const pref = useTheme((s) => s.pref)
  const setPref = useTheme((s) => s.setPref)
  return (
    <fieldset aria-label="主题" className="ui-slide grid grid-cols-3 gap-2 border-0 p-0">
      <SlidePill variant="accent" />
      {THEME_OPTIONS.map((o) => (
        <button
          key={o.pref}
          type="button"
          aria-pressed={pref === o.pref}
          onClick={() => setPref(o.pref)}
          className={`flex h-10 items-center justify-center gap-2 rounded-md text-sm ring-1 transition-colors ${
            pref === o.pref
              ? 'text-accent ring-transparent'
              : 'bg-surface-2 text-ink-muted ring-line hover:text-ink'
          }`}
        >
          <Icon name={o.icon} />
          {o.label}
        </button>
      ))}
    </fieldset>
  )
}
