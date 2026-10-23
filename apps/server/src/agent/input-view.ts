import { createHash } from 'node:crypto'
import { CapabilityError } from '@plein/capabilities'
import type { PreparedInput } from '@plein/protocol'
import { z } from 'zod'

const MAX_BYTES = 24 * 1024
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value, null, 1))
const pointer = (path: string, key: string | number) =>
  `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`

export const InspectNodeInput = z.object({
  id: z.string().min(1).max(200),
  field_path: z
    .string()
    .max(2000)
    .default('')
    .describe('JSON Pointer；例如 /prompt、/refs、/model'),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(30),
  text_offset: z.number().int().min(0).default(0),
  text_limit: z.number().int().min(1).max(8000).default(4000),
  expected_version: z.string().max(128).optional().describe('续读时带第一页返回的 version'),
})

function preview(value: unknown, fieldPath: string): unknown {
  if (typeof value === 'string' && value.length > 400)
    return {
      preview: value.slice(0, 400),
      characters: value.length,
      field_path: fieldPath,
      complete: false,
    }
  if (value && typeof value === 'object')
    return {
      type: Array.isArray(value) ? 'array' : 'object',
      total: Object.keys(value).length,
      field_path: fieldPath,
      complete: false,
    }
  return value
}

/** 只展示有界目录或原文分页；准备时间变化不影响续读，实际输入变化必须重新开始。 */
export function preparedInputPage(input: PreparedInput, a: z.output<typeof InspectNodeInput>) {
  const { preparedAt: _preparedAt, ...stable } = input
  const version = createHash('sha256').update(JSON.stringify(stable)).digest('hex')
  if ((a.offset > 0 || a.text_offset > 0) && !a.expected_version)
    throw new CapabilityError('expected_version_required: 续读必须携带第一页的 expected_version')
  if (a.expected_version && version !== a.expected_version)
    throw new CapabilityError('input_changed: 实际输入已变化，请重新读取第一页')
  if (a.field_path && (!a.field_path.startsWith('/') || /~(?![01])/u.test(a.field_path)))
    throw new CapabilityError('invalid_field_path: 需要 JSON Pointer')

  let value: unknown = input
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
  const base = {
    id: a.id,
    status: input.status,
    ...(input.inputHash ? { inputHash: input.inputHash } : {}),
    version,
    field_path: a.field_path,
  }
  if (typeof value === 'string') {
    let text = value.slice(a.text_offset, a.text_offset + a.text_limit)
    while (bytes({ ...base, value: text }) > MAX_BYTES - 1024)
      text = text.slice(0, Math.floor(text.length * 0.9))
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
    const items: Array<{ key: string; field_path: string; value: unknown }> = []
    for (const [key, v] of entries.slice(a.offset, a.offset + a.limit)) {
      const fieldPath = pointer(a.field_path, key)
      const item = { key, field_path: fieldPath, value: preview(v, fieldPath) }
      if (bytes({ ...base, value: [...items, item] }) > MAX_BYTES - 1024) break
      items.push(item)
    }
    if (a.offset < entries.length && !items.length)
      throw new CapabilityError('field_too_large: 请定位更具体的字段')
    const next = a.offset + items.length
    return {
      ...base,
      type: Array.isArray(value) ? 'array' : 'object',
      value: items,
      total: entries.length,
      offset: a.offset,
      complete: next >= entries.length,
      ...(next < entries.length ? { next_offset: next } : {}),
    }
  }
  return { ...base, type: value === null ? 'null' : typeof value, value, complete: true }
}
