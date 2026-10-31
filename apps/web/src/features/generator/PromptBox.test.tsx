// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { createElement, deleteElements, setParam, updateElement, type PleinDoc } from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { createRef } from 'react'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useDocVersion } from '../../canvas/hooks'
import { mockResizeObserver } from '../../testing/browser'
import { act, fireEvent, renderApp, screen, waitFor, within } from '../../testing/render'
import { PromptBox } from './PromptBox'

const docs: PleinDoc[] = []
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy()
})

function setup(
  text: string,
  targets: Array<{ name: string; type?: string; params?: Record<string, unknown> }> = [
    { name: '小岚 · 测试' },
  ],
) {
  const doc = openDoc()
  docs.push(doc)
  const ids = targets.map((target) =>
    createElement(
      doc,
      node({
        nodeType: 'plein/' + (target.type ?? 'character'),
        name: target.name,
        params: target.params ?? {},
      }),
    ),
  )
  const selfId = createElement(
    doc,
    node({ nodeType: 'plein/text', name: '提示词正文', params: { text } }),
  )
  const ref = createRef<HTMLTextAreaElement>()
  const select = vi.fn()
  const zoomToFit = vi.fn()
  const engine = {
    doc,
    selection: { set: select },
    zoomToFit,
  } as unknown as Engine
  mockResizeObserver()
  vi.spyOn(HTMLTextAreaElement.prototype, 'getClientRects').mockReturnValue([
    new DOMRect(0, 0, 400, 100),
  ] as unknown as DOMRectList)
  function Harness() {
    useDocVersion(doc)
    return (
      <PromptBox
        ref={ref}
        engine={engine}
        selfId={selfId}
        value={String(doc.get(selfId)?.params?.text ?? '')}
        presets={[]}
        placeholder=""
        onChange={(value) => {
          setParam(doc, selfId, 'text', value)
          doc.flush()
        }}
        onPreset={() => {}}
      />
    )
  }
  const rendered = renderApp(<Harness />)
  return {
    ...rendered,
    doc,
    engine,
    selfId,
    target: ids[0]!,
    select,
    zoomToFit,
    field: () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: '提示词' }),
    marks: () =>
      [...document.querySelectorAll('[data-testid="mention-highlights"] mark')].map((el) => ({
        text: el.textContent,
        state: el.getAttribute('data-state'),
      })),
    remote: (value: string) =>
      act(() => {
        setParam(doc, selfId, 'text', value)
        doc.flush()
      }),
  }
}

it('正文和展开编辑器标记引用，IME 确认不误选且保留原文', async () => {
  const original = '清晨，@小岚 · 测试 在@雨后木桌旁看着@玻璃杯。待补充 @不存在#0。'
  const f = setup(original, [
    { name: '小岚 · 测试' },
    { name: '雨后木桌', type: 'scene' },
    { name: '玻璃杯', type: 'prop' },
  ])
  expect(f.marks().map((mark) => mark.text)).toEqual([
    '@小岚 · 测试',
    '@雨后木桌',
    '@玻璃杯',
    '@不存在#0',
  ])
  expect(f.marks().at(-1)?.state).toBe('missing')
  expect(f.field().value).toBe(original)

  await f.user.click(screen.getByRole('button', { name: '放大编辑提示词' }))
  const dialog = await screen.findByRole('dialog', { name: '编辑提示词' })
  const expanded = within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: '提示词' })
  await f.user.clear(expanded)
  await f.user.type(expanded, '@玻')
  const choices = await screen.findByRole('listbox', { name: '引用资产' })
  expect(dialog.contains(choices)).toBe(false)
  expect(within(choices).getByRole('option').textContent).toContain('道具')
  fireEvent.keyDown(expanded, { key: 'Enter', isComposing: true })
  expect(expanded.value).toBe('@玻')
  fireEvent.keyDown(expanded, { key: 'Enter', isComposing: false })
  await waitFor(() => expect(expanded.value).toBe('@玻璃杯 '))
  await f.user.keyboard('{Escape}')
  await waitFor(() => expect(f.field().value).toBe('@玻璃杯 '))
})

it('重名和相似旧名警示，新增精确目标后立即恢复', () => {
  const f = setup('@林夏 与 @林夏#1 看向 @新场景。', [{ name: '林夏' }, { name: '林夏' }])
  expect(f.marks().map((mark) => mark.state)).toEqual(['warning', 'resolved', 'missing'])
  act(() => {
    createElement(
      f.doc,
      node({ nodeType: 'plein/scene', name: '新场景', params: {}, x: 0, y: 0, w: 100, h: 80 }),
    )
    f.doc.flush()
  })
  expect(f.marks().map((mark) => mark.state)).toEqual(['warning', 'resolved', 'resolved'])
})

