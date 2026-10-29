/**
 * 平台的「密钥」区：一组密钥一张紧凑卡片（标签、各密钥输入、使用中标记、检查连接、删除），
 * 没保存过的新卡接在后面。草稿由行组件持有，保存时随设置一起提交；这里只渲染并转发操作。
 */

import type { ProviderConfigView, ProviderInfo } from '@plein/protocol'
import { usageSummary } from './credentialUsage'
import { credentialCardDirty, type CredentialCardDraft } from './providerDirty'

interface CardProps {
  provider: ProviderInfo
  card: CredentialCardDraft
  /** 已保存组的元信息；新卡没有 */
  saved?: ProviderConfigView['credentials'][number]
  /** 这张卡是不是当前使用中的组 */
  active: boolean
  /** 组数 ≥2 时才显示「使用中」和「设为使用」，单组界面保持安静 */
  multi: boolean
  /** 平台级设置还有没保存的改动：检查连接查的是整体配置，得先保存 */
  settingsDirty: boolean
  /** 在草稿卡里的序号：没填标签时用「新密钥组 N」作名字，多张卡不重名 */
  draftIndex?: number
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
  settingsDirty,
  draftIndex,
  onLabel,
  onSecret,
  onUse,
  onRemove,
  onDiscard,
  onTest,
}: CardProps) {
  // 新卡用草稿标签作名字，没填时退回序号；已保存组用已保存的标签
  const name =
    saved?.label ??
    (card.label.trim() || (draftIndex === undefined ? '新密钥组' : `新密钥组 ${draftIndex + 1}`))
  // 名下还有未取回的结果或音色时给一行轻量说明，全为 0 不显示
  const summary = saved ? usageSummary(saved.usage) : null
  // 标签必填只约束要创建的新卡：预填卡改动后提交时必须带标签；已保存组留空表示不修改，
  // 只填新密钥也要能保存
  const labelRequired =
    saved === undefined &&
    (card.baseline === undefined || credentialCardDirty(card)) &&
    !card.label.trim()
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
            aria-label={`设为使用「${name}」`}
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
      {saved && summary && <p className="text-xs text-ink-subtle">{summary}</p>}
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
        // 有没保存的密钥输入或平台设置时禁用：检查的是已保存的整体配置，不先保存会查到旧值
        <button
          type="button"
          className="ui-btn ui-btn-secondary self-start"
          disabled={settingsDirty || Object.values(card.secrets).some((v) => v !== '')}
          aria-label={`检查「${name}」的连接`}
          onClick={() => onTest(card.key)}
        >
          检查连接
        </button>
      )}
    </li>
  )
}

/** 密钥区的入口：按服务端视图加本地草稿拼出卡片列表，末尾是「添加一组密钥」 */
export function ProviderCredentials({
  provider,
  config,
  labels,
  groupSecrets,
  drafts,
  settingsDirty,
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
  /** 平台级设置还有没保存的改动，存在时禁用各卡的检查连接 */
  settingsDirty: boolean
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
              baseline: saved.label,
            }}
            saved={saved}
            active={config.activeCredential === saved.id}
            multi={multi}
            settingsDirty={settingsDirty}
            onLabel={onLabel}
            onSecret={onSecret}
            onUse={onUse}
            onRemove={onRemove}
            onDiscard={onDiscard}
            onTest={onTest}
          />
        ))}
        {drafts.map((card, draftIndex) => (
          <CredentialCard
            key={card.key}
            provider={provider}
            card={card}
            active={false}
            multi={multi}
            settingsDirty={settingsDirty}
            draftIndex={draftIndex}
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
