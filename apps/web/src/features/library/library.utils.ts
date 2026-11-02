import type { LibraryKindSpec } from '@plein/nodes'

export type Scope = 'project' | 'mine' | 'official' | 'favorite' | 'recent'

export function tagLine(kind: LibraryKindSpec, tags: Record<string, string>) {
  return kind.tags
    .map((t) => tags[t.id])
    .filter(Boolean)
    .join(' · ')
}