it('重命名和删除显示失效，撤销重做恢复对应引用状态', () => {
  const f = setup('清晨，@小岚 · 测试 走进院子。', [{ name: '小岚 · 测试' }])
  f.doc.undo.stopCapturing()
  act(() => {
    updateElement(f.doc, f.target, { name: '小岚 · 新名称' })
    f.doc.flush()
  })
  expect(f.marks()[0]?.state).toBe('missing')
  expect(document.body.textContent).toContain('未找到：')
  act(() => {
    f.doc.undo.undo()
    f.doc.flush()
  })
  expect(f.marks()[0]?.state).toBe('resolved')
  act(() => {
    f.doc.undo.redo()
    f.doc.flush()
  })
  expect(f.marks()[0]?.state).toBe('missing')
  act(() => {
    f.doc.undo.undo()
    f.doc.flush()
  })
  f.doc.undo.stopCapturing()
  act(() => {
    deleteElements(f.doc, [f.target])
    f.doc.flush()
  })
  expect(f.marks()[0]?.state).toBe('missing')
  act(() => {
    f.doc.undo.undo()
    f.doc.flush()
  })
  expect(f.marks()[0]?.state).toBe('resolved')
})

it('普通点击继续编辑，组合点击定位引用且不修改正文', () => {
  const original = '清晨，@小岚 · 测试 走进院子。'
  const f = setup(original)
  f.field().setSelectionRange(4, 4)
  fireEvent.click(f.field())
  expect(f.select).not.toHaveBeenCalled()
  f.field().setSelectionRange(4, 4)
  fireEvent.click(f.field(), { ctrlKey: true })
  expect(f.select).toHaveBeenCalledWith([f.target])
  expect(f.zoomToFit).toHaveBeenCalledWith([f.target])
  expect(f.field().value).toBe(original)
})

it('保持焦点跟随远端正文和引用，继续输入不覆盖，远端清空关闭补全', async () => {
  const f = setup('最初正文')
  f.field().focus()
  f.remote('同伴写入 @小岚 · 测试。')
  expect(f.field().value).toBe('同伴写入 @小岚 · 测试。')
  expect(document.activeElement).toBe(f.field())
  expect(f.marks().map((mark) => mark.text)).toEqual(['@小岚 · 测试'])
  f.field().setSelectionRange(f.field().value.length, f.field().value.length)
  await f.user.type(f.field(), '继续')
  expect(f.doc.get(f.selfId)?.params?.text).toBe('同伴写入 @小岚 · 测试。继续')

  await f.user.clear(f.field())
  await f.user.type(f.field(), '@小')
  expect(await screen.findByRole('listbox', { name: '引用资产' })).not.toBeNull()
  f.remote('同伴清空了引用')
  expect(f.field().value).toBe('同伴清空了引用')
  expect(screen.queryByRole('listbox', { name: '引用资产' })).toBeNull()
  expect(f.marks()).toEqual([])
})

it('远端插删前缀保留 emoji 中间光标和反向选区，后续输入落在原位置', async () => {
  const f = setup('雨后😀春天的画面')
  f.field().focus()
  f.field().setSelectionRange(6, 6)
  f.remote('序章\n雨后😀春天的画面')
  expect([f.field().selectionStart, f.field().selectionEnd]).toEqual([9, 9])
  await f.user.keyboard('！')
  expect(f.doc.get(f.selfId)?.params?.text).toBe('序章\n雨后😀春天！的画面')

  f.field().setSelectionRange(7, 9, 'backward')
  f.remote('雨后😀春天！的画面')
  expect([f.field().selectionStart, f.field().selectionEnd, f.field().selectionDirection]).toEqual([
    4,
    6,
    'backward',
  ])
  await f.user.keyboard('夏日')
  expect(f.doc.get(f.selfId)?.params?.text).toBe('雨后😀夏日！的画面')
})

it('放大提示词跟随远端，关闭后与行内一致', async () => {
  const f = setup('最初正文')
  await f.user.click(screen.getByRole('button', { name: '放大编辑提示词' }))
  const dialog = await screen.findByRole('dialog', { name: '编辑提示词' })
  const expanded = within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: '提示词' })
  f.remote('放大时收到的远端正文')
  expect(expanded.value).toBe('放大时收到的远端正文')
  expanded.setSelectionRange(expanded.value.length, expanded.value.length)
  await f.user.type(expanded, '，补充说明')
  await f.user.keyboard('{Escape}')
  await waitFor(() => expect(f.field().value).toBe('放大时收到的远端正文，补充说明'))
})

