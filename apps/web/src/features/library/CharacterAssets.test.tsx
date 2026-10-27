// @vitest-environment happy-dom
import type { LibraryImage } from '@plein/protocol'
import { useState } from 'react'
import { describe, expect, it } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { fireEvent, renderApp, screen, waitFor, within } from '../../testing/render'
import { CharacterAssets } from './CharacterAssets'
import type { CanvasMedia } from './canvas'

const png = (name: string) => new File(['image'], name, { type: 'image/png' })

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** 上传接口：按调用顺序发放素材 id，也可以挂起或直接失败。 */
function mockUploads(handler: (name: string) => Response | Promise<Response>) {
  mockFetch(async (request) => {
    if (request.method !== 'POST') return undefined
    if (new URL(request.url).pathname !== '/api/assets') return undefined
    return handler(decodeURIComponent(request.headers.get('x-file-name') ?? ''))
  })
}

function Harness({
  initial = [],
  media = [],
  onBusy,
}: {
  initial?: LibraryImage[]
  media?: CanvasMedia[]
  onBusy?(busy: boolean): void
}) {
  const [images, setImages] = useState<LibraryImage[]>(initial)
  const [selected, setSelected] = useState<string | null>(null)
  // 上传占用由面板向上汇报、再回灌给四类格子；这里保持同样的回路。
  const [busy, setBusy] = useState(false)
  return (
    <>
      <output data-testid="images">{JSON.stringify(images)}</output>
      <CharacterAssets
        images={images}
        media={media}
        selected={selected}
        onSelect={(assetId) => setSelected(assetId)}
        onChange={(update) => setImages((current) => update(current))}
        busy={busy}
        onBusyChange={(value) => {
          setBusy(value)
          onBusy?.(value)
        }}
      />
    </>
  )
}

const tile = (id: string) => document.querySelector(`[data-character-slot="${id}"]`) as HTMLElement
const images = () => JSON.parse(screen.getByTestId('images').textContent ?? '[]') as LibraryImage[]

