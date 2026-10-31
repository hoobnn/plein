/**
 * 模型列表接口的共用解析：把平台返回的条目归一化成 RemoteModel。
 * 只做字段归一化，不做能力推断；推断在服务端合并时进行。
 */
import type { RemoteModel } from '@plein/plugin-sdk'
import { ProviderError } from '@plein/plugin-sdk'
import { asJson, type Json } from './http'

function entry(id: string, item: Json, kind?: RemoteModel['kind'], name?: unknown): RemoteModel {
  return {
    id,
    ...(typeof name === 'string' && name ? { name } : {}),
    ...(typeof item.created === 'number' ? { created: item.created } : {}),
    ...(typeof item.owned_by === 'string' && item.owned_by ? { ownedBy: item.owned_by } : {}),
    ...(kind ? { kind } : {}),
  }
}

/** OpenAI 兼容列表（方舟、百炼兼容模式、自定义渠道）：`{ data: [{ id, owned_by?, created? }] }` */
export function openAiModelList(
  value: unknown,
  opts: { kind?: RemoteModel['kind'] } = {},
): RemoteModel[] {
  const items = asJson(value).data
  if (!Array.isArray(items)) throw new ProviderError('unknown', '模型列表响应缺少 data 数组')
  return items.flatMap((item) => {
    const entry_ = asJson(item)
    if (typeof entry_.id !== 'string' || !entry_.id) return []
    return [entry(entry_.id, entry_, opts.kind)]
  })
}

/** MiniMax 列表：`{ data: [{ model 或 id, owned_by?, created? }] }`，条目键按官方版本可能是 model */
export function minimaxModelList(value: unknown): RemoteModel[] {
  const items = asJson(value).data
  if (!Array.isArray(items))
    throw new ProviderError('unknown', 'MiniMax 模型列表响应缺少 data 数组')
  return items.flatMap((item) => {
    const entry_ = asJson(item)
    const id =
      typeof entry_.model === 'string' && entry_.model
        ? entry_.model
        : typeof entry_.id === 'string'
          ? entry_.id
          : ''
    if (!id) return []
    return [entry(id, entry_)]
  })
}