it('组词不被远端刷新打断，确认不重复插字，失焦后恢复远端同步', () => {
  const f = setup('最初正文')
  const input = f.field()
  input.focus()
  fireEvent.compositionStart(input, { data: '' })
  fireEvent.change(input, { target: { value: '正在组词' } })
  expect(f.doc.get(f.selfId)?.params?.text).toBe('正在组词')
  f.remote('同伴的远端正文')
  expect(input.value).toBe('正在组词')
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  expect(document.activeElement).toBe(input)

  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
    input,
    '确认后的完整正文',
  )
  fireEvent.compositionEnd(input, { data: '完整正文' })
  fireEvent.input(input, {
    data: '完整正文',
    inputType: 'insertCompositionText',
    isComposing: false,
  })
  expect(input.value).toBe('确认后的完整正文')
  expect(f.doc.get(f.selfId)?.params?.text).toBe('确认后的完整正文')
  fireEvent.blur(input)
  f.remote('组词结束后的新正文')
  expect(input.value).toBe('组词结束后的新正文')
})

it('@ 菜单分类搜索不修改正文，选择后保留原内容并还焦点', async () => {
  const targets = [
    { name: '小岚 · 测试' },
    ...Array.from({ length: 12 }, (_, index) => ({ name: '人物' + (index + 1) })),
  ]
  const f = setup('@小岚 · 测试 与 ', targets)
  f.field().focus()
  f.field().setSelectionRange(f.field().value.length, f.field().value.length)
  await f.user.type(f.field(), '@')
  const menu = await screen.findByRole('dialog', { name: '引用素材' })
  expect(menu.textContent).toContain('已引用')
  for (const name of ['图片', '视频', '音频', '资产'])
    expect(within(menu).getByRole('option', { name })).not.toBeNull()
  await f.user.click(within(menu).getByRole('option', { name: '资产' }))
  expect(within(menu).getAllByRole('option')).toHaveLength(13)
  const search = within(menu).getByRole<HTMLInputElement>('textbox', { name: '搜索引用素材' })
  await f.user.type(search, '人物11')
  expect(within(menu).getAllByRole('option')).toHaveLength(1)
  expect(f.field().value).toBe('@小岚 · 测试 与 @')
  fireEvent.keyDown(search, { key: 'Enter' })
  await waitFor(() => expect(f.field().value).toBe('@小岚 · 测试 与 @人物11 '))
  expect(document.activeElement).toBe(f.field())
})

it('邮箱、转义说明不触发补全或缺失提示，正文按原样保存', async () => {
  const f = setup('', [{ name: 'example.com' }, { name: '小岚' }])
  const text = '联系 test@example.com；说明 \\@小岚；@@不存在'
  await f.user.type(f.field(), text)
  expect(f.marks()).toEqual([])
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(document.body.textContent).not.toContain('未找到：')
  expect(f.doc.get(f.selfId)?.params?.text).toBe(text)
})

it('重名角色档案补全保留消歧编号，引用缩略图来自所选时期', async () => {
  const targets = ['a', 'b'].map((image) => ({
    name: '林夏',
    params: {
      profile: {
        periods: [
          {
            id: 'young',
            name: '青年',
            aliases: [],
            description: '青年身份',
            images: [image.repeat(64)],
            voice: null,
            voiceStates: [],
            outfits: [],
          },
        ],
        expressions: [],
      },
    },
  }))
  const f = setup('', targets)
  const second = [...f.doc.elements()]
    .filter((el) => el.name === '林夏')
    .sort((a, b) => a.id.localeCompare(b.id))[1]!
  await f.user.type(f.field(), '@林夏#2/青')
  expect(await screen.findByRole('option', { name: /青年/ })).toBeTruthy()
  await f.user.keyboard('{Enter}')
  await waitFor(() => expect(f.field().value).toBe('@林夏#2/青年 '))
  const chip = screen.getByRole('button', { name: '林夏#2（青年）' })
  const expected = (second.params!.profile as { periods: Array<{ images: string[] }> }).periods[0]!
    .images[0]!
  expect(chip.querySelector('img')?.getAttribute('src')).toContain(expected)
  await f.user.click(chip)
  expect(f.select).toHaveBeenLastCalledWith([second.id])
})
