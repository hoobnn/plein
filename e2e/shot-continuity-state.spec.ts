import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { centerOf, newProject, zoomTo } from './canvas'

const input = JSON.parse(
  readFileSync(
    new URL('../docs/benchmarks/creative-baselines/action-continuity.json', import.meta.url),
    'utf8',
  ),
) as { shots: unknown[] }
async function seed(page: Page) {
  await newProject(page)
  const assets: string[] = []
  for (const color of ['red', 'blue']) {
    const data = execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=${color}:s=96x64:r=10:d=3`,
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      'frag_keyframe+empty_moov',
      '-f',
      'mp4',
      'pipe:1',
    ])
    const response = await page.request.post('/api/assets', {
      headers: { 'content-type': 'video/mp4' },
      data,
    })
    expect(response.status()).toBe(201)
    assets.push((await response.json()).id)
  }
  const ids = await page.evaluate(
    ({ assets, shots }) => {
      const board = window.__plein.addNode({
        type: 'plein/storyboard',
        name: '连续状态协议',
        params: { shots },
        x: 100,
        y: 100,
      })
      const nodes = ['action-continuity-1', 'action-continuity-2'].map((shotId, index) => {
        const node = window.__plein.addNode({
          type: 'plein/video',
          name: `协议视频${index + 1}`,
          params: {
            prompt: '本地受控媒体',
            source: { storyboard: board, shot: shotId, role: 'video' },
          },
          x: 700,
          y: 100 + index * 300,
        })
        const map = window.__plein.engine.doc.mutable(node) as unknown as {
          set(key: string, value: unknown): void
        }
        map.set('results', [
          {
            id: `candidate-${index + 1}`,
            runId: `local-${index}`,
            port: 'video',
            at: 1,
            value: { type: 'video', assetId: assets[index] },
          },
        ])
        map.set('adopted', `candidate-${index + 1}`)
        return node
      })
      return { board, beforeNode: nodes[0]!, afterNode: nodes[1]! }
    },
    { assets, shots: input.shots.slice(0, 2) },
  )
  await zoomTo(page, [ids.board])
  const at = await centerOf(page, ids.board)
  await page.mouse.dblclick(at.x, at.y)
  await expect(page.getByRole('dialog', { name: '分镜表', exact: true })).toBeVisible()
  return { ...ids, assets }
}
const editor = (page: Page) => page.getByRole('dialog', { name: '分镜表', exact: true })
const panel = (page: Page) => page.getByRole('dialog', { name: '镜头目的与起止计划', exact: true })
async function openState(page: Page, no: number) {
  await editor(page)
    .getByRole('article', { name: `镜头 ${String(no).padStart(2, '0')}` })
    .getByRole('button', { name: '目的与起止状态', exact: true })
    .click()
  await expect(panel(page)).toBeVisible()
  return panel(page)
}
async function addSubject(page: Page, form: Locator, kind: 'character' | 'prop', label: string) {
  if (!(await form.getByRole('textbox', { name: '主体名称', exact: true }).isVisible()))
    await form.getByText('添加可选主体', { exact: true }).click()
  await form.getByRole('combobox', { name: '主体类型', exact: true }).selectOption(kind)
  await form.getByRole('textbox', { name: '主体名称', exact: true }).fill(label)
  await form.getByRole('button', { name: '添加主体', exact: true }).click()
  await expect(
    form.getByRole('combobox', { name: '状态主体', exact: true }).locator('option:checked'),
  ).toContainText(label)
  return page.evaluate(
    ({ label }) =>
      [...window.__plein.engine.doc.elements()]
        .find((el) => el.nodeType === 'plein/storyboard')!
        .production!.continuity!.subjects.find((s) => s.label === label)!.id,
    { label },
  )
}
async function plans(page: Page, board: string) {
  let form = await openState(page, 1)
  const courier = await addSubject(page, form, 'character', '快递员')
  await form.getByRole('textbox', { name: '镜头目的', exact: true }).fill('建立红信封的持有关系')
  await form.getByRole('textbox', { name: '结束世界位置', exact: true }).fill('桌边')
  await form.getByRole('textbox', { name: '结束画面位置', exact: true }).fill('画面右侧')
  await form.getByRole('textbox', { name: '结束姿态', exact: true }).fill('起身')
  const envelope = await addSubject(page, form, 'prop', '红信封')
  await form.getByRole('combobox', { name: '结束持有者与手', exact: true }).selectOption(courier)
  await form.getByRole('combobox', { name: '结束持物手', exact: true }).selectOption('right')
  await form
    .getByRole('textbox', { name: '结束状态 / 完好程度', exact: true })
    .fill('一只、红色、完整')
  await form.getByRole('button', { name: '保存计划新版本', exact: true }).click()
  const firstPlan = await page.evaluate(
    (id) => window.__plein.engine.doc.get(id)!.production!.continuity!.plans[0]!.id,
    board,
  )
  await page.keyboard.press('Escape')
  await expect(panel(page)).not.toBeVisible()
  await expect(editor(page)).toBeVisible()
  form = await openState(page, 2)
  await form.getByRole('textbox', { name: '镜头目的', exact: true }).fill('向门口推进')
  await form.getByRole('combobox', { name: '状态主体', exact: true }).selectOption(envelope)
  await form.getByRole('combobox', { name: '引用计划版本', exact: true }).selectOption(firstPlan)
  await form.getByRole('checkbox', { name: '持有者与手', exact: true }).check()
  await form.getByRole('checkbox', { name: '状态 / 完好程度', exact: true }).check()
  await form.getByRole('button', { name: '引用所选版本的结束字段', exact: true }).click()
  await form.getByRole('button', { name: '保存计划新版本', exact: true }).click()
  await expect(form.getByRole('list', { name: '计划状态依赖' })).toContainText('所引字段一致')
  return { courier, envelope, firstPlan, form }
}
function watch(page: Page) {
  const calls: string[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/(?:run|run-flow|run-batch|storyboard-batch\/commit)(?:\?|$)/.test(request.url())
    )
      calls.push(request.url())
  })
  return calls
}

test('两镜可选计划、真实镜头目的和冻结继承；Esc只关闭起止状态层，零生成', async ({
  page,
}, info) => {
  const { board } = await seed(page),
    calls = watch(page)
  const { form, firstPlan, envelope } = await plans(page, board)
  await expect(form.getByRole('combobox', { name: '起始持物手', exact: true })).toHaveValue('right')
  await expect(form.getByRole('combobox', { name: '起始持物手', exact: true })).toBeDisabled()
  const data = await page.evaluate((id) => window.__plein.engine.doc.get(id)!, board)
  const second = data.production!.continuity!.plans.find((p) => p.shotId === 'action-continuity-2')!
  expect(second.content.inherits[0]).toMatchObject({
    planRevisionId: firstPlan,
    subjectId: envelope,
  })
  expect((data.params!.shots as Array<{ description: string }>)[1]!.description).toBe(
    '侧面跟拍，主角右手持红信封朝门口走',
  )
  await form.screenshot({ path: info.outputPath('two-shot-plan.png') })
  expect(calls).toEqual([])
})

test('候选观察区分未知和范围，换同asset新result不继承；实际静音回放才启用motion区间', async ({
  page,
}, info) => {
  const { board, afterNode } = await seed(page),
    calls = watch(page)
  let form = await openState(page, 1)
  await addSubject(page, form, 'prop', '红信封')
  await page.keyboard.press('Escape')
  await editor(page).getByRole('button', { name: '审核镜头', exact: true }).click()
  await editor(page)
    .locator('[data-shot-id="action-continuity-2"]')
    .getByRole('button', { name: '与上一镜连续性审看', exact: true })
    .click()
  const cut = page.getByRole('dialog', { name: '连续性审看', exact: true })
  await expect(cut.getByRole('img', { name: '镜头 2 真实首帧' })).toBeVisible()
  let observation = cut.getByRole('region', { name: '起始候选观察', exact: true })
  await observation.getByRole('textbox', { name: '起始观察备注' }).fill('色块无法判断持物与破损')
  await observation.getByRole('button', { name: '保存独立观察', exact: true }).click()
  await expect(observation.getByRole('list', { name: '起始当前候选观察' })).toContainText(
    '无法判断',
  )
  await page.evaluate((id) => {
    const el = window.__plein.engine.doc.get(id)!
    const next = { ...el.results![0], id: 'candidate-2-new' }
    const map = window.__plein.engine.doc.mutable(id) as unknown as {
      set(key: string, value: unknown): void
    }
    map.set('results', [next, ...el.results!])
    map.set('adopted', next.id)
  }, afterNode)
  observation = cut.getByRole('region', { name: '起始候选观察', exact: true })
  await expect(
    observation.getByRole('list', { name: '起始当前候选观察' }).locator('li'),
  ).toHaveCount(0)
  await expect(observation).toContainText('历史候选观察（1）')
  await cut.getByRole('checkbox', { name: '静音', exact: true }).check()
  await cut.getByRole('button', { name: '循环回看切点前后各一秒', exact: true }).click()
  await expect(
    observation.getByRole('combobox', { name: '起始检查范围' }).locator('option[value="interval"]'),
  ).toBeEnabled({ timeout: 15000 })
  await observation.getByRole('combobox', { name: '起始检查范围' }).selectOption('interval')
  await observation.getByRole('checkbox', { name: '动作回看', exact: true }).check()
  await expect(observation.getByRole('checkbox', { name: '声音回听', exact: true })).toBeDisabled()
  await observation
    .getByRole('checkbox', { name: '我已在所示回放区间检查所选项目；未知和推测仍保留' })
    .check()
  await observation.getByRole('button', { name: '保存独立观察', exact: true }).click()
  await cut.getByRole('button', { name: '暂停回看', exact: true }).click()
  await expect(observation.getByRole('list', { name: '起始当前候选观察' })).toContainText(
    '动作回看',
  )
  const stored = await page.evaluate(
    (id) =>
      window.__plein.engine.doc
        .get(id)!
        .production!.continuity!.observations.find((o) => o.target.resultId === 'candidate-2-new')!,
    board,
  )
  expect(stored.evidence).toMatchObject({
    kind: 'interval',
    start: 0,
    end: 1,
    playback: { completed: true, audible: false },
  })
  expect(Object.values(Object.values(stored.states)[0]!)[0]!.certainty).toBe('unknown')
  await cut.screenshot({ path: info.outputPath('candidate-observation-scope.png') })
  expect(calls).toEqual([])
})

test('独立场景reset解除真实依赖，前镜后续换手不再提醒后镜', async ({ page }, info) => {
  const { board } = await seed(page),
    calls = watch(page)
  const { form, envelope } = await plans(page, board)
  await form.getByRole('combobox', { name: '连续关系', exact: true }).selectOption('new_scene')
  await form.getByRole('textbox', { name: '重置原因', exact: true }).fill('时间跳跃后的独立场景')
  await form.getByRole('button', { name: '保存计划新版本', exact: true }).click()
  await expect(form.getByRole('list', { name: '计划状态依赖' }).locator('li')).toHaveCount(0)
  await expect(form.getByRole('combobox', { name: '起始持有者与手', exact: true })).toHaveValue('')
  await page.keyboard.press('Escape')
  const previous = await openState(page, 1)
  await previous.getByRole('combobox', { name: '状态主体', exact: true }).selectOption(envelope)
  await previous.getByRole('combobox', { name: '结束持物手', exact: true }).selectOption('left')
  await previous.getByRole('button', { name: '保存计划新版本', exact: true }).click()
  await page.keyboard.press('Escape')
  const independent = await openState(page, 2)
  await expect(independent.getByRole('list', { name: '计划状态依赖' }).locator('li')).toHaveCount(0)
  await independent.screenshot({ path: info.outputPath('independent-scene-reset.png') })
  expect(calls).toEqual([])
})
