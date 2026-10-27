import {
  PLUGIN_INSTALL_MAX_UPLOAD,
  type LocalPluginInfo,
  type PluginInstallPreview,
} from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { ApiError, reportUnauthorized } from '../../api/client'
import { queryClient, queryKeys } from '../../api/query'
import { desktop } from '../../desktop'
import { useCatalog } from '../../stores/catalog'
import { Icon } from '../../ui/icons'
import { Switch } from '../../ui/Switch'
import { Modal } from '../../ui/Modal'
import { useCanvas } from '../../stores/canvas'

async function installRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/plugins/install/${path}`, {
    credentials: 'same-origin',
    ...init,
  })
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as {
      error?: string
      message?: string
    } | null
    if (response.status === 401) reportUnauthorized()
    throw new ApiError(
      response.status,
      error?.error ?? 'install_failed',
      error?.message ?? '插件安装请求失败',
    )
  }
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>)
}

/** 状态标签 */
function state(p: LocalPluginInfo): { label: string; tone: string } {
  if (p.status === 'error') return { label: '出错', tone: 'ui-tag-danger' }
  if (p.status === 'active') return { label: '已加载', tone: 'ui-tag-success' }
  return { label: '未启用', tone: '' }
}

/**
 * 隔离程度：按子进程里实测的权限模型如实写，不夸大。
 * 网络这一项 Node 还管不住（没有 --allow-net 时），插件可以绕过宿主自己联网
 */
function isolation(p: LocalPluginInfo): { label: string; tone: string; hint: string } | null {
  const s = p.sandbox
  if (!s || p.status !== 'active') return null
  if (!s.permission)
    return {
      label: '未隔离',
      tone: 'ui-tag-warning',
      hint: '当前运行时不支持权限模型：插件进程能读写本机文件',
    }
  if (s.net)
    return {
      label: '文件已隔离 · 网络未隔离',
      tone: 'ui-tag-warning',
      hint: '只能读自己的文件夹，不能写文件、开子进程；但能绕过 Plein 直接联网',
    }
  return {
    label: '已隔离',
    tone: 'ui-tag-success',
    hint: '只能读自己的文件夹，联网都经 Plein 代发',
  }
}

/** 声明的权限，一项一个标签 */
function permissionTags(p: Pick<LocalPluginInfo, 'permissions'>) {
  const perm = p.permissions
  if (!perm) return []
  const tags: string[] = []
  for (const d of perm.network) tags.push(`联网 ${d}`)
  for (const s of perm.secrets) tags.push(`密钥 ${s}`)
  if (perm.assets === 'read') tags.push('读素材')
  if (perm.assets === 'write') tags.push('读写素材')
  if (perm.media) tags.push('媒体处理')
  return tags
}

function contributesText(p: LocalPluginInfo) {
  const c = p.contributes
  if (!c) return ''
  return [
    c.nodes.length && `${c.nodes.length} 个节点`,
    c.providers.length && `${c.providers.length} 个平台`,
    c.prompts.length && `${c.prompts.length} 个预设`,
    c.templates.length && `${c.templates.length} 个模板`,
  ]
    .filter(Boolean)
    .join('、')
}

/** 本机插件：数据目录 plugins/ 下的文件夹，默认不启用，看过权限再打开 */
export function LocalPlugins() {
  const { data: installStatus } = useQuery({
    queryKey: ['plugin-install-status'],
    queryFn: () => installRequest<{ available: boolean }>('status'),
  })
  const fileInput = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<PluginInstallPreview | null>(null)
  const previewRef = useRef(preview)
  previewRef.current = preview
  const installPending = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      if (previewRef.current && !installPending.current)
        void installRequest(`${previewRef.current.token}`, { method: 'DELETE' }).catch(() => {})
    }
  }, [])
  const catalogError = useCatalog((state) => state.error)
  const {
    data: list,
    error: loadError,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: queryKeys.localPlugins,
    queryFn: api.localPlugins,
    // 面板可见时跟进其他客户端的启停；读取失败时保留提示，等待重试。
    refetchInterval: (query) => (query.state.data && !query.state.error ? 2000 : false),
  })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const lastList = useRef<string | undefined>(undefined)
  const listKey = list ? JSON.stringify(list) : undefined
  useEffect(() => {
    if (busy !== null || listKey === undefined || lastList.current === listKey) return
    lastList.current = listKey
    void useCatalog.getState().load()
  }, [listKey, busy])

  /** 改完刷新列表和目录（节点、平台、预设跟着变） */
  const act = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key)
    setError(null)
    setMessage(null)
    try {
      await fn()
      if (done) setMessage(done)
    } catch (err) {
      setError(`插件操作失败：${(err as Error).message}`)
    } finally {
      await queryClient.invalidateQueries({ queryKey: queryKeys.localPlugins })
      lastList.current = JSON.stringify(queryClient.getQueryData(queryKeys.localPlugins))
      await useCatalog.getState().load()
      setBusy(null)
    }
  }

  const inspect = async (file: File) => {
    if (installPending.current) return
    if (file.size > PLUGIN_INSTALL_MAX_UPLOAD) {
      setError('插件 ZIP 不能超过 20 MiB')
      return
    }
    installPending.current = true
    setBusy('install-preview')
    setError(null)
    try {
      const next = await installRequest<PluginInstallPreview>('preview', {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body: file,
      })
      if (active.current) setPreview(next)
      else void installRequest(next.token, { method: 'DELETE' }).catch(() => {})
    } catch (err) {
      if (active.current) setError((err as Error).message)
    } finally {
      installPending.current = false
      if (active.current) setBusy(null)
    }
  }
  const closePreview = () => {
    const old = previewRef.current
    previewRef.current = null
    setPreview(null)
    if (old && !installPending.current)
      void installRequest(old.token, { method: 'DELETE' }).catch(() => {})
  }
  const install = async () => {
    const current = previewRef.current
    if (!current || installPending.current) return
    installPending.current = true
    setBusy('install-confirm')
    setError(null)
    try {
      const plugin = await installRequest<LocalPluginInfo>('confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: current.token }),
      })
      useCanvas.getState().notify(`已安装「${plugin.name}」，尚未启用`)
      await queryClient.invalidateQueries({ queryKey: queryKeys.localPlugins })
      await useCatalog.getState().load()
    } catch (err) {
      if (active.current) setError((err as Error).message)
      else useCanvas.getState().notify(`插件安装未获确认：${(err as Error).message}`)
    } finally {
      installPending.current = false
      previewRef.current = null
      if (active.current) {
        setPreview(null)
        setBusy(null)
      }
    }
  }

  const retryCatalog = async () => {
    setBusy('catalog')
    try {
      await useCatalog.getState().load()
    } finally {
      setBusy(null)
    }
  }

  const retry = (
    <button
      type="button"
      className="ui-btn ui-btn-secondary self-start"
      disabled={isFetching}
      onClick={() => void refetch()}
    >
      重试读取插件
    </button>
  )
  if (!list)
    return (
      <div className="flex flex-col gap-3">
        <p
          role={loadError ? 'alert' : 'status'}
          className={loadError ? 'text-sm text-danger' : 'ui-help'}
        >
          {loadError ? `读取插件失败：${loadError.message}` : '正在读取本机插件…'}
        </p>
        {loadError && retry}
      </div>
    )
  return (
    <div className="flex flex-col gap-3">
      {(error || loadError) && (
        <p role="alert" className="text-sm text-danger">
          {error ?? `读取插件失败：${loadError!.message}`}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm text-ink-muted">
          {message}
        </p>
      )}
      {loadError && retry}
      {catalogError && (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-danger">
            节点目录更新失败：{catalogError}
          </p>
          <button
            type="button"
            className="ui-btn ui-btn-secondary"
            disabled={busy !== null}
            onClick={retryCatalog}
          >
            {busy === 'catalog' ? '正在更新目录…' : '重试更新节点目录'}
          </button>
        </div>
      )}
      {list.length === 0 ? (
        <p className="text-sm text-ink-subtle">
          还没有本机插件。把插件文件夹放进数据目录的 plugins/ 里，再点「重新扫描」。
        </p>
      ) : (
        <ul className="rounded-lg ring-1 ring-line" data-testid="local-plugins">
          {list.map((p) => {
            const st = state(p)
            const iso = isolation(p)
            const tags = permissionTags(p)
            const what = contributesText(p)
            return (
              <li
                key={p.id}
                data-plugin={p.id}
                className="flex flex-col gap-2 border-b border-line px-4 py-3 last:border-b-0"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm">{p.name}</span>
                      <span className={`ui-tag ${st.tone}`}>{st.label}</span>
                    </span>
                    <span className="block truncate text-xs text-ink-subtle">
                      {p.id}
                      {p.version && ` · ${p.version}`}
                      {p.author && ` · ${p.author}`}
                    </span>
                  </span>
                  {(p.permissions || p.enabled) && (
                    <Switch
                      label={`启用 ${p.name}`}
                      checked={p.enabled}
                      disabled={busy !== null}
                      onChange={(on) =>
                        void act(
                          p.id,
                          () => api.setLocalPlugin(p.id, on),
                          on ? `已启用「${p.name}」` : `已停用「${p.name}」`,
                        )
                      }
                    />
                  )}
                </div>
                {p.description && <p className="text-xs text-ink-muted">{p.description}</p>}
                {(tags.length > 0 || what) && (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-subtle">
                    {what && <span className="mr-1">提供 {what}</span>}
                    {tags.length > 0 ? (
                      tags.map((t) => (
                        <span key={t} className="ui-tag">
                          {t}
                        </span>
                      ))
                    ) : (
                      <span>不需要联网、密钥或素材</span>
                    )}
                  </div>
                )}
                {iso && (
                  <p className="flex items-center gap-1.5 text-xs text-ink-subtle">
                    <span className={`ui-tag ${iso.tone}`}>{iso.label}</span>
                    <span className="min-w-0">{iso.hint}</span>
                  </p>
                )}
                {p.error && (
                  <p role="alert" className="text-xs break-words text-danger">
                    {p.error}
                  </p>
                )}
                {p.enabled && (
                  <div>
                    <button
                      type="button"
                      className="ui-btn ui-btn-xs ui-btn-quiet"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(p.id, () => api.reloadLocalPlugin(p.id), `已重新加载「${p.name}」`)
                      }
                    >
                      <Icon name="retry" size={12} />
                      {busy === p.id ? '加载中…' : '重新加载'}
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          type="file"
          accept=".zip,application/zip"
          hidden
          ref={fileInput}
          data-testid="plugin-install-file"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void inspect(file)
          }}
        />
        <button
          type="button"
          className="ui-btn ui-btn-secondary"
          disabled={busy !== null || !installStatus?.available}
          onClick={() => fileInput.current?.click()}
          title={
            installStatus?.available
              ? '选择本机 ZIP，先查看清单与权限再安装'
              : '插件包安装只在本机模式可用'
          }
        >
          {busy === 'install-preview'
            ? '正在预检…'
            : busy === 'install-confirm'
              ? '正在安装…'
              : '安装插件包'}
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-secondary"
          disabled={busy !== null}
          onClick={() => void act('scan', api.rescanLocalPlugins, '已重新扫描本机插件')}
        >
          {busy === 'scan' ? '正在扫描…' : '重新扫描'}
        </button>
        {desktop && (
          <button
            type="button"
            className="ui-btn ui-btn-quiet"
            onClick={() => void desktop?.openDataDir()}
          >
            <Icon name="folder" size={14} />
            打开数据目录
          </button>
        )}
      </div>
      {preview && (
        <Modal label="安装本机插件" onClose={closePreview} top isolateKeys className="max-w-150">
          <div className="ui-scrollbar flex min-h-0 flex-col gap-3 overflow-y-auto p-6">
            <h2 className="text-lg font-semibold">安装 {preview.manifest.name}</h2>
            <p className="text-sm text-ink-muted">
              {preview.manifest.id} · {preview.manifest.version} · 插件 API{' '}
              {preview.manifest.engines.plein}
            </p>
            {preview.manifest.description && (
              <p className="text-sm">{preview.manifest.description}</p>
            )}
            <p className="ui-help">
              {preview.files} 个文件，解压后 {(preview.bytes / 1024).toFixed(1)}{' '}
              KiB。预检已检查包结构和清单，未执行插件代码；启用时才校验实际贡献。
            </p>
            <div className="flex flex-wrap gap-1.5" aria-label="插件声明权限">
              {permissionTags({ permissions: preview.manifest.permissions }).map((tag) => (
                <span key={tag} className="ui-tag">
                  {tag}
                </span>
              ))}
              {!permissionTags({ permissions: preview.manifest.permissions }).length && (
                <span className="ui-help">不声明联网、密钥或素材访问</span>
              )}
            </div>
            <ul className="text-sm text-ink-muted" aria-label="插件声明贡献">
              {Object.entries(preview.manifest.contributes)
                .filter(([, ids]) => ids.length)
                .map(([kind, ids]) => (
                  <li key={kind}>
                    {kind}：{ids.join('、')}
                  </li>
                ))}
            </ul>
            <p className="ui-help break-all">包 SHA-256：{preview.sha256}</p>
            <p className="ui-help">
              安装后默认禁用。仅在你启用时运行插件；现有同 ID 插件不会被覆盖。
            </p>
          </div>
          <footer className="flex flex-none justify-end gap-2 border-t border-line px-6 py-4">
            <button type="button" className="ui-btn ui-btn-quiet" onClick={closePreview}>
              取消
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              disabled={busy === 'install-confirm'}
              onClick={() => void install()}
            >
              {busy === 'install-confirm' ? '正在安装…' : '确认安装（暂不启用）'}
            </button>
          </footer>
        </Modal>
      )}
    </div>
  )
}
