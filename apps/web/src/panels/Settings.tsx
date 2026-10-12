import { type ThemePref, useTheme } from '../stores/theme'
import { Icon, type IconName } from '../ui/icons'
import type { ProviderConfigView, ProviderInfo, ProviderTestResult } from '@plein/protocol'
import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { desktop } from '../desktop'
import { useCatalog } from '../stores/catalog'
import { type ObjectSchema, SchemaForm } from './SchemaForm'

const input = 'ui-input !h-9 w-full'

/** 单个平台：启用开关、设置表单（由插件声明的 schema 生成）、密钥、测试连接 */
function ProviderCard({ provider, onSaved }: { provider: ProviderInfo; onSaved(): void }) {
  const [config, setConfig] = useState<ProviderConfigView | null>(null)
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<string | null>(null)
  const [test, setTest] = useState<ProviderTestResult | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.providerConfig(provider.id).then((c) => {
      setConfig(c)
      setSettings(c.settings)
    })
  }, [provider.id])

  const save = async (patch: { enabled?: boolean } = {}) => {
    setBusy(true)
    setStatus(null)
    try {
      const next = await api.updateProviderConfig(provider.id, {
        ...patch,
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

  const runTest = async () => {
    setTest(null)
    setBusy(true)
    try {
      setTest(await api.testProvider(provider.id))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className="flex flex-col gap-4 rounded-[14px] bg-surface-2 p-4 ring-1 ring-line"
      data-provider={provider.id}
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">{provider.title}</h3>
          {provider.description && (
            <p className="mt-0.5 text-xs text-ink-subtle">{provider.description}</p>
          )}
          <p className="mt-1 text-xs text-ink-subtle">
            {provider.models.map((m) => m.title).join(' · ')}
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-[var(--accent)]"
            checked={config?.enabled ?? provider.enabled}
            disabled={busy || !config}
            onChange={(e) => save({ enabled: e.target.checked })}
          />
          启用
        </label>
      </header>
      {config && (
        <>
          <SchemaForm
            schema={provider.settingsSchema as ObjectSchema}
            value={settings}
            onChange={setSettings}
          />
          {provider.secrets.map((s) => (
            <label key={s.name} className="flex flex-col gap-1 text-sm">
              <span className="text-ink-muted">
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
              {s.help && <span className="text-xs text-ink-subtle">{s.help}</span>}
            </label>
          ))}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => save()}
              className="ui-btn ui-btn-primary !h-9"
            >
              保存
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={runTest}
              className="ui-btn ui-btn-secondary !h-9"
            >
              {provider.testScope === 'configuration' ? '检查配置' : '测试连接'}
            </button>
            <span className="text-xs text-ink-muted" role="status">
              {test
                ? test.ok
                  ? (test.message ?? '连接正常')
                  : `检查失败：${test.message}`
                : status}
            </span>
          </div>
        </>
      )}
    </section>
  )
}

/** 设置：模型平台与已安装插件 */
export function SettingsDialog({ onClose }: { onClose(): void }) {
  const { catalog, load } = useCatalog()
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
      onPointerDown={onClose}
    >
      <div
        role="dialog"
        aria-label="设置"
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-[18px] bg-surface shadow-[var(--shadow-3)]"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-base font-semibold">设置</h2>
          <button
            type="button"
            onClick={onClose}
            className="ui-btn ui-btn-quiet ui-icon-btn"
            aria-label="关闭"
          >
            <Icon name="x" />
          </button>
        </header>
        <div className="ui-scrollbar flex flex-col gap-7 overflow-y-auto p-5">
          <div className="flex flex-col gap-3">
            <h3 className="text-xs font-medium text-ink-subtle">外观</h3>
            <Appearance />
          </div>
          <div className="flex flex-col gap-3">
            <h3 className="text-xs font-medium text-ink-subtle">模型平台</h3>
            {catalog?.providers.length === 0 && (
              <p className="text-sm text-ink-subtle">还没有安装模型平台插件。</p>
            )}
            {catalog?.providers.map((p) => (
              <ProviderCard key={p.id} provider={p} onSaved={load} />
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-ink-subtle">插件</h3>
            <ul className="flex flex-col gap-1 text-sm">
              {catalog?.plugins.map((p) => (
                <li
                  key={p.id}
                  className="flex items-baseline justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-hover"
                >
                  <span>
                    {p.name}{' '}
                    <span className="text-xs text-ink-subtle">
                      {p.id} · {p.version}
                      {p.builtin ? ' · 内置' : ''}
                    </span>
                  </span>
                  <span
                    className={`text-xs ${p.status === 'active' ? 'text-success' : 'text-danger'}`}
                  >
                    {p.status === 'active' ? '已加载' : `加载失败：${p.error}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {desktop && (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-ink-subtle">数据</h3>
              <div className="flex items-center justify-between gap-3 px-2 text-sm">
                <span className="text-ink-muted">画布、素材和平台密钥都保存在本机的数据目录里</span>
                <button
                  type="button"
                  onClick={() => void desktop?.openDataDir()}
                  className="ui-btn ui-btn-secondary shrink-0"
                >
                  打开数据目录
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const APPEARANCE: Array<{ pref: ThemePref; label: string; icon: IconName }> = [
  { pref: 'system', label: '跟随系统', icon: 'monitor' },
  { pref: 'light', label: '浅色', icon: 'sun' },
  { pref: 'dark', label: '深色', icon: 'moon' },
]

/** 外观：主题三选一 */
function Appearance() {
  const pref = useTheme((s) => s.pref)
  const setPref = useTheme((s) => s.setPref)
  return (
    <fieldset aria-label="主题" className="grid grid-cols-3 gap-2 border-0 p-0">
      {APPEARANCE.map((o) => (
        <button
          key={o.pref}
          type="button"
          aria-pressed={pref === o.pref}
          onClick={() => setPref(o.pref)}
          className={`flex h-10 items-center justify-center gap-2 rounded-[10px] text-[13px] ring-1 transition-colors ${
            pref === o.pref
              ? 'bg-accent-soft text-accent ring-accent'
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
