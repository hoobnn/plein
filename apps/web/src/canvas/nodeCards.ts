import { type Engine, NODE_LAYOUT } from '@plein/canvas-core'
import { adoptResult, type CanvasElement, currentResult, type RunStatus } from '@plein/doc'
import { ASSET_NODE_TYPES, presetsFor, STORYBOARD_TYPE } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { useCatalog } from '../stores/catalog'
import { useStale } from '../stores/stale'
import { type IconName, iconElement } from '../ui/icons'
import { findNode, isPure, promptKey, targetImages } from './nodes'
import { shotsOf } from './storyboard'

type PromptPreset = Catalog['prompts'][number]

export interface NodeCardActions {
  run(id: string): void
  cancel(id: string): void
  /** 空节点上的“尝试”：套用提示词预设并聚焦生成器 */
  applyPreset(id: string, preset: PromptPreset): void
  /** 资产卡上参考图缩略图的地址 */
  thumbUrl(assetId: string): string
}

interface Card {
  root: HTMLDivElement
  glyph: HTMLSpanElement
  title: HTMLSpanElement
  status: HTMLSpanElement
  nav: HTMLSpanElement
  count: HTMLSpanElement
  body: HTMLDivElement
  progress: HTMLDivElement
  /** 上次渲染的签名，没变化就不碰 DOM */
  sig: string
}

const STATUS_TEXT: Record<RunStatus, string> = {
  queued: '排队中',
  running: '生成中',
  succeeded: '',
  failed: '失败',
  canceled: '已取消',
}

/** 按输出类型的图标，标题前和空节点中央用 */
const GLYPHS: Record<string, IconName> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  text: 'text',
  json: 'json',
}

/** 卡片上的按钮：图标按钮传 icon，文字按钮传 text */
function button(cls: string, label: string, content: { text: string } | { icon: IconName }) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = cls
  b.title = label
  b.setAttribute('aria-label', label)
  if ('icon' in content) b.appendChild(iconElement(content.icon, 14))
  else b.textContent = content.text
  return b
}

function glyphOf(el: CanvasElement, kind: string): IconName {
  if (el.nodeType === STORYBOARD_TYPE) return 'story'
  if (el.nodeType && ASSET_NODE_TYPES.has(el.nodeType)) return 'character'
  return GLYPHS[kind] ?? 'text'
}

/**
 * 节点卡片的 DOM 层（正常细节下）：
 * - 标题行在卡片外上方：类型图标、名称，右侧是状态和候选切换；
 * - 卡片本体就是结果（图片 / 视频封面由 GPU 画，这里透明），没有结果时显示类型图标和“尝试”预设；
 * - 生成中在卡片中央显示进度和取消，失败显示原因和重试。
 * 卡片本身不接收指针事件（拖动、选择照常交给画布），只有按钮可点。
 */
export class NodeCards {
  private cards = new Map<string, Card>()
  private disposers: Array<() => void> = []

  constructor(
    private engine: Engine,
    private root: HTMLElement,
    private actions: NodeCardActions,
  ) {
    this.disposers.push(
      engine.onViewChange(() => this.sync()),
      engine.selection.onChange(() => this.sync()),
      useCatalog.subscribe(() => {
        for (const c of this.cards.values()) c.sig = ''
        this.sync()
      }),
      useStale.subscribe(() => this.sync()),
    )
    this.sync()
  }

  sync() {
    const { engine } = this
    const want = new Set<string>()
    if (engine.highDetail) {
      for (const id of engine.visibleIds) {
        if (engine.scene.get(id)?.kind === 'node') want.add(id)
      }
    }
    for (const [id, c] of this.cards) {
      if (!want.has(id)) {
        c.root.remove()
        this.cards.delete(id)
      }
    }
    for (const id of want) {
      const el = engine.scene.get(id)!
      const rect = engine.scene.rect(id)
      if (!rect) continue
      let card = this.cards.get(id)
      if (!card) {
        card = this.create(id)
        this.cards.set(id, card)
      }
      card.root.style.transform = `translate(${rect.x}px, ${rect.y}px)`
      card.root.style.width = `${rect.w}px`
      card.root.style.height = `${rect.h}px`
      this.render(card, { ...el, ...rect }, engine.selection.has(id))
    }
  }

  destroy() {
    for (const d of this.disposers) d()
    for (const c of this.cards.values()) c.root.remove()
    this.cards.clear()
  }

