import { currentResult, type CanvasElement } from '@plein/doc'
import type * as Y from 'yjs'
import { z } from 'zod'
import { CapabilityError, defineCapability } from './define'
import { need } from './place'

const versions = new WeakMap<Y.Doc, { epoch: string; counter: number }>()
const encoder = new TextEncoder()
const MAX_BYTES = 24 * 1024
export function canvasReadVersion(doc: Y.Doc): string {
  let state = versions.get(doc)
  if (!state) {
    state = { epoch: globalThis.crypto.randomUUID(), counter: 0 }
    versions.set(doc, state)
    const bump = () => {
      state!.counter++
    }
    const cleanup = () => {
      doc.off('update', bump)
      doc.off('destroy', cleanup)
      versions.delete(doc)
    }
    doc.on('update', bump)
    doc.on('destroy', cleanup)
  }
  return `${state.epoch}:${state.counter}`
}
const bytes = (v: unknown) => encoder.encode(JSON.stringify(v)).byteLength
const pointer = (path: string, key: string | number) =>
  `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`
function preview(value: unknown, path: string): unknown {
  if (typeof value === 'string')
    return value.length <= 400
      ? value
      : {
          preview: value.slice(0, 400),
          characters: value.length,
          field_path: path,
          complete: false,
        }
  if (value && typeof value === 'object')
    return {
      type: Array.isArray(value) ? 'array' : 'object',
      total: Object.keys(value).length,
      field_path: path,
      complete: false,
    }
  return value
}
function versionCheck(ydoc: Y.Doc, expected: string | undefined, continued: boolean) {
  const version = canvasReadVersion(ydoc)
  if (continued && !expected)
    throw new CapabilityError('expected_version_required: 续读必须携带第一页的 expected_version')
  if (expected && version !== expected)
    throw new CapabilityError('canvas_changed: 画布已变化，请重新读取第一页')
  return version
}
function bounded<T>(
  values: T[],
  offset: number,
  limit: number,
  transform: (v: T, i: number) => unknown,
) {
  const items: unknown[] = []
  for (let i = offset; i < Math.min(values.length, offset + limit); i++) {
    const item = transform(values[i]!, i)
    if (bytes([...items, item]) > MAX_BYTES - 2048) break
    items.push(item)
  }
  if (offset < values.length && !items.length)
    throw new CapabilityError('field_too_large: 请定位更具体的字段')
  const next = offset + items.length
  return {
    items,
    total: values.length,
    offset,
    ...(next < values.length ? { next_offset: next } : {}),
    complete: next >= values.length,
  }
}
function index(el: CanvasElement) {
  const result = currentResult(el)
  return {
    id: el.id,
    kind: el.kind,
    name: el.name?.slice(0, 200),
    type: el.nodeType,
    rect: [el.x, el.y, el.w, el.h],
    run: el.run ? { id: el.run.id, status: el.run.status } : undefined,
    current_result: result ? { id: result.id, type: result.value.type } : undefined,
    fields: Object.keys(el)
      .sort()
      .map((key) => ({
        field_path: pointer('', key),
        value: preview((el as unknown as Record<string, unknown>)[key], pointer('', key)),
      })),
  }
}
export const getCanvasPage = defineCapability({
  name: 'get_canvas_page',
  title: '分页查看画布',
  group: 'read',
  where: 'doc',
  effect: 'read',
  description:
    '有界画布索引。先读取第一页，沿 next_offset 续读并带 expected_version=version；完整字段用 get_element_field。complete 只表示当前 section 的记录读完，不表示预览是原文。',
  input: z.object({
    section: z.enum(['elements', 'edges']).default('elements'),
    frame_id: z.string().optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(30),
    expected_version: z.string().optional(),
  }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const version = versionCheck(doc.ydoc, a.expected_version, a.offset > 0)
      const elements = a.frame_id
        ? [need(doc, a.frame_id), ...doc.descendants(a.frame_id)]
        : [...doc.elements()]
      const ids = new Set(elements.map((e) => e.id))
      const records =
        a.section === 'elements'
          ? bounded(
              elements.sort((a, b) => a.id.localeCompare(b.id)),
              a.offset,
              a.limit,
              index,
            )
          : bounded(
              [...doc.edges()]
                .filter((e) => ids.has(e.from[0]) || ids.has(e.to[0]))
                .sort((a, b) => a.id.localeCompare(b.id)),
              a.offset,
              a.limit,
              (e) => e,
            )
      return { version, section: a.section, ...records }
    }),
})
export const getElementField = defineCapability({
  name: 'get_element_field',
  title: '读取元素原文字段',
  group: 'read',
  where: 'doc',
  effect: 'read',
  description:
    '按 JSON Pointer 读取原始元素字段（例如 /params/prompt、/results/0/value/text）；空路径读取根字段目录。字符串沿 next_text_offset，数组/对象沿 next_offset；续读必须带 expected_version。',
  input: z.object({
    id: z.string().min(1).max(200),
    field_path: z.string().max(2000).default(''),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(30),
    text_offset: z.number().int().min(0).default(0),
    text_limit: z.number().int().min(1).max(8000).default(4000),
    expected_version: z.string().optional(),
  }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const version = versionCheck(doc.ydoc, a.expected_version, a.offset > 0 || a.text_offset > 0)
      let value: unknown = need(doc, a.id)
      if (a.field_path && (!a.field_path.startsWith('/') || /~(?![01])/u.test(a.field_path)))
        throw new CapabilityError('invalid_field_path: 需要 JSON Pointer')
      for (const key of a.field_path
        ? a.field_path
            .slice(1)
            .split('/')
            .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
        : []) {
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, key))
          throw new CapabilityError('field_missing: 字段不存在')
        value = (value as Record<string, unknown>)[key]
      }
      const base = { version, id: a.id, field_path: a.field_path }
      if (typeof value === 'string') {
        let text = value.slice(a.text_offset, a.text_offset + a.text_limit)
        while (bytes(text) > MAX_BYTES - 2048) text = text.slice(0, Math.floor(text.length * 0.9))
        const next = a.text_offset + text.length
        return {
          ...base,
          type: 'string',
          value: text,
          total: value.length,
          complete: next >= value.length,
          ...(next < value.length ? { next_text_offset: next } : {}),
        }
      }
      if (value && typeof value === 'object') {
        const entries = Object.entries(value)
        const page = bounded(entries, a.offset, a.limit, ([key, v]) => ({
          key,
          value: preview(v, pointer(a.field_path, key)),
        }))
        const { items, ...rest } = page
        return { ...base, type: Array.isArray(value) ? 'array' : 'object', value: items, ...rest }
      }
      return { ...base, type: value === null ? 'null' : typeof value, value, complete: true }
    }),
})
export const readViewCapabilities = [getCanvasPage, getElementField]
