import { createHash, createHmac } from 'node:crypto'
import { ProviderError, type ProviderContext, type RemoteModel } from '@plein/plugin-sdk'
import { asJson, readJson, send } from '../shared/http'

/** 官方套餐目录接口是管控面，只接受 AK/SK，不接受 Agent Plan API Key。 */
export async function listPlanModels(ctx: ProviderContext): Promise<RemoteModel[]> {
  const access = ctx.secret('ARK_PLAN_ACCESS_KEY'),
    secret = ctx.secret('ARK_PLAN_SECRET_KEY')
  if (!access || !secret)
    throw new ProviderError(
      'auth',
      '自动获取套餐模型需要填写模型目录 Access Key 和 Secret Key；生成仍使用 Agent Plan 专属 API Key',
    )
  const host = 'ark.cn-beijing.volcengineapi.com'
  const query = 'Action=ListArkAgentPlanModel&Version=2024-01-01'
  const body = JSON.stringify({ Edition: 'personal' })
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const day = date.slice(0, 8),
    scope = `${day}/cn-beijing/ark/request`
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const signed = 'host;x-content-sha256;x-date'
  const payloadHash = hash(body)
  const canonical = `POST\n/\n${query}\nhost:${host}\nx-content-sha256:${payloadHash}\nx-date:${date}\n\n${signed}\n${payloadHash}`
  let signingKey: Buffer = Buffer.from(secret)
  for (const part of [day, 'cn-beijing', 'ark', 'request'])
    signingKey = createHmac('sha256', signingKey).update(part).digest()
  const signature = createHmac('sha256', signingKey)
    .update(`HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`)
    .digest('hex')
  const messages = { cancelled: '模型目录查询已取消', network: '模型目录查询失败' }
  const response = await send(
    ctx,
    `https://${host}/?${query}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Date': date,
        'X-Content-Sha256': payloadHash,
        Authorization: `HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
      },
      body,
    },
    messages,
  )
  const data = asJson(await readJson(ctx, response, 'POST', messages))
  if (!response.ok || asJson(data.ResponseMetadata).Error)
    throw new ProviderError(
      response.status === 401 || response.status === 403 ? 'auth' : 'unavailable',
      '套餐模型目录查询失败，请检查 AK/SK 和方舟查询权限',
    )
  const items = asJson(data.Result).Datas
  if (!Array.isArray(items)) throw new ProviderError('unknown', '套餐模型目录缺少 Datas 数组')
  return [
    ...new Set(
      items
        .map((item) => asJson(item).ModelID)
        .filter((id): id is string => typeof id === 'string' && Boolean(id)),
    ),
  ].map((id) => ({ id }))
}