  private create(id: string): Card {
    const root = document.createElement('div')
    root.className = 'plein-node'
    root.style.setProperty('--node-title', `${NODE_LAYOUT.title}px`)

    const head = document.createElement('div')
    head.className = 'plein-node-head'
    const glyph = document.createElement('span')
    glyph.className = 'plein-node-glyph'
    const title = document.createElement('span')
    title.className = 'plein-node-title'
    const status = document.createElement('span')
    status.className = 'plein-node-status'
    const nav = document.createElement('span')
    nav.className = 'plein-node-nav'
    const prev = button('plein-node-btn', '上一个结果', { icon: 'chevronLeft' })
    const count = document.createElement('span')
    count.className = 'plein-node-count'
    const next = button('plein-node-btn', '下一个结果', { icon: 'chevronRight' })
    nav.append(prev, count, next)
    head.append(glyph, title, status, nav)

    const body = document.createElement('div')
    body.className = 'plein-node-body'
    const progress = document.createElement('div')
    progress.className = 'plein-node-progress'

    root.append(head, body, progress)
    this.root.appendChild(root)

    const step = (d: number) => {
      const el = this.engine.scene.get(id)
      if (!el) return
      const list = primaryResults(el)
      const cur = currentResult(el, list[0]?.port)
      const i = list.findIndex((r) => r.id === cur?.id)
      const target = list[(i + d + list.length) % list.length]
      if (target) adoptResult(this.engine.doc, id, target.id)
    }
    prev.addEventListener('click', () => step(-1))
    next.addEventListener('click', () => step(1))

    return { root, glyph, title, status, nav, count, body, progress, sig: '' }
  }

  private render(card: Card, el: CanvasElement, selected: boolean) {
    const catalog = useCatalog.getState().catalog
    const info = findNode(catalog, el.nodeType)
    const pure = info ? isPure(info) : false
    const pk = info ? promptKey(info) : undefined
    const key = pure ? pk : undefined
    const thumbs =
      el.nodeType && ASSET_NODE_TYPES.has(el.nodeType) ? targetImages(this.engine, el) : []
    const board = el.nodeType === STORYBOARD_TYPE
    const sig = JSON.stringify([
      thumbs,
      el.w,
      el.h,
      el.name,
      el.run,
      useStale.getState().nodes.get(el.id),
      el.adopted,
      el.results?.length,
      el.results?.[0]?.id,
      pk ? el.params?.[pk] : undefined,
      selected,
      Boolean(info),
      board ? el.params?.shots : undefined,
    ])
    if (sig === card.sig) return
    card.sig = sig

    const run = el.run
    const active = run?.status === 'running' || run?.status === 'queued'
    const kind = info?.outputs[0]?.type ?? ''
    card.root.dataset.status = run?.status ?? 'idle'
    card.root.dataset.kind = kind
    card.root.dataset.selected = String(selected)
    card.title.textContent = el.name ?? info?.title ?? el.nodeType ?? '节点'
    card.glyph.replaceChildren(iconElement(glyphOf(el, kind), 14))

    let status = run && !(run.status === 'running' && !run.progress) ? STATUS_TEXT[run.status] : ''
    if (run?.status === 'running' && run.progress) status += ` ${Math.round(run.progress * 100)}%`
    // 参数或上游改过、结果已经过期：运行中、失败时以运行状态为准
    const stale =
      active || run?.status === 'failed' ? undefined : useStale.getState().nodes.get(el.id)
    if (stale) status = stale === 'self' ? '需要重跑' : '上游已改'
    card.root.dataset.stale = stale ?? ''
    card.status.title = stale
      ? stale === 'self'
        ? '参数或输入改过，当前结果不是按现在的设置生成的'
        : '上游节点改过，重跑上游后这里也要重跑'
      : ''
    card.status.textContent = status
    card.progress.style.width = active ? `${Math.max(4, (run?.progress ?? 0) * 100)}%` : '0'

    const list = primaryResults(el)
    const cur = currentResult(el, list[0]?.port)
    const v = cur?.value
    card.nav.hidden = list.length < 2
    card.count.textContent = `${list.findIndex((r) => r.id === cur?.id) + 1}/${list.length}`

    card.body.className = 'plein-node-body'
    if (!info) {
      card.body.textContent = `未安装的节点类型：${el.nodeType ?? '未知'}`
      card.body.classList.add('is-hint')
    } else if (thumbs.length || (el.nodeType && ASSET_NODE_TYPES.has(el.nodeType))) {
      // 资产卡：参考图一字排开，下面是设定
      const strip = document.createElement('div')
      strip.className = 'plein-node-thumbs'
      for (const id of thumbs.slice(0, 4)) {
        const img = document.createElement('img')
        img.src = this.actions.thumbUrl(id)
        img.alt = ''
        strip.appendChild(img)
      }
      if (!thumbs.length) strip.textContent = '从左侧连入 2–4 张多角度参考图'
      const text = document.createElement('div')
      text.textContent = String(el.params?.description ?? '') || '在下方写设定'
      text.className = el.params?.description ? '' : 'plein-node-muted'
      card.body.replaceChildren(strip, text)
      card.body.classList.add('is-text')
    } else if (board && !active && shotsOf(el).length) {
      // 分镜：镜号 / 景别 / 画面的小表，双击打开完整表格
      const shots = shotsOf(el)
      const ol = document.createElement('ol')
      ol.className = 'plein-node-shots'
      for (const s of shots.slice(0, 12)) {
        const li = document.createElement('li')
        const no = document.createElement('span')
        no.textContent = String(s.no).padStart(2, '0')
        const size = document.createElement('span')
        size.textContent = s.shotSize
        const desc = document.createElement('span')
        desc.textContent = s.description
        li.append(no, size, desc)
        ol.appendChild(li)
      }
      const more = document.createElement('div')
      more.className = 'plein-node-muted'
      more.textContent = `${shots.length} 个镜头 · ${shots.reduce((t, s) => t + s.duration, 0)} 秒 · 双击打开分镜表`
      card.body.replaceChildren(ol, more)
      card.body.classList.add('is-text')
    } else if (key) {
      const text = String(el.params?.[key] ?? '')
      card.body.textContent = text || '双击写下文本，连到下游节点'
      card.body.classList.add('is-text')
      card.body.classList.toggle('is-hint', !text)
    } else if (active) {
      this.renderRunning(card, el)
    } else if (run?.status === 'failed') {
      this.renderFailed(card, el, run.error)
    } else if (v?.type === 'text') {
      card.body.textContent = v.text
      card.body.classList.add('is-text')
    } else if (v?.type === 'json') {
      card.body.textContent = JSON.stringify(v.value, null, 2)
      card.body.classList.add('is-text')
    } else if (v) {
      // 图片、视频封面、音频波形由 GPU 画；视频右下角标一个播放提示
      card.body.replaceChildren()
      if (v.type === 'video') {
        const tag = document.createElement('span')
        tag.className = 'ui-badge'
        tag.append(iconElement('play', 12), '双击播放')
        card.body.appendChild(tag)
      }
      card.body.classList.add('is-media')
    } else {
      // 已经写了提示词就不再推荐预设
      const written = pk ? String(el.params?.[pk] ?? '').trim() : ''
      this.renderEmpty(card, el, kind, written ? [] : presetsFor(catalog?.prompts ?? [], info))
    }
  }

