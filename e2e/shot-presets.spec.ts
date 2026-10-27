import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { addNode, clickRun, elements, newProject, revealGenerator, waitNode } from './canvas'

/** 设了就把界面截图存到这个目录（亮色、暗色各一张） */
const shotDir = process.env.PLEIN_E2E_SHOTS

async function shoot(page: Page, name: string) {
  if (!shotDir) return
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(shotDir, `${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: null })
}

test(
  '镜头与风格预设：选运镜、景别、光影、风格拼进提示词，提示冲突，存为风格卡',
  { tag: '@core' },
  async ({ page }) => {
    await newProject(page)
    await addNode(page, '生成视频')
    // 编辑器固定在卡片下方，先把它移进窗口再点里面的控件
    await revealGenerator(page)
    const generator = page.getByTestId('generator')
    const prompt = generator.getByRole('textbox', { name: '提示词' })
    await prompt.fill('女孩在雨夜的街口回头')
    const bar = generator.getByTestId('shot-presets')
    await expect(bar.getByRole('button', { name: /^运镜/ })).toBeHidden()
    await bar.locator('summary').click()
    await expect(bar).toContainText('提示词预设 · 效果因模型而异')

    const choose = async (slot: string, option: string) => {
      await bar.getByRole('button', { name: new RegExp(`^${slot}`) }).click()
      await page
        .getByRole('dialog', { name: slot })
        .getByRole('button', { name: new RegExp(`^${option}`) })
        .click()
    }
    await bar.getByRole('button', { name: /^运镜/ }).click()
    const moves = page.getByRole('dialog', { name: '运镜' })
    await moves.getByRole('button', { name: '缓慢' }).click()
    await moves.getByRole('button', { name: /^推近/ }).click()
    await choose('景别', '中景')
    await choose('光影', '霓虹夜景')
    await choose('风格', '赛博朋克')
    await expect(prompt).toHaveValue(
      '女孩在雨夜的街口回头\n镜头：缓慢推近主体，中景，膝盖以上，夜景霓虹灯光。\n风格：赛博朋克，冷暖撞色霓虹，雨夜反光。',
    )
    await expect(bar.getByRole('button', { name: /^运镜/ })).toContainText('缓慢推近')
    await bar.getByRole('button', { name: /^风格/ }).click()
    await page.mouse.move(700, 120)
    await shoot(page, '1-picker')
    await page.keyboard.press('Escape')

    // 改成固定机位，但正文里写了推近：提示冲突
    await prompt.fill('女孩在雨夜的街口回头，镜头推近她的脸')
    await choose('运镜', '固定机位')
    await expect(bar).toContainText('和「固定机位」冲突')
    const value = await prompt.inputValue()
    expect(value).toContain('镜头：固定机位，镜头不动')
    await page.mouse.move(700, 120)
    await shoot(page, '2-conflict')

    // 手改了镜头那一行：芯片标出已改动
    await prompt.fill(value.replace('镜头不动', '镜头不动，雨丝很密'))
    await expect(bar.getByRole('button', { name: /^运镜/ })).toContainText('已改动')

    // 风格存为风格卡
    await bar.getByRole('button', { name: /^风格/ }).click()
    await page
      .getByRole('dialog', { name: '风格' })
      .getByRole('button', { name: /存为风格卡/ })
      .click()
    const card = (await elements(page)).find((e) => e.nodeType === 'plein/style')
    expect(card?.name).toBe('赛博朋克')

    // 选择记在节点上，照常生成
    const video = (await elements(page)).find((e) => e.nodeType === 'plein/video')!
    await page.evaluate((id) => window.__plein.engine.selection.set([id]), video.id)
    await clickRun(page)
    await waitNode(page, video.id)
  },
)
