import { localCard } from './elements'
import { createHash } from 'node:crypto'
import type {
  ExternalAction,
  ExternalContent,
  ExternalRow,
  ExternalState,
  ExternalTarget,
} from '@plein/protocol'
import type { CanvasElement } from '@plein/doc'
import type { RemoteItem } from './provider'
import type { Link } from './store'

const samePosition = (a: ExternalContent['position'], b: ExternalContent['position']) =>
  a?.x === b?.x && a?.y === b?.y
export const same = (a: ExternalContent, b: ExternalContent) =>
  a.title === b.title && a.text === b.text && samePosition(a.position, b.position)

function mergeFields(base: ExternalContent, local: ExternalContent, remote: ExternalContent) {
  for (const field of ['title', 'text'] as const) {
    if (
      local[field] !== base[field] &&
      remote[field] !== base[field] &&
      remote[field] !== local[field]
    )
      return
  }
  // A drag is one change. Combining x from one drag with y from another invents a position.
  const moved = !samePosition(base.position, local.position)
  if (
    moved &&
    !samePosition(base.position, remote.position) &&
    !samePosition(local.position, remote.position)
  )
    return
  const position = moved ? local.position : remote.position
  return {
    title: local.title === base.title ? remote.title : local.title,
    text: local.text === base.text ? remote.text : local.text,
    ...(position ? { position } : {}),
  }
}

function status(
  local: ExternalContent | null,
  remote: ExternalContent | null,
  link?: Link,
): ExternalState {
  if (!link) return remote ? 'remote-only' : 'local-only'
  if (!link.remoteId) return 'pending'
  if (!remote) return 'missing-remote'
  if (!local) return 'missing-local'
  if (same(local, remote)) return 'synced'
  if (same(link.baseline, remote)) return 'local-changed'
  if (same(link.baseline, local)) return 'remote-changed'
  return 'conflict'
}

export function makePlan(
  ref: ExternalTarget,
  canvasId: string,
  elements: Iterable<CanvasElement>,
  items: RemoteItem[],
  links: Link[],
  createKinds: readonly string[],
  canCreateAtPosition: boolean,
) {
  const locals = new Map([...elements].filter((e) => localCard(e)).map((e) => [e.id, e]))
  const remotes = new Map(items.map((r) => [r.id, r]))
  if (remotes.size !== items.length) throw new Error('平台返回了重复的节点，请刷新后重试')
  const rows: ExternalRow[] = []
  function add(element?: CanvasElement, item?: RemoteItem, link?: Link) {
    const position =
      !element?.parentId && (!!item?.fields.position || (!link && !item && canCreateAtPosition))
    const card = element && localCard(element)
    const local =
      element && card
        ? {
            title: element.name ?? '',
            text: card.text,
            ...(position ? { position: { x: element.x, y: element.y } } : {}),
          }
        : null
    const remote = item
      ? {
          title: item.fields.title,
          text: item.fields.text,
          ...(position && item.fields.position ? { position: item.fields.position } : {}),
        }
      : null
    if (!position && link?.baseline.position)
      link = { ...link, baseline: { title: link.baseline.title, text: link.baseline.text } }
    let state = status(local, remote, link)
    const merged =
      state === 'conflict' && link && local && remote && item?.editable && !element?.locked
        ? mergeFields(link.baseline, local, remote)
        : undefined
    if (merged) state = 'mergeable'
    const actions: ExternalAction[] = []
    if (merged) actions.push('merge')
    if (
      item &&
      !element?.locked &&
      [
        'remote-only',
        'remote-changed',
        'missing-local',
        'conflict',
        'mergeable',
        'local-changed',
      ].includes(state)
    )
      actions.push('pull')
    if (
      local &&
      ((item?.editable && ['local-changed', 'mergeable', 'conflict'].includes(state)) ||
        (state === 'local-only' && card && createKinds.includes(card.kind)))
    )
      actions.push('push')
    if (state === 'pending' && local) actions.push('reconcile')
    if (link) actions.push('unlink')
    const localId = element?.id ?? link?.localId ?? null
    const remoteId = item?.id ?? link?.remoteId ?? null
    const rowId = localId ? 'local/' + localId : 'remote/' + remoteId
    const revision = createHash('sha256')
      .update(
        JSON.stringify([
          canvasId,
          ref.provider,
          ref.target,
          rowId,
          remoteId,
          state,
          local,
          remote,
          state === 'synced' ? null : link?.baseline,
          link?.operationId,
          actions,
          item?.kind,
          item?.referenceRevision ?? item?.references,
          card?.kind,
        ]),
      )
      .digest('hex')
    rows.push({
      rowId,
      revision,
      localId,
      remoteId,
      state,
      ...(item?.references?.length ? { references: item.references } : {}),
      kind: item?.kind ?? card?.kind ?? 'text',
      local,
      remote,
      ...(merged ? { merged } : {}),
      actions,
    })
  }
  for (const link of links) {
    const item = link.remoteId ? remotes.get(link.remoteId) : undefined
    add(locals.get(link.localId), item, link)
    locals.delete(link.localId)
    if (item) remotes.delete(item.id)
  }
  for (const remote of remotes.values()) add(undefined, remote)
  for (const el of locals.values()) if (createKinds.includes(localCard(el)!.kind)) add(el)
  return rows
}