describe('角色形象的四类图片', () => {
  it('四类槽位可上传与替换，图片落在对应分类', async () => {
    let seq = 0
    mockUploads(() => json({ id: `asset_${++seq}` }, 201))
    renderApp(<Harness />)

    fireEvent.change(within(tile('full_body')).getByLabelText('上传全身定妆图'), {
      target: { files: [png('full.png')] },
    })
    await waitFor(() => expect(images()).toEqual([{ slot: 'full_body', assetId: 'asset_1' }]))
    expect(
      within(tile('full_body')).getByRole('img', { name: '全身定妆图' }).getAttribute('src'),
    ).toContain('asset_1')

    fireEvent.change(within(tile('portrait')).getByLabelText('上传肖像／半身图'), {
      target: { files: [png('portrait.png')] },
    })
    await waitFor(() =>
      expect(images()).toEqual([
        { slot: 'full_body', assetId: 'asset_1' },
        { slot: 'portrait', assetId: 'asset_2' },
      ]),
    )

    // 替换只换这一类，不动其它分类，也不留下重复条目。
    fireEvent.change(within(tile('portrait')).getByLabelText('上传肖像／半身图'), {
      target: { files: [png('portrait2.png')] },
    })
    await waitFor(() =>
      expect(images()).toEqual([
        { slot: 'full_body', assetId: 'asset_1' },
        { slot: 'portrait', assetId: 'asset_3' },
      ]),
    )
  })

  it('移除后分类空出来，重新上传能补回', async () => {
    let seq = 0
    mockUploads(() => json({ id: `asset_${++seq}` }, 201))
    renderApp(<Harness />)

    fireEvent.change(within(tile('face_grid')).getByLabelText('上传情绪九宫格'), {
      target: { files: [png('grid.png')] },
    })
    await waitFor(() => expect(images()).toEqual([{ slot: 'face_grid', assetId: 'asset_1' }]))

    fireEvent.click(within(tile('face_grid')).getByRole('button', { name: '移除' }))
    await waitFor(() => expect(images()).toEqual([]))
    expect(within(tile('face_grid')).queryByRole('img', { name: '情绪九宫格' })).toBeNull()

    fireEvent.change(within(tile('face_grid')).getByLabelText('上传情绪九宫格'), {
      target: { files: [png('grid2.png')] },
    })
    await waitFor(() => expect(images()).toEqual([{ slot: 'face_grid', assetId: 'asset_2' }]))
  })

  it('上传失败给出明确提示，恢复后重新上传即可补上', async () => {
    let broken = true
    mockUploads(() =>
      broken
        ? json({ error: 'upload_failed', message: '素材服务暂不可用' }, 503)
        : json({ id: 'asset_ok' }, 201),
    )
    renderApp(<Harness />)

    const full = within(tile('full_body'))
    fireEvent.change(full.getByLabelText('上传全身定妆图'), {
      target: { files: [png('full.png')] },
    })
    await waitFor(() => expect(full.getByRole('alert').textContent).toContain('素材服务暂不可用'))
    expect(images()).toEqual([])

    broken = false
    fireEvent.change(full.getByLabelText('上传全身定妆图'), {
      target: { files: [png('full.png')] },
    })
    await waitFor(() => expect(images()).toEqual([{ slot: 'full_body', assetId: 'asset_ok' }]))
    expect(full.queryByRole('alert')).toBeNull()
  })

  it('大图加载失败有重试入口，重试后换一张图重新加载', async () => {
    mockUploads(() => json({ id: 'asset_1' }, 201))
    renderApp(<Harness initial={[{ slot: 'full_body', assetId: 'asset_1' }]} />)

    const full = within(tile('full_body'))
    const image = full.getByRole('img', { name: '全身定妆图' })
    fireEvent.error(image)
    await waitFor(() => expect(full.getByText('图片加载失败').textContent).toBe('图片加载失败'))

    const retry = full.getByRole('button', { name: '重新加载全身定妆图' })
    fireEvent.click(retry)
    await waitFor(() => expect(full.queryByText('图片加载失败')).toBeNull())
    expect(full.getByRole('img', { name: '全身定妆图' })).toBeTruthy()
  })

  it('从画布补入的素材归入对应分类', async () => {
    mockUploads(() => json({ id: 'asset_1' }, 201))
    renderApp(
      <Harness
        media={[{ elId: 'el_1', assetId: 'canvas_1', kind: 'image', name: 'character-7.png' }]}
      />,
    )

    fireEvent.click(
      within(tile('character_3view')).getByRole('button', { name: '从画布选择角色设定图' }),
    )
    const pick = await screen.findByRole('button', { name: '选择图片「character-7.png」' })
    fireEvent.click(pick)
    await waitFor(() =>
      expect(images()).toEqual([{ slot: 'character_3view', assetId: 'canvas_1' }]),
    )
  })

  it('上传期间暂停其它入口，上传完成后恢复', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const uploading = new Promise<void>((resolve) => {
      started = resolve
    })
    mockUploads(async () => {
      started()
      await held
      return json({ id: 'asset_1' }, 201)
    })
    const busy: boolean[] = []
    renderApp(
      <Harness
        onBusy={(value) => busy.push(value)}
        media={[{ elId: 'el_1', assetId: 'canvas_1', kind: 'image', name: 'character-7.png' }]}
      />,
    )

    fireEvent.change(within(tile('full_body')).getByLabelText('上传全身定妆图'), {
      target: { files: [png('full.png')] },
    })
    await uploading
    await waitFor(() => expect(busy).toContain(true))

    // 本格正在上传，其余分类的入口都要停住，不能让用户以为已经生效。
    for (const [slot, label] of [
      ['portrait', '上传肖像／半身图'],
      ['face_grid', '上传情绪九宫格'],
      ['character_3view', '上传角色设定图'],
    ] as const) {
      expect((within(tile(slot)).getByLabelText(label) as HTMLInputElement).disabled).toBe(true)
    }
    const portrait = within(tile('portrait'))
    expect((portrait.getByLabelText('上传肖像／半身图') as HTMLInputElement).disabled).toBe(true)
    expect(
      (portrait.getByRole('button', { name: '从画布选择肖像／半身图' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect((portrait.getByRole('button', { name: '上传' }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    release()
    await waitFor(() => expect(images()).toEqual([{ slot: 'full_body', assetId: 'asset_1' }]))
    await waitFor(() =>
      expect(
        (within(tile('portrait')).getByLabelText('上传肖像／半身图') as HTMLInputElement).disabled,
      ).toBe(false),
    )
    expect(busy).toEqual([true, false])
  })

  it('24 张参考图满额时禁止再添加，并说明原因，已有分类仍可替换', async () => {
    mockUploads(() => json({ id: 'asset_new' }, 201))
    const initial = Array.from({ length: 24 }, (_, index) => ({
      slot: 'extra',
      assetId: `extra_${index}`,
    }))
    renderApp(<Harness initial={initial} />)

    // 提示必须在四类格子旁边，不能只藏在「其他参考」里。
    expect(
      screen.getByText('参考图已达 24 张上限，先移除一张再添加新的分类。').textContent,
    ).toContain('24 张上限')
    const full = within(tile('full_body'))
    expect((full.getByLabelText('上传全身定妆图') as HTMLInputElement).disabled).toBe(true)
    expect(full.getByRole('button', { name: '添加全身定妆图' }).getAttribute('title')).toContain(
      '已达 24 张上限',
    )
    expect((full.getByRole('button', { name: '上传' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('24 张满额时仍可把其他参考无损归入四类，分类占位后可替换', async () => {
    mockUploads(() => json({ id: 'asset_new' }, 201))
    const initial = Array.from({ length: 24 }, (_, index) => ({
      slot: 'extra',
      assetId: `extra_${index}`,
    }))
    renderApp(<Harness initial={initial} />)

    const extras = document.querySelector('details.lib-character-extras') as HTMLElement
    fireEvent.click(within(extras).getByRole('combobox', { name: '参考图 1 的分类' }))
    const option = await screen.findByRole('option', { name: '全身定妆图' })
    fireEvent.pointerDown(option)
    fireEvent.pointerUp(option)
    fireEvent.click(option)

    await waitFor(() => expect(images()).toContainEqual({ slot: 'full_body', assetId: 'extra_0' }))
    // 归类只换槽位，不新增也不丢失素材。
    expect(images()).toHaveLength(24)
    expect(images().filter((image) => image.slot === 'extra')).toHaveLength(23)
    // 有了占位图，这一类就能替换了；没占位的仍被上限挡住。
    expect(
      (within(tile('full_body')).getByRole('button', { name: '替换' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false)
    expect(
      (within(tile('portrait')).getByRole('button', { name: '上传' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })
})
