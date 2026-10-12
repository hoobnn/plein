import type { ProviderConfigView, ProviderInfo, ProviderTestResult } from '@plein/protocol'
import { type ReactNode, useEffect, useState } from 'react'
import { api } from '../api/client'
import { desktop } from '../desktop'
import { useCatalog } from '../stores/catalog'
import { useTheme } from '../stores/theme'
import { Icon, type IconName } from '../ui/icons'
import { Modal, ModalHeader } from '../ui/Modal'
import { THEME_OPTIONS } from '../ui/ThemeToggle'
import { type ObjectSchema, SchemaForm } from './SchemaForm'
import { SlidePill, SlideSwap } from '../ui/Slide'
import { Switch } from '../ui/Switch'

const input = 'ui-input ui-input-lg w-full'

type Section = 'appearance' | 'providers' | 'plugins' | 'data'

/** 平台行的状态：停用 / 缺密钥 / 可用 */
function providerState(p: ProviderInfo): { label: string; tone: string } {
  if (!p.enabled) return { label: '已停用', tone: '' }
  if (!p.configured) return { label: '缺少密钥', tone: 'ui-tag-warning' }
  return { label: '可用', tone: 'ui-tag-success' }
}

/** 单个平台：一行摘要（状态、启用开关），展开后是设置表单（由插件声明的 schema 生成）、密钥、测试连接 */
export function ProviderRow({
  provider,
  open,
  onToggleOpen,
  onSaved,
  enableOnSave = false,
}: {
  provider: ProviderInfo
  open: boolean
  onToggleOpen(): void
  onSaved(): void
  /** 保存时顺带启用（首次启动引导里填完密钥就能用） */
  enableOnSave?: boolean
}) {
  const [config, setConfig] = useState<ProviderConfigView | null>(null)
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<string | null>(null)
  const [test, setTest] = useState<ProviderTestResult | null>(null)
  const [busy, setBusy] = useState(false)

  // 展开时才读配置
  useEffect(() => {
    if (!open || config) return
    api.providerConfig(provider.id).then(
      (c) => {
        setConfig(c)
        setSettings(c.settings)
      },
      (err) => setStatus(`读取配置失败：${(err as Error).message}`),
    )
  }, [open, config, provider.id])

  const save = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const next = await api.updateProviderConfig(provider.id, {
        ...(enableOnSave ? { enabled: true } : {}),
        settings,
        // 只提交改过的密钥；留空表示不修改
        secrets: Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== '')),
      })
      setConfig(next)
      setSecrets({})
      setStatus('已保存')
      onSaved()
    } catch (err) {
      setStatus(`保存失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const setEnabled = async (enabled: boolean) => {
    setBusy(true)
    try {
      const next = await api.updateProviderConfig(provider.id, { enabled })
      if (config) setConfig(next)
      onSaved()
    } catch (err) {
      setStatus(`保存失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const runTest = async () => {
    setTest(null)
    setBusy(true)
    try {
      setTest(await api.testProvider(provider.id))
    } catch (err) {
      setTest({ ok: false, message: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const state = providerState(provider)
  const bodyId = `provider-${provider.id}`

  return (
    <li className="border-b border-line last:border-b-0" data-provider={provider.id}>
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggleOpen}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span
            className={`flex-none text-ink-subtle transition-transform ${open ? 'rotate-90' : ''}`}
          >
            <Icon name="chevronRight" size={14} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{provider.title}</span>
            <span className="block truncate text-xs text-ink-subtle">
              {provider.description ?? `${provider.models.length} 个模型`}
            </span>
          </span>
          <span className={`ui-tag ${state.tone}`}>{state.label}</span>
        </button>
        <Switch
          checked={provider.enabled}
          disabled={busy}
          label={`启用 ${provider.title}`}
          onChange={setEnabled}
        />
      </div>
      {/* 展开的内容和标题文字对齐：左边距 16 + 箭头 14 + 间距 12 */}
      {open && (
        <div id={bodyId} className="flex flex-col gap-4 px-4 pb-4 pl-10.5">
          {provider.models.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {provider.models.map((m) => (
                <span key={m.id} className="ui-tag">
                  {m.title}
                </span>
              ))}
            </div>
          )}
          {!config ? (
            <p className="text-xs text-ink-subtle" role="status">
              {status ?? '读取中…'}
            </p>
          ) : (
            <>
              {provider.secrets.map((s) => (
                <label key={s.name} className="ui-field">
                  <span className="ui-label">
                    {s.title}
                    {s.required ? '' : '（可选）'}
                  </span>
                  <input
                    type="password"
                    autoComplete="off"
                    className={input}
                    placeholder={config.secrets[s.name] ? '已填写，留空表示不修改' : '未填写'}
                    value={secrets[s.name] ?? ''}
                    onChange={(e) => setSecrets({ ...secrets, [s.name]: e.target.value })}
                  />
                  {s.help && <span className="ui-help">{s.help}</span>}
                </label>
              ))}
              <SchemaForm
                schema={provider.settingsSchema as ObjectSchema}
                value={settings}
                onChange={setSettings}
              />
              <div className="flex flex-wrap items-center gap-2">
                <span className="mr-auto text-xs text-ink-muted" role="status">
                  {test
                    ? test.ok
                      ? (test.message ?? '连接正常')
                      : `检查失败：${test.message}`
                    : status}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={runTest}
                  className="ui-btn ui-btn-secondary"
                >
                  {provider.testScope === 'configuration' ? '检查配置' : '测试连接'}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => save()}
                  className="ui-btn ui-btn-primary"
                >
                  保存
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </li>
  )
}

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-ink-subtle">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

/** 设置：左侧分区导航，右侧当前分区 */
export function SettingsDialog({ onClose }: { onClose(): void }) {
  const { catalog, load } = useCatalog()
  const [section, setSection] = useState<Section>('appearance')
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
    { id: 'plugins', label: '插件', icon: 'puzzle', badge: plugins.length },
    ...(desktop ? [{ id: 'data' as const, label: '数据', icon: 'folder' as const }] : []),
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
          <SlideSwap index={sections.indexOf(current)} axis="y" className="flex flex-col gap-8">
            {current.id === 'appearance' && (
              <Group title="主题" hint="跟随系统时，会随系统的浅色 / 深色自动切换">
                <Appearance />
              </Group>
            )}
            {current.id === 'providers' && (
              <Group title="已安装的平台" hint="启用并填好密钥后，节点里才能选到这个平台的模型">
                {providers.length === 0 ? (
                  <p className="text-sm text-ink-subtle">还没有安装模型平台插件。</p>
                ) : (
                  <ul className="rounded-lg ring-1 ring-line">
                    {providers.map((p) => (
                      <ProviderRow
                        key={p.id}
                        provider={p}
                        open={openProvider === p.id}
                        onToggleOpen={() => setOpenProvider(openProvider === p.id ? null : p.id)}
                        onSaved={load}
                      />
                    ))}
                  </ul>
                )}
              </Group>
            )}
            {current.id === 'plugins' && (
              <Group title="已安装的插件">
                <ul className="rounded-lg ring-1 ring-line">
                  {plugins.map((p) => (
                    <li
                      key={p.id}
                      className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm">{p.name}</span>
                        <span className="block truncate text-xs text-ink-subtle">
                          {p.id} · {p.version}
                          {p.builtin ? ' · 内置' : ''}
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
            {current.id === 'data' && (
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
