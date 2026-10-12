import { type Engine, NODE_LAYOUT, portPosition } from '@plein/canvas-core'
import { adoptResult, type CanvasElement, currentResult, type RunStatus } from '@plein/doc'
import { useCatalog } from '../stores/catalog'
import { ASSET_NODE_TYPES, STORYBOARD_TYPE } from '@plein/nodes'
import { findNode, isPure, promptKey, targetImages } from './nodes'
import { shotsOf } from './storyboard'

export interface NodeCardActions {
  run(id: string): void
  cancel(id: string): void
  /** 资产卡上参考图缩略图的地址 */
  thumbUrl(assetId: string): string
}

interface Card {
  root: HTMLDivElement
  title: HTMLSpanElement
  status: HTMLSpanElement
  progress: HTMLDivElement
  body: HTMLDivElement
  nav: HTMLSpanElement
  count: HTMLSpanElement
  action: HTMLButtonElement
  ports: HTMLDivElement
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

const MEDIA_TAG = { image: '', video: '▶ 视频', audio: '♪ 音频' } as const

function button(cls: string, label: string, text: string) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = cls
  b.title = label
  b.setAttribute('aria-label', label)
  b.textContent = text
  return b
}

/**
 * 节点卡片的 DOM 层（正常细节下）：标题、运行状态、文本结果、候选切换、生成按钮、端口名。
 * 图片 / 视频封面由 GPU 渲染器画在预览区，这里的预览区保持透明。
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
    root.style.setProperty('--node-head', `${NODE_LAYOUT.header}px`)
    root.style.setProperty('--node-foot', `${NODE_LAYOUT.footer}px`)
    root.style.setProperty('--node-pad', `${NODE_LAYOUT.pad}px`)

    const head = document.createElement('div')
    head.className = 'plein-node-head'
    const title = document.createElement('span')
    title.className = 'plein-node-title'
    const status = document.createElement('span')
    status.className = 'plein-node-status'
    const progress = document.createElement('div')
    progress.className = 'plein-node-progress'
    head.append(title, status, progress)

    const body = document.createElement('div')
    body.className = 'plein-node-body'

    const foot = document.createElement('div')
    foot.className = 'plein-node-foot'
    const nav = document.createElement('span')
    nav.className = 'plein-node-nav'
    const prev = button('plein-node-btn', '上一个结果', '‹')
    const count = document.createElement('span')
    count.className = 'plein-node-count'
    const next = button('plein-node-btn', '下一个结果', '›')
    nav.append(prev, count, next)
    const action = button('plein-node-run', '生成', '生成')
    foot.append(nav, action)

    const ports = document.createElement('div')
    ports.className = 'plein-node-ports'

    root.append(head, body, foot, ports)
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
    action.addEventListener('click', () => {
      const status = this.engine.scene.get(id)?.run?.status
      if (status === 'running' || status === 'queued') this.actions.cancel(id)
      else {
        this.engine.selection.set([id])
        this.actions.run(id)
      }
    })

    return { root, title, status, progress, body, nav, count, action, ports, sig: '' }
  }

  private render(card: Card, el: CanvasElement, selected: boolean) {
    const info = findNode(useCatalog.getState().catalog, el.nodeType)
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
      el.adopted,
      el.results?.length,
      el.results?.[0]?.id,
      pk ? el.params?.[pk] : undefined,
      selected,
      el.ports,
      Boolean(info),
      board ? el.params?.shots : undefined,
    ])
    if (sig === card.sig) return
    card.sig = sig

    const run = el.run
    const active = run?.status === 'running' || run?.status === 'queued'
    card.root.dataset.status = run?.status ?? 'idle'
    card.root.dataset.selected = String(selected)
    card.title.textContent = el.name ?? info?.title ?? el.nodeType ?? '节点'

    let status = run ? STATUS_TEXT[run.status] : ''
    if (run?.status === 'running' && run.progress) status += ` ${Math.round(run.progress * 100)}%`
    card.status.textContent = status
    card.progress.style.width = active ? `${Math.max(4, (run?.progress ?? 0) * 100)}%` : '0'

    // 预览区：文本结果、失败原因或空状态；图片类结果由 GPU 画，这里留空
    const list = primaryResults(el)
    const cur = currentResult(el, list[0]?.port)
    const v = cur?.value
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
    } else if (board && !active && shotsOf(el).length) {
      // 分镜：镜号 / 景别 / 画面的小表，双击打开完整表格
      const shots = shotsOf(el)
      const list = document.createElement('ol')
      list.className = 'plein-node-shots'
      for (const s of shots.slice(0, 12)) {
        const li = document.createElement('li')
        const no = document.createElement('span')
        no.textContent = String(s.no).padStart(2, '0')
        const size = document.createElement('span')
        size.textContent = s.shotSize
        const desc = document.createElement('span')
        desc.textContent = s.description
        li.append(no, size, desc)
        list.appendChild(li)
      }
      const more = document.createElement('div')
      more.className = 'plein-node-muted'
      more.textContent = `${shots.length} 个镜头 · ${shots.reduce((t, s) => t + s.duration, 0)} 秒 · 双击打开分镜表`
      card.body.replaceChildren(list, more)
    } else if (key) {
      const text = String(el.params?.[key] ?? '')
      card.body.textContent = text || '双击写下文本，连到下游节点'
      card.body.classList.toggle('is-hint', !text)
    } else if (run?.status === 'failed' && !active) {
      card.body.textContent = run.error ?? '生成失败'
      card.body.classList.add('is-error')
    } else if (v?.type === 'text') {
      card.body.textContent = v.text
    } else if (v?.type === 'json') {
      card.body.textContent = JSON.stringify(v.value, null, 2)
    } else if (v) {
      card.body.textContent = MEDIA_TAG[v.type]
      card.body.classList.add('is-media')
    } else {
      const prompt = pk ? String(el.params?.[pk] ?? '').trim() : ''
      card.body.textContent = active ? '' : prompt || '选中节点，在下方写提示词后生成'
      card.body.classList.add('is-hint')
    }

    card.nav.hidden = list.length < 2
    card.count.textContent = `${list.findIndex((r) => r.id === cur?.id) + 1}/${list.length}`

    card.action.hidden = !info || pure || !info.executable
    card.action.textContent = active ? '取消' : list.length ? '重新生成' : '生成'
    card.action.title = active ? '取消' : '生成'
    card.action.dataset.variant = active ? 'cancel' : 'run'

    // 端口名：选中时显示在卡片外侧，平时只看端口点
    card.ports.replaceChildren()
    if (selected) {
      const rect = { x: 0, y: 0, w: el.w, h: el.h }
      for (const side of ['in', 'out'] as const) {
        const ports = (side === 'in' ? el.ports?.inputs : el.ports?.outputs) ?? []
        ports.forEach((p, i) => {
          const pos = portPosition(el, rect, side, i)
          const tag = document.createElement('span')
          tag.className = `plein-port-label is-${side}`
          tag.textContent = p.label
          tag.style.top = `${pos.y}px`
          card.ports.appendChild(tag)
        })
      }
    }
  }
}

/** 主输出端口的结果（卡片只展示和切换它） */
function primaryResults(el: CanvasElement) {
  const port = el.ports?.outputs[0]?.id
  return (el.results ?? []).filter((r) => port === undefined || r.port === port)
}
