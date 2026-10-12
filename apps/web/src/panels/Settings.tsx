import type { ProviderConfigView, ProviderInfo, ProviderTestResult } from '@plein/protocol'
import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { desktop } from '../desktop'
import { useCatalog } from '../stores/catalog'
import { type ObjectSchema, SchemaForm } from './SchemaForm'

const input =
  'h-9 w-full rounded-lg bg-surface-2 px-3 text-sm text-ink outline-none ring-1 ring-line placeholder:text-ink-muted focus:ring-accent/60'

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
      className="flex flex-col gap-4 rounded-2xl bg-surface-2/50 p-4 ring-1 ring-line"
      data-provider={provider.id}
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">{provider.title}</h3>
          {provider.description && (
            <p className="mt-0.5 text-xs text-ink-muted">{provider.description}</p>
          )}
          <p className="mt-1 text-xs text-ink-muted">
            {provider.models.map((m) => m.title).join(' · ')}
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm">
          <input
            type="checkbox"
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
              {s.help && <span className="text-xs text-ink-muted">{s.help}</span>}
            </label>
          ))}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => save()}
              className="h-9 rounded-lg bg-accent px-4 text-sm font-medium text-canvas disabled:opacity-50"
            >
              保存
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={runTest}
              className="h-9 rounded-lg px-3 text-sm text-ink-muted ring-1 ring-line hover:text-ink disabled:opacity-50"
            >
              测试连接
            </button>
            <span className="text-xs text-ink-muted" role="status">
              {test ? (test.ok ? '连接正常' : `连接失败：${test.message}`) : status}
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onPointerDown={onClose}
    >
      <div
        role="dialog"
        aria-label="设置"
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-surface shadow-[var(--shadow-3)]"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="font-medium">设置</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-ink-muted hover:text-ink"
            aria-label="关闭"
          >
            ✕
          </button>
        </header>
        <div className="flex flex-col gap-6 overflow-y-auto p-5">
          <div className="flex flex-col gap-3">
            <h3 className="text-sm text-ink-muted">模型平台</h3>
            {catalog?.providers.length === 0 && (
              <p className="text-sm text-ink-muted">还没有安装模型平台插件。</p>
            )}
            {catalog?.providers.map((p) => (
              <ProviderCard key={p.id} provider={p} onSaved={load} />
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm text-ink-muted">插件</h3>
            <ul className="flex flex-col gap-1 text-sm">
              {catalog?.plugins.map((p) => (
                <li
                  key={p.id}
                  className="flex items-baseline justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-white/5"
                >
                  <span>
                    {p.name}{' '}
                    <span className="text-xs text-ink-muted">
                      {p.id} · {p.version}
                      {p.builtin ? ' · 内置' : ''}
                    </span>
                  </span>
                  <span
                    className={`text-xs ${p.status === 'active' ? 'text-ink-muted' : 'text-red-400'}`}
                  >
                    {p.status === 'active' ? '已加载' : `加载失败：${p.error}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {desktop && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm text-ink-muted">数据</h3>
              <div className="flex items-center justify-between gap-3 px-2 text-sm">
                <span className="text-ink-muted">画布、素材和平台密钥都保存在本机的数据目录里</span>
                <button
                  type="button"
                  onClick={() => void desktop?.openDataDir()}
                  className="shrink-0 rounded-lg px-3 py-1.5 ring-1 ring-line hover:bg-white/5"
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
