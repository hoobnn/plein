import {
  type CharacterProfile,
  type LibraryKindSpec,
  type OfficialLibraryItem,
  normalizeLibraryImages,
  profileOf,
  slotImages,
} from '@plein/nodes'
import type { LibraryImage, LibraryItem } from '@plein/protocol'
import type { LibrarySeed } from './store'

export type Editing =
  | { type: 'item'; id: string; editorKey?: string }
  | { type: 'official'; item: OfficialLibraryItem }
  | { type: 'new'; seed?: LibrarySeed }

export interface Draft {
  name: string
  description: string
  tags: Record<string, string>
  voice: { provider: string; voiceId: string }
  images: LibraryImage[]
  video: string | null
  models: string
  profile: CharacterProfile
  /** 归属当前项目 */
  inProject: boolean
}

export function draftOf(
  kind: LibraryKindSpec,
  item: LibraryItem | undefined,
  official: OfficialLibraryItem | undefined,
  projectId: string | null,
  seed?: LibrarySeed,
): Draft {
  return {
    name: item?.name ?? official?.name ?? seed?.name?.replace(/\.[a-z0-9]{2,5}$/i, '') ?? '',
    description: item?.description ?? official?.description ?? '',
    tags: { ...(item?.tags ?? official?.tags) },
    voice: item?.voice ?? { provider: '', voiceId: '' },
    images: normalizeLibraryImages(
      kind,
      item?.images ?? (seed ? slotImages(kind, seed.images) : []),
    ),
    video: item?.video ?? (kind.video ? (seed?.videos[0] ?? null) : null),
    models: (item?.models ?? official?.models ?? []).join('，'),
    profile: profileOf(item?.profile),
    // 新建的角色 / 场景 / 道具默认归到当前项目；风格、特效默认全局
    inProject: item ? item.projectId !== null : !!projectId && !kind.video && kind.id !== 'style',
  }
}

/** 创建成功只接手服务端 ID，保留原编辑实例。 */
function sessionKeyOf(editing: Editing) {
  return editing.type === 'item' ? (editing.editorKey ?? editing.id) : editing.type
}
export function editorKeyOf(kind: string, editing: Editing) {
  return `${kind}:${sessionKeyOf(editing)}`
}
export function createdEditing(previous: Editing, id: string): Editing {
  return { type: 'item', id, editorKey: sessionKeyOf(previous) }
}
