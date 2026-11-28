import { capabilityFor, CapabilityError } from '@plein/capabilities'
import {
  API,
  ExternalApply,
  ExternalAuthRequest,
  ExternalMediaImport,
  ExternalMediaPublish,
  ExternalMediaReplace,
  ExternalProjectsRequest,
  ExternalPullNew,
  ExternalSpacesRequest,
  ExternalTarget,
  externalAuthPath,
  externalMediaPath,
  type ExternalAuthState,
  type ExternalPreview,
  type ExternalRow,
  type ExternalSpace,
  type RemoteMedia,
} from '@plein/protocol'
import { z } from 'zod'
import { canonicalTarget, parseNovelTarget } from '../external-canvas/targets'
import { callInternal } from './internal-api'
import type { ServerContext } from './tools'

const cap = capabilityFor<ServerContext>()
const remote = { where: 'server', group: 'project', openWorld: true } as const
const pageInput = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(20),
}
type Page = { offset: number; limit: number }
type Operation = Parameters<typeof API.externalCanvas>[1]
type MediaOperation = Parameters<typeof externalMediaPath>[1]
const unavailable = '请确认本机免登录服务绑定了回环地址，并选择可访问的 Plein 画布'

// Leave space in the MCP response for the target, counters, and the next page cursor.
function page<T>(rows: T[], { offset, limit }: Page) {
  const items: T[] = []
  let bytes = 0
  for (const row of rows.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(JSON.stringify(row, null, 1))
    if (items.length && bytes + size > 16_384) break
    items.push(row)
    bytes += size
  }
  const next = offset + items.length
  return { total: rows.length, items, ...(next < rows.length ? { next_offset: next } : {}) }
}

function call<T>(ctx: ServerContext, op: Operation, body?: unknown) {
  return callInternal<T>(
    ctx,
    {
      path: API.externalCanvas(ctx.env.canvasId, op),
      pathname:
        /^\/api\/canvases\/[^/]+\/external\/(?:targets|spaces|projects|preview|apply|pull-new)$/,
      method: op === 'targets' ? 'GET' : 'POST',
      body,
    },
    unavailable,
  )
}
function media<T>(ctx: ServerContext, op: MediaOperation, body: unknown) {
  return callInternal<T>(
    ctx,
    {
      path: externalMediaPath(ctx.env.canvasId, op),
      pathname: /^\/api\/canvases\/[^/]+\/external\/media\/(?:list|import|replace|publish)$/,
      method: 'POST',
      body,
    },
    unavailable,
  )
}
function inspect(ctx: ServerContext, { provider, target }: ExternalTarget) {
  return call<ExternalPreview>(ctx, 'preview', { provider, target, inspectOnly: true })
}

// Media IDs can recur across short-drama spaces. Keep the confirmed target pinned through CLI calls.
function fixedTarget(input: ExternalTarget) {
  const target = canonicalTarget(input)
  if (target.provider === 'jimeng-novel' && parseNovelTarget(target.target).teamId === undefined)
    throw new CapabilityError(
      '请选择已核实的短剧空间及项目。用 external_canvas_spaces、external_canvas_projects 取得「空间 ID/项目 ID」后刷新预览。',
    )
  return target.target
}
const resolvedTarget = ExternalTarget.shape.target
  .optional()
  .describe(
    '预览返回的 resolvedTarget。旧版短剧绑定可能使用不同的 target 与 resolvedTarget，两者均应原样保留。',
  )
function applyBody<T extends ExternalTarget & { resolvedTarget?: string }>(a: T) {
  const { resolvedTarget, ...body } = a
  const expectTarget = fixedTarget({ provider: a.provider, target: resolvedTarget ?? a.target })
  return { ...body, expectTarget, includeReceipt: true }
}

