import { describe, expect, it } from 'vite-plus/test'
import {
  credentialCardDirty,
  providerDirty,
  sameSettings,
  type CredentialCardDraft,
} from './providerDirty'

/** 已保存组的卡：标签与密钥输入都留空（不改） */
const savedCard = (over: Partial<CredentialCardDraft> = {}): CredentialCardDraft => ({
  key: 'cred-1',
  label: '',
  secrets: {},
  baseline: '',
  ...over,
})

describe('平台设置的脏检查', () => {
  it('值相同就算没改，键的顺序不影响判断', () => {
    expect(sameSettings({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true)
    expect(sameSettings({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(sameSettings({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(sameSettings({ a: 1 }, { a: '1' })).toBe(false)
    expect(sameSettings({}, {})).toBe(true)
    expect(sameSettings(undefined, {})).toBe(true)
  })

  it('改过值、密钥卡有草稿或正在编辑数字都算未保存', () => {
    expect(providerDirty({ a: 1 }, { a: 1 }, [], false)).toBe(false)
    expect(providerDirty({ a: 2 }, { a: 1 }, [], false)).toBe(true)
    expect(providerDirty({ a: 1 }, { a: 1 }, [savedCard()], false)).toBe(false)
    // 密钥输入非空算改动，留空（不修改）不算
    expect(providerDirty({ a: 1 }, { a: 1 }, [savedCard({ secrets: { k: 'v' } })], false)).toBe(
      true,
    )
    expect(providerDirty({ a: 1 }, { a: 1 }, [savedCard({ secrets: { k: '' } })], false)).toBe(
      false,
    )
    // 已保存组的标签输入非空算改动，留空不算
    expect(providerDirty({ a: 1 }, { a: 1 }, [savedCard({ label: '团队' })], false)).toBe(true)
    expect(providerDirty({ a: 1 }, { a: 1 }, [savedCard({ label: '  ' })], false)).toBe(false)
    expect(providerDirty({ a: 1 }, { a: 1 }, [], true)).toBe(true)
  })

  it('没有基线的新卡总是未保存，预填卡改过才算', () => {
    // 手动添加的新卡：还没保存过，总是算未保存
    expect(credentialCardDirty({ key: 'draft-0', label: '', secrets: {} })).toBe(true)
    // 新平台的预填卡：没动过不算，改了标签或填了密钥才算
    const seeded: CredentialCardDraft = {
      key: 'draft-0',
      label: '默认',
      secrets: {},
      baseline: '默认',
    }
    expect(credentialCardDirty(seeded)).toBe(false)
    expect(credentialCardDirty({ ...seeded, label: '个人' })).toBe(true)
    expect(credentialCardDirty({ ...seeded, secrets: { k: 'v' } })).toBe(true)
    // 改了基线以外的空白字符也按原值算：trim 后与基线一致就不算
    expect(credentialCardDirty({ ...seeded, label: ' 默认 ' })).toBe(false)
  })

  it('服务端回传的键序与本地不同，不误报未保存', () => {
    // 删掉一个字段再填回去：新键排到了末尾，与服务端保存的顺序不同
    expect(
      providerDirty({ queueMs: 20, latencyMs: 300 }, { latencyMs: 300, queueMs: 20 }, [], false),
    ).toBe(false)
  })

  it('嵌套对象按内容比较，不按引用', () => {
    const saved = { nested: { a: 1, b: { c: 2 } } }
    // 保存响应里同样的内容是另一个对象，不能当成改动
    expect(providerDirty({ nested: { a: 1, b: { c: 2 } } }, saved, [], false)).toBe(false)
    // 嵌套里的键序不同也不算改动
    expect(providerDirty({ nested: { b: { c: 2 }, a: 1 } }, saved, [], false)).toBe(false)
    // 嵌套里真的改了才算
    expect(providerDirty({ nested: { a: 1, b: { c: 3 } } }, saved, [], false)).toBe(true)
    expect(providerDirty({ nested: { a: 1 } }, saved, [], false)).toBe(true)
  })

  it('数组按顺序逐项比较', () => {
    const saved = { list: [1, { a: 2 }, 'x'] }
    expect(providerDirty({ list: [1, { a: 2 }, 'x'] }, saved, [], false)).toBe(false)
    // 顺序变了算改动
    expect(providerDirty({ list: [{ a: 2 }, 1, 'x'] }, saved, [], false)).toBe(true)
    // 长度变了算改动
    expect(providerDirty({ list: [1, { a: 2 }] }, saved, [], false)).toBe(true)
    // 元素内容变了算改动
    expect(providerDirty({ list: [1, { a: 3 }, 'x'] }, saved, [], false)).toBe(true)
  })

  it('对象与数组互相替换算改动', () => {
    expect(sameSettings({ a: [] }, { a: {} })).toBe(false)
    expect(sameSettings({ a: [1] }, { a: 1 })).toBe(false)
  })

  it('保存响应经过 JSON 往返后仍算没改', () => {
    // 服务端回传的是 JSON 解析出来的对象，与本地编辑后的对象没有同一引用
    const local = { nested: { a: 1, b: [1, 2] }, top: 'x' }
    const roundTripped = JSON.parse(JSON.stringify(local)) as typeof local
    expect(roundTripped).not.toBe(local)
    expect(roundTripped.nested).not.toBe(local.nested)
    expect(providerDirty(local, roundTripped, [], false)).toBe(false)
  })
})