  /** 空节点：中央类型图标，下面列几个可直接套用的预设 */
  private renderEmpty(card: Card, el: CanvasElement, kind: string, presets: PromptPreset[]) {
    const center = document.createElement('div')
    center.className = 'plein-node-empty'
    const icon = document.createElement('span')
    icon.className = 'plein-node-empty-icon'
    icon.appendChild(iconElement(glyphOf(el, kind), 24))
    center.appendChild(icon)
    const room = el.h >= 150 && el.w >= 160
    if (room && presets.length) {
      const tries = document.createElement('div')
      tries.className = 'plein-node-tries'
      const label = document.createElement('span')
      label.textContent = '尝试：'
      tries.appendChild(label)
      for (const p of presets.slice(0, el.h >= 220 ? 3 : 2)) {
        const b = button('plein-node-try', p.description ?? p.title, { text: p.title })
        b.addEventListener('click', (e) => {
          e.stopPropagation()
          this.actions.applyPreset(el.id, p)
        })
        tries.appendChild(b)
      }
      center.appendChild(tries)
    }
    card.body.replaceChildren(center)
    card.body.classList.add('is-empty')
  }

  private renderRunning(card: Card, el: CanvasElement) {
    const box = document.createElement('div')
    box.className = 'plein-node-running'
    const spin = document.createElement('span')
    spin.className = 'ui-spinner'
    const text = document.createElement('span')
    const p = el.run?.progress
    text.textContent =
      el.run?.status === 'queued' ? '排队中…' : p ? `生成中 ${Math.round(p * 100)}%` : '生成中…'
    const cancel = button('plein-node-action', '取消生成', { text: '取消' })
    cancel.addEventListener('click', (e) => {
      e.stopPropagation()
      this.actions.cancel(el.id)
    })
    box.append(spin, text, cancel)
    card.body.replaceChildren(box)
    card.body.classList.add('is-running')
  }

  private renderFailed(card: Card, el: CanvasElement, error?: string) {
    const box = document.createElement('div')
    box.className = 'plein-node-failed'
    const text = document.createElement('span')
    text.textContent = error ?? '生成失败'
    const retry = button('plein-node-action', '重试', { text: '重试' })
    retry.addEventListener('click', (e) => {
      e.stopPropagation()
      this.engine.selection.set([el.id])
      this.actions.run(el.id)
    })
    box.append(text, retry)
    card.body.replaceChildren(box)
    card.body.classList.add('is-failed')
  }
}

/** 主输出端口的结果（卡片只展示和切换它） */
function primaryResults(el: CanvasElement) {
  const port = el.ports?.outputs[0]?.id
  return (el.results ?? []).filter((r) => port === undefined || r.port === port)
}
