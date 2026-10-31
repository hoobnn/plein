import { expect, test, type Page } from './fixtures'
import type {
  DesktopBridge,
  DesktopMenuCommand,
  DesktopUpdateState,
} from '../packages/protocol/src/desktop'

declare global {
  interface Window {
    pleinDesktop?: DesktopBridge
    __updates: {
      emit(state: DesktopUpdateState): void
      menu(): void
      resolveInitial(): void
      calls: string[]
    }
  }
}

const release = {
  version: '2.2.0',
  name: 'Plein 2.2 · 更流畅的创作体验',
  date: '2026-10-23T08:00:00Z',
  notes: [
    {
      version: '2.2.0',
      note: '## 新增\n- 支持查看完整更新内容\n- 下载进度与剩余时间\n\n## 优化\n下载失败后可以直接重试，继续安心创作。',
    },
    { version: '2.1.1', note: '### 问题修复\n修复窗口重新打开后更新进度丢失的问题。' },
  ],
}
const available: DesktopUpdateState = {
  phase: 'available',
  currentVersion: '2.1.0',
  checkedAt: Date.now(),
  release,
}

/** 只替换 Electron bridge；页面、设置、主题、焦点管理和服务端均运行真实实现。 */
async function bridge(
  page: Page,
  initial = available,
  options: { deferRead?: number; reject?: boolean; earlyMenu?: boolean } = {},
) {
  await page.addInitScript(
    ({ initial, options }) => {
      let state: DesktopUpdateState =
        JSON.parse(sessionStorage.getItem('update-test-state') || 'null') ?? initial
      const listeners = new Set<(state: DesktopUpdateState) => void>()
      const menus = new Set<(command: DesktopMenuCommand) => void>()
      const calls: string[] = []
      let resolve: (() => void) | undefined
      const emit = (next: DesktopUpdateState) => {
        state = next
        sessionStorage.setItem('update-test-state', JSON.stringify(next))
        for (const listener of listeners) listener(next)
      }
      window.__updates = {
        emit,
        calls,
        menu: () => {
          for (const listener of menus) listener('updates')
        },
        resolveInitial: () => resolve?.(),
      }
      window.pleinDesktop = {
        platform: 'darwin',
        onMenuCommand: (listener) => {
          menus.add(listener)
          if (options.earlyMenu) listener('updates')
          return () => menus.delete(listener)
        },
        nativeEdit: async () => {},
        openDataDir: async () => {},
        onOpenNode: () => () => {},
        onSaved: () => () => {},
        showSavedFile: async () => {},
        getUpdateState: () => {
          calls.push('read')
          if (options.reject && calls.filter((c) => c === 'read').length === 1)
            return Promise.reject(new Error('主进程暂时不可用'))
          if (calls.filter((c) => c === 'read').length === options.deferRead)
            return new Promise((done) => {
              resolve = () => done(initial)
            })
          return Promise.resolve(state)
        },
        getUpdatePreferences: () => {
          calls.push('preferences')
          return Promise.resolve({ checkOnLaunch: true, intervalHours: 6 })
        },
        setUpdatePreferences: (preferences) => {
          calls.push('set-preferences')
          return Promise.resolve(preferences)
        },
        checkForUpdates: async () => {
          calls.push('check')
          emit({ ...state, phase: 'checking', error: undefined })
        },
        downloadUpdate: async () => {
          calls.push('download')
          emit({ ...state, phase: 'downloading', error: undefined, progress: undefined })
        },
        installUpdate: async () => {
          calls.push('install')
        },
        onUpdateState: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      } satisfies DesktopBridge
    },
    { initial, options },
  )
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__updates.calls.includes('read'))).toBe(true)
}

async function emit(page: Page, state: DesktopUpdateState) {
  await page.evaluate((state) => window.__updates.emit(state), state)
}

async function show(page: Page) {
  await page.evaluate(() => window.__updates.menu())
  return page.getByRole('dialog', { name: '应用更新', exact: true })
}

