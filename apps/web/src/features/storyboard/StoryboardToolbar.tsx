import { Menu } from '@base-ui/react/menu'
import type { ShotRole } from '@plein/nodes'
import { Icon } from '../../ui/icons'
import { useDialogMenu } from '../../ui/useDialogMenu'

const item = 'ui-menu-item'
const roles = { image: '分镜图', video: '视频', speech: '配音', sfx: '音效' } as const
const primaryBatch = {
  image: { label: '批量出分镜图', icon: 'image' },
  video: { label: '批量生成视频', icon: 'video' },
  speech: { label: '批量配音', icon: 'mic' },
} as const

export function StoryboardToolbar({
  scope,
  hasShots,
  hasExpanded,
  scopeDiffs,
  nextRole,
  hasCanvas,
  onExpand,
  onLink,
  onBatch,
  onSync,
  onImpact,
  onReview,
  onSources,
  onAnimatic,
}: {
  scope: string
  hasShots: boolean
  hasExpanded: boolean
  scopeDiffs: number
  /** 目标镜头的下一步：有未展开的是 'expand'，其次是下一类还没出结果的批量动作；都展开且出齐了是 null */
  nextRole: 'expand' | 'image' | 'video' | 'speech' | null
  hasCanvas: boolean
  onExpand(mode: 'new' | 'update'): void
  onLink(): void
  onBatch(role: ShotRole, force?: boolean): void
  onSync(): void
  onImpact(): void
  onReview(): void
  onSources(): void
  onAnimatic(): void
}) {
  const menu = useDialogMenu()
  return (
    <div
      role="toolbar"
      aria-label="分镜批量操作"
      className="flex flex-none flex-wrap items-center gap-2 border-b border-line px-5 py-2"
    >
      <span className="mr-auto text-xs text-ink-subtle">作用于{scope}</span>
      <PrimaryAction
        hasShots={hasShots}
        hasExpanded={hasExpanded}
        scopeDiffs={scopeDiffs}
        nextRole={nextRole}
        onExpand={onExpand}
        onBatch={onBatch}
        onSync={onSync}
        onReview={onReview}
      />
      <Menu.Root modal={false} open={menu.open} onOpenChange={menu.onOpenChange}>
        <Menu.Trigger
          {...menu.triggerProps}
          aria-label="更多分镜操作"
          className="ui-btn ui-btn-secondary"
        >
          更多
          <Icon name="chevronDown" size={12} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            side="bottom"
            align="end"
            sideOffset={8}
            collisionPadding={8}
            className="z-70"
          >
            <Menu.Popup
              aria-label="更多分镜操作"
              className="ui-menu ui-scrollbar pointer-events-auto max-h-[70vh] w-56 overflow-y-auto outline-none"
            >
              <div className="ui-menu-label">节点与生成</div>
              <Menu.Item className={item} disabled={!hasShots} onClick={() => onExpand('new')}>
                <Icon name="workflow" />
                展开为镜头
              </Menu.Item>
              <Menu.Item
                className={item}
                disabled={!hasExpanded}
                title="给已展开的镜头补齐缺的角色和新增的台词，已有内容不动"
                onClick={() => onExpand('update')}
              >
                <Icon name="retry" />
                同步到镜头
              </Menu.Item>
              <Menu.Item
                className={item}
                disabled={!hasExpanded}
                title="把来源明确的镜头、配音和音效关联到画布中唯一的序列，保留手动设置"
                onClick={onLink}
              >
                关联已有序列
              </Menu.Item>
              <Menu.Item className={item} disabled={!hasExpanded} onClick={() => onBatch('image')}>
                <Icon name="image" />
                批量出分镜图
              </Menu.Item>
              <Menu.Item className={item} disabled={!hasExpanded} onClick={() => onBatch('video')}>
                <Icon name="video" />
                批量生成视频
              </Menu.Item>
              <Menu.Item className={item} disabled={!hasExpanded} onClick={() => onBatch('speech')}>
                <Icon name="mic" />
                批量配音
              </Menu.Item>
              <Menu.Item className={item} disabled={!hasExpanded} onClick={() => onBatch('sfx')}>
                批量音效
              </Menu.Item>
              <Menu.SubmenuRoot>
                <Menu.SubmenuTrigger
                  aria-label="全部重新生成"
                  className={item}
                  disabled={!hasExpanded}
                  openOnHover={false}
                >
                  全部重新生成
                  <Icon name="chevronRight" size={12} />
                </Menu.SubmenuTrigger>
                <Menu.Portal>
                  <Menu.Positioner
                    side="right"
                    align="start"
                    sideOffset={4}
                    collisionPadding={8}
                    className="z-70 pointer-events-auto"
                  >
                    <Menu.Popup
                      aria-label="全部重新生成"
                      className="ui-menu pointer-events-auto w-44 outline-none"
                    >
                      {(Object.keys(roles) as ShotRole[]).map((role) => (
                        <Menu.Item key={role} className={item} onClick={() => onBatch(role, true)}>
                          {roles[role]}
                        </Menu.Item>
                      ))}
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.SubmenuRoot>
              <Menu.Separator className="my-1 h-px bg-line" />
              <div className="ui-menu-label">检查与视图</div>
              <Menu.Item
                className={item}
                disabled={!scopeDiffs}
                title="看分镜表改动和已展开镜头的出入，确认后才同步"
                onClick={onSync}
              >
                <Icon name="layers" />
                查看差异{scopeDiffs ? `（${scopeDiffs}）` : ''}
              </Menu.Item>
              {hasCanvas && (
                <Menu.Item
                  className={item}
                  disabled={!hasExpanded}
                  title="改了之后哪些镜头图、视频、配音受影响，保留还是重做"
                  onClick={onImpact}
                >
                  <Icon name="layers" />
                  查看影响
                </Menu.Item>
              )}
              <Menu.Item className={item} onClick={onReview}>
                审核镜头
              </Menu.Item>
              <Menu.Item className={item} onClick={onSources}>
                剧情来源
              </Menu.Item>
              <Menu.Item className={item} disabled={!hasShots} onClick={onAnimatic}>
                节奏样片
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  )
}

/** 随阶段变化的主按钮：没展开先展开；表格改过先同步；之后依次出图、视频、配音；都齐了去审核 */
function PrimaryAction({
  hasShots,
  hasExpanded,
  scopeDiffs,
  nextRole,
  onExpand,
  onBatch,
  onSync,
  onReview,
}: {
  hasShots: boolean
  hasExpanded: boolean
  scopeDiffs: number
  nextRole: 'expand' | 'image' | 'video' | 'speech' | null
  onExpand(mode: 'new' | 'update'): void
  onBatch(role: ShotRole): void
  onSync(): void
  onReview(): void
}) {
  const cls = 'ui-btn ui-btn-primary'
  if (!hasExpanded || nextRole === 'expand')
    return (
      <button type="button" className={cls} disabled={!hasShots} onClick={() => onExpand('new')}>
        <Icon name="workflow" />
        展开为镜头
      </button>
    )
  if (scopeDiffs)
    return (
      <button type="button" className={cls} onClick={onSync}>
        <Icon name="layers" />
        同步改动
      </button>
    )
  if (nextRole) {
    const { label, icon } = primaryBatch[nextRole]
    return (
      <button type="button" className={cls} onClick={() => onBatch(nextRole)}>
        <Icon name={icon} />
        {label}
      </button>
    )
  }
  return (
    <button type="button" className={cls} onClick={onReview}>
      审核镜头
    </button>
  )
}
