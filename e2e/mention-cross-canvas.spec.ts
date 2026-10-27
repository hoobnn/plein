import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { clickElement, newProject, waitNode } from './canvas'
import type { PreparedInput } from '../packages/protocol/src/runs'

test('跨画布粘贴重名角色后，档案素材、原有引用、撤销重做和生成输入保持一致', async ({
  page,
  context,
}) => {
  await newProject(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const dir = mkdtempSync(join(tmpdir(), 'plein-mention-copy-'))
  const assets: string[] = []
  try {
    for (const color of ['red', 'blue', 'green']) {
      const path = join(dir, `${color}.png`)
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=c=${color}:s=64x64`,
        '-frames:v',
        '1',
        path,
      ])
      const response = await page.request.post('/api/assets', {
        headers: { 'content-type': 'image/png' },
        data: readFileSync(path),
      })
      expect(response.status()).toBe(201)
      assets.push((await response.json()).id)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const original = await page.evaluate((assets) => {
    const chars = assets.slice(0, 2).map((image, i) =>
      window.__plein.addNode({
        type: 'plein/character',
        name: '林夏 · 复制',
        x: -900,
        y: i * 450,
        params: {
          description: `角色${i}`,
          profile: {
            periods: [
              {
                id: 'child',
                name: '少年',
                aliases: [],
                description: '少年身份',
                images: [assets[1 - i]],
                voice: null,
                voiceStates: [],
                outfits: [],
              },
              {
                id: 'young',
                name: '青年',
                aliases: [],
                description: '青年身份',
                images: [image],
                voice: null,
                voiceStates: [],
                outfits: [
                  {
                    id: 'uniform',
                    name: '校服',
                    aliases: [],
                    description: '蓝白校服',
                    images: [assets[2]],
                  },
                ],
              },
            ],
            expressions: [],
          },
        },
      }),
    )
    const sorted = [...chars].sort()
    const image = window.__plein.addNode({
      type: 'plein/image',
      name: '档案引用生成',
      x: 0,
      y: 0,
      params: {
        model: 'plein/mock:image',
        prompt: '@林夏 · 复制#2/青年/校服 站在窗前',
        requiredRefs: [sorted[1]],
      },
    })
    window.__plein.engine.selection.set([...chars, image])
    return { image, asset: assets[chars.indexOf(sorted[1]!)] }
  }, assets)
  await page.keyboard.press('ControlOrMeta+c')
  expect(
    JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).extensions,
  ).toBeTruthy()
  await newProject(page)
  const existing = await page.evaluate(() => {
    const role = window.__plein.addNode({
      type: 'plein/character',
      name: '林夏 · 复制',
      x: -900,
      y: 0,
      params: { description: '目标画布原有角色' },
    })
    const text = window.__plein.addNode({
      type: 'plein/text',
      name: '原有文本',
      x: 0,
      y: 500,
      params: { text: '@林夏 · 复制 留在这里' },
    })
    return { role, text }
  })
  await page.keyboard.press('ControlOrMeta+v')
  await expect
    .poll(() => page.evaluate(() => [...window.__plein.engine.doc.elements()].length))
    .toBe(5)
  const copied = await page.evaluate(
    () => [...window.__plein.engine.doc.elements()].find((el) => el.name === '档案引用生成')!.id,
  )
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
  const input = async () => {
    const response = await page.request.get(`/api/canvases/${canvas}/nodes/${copied}/input`)
    return response.ok() ? ((await response.json()) as PreparedInput) : null
  }
  await expect.poll(async () => (await input())?.refs[0]?.elementId).not.toBeUndefined()
  let prepared = (await input())!
  expect(prepared.refs[0]?.elementId).not.toBe(existing.role)
  expect(prepared.refs[0]?.required).toBe(true)
  expect(prepared.refs[0]?.name).toMatch(/#\d（青年·校服）/)
  expect(prepared.inputs.references?.map((v) => ('assetId' in v ? v.assetId : ''))).toEqual([
    original.asset,
    assets[2],
  ])
  expect(prepared.prompt).toContain('青年')
  const existingText = await page.evaluate(
    (id) => window.__plein.engine.doc.get(id)!.params!.text,
    existing.text,
  )
  expect(existingText).toMatch(/#\d/)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => [...window.__plein.engine.doc.elements()].length))
    .toBe(2)
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.text, existing.text),
  ).toBe('@林夏 · 复制 留在这里')
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => [...window.__plein.engine.doc.elements()].length))
    .toBe(5)
  await page.reload()
  await page.waitForFunction(() => !!window.__plein)
  prepared = (await input())!
  expect(prepared.inputs.references?.map((v) => ('assetId' in v ? v.assetId : ''))).toEqual([
    original.asset,
    assets[2],
  ])
  const run = await page.request.post(`/api/canvases/${canvas}/nodes/${copied}/run`, { data: {} })
  expect(run.status()).toBe(202)
  await waitNode(page, copied)
  await clickElement(page, copied)
  const chip = page
    .getByTestId('generator')
    .getByRole('button', { name: prepared.refs[0]!.name, exact: true })
  await expect(chip).toBeVisible()
  await expect(chip.locator('img')).toHaveAttribute('src', new RegExp(original.asset!))
  const field = page.getByTestId('generator').getByRole('textbox', { name: '提示词', exact: true })
  const prompt = await field.inputValue()
  const prefix = prompt.slice(0, prompt.indexOf('/'))
  await field.fill(`${prefix}/青`)
  await expect(page.getByRole('option').filter({ hasText: '青年' })).toBeVisible()
  await field.press('Enter')
  await expect(field).toHaveValue(`${prefix}/青年 `)
})

test('只复制生成节点时，缺失角色不会借用另一画布的同名角色进行生成', async ({ page, context }) => {
  await newProject(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(() => {
    window.__plein.addNode({
      type: 'plein/character',
      name: '林夏',
      x: -500,
      y: 0,
      params: { description: '源角色' },
    })
    const image = window.__plein.addNode({
      type: 'plein/image',
      name: '外部引用',
      x: 0,
      y: 0,
      params: { model: 'plein/mock:image', prompt: '@林夏 站在窗前' },
    })
    window.__plein.engine.selection.set([image])
  })
  await page.keyboard.press('ControlOrMeta+c')
  await newProject(page)
  await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/character',
      name: '林夏',
      x: -500,
      y: 0,
      params: { description: '同名的其他角色' },
    }),
  )
  await page.keyboard.press('ControlOrMeta+v')
  await expect
    .poll(() => page.evaluate(() => [...window.__plein.engine.doc.elements()].length))
    .toBe(2)
  const id = await page.evaluate(
    () => [...window.__plein.engine.doc.elements()].find((el) => el.name === '外部引用')!.id,
  )
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/canvases/${canvas}/nodes/${id}/input`)
      return response.ok()
        ? ((await response.json()) as PreparedInput).blocked.map((b) => b.message).join()
        : ''
    })
    .toContain('@林夏#0')
  await clickElement(page, id)
  await expect(
    page.getByTestId('generator').getByTestId('mention-highlights').locator('mark'),
  ).toHaveAttribute('data-state', 'warning')
  await expect(
    page.getByTestId('generator').getByRole('button', { name: '生成', exact: true }),
  ).toBeDisabled()
})
