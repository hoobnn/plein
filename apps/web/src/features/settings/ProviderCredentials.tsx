import type { ProviderConfigView, ProviderInfo } from '@plein/protocol'
import { credentialCardDirty, type CredentialCardDraft } from './providerDirty'

/**
 * 平台的「密钥」区：一组密钥一张紧凑卡片（标签、各密钥输入、使用中标记、检查连接、删除），
 * 没保存过的新卡接在后面。草稿由行组件持有，保存时随设置一起提交；这里只渲染并转发操作。
 */

interface CardProps {
  provider: ProviderInfo
  card: CredentialCardDraft
  /** 已保存组的元信息；新卡没有 */
  saved?: ProviderConfigView['credentials'][number]
  /** 这张卡是不是当前使用中的组 */
  active: boolean
  /** 组数 ≥2 时才显示「使用中」和「设为使用」，单组界面保持安静 */
  multi: boolean
  onLabel(key: string, value: string): void
  onSecret(key: string, name: string, value: string): void
  onUse(key: string): void
  onRemove(key: string): void
  onDiscard(key: string): void
  onTest(key: string): void
}

function CredentialCard({
  provider,
  card,
  saved,
  active,
  multi,
  onLabel,
  onSecret,
  onUse,
  onRemove,
  onDiscard,
  onTest,
}: CardProps) {
  const name = saved?.label ?? '新密钥组'
  // 标签必填只约束会提交的卡：新卡、以及改动过的预填卡；已保存组留空表示不修改
  const labelRequired = !card.label.trim() && (saved === undefined || credentialCardDirty(card))
  return (
    <li
      className="flex flex-col gap-2.5 rounded-lg p-3 ring-1 ring-line"
      data-credential={card.key}
    >
      <div className="flex items-center gap-2">
        <input
          type="text"
          className="ui-input min-w-0 flex-1"
          aria-label={`「${name}」的标签`}
          placeholder={saved ? saved.label : '个人 / 团队'}
          value={card.label}
          aria-invalid={labelRequired || undefined}
          onChange={(e) => onLabel(card.key, e.target.value)}
        />
        {multi && active && <span className="ui-tag">使用中</span>}
        {multi && saved && !active && (
          <button
            type="button"
            className="ui-btn ui-btn-secondary flex-none"
            onClick={() => onUse(card.key)}
          >
            设为使用
          </button>
        )}
        {saved ? (
          <button
            type="button"
            className="ui-btn ui-btn-quiet ui-btn-danger flex-none"
            aria-label={`删除「${name}」`}
            onClick={() => onRemove(card.key)}
          >
            删除
          </button>
        ) : (
          // 预填卡是新平台创建第一组的入口，不提供移除；手动加的草稿可以直接丢弃
          card.baseline === undefined && (
            <button
              type="button"
              className="ui-btn ui-btn-quiet flex-none"
              aria-label={`移除「${name}」`}
              onClick={() => onDiscard(card.key)}
            >
              移除
            </button>
          )
        )}
      </div>
      {provider.secrets.map((s) => (
        <label key={s.name} className="ui-field">
          <span className="ui-label">
            {s.title}
            {s.required ? '' : '（可选）'}
          </span>
          <input
            type="password"
            autoComplete="off"
            className="ui-input w-full"
            aria-label={`「${name}」的${s.title}`}
            placeholder={saved?.secrets[s.name] ? '已填写，留空表示不修改' : '未填写'}
            value={card.secrets[s.name] ?? ''}
            onChange={(e) => onSecret(card.key, s.name, e.target.value)}
          />
          {s.help && <span className="ui-help">{s.help}</span>}
        </label>
      ))}
      {saved && (
        // 有没保存的密钥输入时禁用：检查的是已保存的密钥，不先保存会查到旧值
        <button
          type="button"
          className="ui-btn ui-btn-secondary self-start"
          disabled={Object.values(card.secrets).some((v) => v !== '')}
          onClick={() => onTest(card.key)}
        >
          检查连接
        </button>
      )}
    </li>
  )
}

export function ProviderCredentials({
  provider,
  config,
  labels,
  groupSecrets,
  drafts,
  onLabel,
  onSecret,
  onUse,
  onRemove,
  onDiscard,
  onTest,
  onAdd,
}: {
  provider: ProviderInfo
  config: ProviderConfigView
  /** 已保存组的标签草稿：组 id → 输入；留空表示不修改 */
  labels: Record<string, string>
  /** 已保存组的密钥草稿：组 id → 密钥名 → 输入；留空表示不修改 */
  groupSecrets: Record<string, Record<string, string>>
  /** 还没保存过的新卡 */
  drafts: CredentialCardDraft[]
  onLabel(key: string, value: string): void
  onSecret(key: string, name: string, value: string): void
  onUse(key: string): void
  onRemove(key: string): void
  onDiscard(key: string): void
  onTest(key: string): void
  onAdd(): void
}) {
  // 平台没有声明密钥就没有组的概念；老版服务端的视图没有 credentials 字段也照常显示
  if (provider.secrets.length === 0) return null
  const savedGroups = config.credentials ?? []
  const multi = savedGroups.length + drafts.length >= 2
  return (
    <section className="flex flex-col gap-2">
      <span className="ui-label">密钥</span>
      <ul aria-label="密钥组" className="flex flex-col gap-2">
        {savedGroups.map((saved) => (
          <CredentialCard
            key={saved.id}
            provider={provider}
            card={{
              key: saved.id,
              label: labels[saved.id] ?? '',
              secrets: groupSecrets[saved.id] ?? {},
              baseline: '',
            }}
            saved={saved}
            active={config.activeCredential === saved.id}
            multi={multi}
            onLabel={onLabel}
            onSecret={onSecret}
            onUse={onUse}
            onRemove={onRemove}
            onDiscard={onDiscard}
            onTest={onTest}
          />
        ))}
        {drafts.map((card) => (
          <CredentialCard
            key={card.key}
            provider={provider}
            card={card}
            active={false}
            multi={multi}
            onLabel={onLabel}
            onSecret={onSecret}
            onUse={onUse}
            onRemove={onRemove}
            onDiscard={onDiscard}
            onTest={onTest}
          />
        ))}
      </ul>
      <button type="button" className="ui-btn ui-btn-secondary self-start" onClick={onAdd}>
        添加一组密钥
      </button>
    </section>
  )
}