test('更新说明、后台下载、失败重试和重载后的安装入口', async ({ page }, info) => {
  await bridge(page)
  const notice = page.getByRole('complementary', { name: '应用更新提醒' })
  await expect(notice).toContainText('发现新版本')
  expect(await page.evaluate(() => window.__updates.calls)).toEqual(['read'])
  await notice.getByRole('button', { name: '查看更新', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '应用更新', exact: true })
  await expect(dialog.getByRole('heading', { name: '新增', exact: true })).toBeVisible()
  await expect(dialog).toContainText('2.1.1')
  await dialog.screenshot({ path: info.outputPath('available-light.png') })
  await dialog.getByRole('button', { name: '下载更新', exact: true }).click()
  await expect(dialog).toContainText('正在下载更新')
  await expect(dialog.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
  const downloading: DesktopUpdateState = {
    ...available,
    phase: 'downloading',
    progress: {
      version: release.version,
      percent: 40,
      transferred: 40 * 1024 * 1024,
      total: 100 * 1024 * 1024,
      bytesPerSecond: 2 * 1024 * 1024,
    },
  }
  await emit(page, downloading)
  await expect(dialog.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
  await expect(dialog).toContainText('约剩余 30 秒')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(notice.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
  await notice.getByRole('button', { name: '收起更新提醒' }).click()
  await expect(notice).toHaveCount(0)
  await emit(page, {
    ...available,
    phase: 'error',
    error: { operation: 'download', message: '连接中断，请重试' },
  })
  await expect(notice).toContainText('更新下载失败')
  await notice.getByRole('button', { name: '查看并重试' }).click()
  await expect(dialog.getByRole('alert')).toContainText('连接中断')
  await dialog.getByRole('button', { name: '重试下载' }).click()
  await emit(page, { ...available, phase: 'downloaded' })
  await expect(dialog.getByRole('button', { name: '重启并安装' })).toBeEnabled()
  await page.reload()
  await expect(notice).toContainText('更新已准备好')
  await notice.getByRole('button', { name: '查看并安装' }).click()
  await expect(dialog).toContainText('支持查看完整更新内容')
  await dialog.getByRole('button', { name: '重启并安装' }).click()
  expect(await page.evaluate(() => window.__updates.calls)).toContain('install')
})

test('设置入口、手动检查、错误恢复、无说明和禁更新状态', async ({ page }) => {
  await bridge(page, { phase: 'idle', currentVersion: '2.1.0' })
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('plein:open-settings', { detail: { section: 'updates' } }),
    ),
  )
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings.getByRole('button', { name: '应用更新', exact: true })).toBeVisible()
  await settings.getByRole('button', { name: '检查更新', exact: true }).click()
  await expect(settings).toContainText('正在检查更新')
  await emit(page, {
    phase: 'error',
    currentVersion: '2.1.0',
    error: { operation: 'check', message: '网络断开' },
  })
  await expect(settings.getByRole('alert')).toContainText('网络断开')
  await settings.getByRole('button', { name: '重试检查' }).click()
  await emit(page, { phase: 'idle', currentVersion: '2.1.0', checkedAt: Date.now() })
  await expect(settings).toContainText('已经是最新版本')
  await emit(page, { ...available, release: { ...release, notes: [] } })
  await expect(settings).toContainText('此版本暂未提供更新说明')
  await expect(settings.getByRole('button', { name: '下载更新', exact: true })).toBeEnabled()
  const updates = await show(page)
  await expect(updates).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(updates).toHaveCount(0)
  await expect(settings).toBeVisible()
  await emit(page, {
    phase: 'unavailable',
    currentVersion: '2.1.0',
    reason: '验收环境不提供自动更新',
  })
  await expect(settings).toContainText('验收环境不提供自动更新')
  await expect(settings.getByRole('button', { name: '检查更新', exact: true })).toHaveCount(0)
})