const status = cap({
  ...remote,
  name: 'external_canvas_status',
  title: '查询即梦登录状态',
  effect: 'read',
  description:
    '查询本机所选即梦 CLI 的授权状态。需要登录时，请用户在即梦同步面板或官方 CLI 完成授权。',
  input: ExternalAuthRequest,
  run: async (ctx, a) => {
    const state = await callInternal<ExternalAuthState>(
      ctx,
      {
        path: externalAuthPath(ctx.env.canvasId, 'status'),
        pathname: /^\/api\/canvases\/[^/]+\/external\/auth\/status$/,
        method: 'POST',
        body: a,
      },
      unavailable,
    )
    return { provider: a.provider, status: state.status }
  },
})
const targets = cap({
  where: 'server',
  group: 'project',
  name: 'external_canvas_targets',
  title: '查询已关联的即梦项目',
  effect: 'read',
  description: '查询当前 Plein 画布保存过卡片绑定的即梦平台和项目 ID。',
  input: z.object(pageInput),
  run: async (ctx, a) => page(await call<ExternalTarget[]>(ctx, 'targets'), a),
})
const spaces = cap({
  ...remote,
  name: 'external_canvas_spaces',
  title: '查询即梦短剧空间',
  effect: 'read',
  description: '查询即梦短剧 CLI 可访问的空间及当前空间。全能画布可直接查询项目。',
  input: ExternalSpacesRequest.extend(pageInput),
  run: async (ctx, a) =>
    page(await call<ExternalSpace[]>(ctx, 'spaces', { provider: a.provider }), a),
})
const projects = cap({
  ...remote,
  name: 'external_canvas_projects',
  title: '查询即梦项目',
  effect: 'read',
  description:
    '查询全能画布或短剧项目。将 external_canvas_spaces 中所选项的 id 作为 space 传入，即可取得带空间的稳定短剧项目 ID。',
  input: ExternalProjectsRequest.extend(pageInput),
  run: async (ctx, a) =>
    page(
      await call<{ id: string; title: string }[]>(ctx, 'projects', {
        provider: a.provider,
        space: a.space,
      }),
      a,
    ),
})
const preview = cap({
  ...remote,
  name: 'external_canvas_preview',
  title: '预览即梦逐卡差异',
  effect: 'read',
  description:
    '读取两端草稿差异、可选动作和逐卡 revision。用 external_canvas_read_row 核对两端正文、合并结果与参考。下一页沿用同一目标。',
  input: ExternalTarget.extend(pageInput),
  run: async (ctx, a) => {
    const p = await inspect(ctx, a)
    return {
      provider: p.provider,
      target: p.target,
      resolvedTarget: p.resolvedTarget ?? p.target,
      ...page(
        p.rows.map((r) => ({
          rowId: r.rowId,
          localId: r.localId,
          remoteId: r.remoteId,
          revision: r.revision,
          state: r.state,
          kind: r.kind,
          title: (r.local?.title || r.remote?.title || '').slice(0, 160),
          actions: r.actions,
        })),
        a,
      ),
    }
  },
})
const readRow = cap({
  ...remote,
  name: 'external_canvas_read_row',
  title: '核对即梦草稿内容',
  effect: 'read',
  description:
    '按预览给出的 rowId、revision 核对当前卡片。local / remote / merged 分别是 Plein、即梦、合并稿，offset 按字符续读长标题和正文；references 按条续读。若版本过期，重新预览。',
  input: ExternalTarget.extend({
    rowId: ExternalApply.shape.rowId,
    revision: ExternalApply.shape.revision,
    side: z.enum(['local', 'remote', 'merged', 'references']),
    offset: pageInput.offset,
  }),
  run: async (ctx, a) => {
    const p = await inspect(ctx, a)
    const row = p.rows.find((r) => r.rowId === a.rowId)
    if (!row || row.revision !== a.revision) throw new CapabilityError('卡片已变化，请重新预览。')
    const base = {
      rowId: row.rowId,
      revision: row.revision,
      kind: row.kind,
      state: row.state,
      localId: row.localId,
      remoteId: row.remoteId,
      actions: row.actions,
    }
    if (a.side === 'references')
      return { ...base, ...page(row.references ?? [], { offset: a.offset, limit: 20 }) }
    const side = row[a.side]
    if (!side) return { ...base, [a.side]: null }
    const end = a.offset + 1024
    return {
      ...base,
      [a.side]: {
        title: side.title.slice(a.offset, end),
        text: side.text.slice(a.offset, end),
        position: side.position,
      },
      ...(end < Math.max(side.text.length, side.title.length) ? { next_offset: end } : {}),
    }
  },
})
const pullNew = cap({
  ...remote,
  name: 'external_canvas_pull_new',
  title: '导入选中的即梦草稿',
  effect: 'edit',
  confirmEdits: true,
  description:
    '把预览中选定的 1 至 200 个 remote-only 草稿导入当前 Plein 画布并建立关联。使用每行原始 rowId、revision；任一行过期时整批拒绝。',
  input: ExternalPullNew.extend({ resolvedTarget }),
  approval: (a, ctx) => ({
    reason: `将即梦项目 ${a.resolvedTarget ?? a.target} 的 ${a.rows.length} 张草稿导入 Plein 画布 ${ctx.env.canvasId} 并建立关联（${a.rows
      .slice(0, 5)
      .map((row) => row.rowId)
      .join('、')}${a.rows.length > 5 ? ' 等' : ''}）`,
    ids: [],
  }),
  run: (ctx, a) => call(ctx, 'pull-new', applyBody(a)),
})
const actionLabel = {
  pull: '将即梦版本写入 Plein',
  push: '将 Plein 版本写入即梦草稿',
  merge: '把合并结果写入两端',
  unlink: '解除两端卡片的关联',
  reconcile: '将待核对的创建记录关联到指定即梦卡片',
} satisfies Record<ExternalRow['actions'][number], string>
const apply = cap({
  ...remote,
  name: 'external_canvas_apply',
  title: '同步一张即梦草稿',
  effect: (a) =>
    a.action === 'reconcile' || (a.action === 'pull' && a.rowId.startsWith('remote/'))
      ? 'edit'
      : 'destructive',
  effects: ['edit', 'destructive'],
  confirmEdits: true,
  description:
    '逐卡执行其预览 actions 中的一项。提交相同目标、rowId、revision；reconcile 另传用户核实的 remoteId。pull/push 采用一侧内容，merge 写入双方，unlink 只清除关联。创建结果待核对时先重新预览，不重复创建。',
  input: ExternalApply.extend({ resolvedTarget }),
  approval: (a, ctx) => ({
    reason: `${actionLabel[a.action]}。Plein 画布 ${ctx.env.canvasId}，即梦项目 ${a.resolvedTarget ?? a.target}，卡片 ${a.rowId}${a.action === 'reconcile' ? ' → ' + (a.remoteId ?? '未选择') : ''}`,
    ids: [],
  }),
  run: (ctx, a) => call(ctx, 'apply', applyBody(a)),
})
const mediaList = cap({
  ...remote,
  name: 'external_canvas_media_list',
  title: '查询即梦可用媒体',
  effect: 'read',
  description:
    '列出已完成的图片、视频、音频及可替换状态。传输时使用返回的 target、nodeId、assetId，短剧 target 带空间 ID。',
  input: ExternalTarget.extend(pageInput),
  run: async (ctx, a) => {
    const result = await media<{ target: string; items: RemoteMedia[] }>(ctx, 'list', {
      provider: a.provider,
      target: a.target,
      includeTarget: true,
    })
    return { provider: a.provider, target: result.target, ...page(result.items, a) }
  },
})
const mediaImport = cap({
  ...remote,
  name: 'external_canvas_media_import',
  title: '导入即梦媒体',
  effect: 'edit',
  confirmEdits: true,
  description:
    '将所选远端媒体原件导入 Plein 并放到当前画布。使用媒体列表的目标、节点和资产 ID，内容已换片时刷新选择。',
  input: ExternalMediaImport,
  approval: (a, ctx) => ({
    reason: `将即梦项目 ${a.target} 的媒体 ${a.nodeId}/${a.assetId} 导入 Plein 画布 ${ctx.env.canvasId}`,
    ids: [],
  }),
  run: (ctx, a) => media(ctx, 'import', { ...a, target: fixedTarget(a) }),
})
const mediaReplace = cap({
  ...remote,
  name: 'external_canvas_media_replace',
  title: '替换短剧当前媒体',
  effect: 'destructive',
  description:
    '使用 Plein 同类素材替换即梦短剧媒体列表中 replaceable 的当前资产。先让用户核对目标版本和本地素材。',
  input: ExternalMediaReplace,
  approval: (a) => ({
    reason: `用 Plein 素材 ${a.localAssetId} 替换即梦项目 ${a.target} 当前媒体 ${a.nodeId}/${a.assetId}`,
    ids: [],
  }),
  run: (ctx, a) => media(ctx, 'replace', { ...a, target: fixedTarget(a) }),
})
const mediaPublish = cap({
  ...remote,
  name: 'external_canvas_media_publish',
  title: '发布素材到即梦草稿',
  effect: 'destructive',
  description:
    '将当前用户可访问的 Plein 素材发布到即梦全能画布草稿项目，沿用同一发布记录核对并恢复。不会启动模型生成。',
  input: ExternalMediaPublish,
  approval: (a) => ({
    reason: `将 Plein 素材 ${a.localAssetId} 发布到即梦草稿项目 ${a.target}`,
    ids: [],
  }),
  run: (ctx, a) => media(ctx, 'publish', { ...a, target: fixedTarget(a) }),
})

export const externalCanvasCapabilities = [
  status,
  targets,
  spaces,
  projects,
  preview,
  readRow,
  pullNew,
  apply,
  mediaList,
  mediaImport,
  mediaReplace,
  mediaPublish,
]
