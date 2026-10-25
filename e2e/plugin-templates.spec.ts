import { expect, test, type Page } from '@playwright/test'
import type { Catalog } from '../packages/protocol/src/plugins'
import { elements, newProject } from './canvas'

/** 注入目录边界夹具，节点及文档同步使用真实本机服务，不执行任何 Provider。 */
async function fixture(page: Page) {
  let mode: 'ready' | 'changed' | 'missing' | 'hold' = 'ready'
  let release = () => {}
  let received = () => {}
  const held = new Promise<void>((resolve) => {
    received = resolve
  })
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let submits = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/.*\/run(?:[-/?]|$)/.test(request.url())) submits++
  })
  await page.route('**/api/catalog', async (route) => {
    const response = await route.fetch()
    const catalog = (await response.json()) as Catalog
    const source = catalog.nodes.find((n) => n.type === 'plein/text')!
    const target = catalog.nodes.find((n) => n.type === 'plein/llm')!
    const template: Catalog['templates'][number] = {
      id: 'plein/test-pair',
      title: '验收插件文字链',
      plugin: source.plugin,
      nodes: [
        {
          key: 'a',
          type: source.type,
          version: source.version,
          title: '模板原文',
          params: { text: '保留参数' },
          x: 0,
          y: 0,
        },
        { key: 'b', type: target.type, version: target.version, title: '模板下游', x: 460, y: 0 },
      ],
      edges: [
        {
          from: ['a', source.outputs.find((p) => p.type === 'text')!.id],
          to: ['b', target.inputs.find((p) => p.type === 'text')!.id],
        },
      ],
    }
    if (mode === 'hold') {
      received()
      await pending
    }
    if (mode === 'changed') template.nodes[0]!.params = { text: '已经改变' }
    if (mode === 'missing') catalog.nodes = catalog.nodes.filter((n) => n !== target)
    catalog.templates.push(template)
    await route.fulfill({ response, json: catalog })
  })
  return {
    set: (value: typeof mode) => {
      mode = value
    },
    release,
    held,
    submits: () => submits,
  }
}

async function openTemplate(page: Page) {
  await page.getByRole('button', { name: '添加节点', exact: true }).click()
  await page.getByRole('textbox', { name: '搜索节点', exact: true }).fill('验收插件文字链')
  await expect(page.getByRole('option', { name: '验收插件文字链', exact: true })).toBeVisible()
  await expect(page.getByText(/^插件模板 · /)).toBeVisible()
}

test('插件模板按来源可发现，整组插入、撤销重做且不自动运行', async ({ page }) => {
  const control = await fixture(page)
  await newProject(page)
  await openTemplate(page)
  await page.getByRole('option', { name: '验收插件文字链', exact: true }).click()
  await expect.poll(async () => (await elements(page)).length).toBe(3)
  await expect(
    page.getByText('已插入模板「验收插件文字链」，未运行任何节点', { exact: true }),
  ).toBeVisible()
  const result = await page.evaluate(() => {
    const doc = window.__plein.engine.doc
    return { elements: [...doc.elements()], edges: [...doc.edges()] }
  })
  expect(result.elements.filter((el) => el.kind === 'frame')).toHaveLength(1)
  expect(result.elements.find((el) => el.name === '模板原文')?.params?.text).toBe('保留参数')
  expect(result.edges).toHaveLength(1)
  expect(result.elements.every((el) => !el.run && !el.results?.length)).toBe(true)
  expect(control.submits()).toBe(0)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(async () => (await elements(page)).length).toBe(0)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect.poll(async () => (await elements(page)).length).toBe(3)
  await page.screenshot({
    path: test.info().outputPath('plugin-template.png'),
    animations: 'disabled',
  })
})

for (const mode of ['changed', 'missing'] as const) {
  test(`点击前目录${mode === 'changed' ? '模板变化' : '依赖移除'}，不插入半份模板`, async ({
    page,
  }) => {
    const control = await fixture(page)
    await newProject(page)
    await openTemplate(page)
    control.set(mode)
    await page.getByRole('option', { name: '验收插件文字链', exact: true }).click()
    await expect(
      page.getByText(new RegExp(mode === 'changed' ? '模板已更新' : '未安装的节点')),
    ).toBeVisible()
    expect(await elements(page)).toHaveLength(0)
    expect(control.submits()).toBe(0)
  })
}

test('目录刷新迟到时不把模板写入已离开的画布', async ({ page }) => {
  const control = await fixture(page)
  await newProject(page)
  const canvasUrl = page.url()
  await openTemplate(page)
  control.set('hold')
  await page.getByRole('option', { name: '验收插件文字链', exact: true }).click()
  try {
    await control.held
    await page.getByRole('link', { name: 'Plein', exact: true }).click()
    await expect(page.getByRole('heading', { name: /^我的项目/ })).toBeVisible()
  } finally {
    control.release()
    control.set('ready')
  }
  await page.goto(canvasUrl)
  await expect.poll(async () => page.evaluate(() => !!window.__plein)).toBe(true)
  expect(await elements(page)).toHaveLength(0)
  expect(control.submits()).toBe(0)
})