test('HTML 更新说明过滤主动内容，深色窄窗口可完整阅读且键盘能关闭', async ({ page }, info) => {
  const html =
    '<h2 onclick="alert(1)">更新亮点</h2><ul><li><strong>保留列表和强调</strong></li></ul><p><a href="https://github.com/hoobnn/plein/releases">安全发布说明</a><a href="javascript:alert(1)">危险地址</a></p><img src="https://invalid.invalid/probe" onerror="alert(1)"><script>window.__injected=true</script><iframe src="https://invalid.invalid/frame"></iframe><svg onload="alert(1)"></svg>' +
    `<pre><code>${'long-code-'.repeat(150)}</code></pre><table><tbody><tr>${'<td>较宽的更新表格内容</td>'.repeat(12)}</tr></tbody></table>`
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 390, height: 620 })
  await bridge(page, {
    ...available,
    release: {
      ...release,
      notes: [
        {
          version: '2.2.0',
          note: html + '<p>较长的更新说明，确保窄窗口也可滚动完整阅读。</p>'.repeat(16),
        },
      ],
    },
  })
  const dialog = await show(page)
  await expect(dialog.getByRole('heading', { name: '更新亮点' })).toBeVisible()
  await expect(dialog.getByRole('link', { name: '安全发布说明' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  )
  await expect(dialog.getByRole('link', { name: '危险地址' })).toHaveCount(0)
  await expect(dialog.locator('script,iframe,img,[onclick],[onerror]')).toHaveCount(0)
  await expect(dialog.getByRole('region', { name: '更新内容', exact: true })).toContainText(
    '危险地址',
  )
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  const code = dialog.getByRole('region', { name: '代码块', exact: true })
  await expect(code).toHaveAttribute('tabindex', '0')
  expect(await code.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  await code.focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => code.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
  const table = dialog.getByRole('region', { name: '表格', exact: true })
  expect(await table.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  await dialog.getByRole('button', { name: '下载更新', exact: true }).scrollIntoViewIfNeeded()
  await expect(dialog.getByRole('button', { name: '下载更新', exact: true })).toBeVisible()
  await dialog.screenshot({ path: info.outputPath('available-dark-mobile.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: '应用更新提醒' })).toBeVisible()
})

test('晚到的初始快照不会覆盖新进度', async ({ page }) => {
  await bridge(page, available, { deferRead: 1 })
  await emit(page, { ...available, phase: 'downloaded' })
  await page.evaluate(() => window.__updates.resolveInitial())
  await expect(page.getByRole('complementary', { name: '应用更新提醒' })).toContainText(
    '更新已准备好',
  )
})

test('初次读取失败后保留可操作的恢复入口', async ({ page }) => {
  await bridge(page, available, { reject: true })
  const dialog = await show(page)
  await expect(dialog.getByRole('alert')).toContainText('主进程暂时不可用')
  await dialog.getByRole('button', { name: '重试读取' }).click()
  await expect(dialog).toContainText('发现新版本')
})

test('重试读取期间收到新进度后，迟到的旧快照不会覆盖已下载状态', async ({ page }) => {
  await bridge(page, available, { reject: true, deferRead: 2 })
  const dialog = await show(page)
  await expect(dialog.getByRole('alert')).toContainText('主进程暂时不可用')
  await dialog.getByRole('button', { name: '重试读取' }).click()
  await expect.poll(() => page.evaluate(() => window.__updates.calls.length)).toBe(2)
  await emit(page, { ...available, phase: 'downloaded' })
  await expect(dialog).toContainText('更新已准备好')
  await page.evaluate(() => window.__updates.resolveInitial())
  await expect(dialog.getByRole('button', { name: '重启并安装' })).toBeEnabled()
  await expect(dialog).toContainText('更新已准备好')
})

test('更新 UI 懒加载完成前收到的菜单命令仍会打开面板', async ({ page }) => {
  await bridge(page, { phase: 'idle', currentVersion: '2.1.0' }, { earlyMenu: true })
  await expect(page.getByRole('dialog', { name: '应用更新', exact: true })).toBeVisible()
})
